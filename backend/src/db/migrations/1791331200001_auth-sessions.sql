-- Up Migration
CREATE TABLE auth_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_version integer NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);

-- Down Migration
DROP TABLE auth_sessions;
