import { detectChapters } from '../ingestion/chapters.js';
import { BookError } from '../books/errors.js';
import { validIdentifier } from '../books/archive.js';
import { PIPELINE_VERSION, LEGACY_PIPELINE_VERSION } from '../ingestion/chunks.js';
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, validVector } from '../ingestion/embeddings.js';
import { parseChapterScope } from './chapter-scope.js';

async function readyEdition(db, identifier) {
  const { rows } = await db.query(`SELECT e.*,
    (SELECT count(*)::integer FROM book_chunks c WHERE c.edition_id=e.id AND c.processing_version=e.published_version) AS stored_count
    FROM book_editions e WHERE archive_identifier=$1`, [identifier]);
  const edition = rows[0];
  if (!edition) throw new BookError(404, 'BOOK_NOT_FOUND', 'Ingest this edition before retrieving passages.');
  if (edition.status !== 'READY' || !edition.published_version) throw new BookError(409, 'SOURCE_NOT_READY', 'This edition is not ready.');
  if (edition.embedding_model !== EMBEDDING_MODEL || edition.embedding_dimensions !== EMBEDDING_DIMENSIONS || ![PIPELINE_VERSION, LEGACY_PIPELINE_VERSION].includes(edition.pipeline_version)) {
    throw new BookError(409, 'REPROCESS_REQUIRED', 'This edition uses an incompatible ingestion configuration.');
  }
  if (!edition.chunk_count || edition.chunk_count !== edition.stored_count) throw new BookError(409, 'INCOMPLETE_EDITION', 'The published chunk set is incomplete.');
  return edition;
}
function selectChapter(edition, scope) {
  if (!scope) return null;
  const chapters = edition.chapter_index;
  if (!Array.isArray(chapters) || !chapters.length) {
    throw new BookError(422, 'CHAPTERS_UNAVAILABLE', 'Chapter boundaries have not been reliably identified for this edition. Try a question about a specific event or topic instead.');
  }
  const number = scope.number === 'last' ? chapters.at(-1).number : scope.number;
  const chapter = chapters.find(item => item.number === number);
  if (!chapter) throw new BookError(422, 'CHAPTER_NOT_FOUND', `Chapter ${number} was not found in this edition. Please check the chapter number.`);
  return { ...chapter, mode: scope.mode };
}
function clipPassages(rows, chapter) {
  return rows.map(row => {
    const startOffset = Math.max(row.startOffset, chapter.startOffset);
    const endOffset = Math.min(row.endOffset, chapter.endOffset);
    return { ...row, chapter: chapter.title, startOffset, endOffset,
      content: row.content.slice(startOffset - row.startOffset, endOffset - row.startOffset) };
  });
}
async function chapterPassages(client, edition, chapter, vector) {
  const params = [edition.id, edition.published_version, chapter.title, chapter.startOffset, chapter.endOffset];
  const filter = 'edition_id=$1 AND processing_version=$2 AND $3::text IS NOT NULL AND start_offset < $5 AND end_offset > $4';
  const counts = (await client.query(`SELECT count(*)::integer AS total,coalesce(sum(token_count),0)::integer AS tokens FROM book_chunks WHERE ${filter}`, params)).rows[0];
  if (!counts.total) throw new BookError(409, 'INCOMPLETE_EDITION', 'This chapter has no published passages.');
  if (chapter.mode === 'overview' && counts.tokens > 12000) throw new BookError(422, 'CHAPTER_TOO_LONG', 'This chapter is too long to summarize reliably in one answer. Ask about a specific event, topic, beginning, or ending.');
  const fullChapter = chapter.mode === 'overview' || (chapter.mode === 'semantic' && counts.tokens <= 12000);
  const semantic = chapter.mode === 'semantic' && !fullChapter;
  if (semantic && !vector) throw new BookError(409, 'SOURCE_CHANGED', 'The chapter changed during retrieval. Please retry.');
  const limit = fullChapter ? counts.total : semantic ? 5 : chapter.mode === 'beginning' ? 1 : 3;
  const distance = semantic ? 'embedding <=> $6::public.vector' : 'NULL::double precision';
  const order = semantic ? 'distance, chunk_index' : chapter.mode === 'ending' ? 'chunk_index DESC' : 'chunk_index';
  // SQL fragments above are fixed strategies, never user-supplied SQL.
  const { rows } = await client.query(`WITH selected AS MATERIALIZED (
    SELECT id,chunk_index,chapter,start_offset,end_offset,content,embedding FROM book_chunks WHERE ${filter}
  ) SELECT id AS "chunkId",chunk_index AS "chunkIndex",chapter,start_offset AS "startOffset",end_offset AS "endOffset",content,
    ${distance} AS distance FROM selected ORDER BY ${order} LIMIT ${limit}`, semantic ? [...params, JSON.stringify(vector)] : params);
  if (rows.length !== Math.min(limit, counts.total) || (semantic && rows.some(row => !Number.isFinite(row.distance)))) throw new BookError(409, 'INCOMPLETE_EDITION', 'This chapter could not be retrieved completely.');
  if (chapter.mode === 'ending') rows.reverse();
  if (semantic) {
    // Include immediate context, always within the same chapter and published version.
    const indices = [...new Set(rows.flatMap(row => [row.chunkIndex - 1, row.chunkIndex, row.chunkIndex + 1]))];
    const neighbors = await client.query(`SELECT id AS "chunkId",chunk_index AS "chunkIndex",chapter,
      start_offset AS "startOffset",end_offset AS "endOffset",content,NULL::double precision AS distance
      FROM book_chunks WHERE ${filter} AND chunk_index=ANY($6::integer[]) ORDER BY chunk_index`, [...params, indices]);
    return { rows: clipPassages(neighbors.rows, chapter), coverage: 'selected-passages' };
  }
  return { rows: clipPassages(rows, chapter), coverage: fullChapter ? 'complete-chapter' : `${chapter.mode}-passages` };
}

