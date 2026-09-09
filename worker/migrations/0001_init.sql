CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  alias TEXT NOT NULL CHECK (length(alias) BETWEEN 1 AND 32 AND alias NOT GLOB '*[^a-z0-9_-]*'),
  google_sub TEXT NOT NULL,
  google_email TEXT NOT NULL,
  send_as TEXT NOT NULL DEFAULT '[]',
  org_domains TEXT,
  scopes TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','needs_reconnect','revoked')),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  send_limit_bytes INTEGER NOT NULL DEFAULT 26214400 CHECK (send_limit_bytes BETWEEN 1 AND 26214400),
  refresh_token_enc BLOB, refresh_token_key_id TEXT,
  access_token_enc BLOB, access_token_key_id TEXT, access_expires_at INTEGER,
  created_at INTEGER NOT NULL, last_refresh_at INTEGER,
  UNIQUE (user_id, id),
  UNIQUE (user_id, alias),
  UNIQUE (user_id, google_sub)
);
CREATE UNIQUE INDEX accounts_one_default ON accounts(user_id) WHERE is_default = 1;

CREATE TABLE policies (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  account_id TEXT,
  action TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('allow','ask','deny')),
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id)
);
CREATE UNIQUE INDEX policies_global_unique  ON policies(user_id, action) WHERE account_id IS NULL;
CREATE UNIQUE INDEX policies_account_unique ON policies(user_id, account_id, action) WHERE account_id IS NOT NULL;

CREATE TABLE contact_allowlist (
  user_id TEXT NOT NULL, account_id TEXT NOT NULL, pattern TEXT NOT NULL,
  PRIMARY KEY (account_id, pattern),
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id)
);

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  action TEXT NOT NULL,
  idempotency_key TEXT,
  state TEXT NOT NULL CHECK (state IN ('claimed','executing','delivery_unknown','executed','failed_safe')),
  payload_hash TEXT NOT NULL,
  rfc822_message_id TEXT,
  gmail_result_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (user_id, account_id, id),
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id)
);
CREATE UNIQUE INDEX operations_idempotency
  ON operations(user_id, account_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE pending_actions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  action TEXT NOT NULL, modifiers TEXT NOT NULL,
  payload_json TEXT,
  payload_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','approved','executing','executed','failed','denied','cancelled','expired')),
  operation_id TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  approved_at INTEGER, approved_via TEXT,
  execution_started_at INTEGER, executed_at INTEGER, error TEXT,
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id),
  FOREIGN KEY (user_id, account_id, operation_id) REFERENCES operations(user_id, account_id, id)
);

CREATE TABLE staging_objects (
  handle TEXT PRIMARY KEY,
  user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('download','upload')),
  r2_key TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL,
  size INTEGER NOT NULL, sha256 TEXT NOT NULL,
  source_message_id TEXT, source_attachment_id TEXT,
  reserved_by_operation_id TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER,
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id),
  FOREIGN KEY (user_id, account_id, reserved_by_operation_id) REFERENCES operations(user_id, account_id, id)
);

CREATE TABLE _assert (x INTEGER NOT NULL CHECK (x = 0));

CREATE TABLE web_sessions (
  id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL, authenticated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL, user_id TEXT, account_id TEXT,
  tool TEXT, action TEXT, modifiers TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('intent','outcome')),
  decision TEXT,
  pending_id TEXT, operation_id TEXT, gmail_result_id TEXT,
  summary TEXT,
  client_hint TEXT
);
CREATE INDEX audit_log_ts ON audit_log(ts);
CREATE INDEX pending_actions_state_expires ON pending_actions(state, expires_at);
CREATE INDEX operations_state_updated ON operations(state, updated_at);
CREATE INDEX staging_objects_expires ON staging_objects(expires_at);
