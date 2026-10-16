import { BookError } from '../books/errors.js';
import { isUuid } from '../auth/service.js';

const columns = `s.id,e.archive_identifier AS "archiveIdentifier",e.title,e.author,e.year,
  e.source_url AS "sourceUrl",CASE WHEN e.status='PENDING' THEN 'PROCESSING' ELSE e.status END AS status,
  e.error_message AS "errorCode"`;
const retryable = new Set(['INGESTION_FAILED', 'ARCHIVE_UNAVAILABLE', 'DOWNLOAD_UNAVAILABLE',
  'EMBEDDING_UNAVAILABLE', 'EMBEDDING_RESPONSE_INVALID']);
function present(row) {
  return { ...row, canRetry: row.status === 'FAILED' && retryable.has(row.errorCode),
    errorMessage: row.status === 'FAILED' ? (retryable.has(row.errorCode)
      ? 'We could not prepare this book. You can try again.'
      : 'This edition could not be prepared. Try another edition or contact support.') : null };
}

export function createSources({ pool, archive, requireModels = () => {} }) {
  async function owned(userId, sourceId, db = pool) {
    if (!isUuid(sourceId)) throw new BookError(404, 'SOURCE_NOT_FOUND', 'Saved book not found.');
    const { rows } = await db.query(`SELECT ${columns} FROM user_sources s JOIN book_editions e ON e.id=s.edition_id
      WHERE s.id=$1 AND s.user_id=$2`, [sourceId, userId]);
    if (!rows.length) throw new BookError(404, 'SOURCE_NOT_FOUND', 'Saved book not found.');
    return present(rows[0]);
  }
  async function queue(db, editionId) {
    // Serialize queue capacity checks, including concurrent requests from different users.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('noteway-queue-capacity',0))");
    if ((await db.query('SELECT edition_id FROM ingestion_jobs WHERE edition_id=$1', [editionId])).rowCount) return;
    const { rows } = await db.query('SELECT count(*)::integer AS count FROM ingestion_jobs');
    if (rows[0].count >= 100) throw new BookError(503, 'INGESTION_BUSY', 'Book preparation is busy. Please try again shortly.');
    await db.query('INSERT INTO ingestion_jobs(edition_id) VALUES($1) ON CONFLICT(edition_id) DO NOTHING', [editionId]);
  }
  async function transaction(run) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  return {
    owned,
    async list(userId, { page = 1, identifiers } = {}) {
      const values = identifiers ? [userId, identifiers] : [userId, (page - 1) * 20];
      const filter = identifiers ? 'AND e.archive_identifier=ANY($2::text[])' : 'ORDER BY s.saved_at DESC,s.id LIMIT 21 OFFSET $2';
      const { rows } = await pool.query(`SELECT ${columns} FROM user_sources s JOIN book_editions e ON e.id=s.edition_id WHERE s.user_id=$1 ${filter}`, values);
      return { items: (identifiers ? rows : rows.slice(0, 20)).map(present), page, hasMore: !identifiers && rows.length > 20 };
    },
    async add(userId, identifier) {
      const existing = await this.list(userId, { identifiers: [identifier] });
      if (existing.items.length) return { source: existing.items[0], created: false };
      // Ready editions can be shared without another download or model call.
      const ready = await pool.query("SELECT id FROM book_editions WHERE archive_identifier=$1 AND status='READY' AND published_version IS NOT NULL", [identifier]);
      let checked;
      if (!ready.rows.length) {
        requireModels();
        checked = await archive.validate(identifier);
        if (!checked.eligible) throw new BookError(422, 'BOOK_UNAVAILABLE', 'This edition cannot be prepared. Try another edition.');
      }
      return transaction(async db => {
        const { rows } = await db.query(`INSERT INTO book_editions(archive_identifier,title,author,year,source_url,verified_text_filename,status)
          VALUES($1,$2,$3,$4,$5,$6,'PENDING') ON CONFLICT(archive_identifier) DO UPDATE SET archive_identifier=EXCLUDED.archive_identifier RETURNING *`,
        [identifier, checked?.title || identifier, checked?.author || null, checked?.year || null,
          `https://archive.org/details/${encodeURIComponent(identifier)}`, checked?.text?.filename || 'pending']);
        const edition = rows[0];
        if (edition.status !== 'READY' && edition.status !== 'FAILED') { requireModels(); await queue(db, edition.id); }
        const saved = await db.query('INSERT INTO user_sources(user_id,edition_id) VALUES($1,$2) ON CONFLICT(user_id,edition_id) DO NOTHING RETURNING id', [userId, edition.id]);
        const source = (await db.query('SELECT id FROM user_sources WHERE user_id=$1 AND edition_id=$2', [userId, edition.id])).rows[0];
        return { source: await owned(userId, source.id, db), created: saved.rowCount === 1 };
      });
    },
    async retry(userId, sourceId) {
      await owned(userId, sourceId);
      return transaction(async db => {
        const { rows } = await db.query(`SELECT e.id,e.status,e.error_message FROM book_editions e JOIN user_sources s ON s.edition_id=e.id
          WHERE s.id=$1 AND s.user_id=$2 FOR UPDATE OF e`, [sourceId, userId]);
        const edition = rows[0];
        if (!edition) throw new BookError(404, 'SOURCE_NOT_FOUND', 'Saved book not found.');
        if (['PENDING', 'PROCESSING', 'READY'].includes(edition.status)) return owned(userId, sourceId, db);
        if (!retryable.has(edition.error_message)) throw new BookError(409, 'RETRY_UNAVAILABLE', 'This edition cannot be retried. Try another edition or contact support.');
        const lock = await db.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', [`noteway-job:${edition.id}`]);
        if (!lock.rows[0].acquired) throw new BookError(409, 'INGESTION_BUSY', 'Book preparation is finishing. Please try again shortly.');
        requireModels();
        await queue(db, edition.id);
        await db.query("UPDATE book_editions SET status='PENDING',error_message=NULL,updated_at=now() WHERE id=$1", [edition.id]);
        return owned(userId, sourceId, db);
      });
    },
  };
}
