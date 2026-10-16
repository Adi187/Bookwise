-- Up Migration
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (length(btrim(email)) > 0),
  password_hash text NOT NULL CHECK (length(password_hash) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

CREATE TABLE book_editions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  archive_identifier text NOT NULL UNIQUE CHECK (length(btrim(archive_identifier)) > 0),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  author text,
  source_url text NOT NULL,
  verified_text_filename text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'READY', 'FAILED')),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  edition_id uuid NOT NULL REFERENCES book_editions(id),
  saved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, edition_id)
);
CREATE INDEX user_sources_edition_id_idx ON user_sources (edition_id);

CREATE TABLE book_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id uuid NOT NULL REFERENCES book_editions(id),
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  chapter text,
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL CHECK (end_offset > start_offset),
  content text NOT NULL CHECK (length(btrim(content)) > 0),
  embedding public.vector(1536) NOT NULL,
  UNIQUE (edition_id, chunk_index)
);
-- The unique index begins with edition_id and supports edition-filtered retrieval.
-- Version staging, rights evidence, and worker leases arrive in later migrations.

-- Down Migration
DROP TABLE book_chunks;
DROP TABLE user_sources;
DROP TABLE book_editions;
DROP TABLE users;
-- Leave the shared vector extension installed.