// HTTP callers resolve an owned saved source before invoking this edition-level service.
export async function retrievePassages({ pool, embed, identifier, question }) {
  if (!validIdentifier(identifier) || typeof question !== 'string' || !question.trim() || question.trim().length > 2000) {
    throw new BookError(400, 'VALIDATION_ERROR', 'Provide a valid Archive identifier and a question of 1–2000 characters.');
  }
  question = question.trim();
  const scope = parseChapterScope(question);
  let client;
  try {
    const before = await readyEdition(pool, identifier);
    if (scope?.mode === 'count') {
      let chapters = before.chapter_index;
      if (!Array.isArray(chapters) || !chapters.length) {
        // Recover structure for editions ingested before title-only detection support.
        const { rows } = await pool.query(`SELECT start_offset,end_offset,content FROM book_chunks
          WHERE edition_id=$1 AND processing_version=$2 ORDER BY chunk_index`, [before.id, before.published_version]);
        let text = '';
        let complete = rows.length === before.chunk_count;
        for (const row of rows) {
          // The published chunker omits whitespace between paragraph units.
          // Restore separators while preserving the stored offsets.
          if (Number.isInteger(row.start_offset) && row.start_offset > text.length && row.start_offset - text.length <= 10000) {
            text += '\n'.repeat(row.start_offset - text.length);
          }
          if (!Number.isInteger(row.start_offset) || row.start_offset > text.length ||
              row.end_offset - row.start_offset !== row.content.length ||
              text.slice(row.start_offset, Math.min(text.length, row.end_offset)) !== row.content.slice(0, Math.max(0, Math.min(text.length, row.end_offset) - row.start_offset))) {
            complete = false; break;
          }
          text += row.content.slice(Math.max(0, text.length - row.start_offset));
        }
        chapters = complete ? detectChapters(text) : [];
      }
      return { editionId: before.id, archiveIdentifier: identifier, publishedVersion: before.published_version,
        question, chapterCount: chapters.length || null, passages: [] };
    }
    const beforeChapter = selectChapter(before, scope);
    let semantic = !scope || scope.mode === 'semantic';
    if (beforeChapter && scope.mode === 'semantic') {
      const { rows } = await pool.query(`SELECT coalesce(sum(token_count),0)::integer AS tokens FROM book_chunks
        WHERE edition_id=$1 AND processing_version=$2 AND $3::text IS NOT NULL AND start_offset < $5 AND end_offset > $4`,
      [before.id, before.published_version, beforeChapter.title, beforeChapter.startOffset, beforeChapter.endOffset]);
      semantic = rows[0].tokens > 12000;
    }
    const vectors = semantic ? await embed([question]) : null;
    if (semantic && (!Array.isArray(vectors) || vectors.length !== 1 || !validVector(vectors[0]))) throw new BookError(502, 'EMBEDDING_RESPONSE_INVALID', 'Invalid question embedding.');
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const edition = await readyEdition(client, identifier);
    if (edition.published_version !== before.published_version) throw new BookError(409, 'SOURCE_CHANGED', 'The edition changed during retrieval. Please retry.');
    const chapter = selectChapter(edition, scope);
    let rows;
    let coverage;
    if (chapter) ({ rows, coverage } = await chapterPassages(client, edition, chapter, vectors?.[0]));
    else {
      // Materialize the filtered set so ranking stays exact if ANN indexes are added later.
      ({ rows } = await client.query(`WITH selected AS MATERIALIZED (
        SELECT id, chunk_index, chapter, start_offset, end_offset, content, embedding
        FROM book_chunks WHERE edition_id=$1 AND processing_version=$2
      ) SELECT id AS "chunkId", chunk_index AS "chunkIndex", chapter,
        start_offset AS "startOffset", end_offset AS "endOffset", content,
        embedding <=> $3::public.vector AS distance
        FROM selected ORDER BY distance, chunk_index LIMIT 5`, [edition.id, edition.published_version, JSON.stringify(vectors[0])]));
      if (rows.length !== Math.min(5, edition.chunk_count) || rows.some(row => !Number.isFinite(row.distance))) throw new BookError(409, 'INCOMPLETE_EDITION', 'Published vectors could not be ranked.');
    }
    await client.query('COMMIT');
    return { editionId: edition.id, archiveIdentifier: identifier, title: edition.title,
      publishedVersion: edition.published_version, question, embeddingModel: EMBEDDING_MODEL,
      scope: chapter ? { chapter: chapter.title, number: chapter.number, mode: chapter.mode,
        coverage, focusChunkId: chapter.mode === 'ending' ? rows.at(-1).chunkId : chapter.mode === 'beginning' ? rows[0].chunkId : null } : null,
      passages: rows.map(row => ({ ...row, similarity: row.distance === null ? null : 1 - row.distance })),
      notice: 'Ranked passages are candidate evidence, not an answer or proof that the book answers the question.' };
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (error instanceof BookError) throw error;
    throw new BookError(500, 'RETRIEVAL_FAILED', 'Retrieval failed. Check database connectivity and migrations.');
  } finally { client?.release(); }
}
