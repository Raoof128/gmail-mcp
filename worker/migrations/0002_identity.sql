-- Owner-level key/value state that is not per account. First use: the client id the OAuth provider
-- generated for the pre-registered companion client, because createClient() does not accept a chosen id.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One-use OAuth state: OIDC login and connect state (with the nonce), and pending consent requests.
-- Consumed by a single UPDATE ... RETURNING, so two callbacks carrying the same state can never both
-- succeed. KV was rejected for this because it is eventually consistent and get-then-delete races.
CREATE TABLE oauth_states (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('login','reauth','connect','authreq')),
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX oauth_states_expires ON oauth_states(expires_at);

-- Incremented by every reconnect and revocation. A refresh that started before the bump cannot write
-- its result back, which is what stops a stale refresh from repopulating a revoked account.
ALTER TABLE accounts ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 0;
