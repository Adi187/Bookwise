import { loadEnvironment } from '../src/config/env.js';
import { createPool } from '../src/db/connection.js';
import { createArchiveService, validIdentifier } from '../src/books/archive.js';
import { cleanText } from '../src/ingestion/chunks.js';
import { detectChapters } from '../src/ingestion/chapters.js';

// Metadata-only update: validates source identity and every published text slice.
// No embeddings or generation calls. Default is a dry run; --apply publishes.
loadEnvironment();
const [identifier, mode] = process.argv.slice(2);
if (!validIdentifier(identifier) || (mode && mode !== '--apply')) throw new Error('Usage: node backend/scripts/index-chapters.js <identifier> [--apply]');
const pool = createPool(process.env.DATABASE_URL);
const client = await pool.connect();
try {
  const lock = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [`noteway-ingest:${identifier}`]);
  if (!lock.rows[0].acquired) throw new Error('Edition is being processed. Retry later.');
  const { rows: [edition] } = await client.query("SELECT * FROM book_editions WHERE archive_identifier=$1 AND status='READY'", [identifier]);
  if (!edition) throw new Error('A ready edition is required.');
  const book = await createArchiveService().downloadText(identifier);
  if (book.sha1 !== edition.source_sha1) throw new Error('Source changed; re-ingestion is required.');
  const text = cleanText(book.text);
  const { rows: chunks } = await client.query('SELECT start_offset,end_offset,content FROM book_chunks WHERE edition_id=$1 AND processing_version=$2', [edition.id, edition.published_version]);
  if (chunks.length !== edition.chunk_count || chunks.some(c => text.slice(c.start_offset,c.end_offset) !== c.content)) throw new Error('Published text offsets do not match downloaded source.');
  const chapters = detectChapters(text);
  if (mode === '--apply' && chapters.length) {
    const result = await client.query("UPDATE book_editions SET chapter_index=$1::jsonb,updated_at=now() WHERE id=$2 AND published_version=$3 AND status='READY'", [JSON.stringify(chapters),edition.id,edition.published_version]);
    if (result.rowCount !== 1) throw new Error('Edition changed; retry.');
  }
  console.log(JSON.stringify({identifier,status: chapters.length ? 'detected' : 'unknown', applied: mode === '--apply' && chapters.length > 0, chapterCount: chapters.length || null, chapters},null,2));
} finally { client.release(true); await pool.end(); }
