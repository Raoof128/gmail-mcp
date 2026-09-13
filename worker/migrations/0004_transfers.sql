-- Transfer identity outlives any individual HTTP request or ticket generation.
CREATE TABLE upload_transfers (
  user_id TEXT NOT NULL, id TEXT NOT NULL, account_id TEXT NOT NULL, account_alias TEXT NOT NULL,
  metadata_json TEXT NOT NULL, intent_hash TEXT NOT NULL,
  payload_version INTEGER NOT NULL DEFAULT 1 CHECK(payload_version = 1),
  state TEXT NOT NULL CHECK(state IN ('awaiting_approval','authorized','in_progress','completed','failed','expired','denied')),
  pending_id TEXT, operation_id TEXT, active_generation INTEGER NOT NULL DEFAULT 0,
  handle TEXT, handle_expires_at INTEGER, error TEXT,
  created_at INTEGER NOT NULL, authority_until INTEGER NOT NULL, retain_until INTEGER NOT NULL,
  PRIMARY KEY(user_id,id), UNIQUE(user_id,account_id,id),
  FOREIGN KEY(user_id,account_id) REFERENCES accounts(user_id,id),
  FOREIGN KEY(pending_id) REFERENCES pending_actions(id),
  FOREIGN KEY(user_id,account_id,operation_id) REFERENCES operations(user_id,account_id,id)
);
CREATE TABLE upload_generations (
  user_id TEXT NOT NULL, transfer_id TEXT NOT NULL, account_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 3), ticket_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('issued','uploading','stored','completed','expired','abandoned','failed')),
  issued_until INTEGER NOT NULL, admitted_at INTEGER, lease_until INTEGER,
  credential_version INTEGER, r2_key TEXT NOT NULL UNIQUE, reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>=0),
  cleanup_state TEXT NOT NULL DEFAULT 'reserved' CHECK(cleanup_state IN ('reserved','debt','deleting','released','published')),
  writer_stopped INTEGER NOT NULL DEFAULT 0 CHECK(writer_stopped IN (0,1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,transfer_id,generation),
  FOREIGN KEY(user_id,account_id,transfer_id) REFERENCES upload_transfers(user_id,account_id,id)
);
CREATE UNIQUE INDEX upload_one_active ON upload_generations(user_id,transfer_id)
 WHERE state IN ('issued','uploading','stored');
CREATE INDEX upload_lease_expiry ON upload_generations(state,lease_until);
CREATE TABLE upload_retry_requests (
 user_id TEXT NOT NULL, transfer_id TEXT NOT NULL, retry_id TEXT NOT NULL,
 expected_generation INTEGER NOT NULL, result_generation INTEGER NOT NULL,
 PRIMARY KEY(user_id,transfer_id,retry_id),
 FOREIGN KEY(user_id,transfer_id,result_generation) REFERENCES upload_generations(user_id,transfer_id,generation)
);
-- Policy revision is asserted inside admission batches; a zero-row CAS must trigger _assert.
CREATE TABLE policy_revision (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
INSERT INTO policy_revision VALUES (1,0);
CREATE TRIGGER policy_revision_insert AFTER INSERT ON policies BEGIN UPDATE policy_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER policy_revision_update AFTER UPDATE ON policies BEGIN UPDATE policy_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER policy_revision_delete AFTER DELETE ON policies BEGIN UPDATE policy_revision SET version=version+1 WHERE id=1; END;
ALTER TABLE staging_objects ADD COLUMN cleanup_state TEXT NOT NULL DEFAULT 'available' CHECK(cleanup_state IN ('available','deleting'));
ALTER TABLE staging_objects ADD COLUMN download_lease_until INTEGER;
CREATE TABLE download_admissions (
 user_id TEXT NOT NULL, handle TEXT NOT NULL, account_id TEXT NOT NULL,
 admitted_at INTEGER NOT NULL, lease_until INTEGER NOT NULL, retain_until INTEGER NOT NULL,
 PRIMARY KEY(user_id,handle),
 FOREIGN KEY(user_id,account_id) REFERENCES accounts(user_id,id)
);
CREATE TABLE staging_acknowledgements (
 user_id TEXT NOT NULL, handle TEXT NOT NULL, account_id TEXT NOT NULL,
 acknowledged_at INTEGER NOT NULL, retain_until INTEGER NOT NULL,
 PRIMARY KEY(user_id,handle),
 FOREIGN KEY(user_id,account_id) REFERENCES accounts(user_id,id)
);
CREATE TABLE download_streams (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, handle TEXT NOT NULL, lease_until INTEGER NOT NULL,
 FOREIGN KEY(user_id,handle) REFERENCES download_admissions(user_id,handle)
);
CREATE TABLE staging_materializations(id TEXT PRIMARY KEY, lease_until INTEGER NOT NULL,user_id TEXT,account_id TEXT,reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),FOREIGN KEY(user_id,account_id) REFERENCES accounts(user_id,id));
CREATE TABLE staging_ingests(
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL,account_id TEXT NOT NULL,r2_key TEXT NOT NULL UNIQUE,
 reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>=0),lease_until INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','debt','released','published')),
 writer_stopped INTEGER NOT NULL DEFAULT 0 CHECK(writer_stopped IN (0,1)),
 FOREIGN KEY(user_id,account_id) REFERENCES accounts(user_id,id)
);
CREATE TABLE staging_recovery_slots(
 user_id TEXT NOT NULL,key TEXT NOT NULL,units INTEGER NOT NULL CHECK(units BETWEEN 1 AND 2),retain_until INTEGER NOT NULL,
 PRIMARY KEY(user_id,key),FOREIGN KEY(user_id) REFERENCES users(id)
);
