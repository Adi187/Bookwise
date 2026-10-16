import { randomUUID } from 'node:crypto';
import { BookError, validIdentifier } from '../books/archive.js';
import { PIPELINE_VERSION } from './chunks.js';
import { prepareText, validateTokenBudget } from './prepare.js';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, validVector } from './embeddings.js';

export async function ingestEdition({ pool, archive, embed, identifier, maxTokens = 1000000, onProgress = () => {}, reprocess = false }) {
  if (!validIdentifier(identifier)) throw new BookError(400, 'VALIDATION_ERROR', 'Invalid Archive identifier.');
  validateTokenBudget(maxTokens);
  const client = await pool.connect();
  let locked = false;
  let editionId;
  let version;
  let transaction = false;
  let previous;
  try {
    // CLI and background workers share the lock; PostgreSQL releases it on a crash.
    const claim = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [`noteway-ingest:${identifier}`]);
    locked = claim.rows[0].acquired;
    if (!locked) throw new BookError(409, 'INGESTION_BUSY', 'This edition is already being processed.');
    const existing = await client.query(`SELECT e.*, (SELECT count(*)::integer FROM book_chunks c WHERE c.edition_id=e.id AND c.processing_version=e.published_version) AS stored_count
      FROM book_editions e WHERE archive_identifier=$1`, [identifier]);
    previous = existing.rows[0];
    if (previous?.status === 'READY' && !reprocess) {
      if (previous.pipeline_version !== PIPELINE_VERSION || previous.embedding_model !== EMBEDDING_MODEL || previous.embedding_dimensions !== EMBEDDING_DIMENSIONS || previous.chunk_count !== previous.stored_count || !previous.published_version) {
        throw new BookError(409, 'REPROCESS_REQUIRED', 'Stored edition needs an explicit version migration before reuse.');
      }
      return { editionId: previous.id, archiveIdentifier: identifier, status: 'READY', reused: true, chunks: previous.chunk_count, embeddedTokens: previous.embedded_tokens };
    }
    version = randomUUID();
    const row = await client.query(`INSERT INTO book_editions (archive_identifier,title,source_url,verified_text_filename,status,processing_version,pipeline_version)
      VALUES ($1,$1,$2,'pending','PROCESSING',$3,$4)
      ON CONFLICT (archive_identifier) DO UPDATE SET status='PROCESSING',processing_version=$3,pipeline_version=$4,error_message=NULL,updated_at=now()
      RETURNING id`, [identifier, `https://archive.org/details/${encodeURIComponent(identifier)}`, version, PIPELINE_VERSION]);
    editionId = row.rows[0].id;
    onProgress({ stage: 'download' });
    const book = await archive.downloadText(identifier);
    const { chunks, tokens, chapters } = prepareText(book.text, maxTokens);
    onProgress({ stage: 'embedding', chunks: chunks.length, tokens });
    for (let offset = 0; offset < chunks.length; offset += 16) {
      const batch = chunks.slice(offset, offset + 16);
      const vectors = await embed(batch.map(chunk => chunk.content));
      if (!Array.isArray(vectors) || vectors.length !== batch.length || !vectors.every(validVector)) throw new BookError(502, 'EMBEDDING_RESPONSE_INVALID', 'Invalid embedding batch.');
      batch.forEach((chunk, i) => { chunk.embedding = vectors[i]; });
      onProgress({ stage: 'embedding', completed: offset + batch.length, total: chunks.length });
    }
    onProgress({ stage: 'publish' });
    await client.query('BEGIN');
    transaction = true;
    for (let offset = 0; offset < chunks.length; offset += 32) {
      const batch = chunks.slice(offset, offset + 32);
      const values = [];
      const rows = batch.map(chunk => {
        const index = values.length;
        values.push(editionId, version, chunk.chunkIndex, chunk.chapter, chunk.startOffset, chunk.endOffset, chunk.content, JSON.stringify(chunk.embedding), chunk.tokenCount);
        return `(${Array.from({ length: 9 }, (_, i) => `$${index + i + 1}${i === 7 ? '::public.vector' : ''}`).join(',')})`;
      });
      await client.query(`INSERT INTO book_chunks (edition_id,processing_version,chunk_index,chapter,start_offset,end_offset,content,embedding,token_count) VALUES ${rows.join(',')}`, values);
    }
    const count = await client.query('SELECT count(*)::integer AS total FROM book_chunks WHERE edition_id=$1 AND processing_version=$2', [editionId, version]);
    if (count.rows[0].total !== chunks.length) throw new Error('Incomplete chunk publication.');
    const published = await client.query(`UPDATE book_editions SET title=$3,author=$4,source_url=$5,verified_text_filename=$6,
      source_sha1=$7,source_bytes=$8,embedding_model=$9,embedding_dimensions=$10,chunk_count=$11,embedded_tokens=$12,year=$13,chapter_index=$14::jsonb,
      published_version=$2,status='READY',error_message=NULL,updated_at=now()
      WHERE id=$1 AND processing_version=$2 AND status='PROCESSING' RETURNING id`,
    [editionId, version, book.title, book.author, book.sourceUrl, book.filename, book.sha1, book.sizeBytes, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, chunks.length, tokens, book.year ?? null, JSON.stringify(chapters)]);
    if (published.rowCount !== 1) throw new Error('Processing claim changed.');
    await client.query('DELETE FROM book_chunks WHERE edition_id=$1 AND processing_version<>$2', [editionId, version]);
    await client.query('COMMIT');
    transaction = false;
    return { editionId, archiveIdentifier: identifier, status: 'READY', reused: false, chunks: chunks.length, chapters: chapters.length, embeddedTokens: tokens, bytes: book.sizeBytes, sha1: book.sha1 };
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
    if (editionId && reprocess && previous?.status === 'READY') {
      // Keep the last published edition usable if replacement preparation fails.
      await client.query(`UPDATE book_editions SET status='READY',processing_version=$3,pipeline_version=$4,error_message=NULL,updated_at=now()
        WHERE id=$1 AND processing_version=$2 AND status='PROCESSING'`, [editionId, version, previous.processing_version, previous.pipeline_version]).catch(() => {});
    } else if (editionId) await client.query(`UPDATE book_editions SET status='FAILED',error_message=$3,updated_at=now()
      WHERE id=$1 AND processing_version=$2 AND status='PROCESSING'`, [editionId, version, error instanceof BookError ? error.code : 'INGESTION_FAILED']).catch(() => {});
    if (error instanceof BookError) throw error;
    throw new BookError(500, 'INGESTION_FAILED', 'Ingestion failed. Check database connectivity and migrations; rerun the command to retry.');
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`noteway-ingest:${identifier}`]).catch(() => {});
    // Close the session so even an unlock failure cannot leave a pooled lock behind.
    client.release(true);
  }
}
