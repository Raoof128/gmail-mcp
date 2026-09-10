-- Idempotency keyed on the client's intent (spec 3.5), recorded before staging and before the
-- allow/ask fork so a key means the same thing on every path. A key follows its pending action or
-- operation; a failed_safe operation or a dead pending action releases it for a fresh attempt.
CREATE TABLE idempotency_keys (
  user_id TEXT NOT NULL, account_id TEXT NOT NULL, key TEXT NOT NULL,
  tool TEXT NOT NULL, intent_hash TEXT NOT NULL,
  pending_id TEXT, operation_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, account_id, key),
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id),
  FOREIGN KEY (user_id, account_id, operation_id) REFERENCES operations(user_id, account_id, id)
);
-- The hash of the client's arguments, which is what an elicitation resume compares. payload_hash
-- stays the hash of the execution payload, which is what the claim and the approval page bind to.
ALTER TABLE pending_actions ADD COLUMN intent_hash TEXT;
ALTER TABLE pending_actions ADD COLUMN idempotency_key TEXT;
-- Ids only (message id, thread id, label id), so a replayed key can answer with the original result.
ALTER TABLE operations ADD COLUMN result_json TEXT;
