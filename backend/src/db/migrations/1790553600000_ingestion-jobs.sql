-- Up Migration
ALTER TABLE book_editions ADD COLUMN year text;
-- A queued row survives browser disconnects and server/worker restarts.
-- Workers hold session advisory locks; PostgreSQL releases them on disconnect.
CREATE TABLE ingestion_jobs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  edition_id uuid PRIMARY KEY REFERENCES book_editions(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ingestion_jobs_created_idx ON ingestion_jobs(created_at);

-- Down Migration
DROP TABLE ingestion_jobs;
ALTER TABLE book_editions DROP COLUMN year;
