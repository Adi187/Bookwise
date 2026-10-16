-- Up Migration
ALTER TABLE book_editions
  ADD COLUMN processing_version uuid,
  ADD COLUMN published_version uuid,
  ADD COLUMN pipeline_version text,
  ADD COLUMN source_sha1 text,
  ADD COLUMN source_bytes integer CHECK (source_bytes > 0),
  ADD COLUMN embedding_model text,
  ADD COLUMN embedding_dimensions integer CHECK (embedding_dimensions = 1536),
  ADD COLUMN chunk_count integer CHECK (chunk_count > 0),
  ADD COLUMN embedded_tokens integer CHECK (embedded_tokens > 0);
ALTER TABLE book_chunks ADD COLUMN processing_version uuid, ADD COLUMN token_count integer CHECK (token_count > 0);
-- Preserve legacy rows if this foundation schema has already been populated.
UPDATE book_editions SET processing_version = gen_random_uuid();
UPDATE book_editions SET published_version = processing_version WHERE status = 'READY';
UPDATE book_chunks c SET processing_version = e.processing_version FROM book_editions e WHERE e.id = c.edition_id;
ALTER TABLE book_chunks ALTER COLUMN processing_version SET NOT NULL;
ALTER TABLE book_chunks DROP CONSTRAINT book_chunks_edition_id_chunk_index_key;
ALTER TABLE book_chunks ADD CONSTRAINT book_chunks_version_index_unique UNIQUE (edition_id, processing_version, chunk_index);

-- Down Migration
-- Retain only published rows when reverting to the unversioned schema.
DELETE FROM book_chunks c USING book_editions e WHERE c.edition_id = e.id AND c.processing_version IS DISTINCT FROM e.published_version;
ALTER TABLE book_chunks DROP CONSTRAINT book_chunks_version_index_unique;
ALTER TABLE book_chunks DROP COLUMN processing_version, DROP COLUMN token_count;
ALTER TABLE book_chunks ADD UNIQUE (edition_id, chunk_index);
ALTER TABLE book_editions DROP COLUMN processing_version, DROP COLUMN published_version,
  DROP COLUMN pipeline_version, DROP COLUMN source_sha1, DROP COLUMN source_bytes,
  DROP COLUMN embedding_model, DROP COLUMN embedding_dimensions, DROP COLUMN chunk_count, DROP COLUMN embedded_tokens;
