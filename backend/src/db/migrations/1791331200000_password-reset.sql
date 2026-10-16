-- Up Migration
ALTER TABLE users ADD COLUMN reset_token_hash text;
ALTER TABLE users ADD COLUMN reset_expires_at timestamptz;
ALTER TABLE users ADD COLUMN auth_version integer NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX users_reset_token_hash_idx ON users(reset_token_hash) WHERE reset_token_hash IS NOT NULL;

-- Down Migration
DROP INDEX users_reset_token_hash_idx;
ALTER TABLE users DROP COLUMN reset_token_hash, DROP COLUMN reset_expires_at, DROP COLUMN auth_version;
