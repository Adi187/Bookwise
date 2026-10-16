import { loadEnvironment, readDatabaseUrl, ConfigurationError } from '../src/config/env.js';
import { createPool } from '../src/db/connection.js';
import { validIdentifier } from '../src/books/archive.js';
let pool;
try {
  loadEnvironment();
  const [identifier, ...extra] = process.argv.slice(2);
  if (!validIdentifier(identifier) || extra.length) throw new ConfigurationError('Usage: npm run ingest:status -- <archiveIdentifier>');
  pool = createPool(readDatabaseUrl(process.env.DATABASE_URL));
  const result = await pool.query(`SELECT e.id,e.archive_identifier,e.title,e.status,e.error_message,e.verified_text_filename,
    e.source_sha1,e.source_bytes,e.embedding_model,e.embedding_dimensions,e.chunk_count,e.embedded_tokens,e.pipeline_version,e.published_version,
    count(c.id)::integer AS published_chunks,min(public.vector_dims(c.embedding)) AS stored_dimensions
    FROM book_editions e LEFT JOIN book_chunks c ON c.edition_id=e.id AND c.processing_version=e.published_version
    WHERE e.archive_identifier=$1 GROUP BY e.id`, [identifier]);
  console.info(JSON.stringify(result.rows[0] || { archiveIdentifier: identifier, status: 'NOT_INGESTED' }, null, 2));
} catch (error) {
  console.error(error instanceof ConfigurationError ? error.message : 'Cannot read ingestion status. Check database connectivity and migrations.');
  process.exitCode = 1;
} finally { await pool?.end(); }
