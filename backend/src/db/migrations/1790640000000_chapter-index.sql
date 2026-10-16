-- Up Migration
ALTER TABLE book_editions ADD COLUMN chapter_index jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(chapter_index) = 'array');
CREATE INDEX book_chunks_chapter_idx ON book_chunks(edition_id,processing_version,chapter,chunk_index);

-- Down Migration
DROP INDEX book_chunks_chapter_idx;
ALTER TABLE book_editions DROP COLUMN chapter_index;
