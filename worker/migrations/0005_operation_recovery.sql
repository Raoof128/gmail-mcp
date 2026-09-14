-- Plan 5: compatibility guards precede protocol-2 writers. Existing rows stay legacy.
ALTER TABLE operations ADD COLUMN settlement_protocol INTEGER NOT NULL DEFAULT 1 CHECK(settlement_protocol IN (1,2));
ALTER TABLE operations ADD COLUMN result_identity TEXT;
ALTER TABLE operations ADD COLUMN settlement_context_json TEXT CHECK(settlement_context_json IS NULL OR
 (json_valid(settlement_context_json) AND length(CAST(settlement_context_json AS BLOB))<=2048));
ALTER TABLE operations ADD COLUMN byte_admitted INTEGER NOT NULL DEFAULT 0 CHECK(byte_admitted IN (0,1));
CREATE TABLE recovery_installation (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  schema_version INTEGER NOT NULL CHECK(schema_version=5),
  restore_generation TEXT NOT NULL, mutation_state TEXT NOT NULL CHECK(mutation_state IN ('frozen','active'))
);
-- No default active row: trusted installation must bind the external generation first.
CREATE TABLE recovery_control (
  origin TEXT NOT NULL, build_id TEXT NOT NULL, user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  credential_version INTEGER NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('generated_search','send_session_status')),
  state TEXT NOT NULL CHECK(state IN ('probe','enabled','disabled')), epoch TEXT NOT NULL CHECK(length(epoch)=46 AND epoch GLOB 'qe_*'),
  expires_at INTEGER NOT NULL, evidence_hash TEXT NOT NULL, probe_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(probe_ids)),
  PRIMARY KEY(origin,build_id,user_id,account_id,credential_version,mode),
  FOREIGN KEY(user_id,account_id) REFERENCES accounts(user_id,id)
);
CREATE TABLE operation_recovery (
  operation_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  credential_version INTEGER NOT NULL, binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),
  state TEXT NOT NULL CHECK(state IN ('active','manual','suspended','completed')),
  started_at INTEGER NOT NULL, deadline INTEGER NOT NULL CHECK(deadline=started_at+86400000),
  retain_until INTEGER NOT NULL CHECK(retain_until=started_at+604800000),
  next_attempt_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 288),
  last_window INTEGER, lease_token TEXT, lease_until INTEGER,
  session_enc BLOB, session_key_id TEXT, session_digest TEXT,
  mime_length INTEGER CHECK(mime_length BETWEEN 0 AND 36700160),
  confirmed_offset INTEGER NOT NULL DEFAULT 0 CHECK(confirmed_offset>=0),
  CHECK((session_enc IS NULL)=(session_key_id IS NULL)),
  CHECK((lease_token IS NULL)=(lease_until IS NULL)),
  CHECK(mime_length IS NULL OR confirmed_offset<=mime_length),
  CHECK(COALESCE(length(session_enc),0)<=4124),
  CHECK(length(CAST(binding_json AS BLOB))+COALESCE(length(session_enc),0)<=8192),
  FOREIGN KEY(user_id,account_id,operation_id) REFERENCES operations(user_id,account_id,id)
);
CREATE INDEX recovery_due ON operation_recovery(state,next_attempt_at,started_at,operation_id);
CREATE TABLE recovery_attempts (
  window_id INTEGER NOT NULL, operation_id TEXT NOT NULL, user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  admitted_at INTEGER NOT NULL, PRIMARY KEY(window_id,operation_id),
  FOREIGN KEY(user_id,account_id,operation_id) REFERENCES operations(user_id,account_id,id)
);
CREATE TABLE recovery_requests (
  id TEXT PRIMARY KEY, window_id INTEGER NOT NULL, operation_id TEXT NOT NULL,
  admitted_at INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('gmail','refresh')),
  FOREIGN KEY(operation_id) REFERENCES operations(id)
);
CREATE INDEX recovery_requests_time ON recovery_requests(admitted_at);
CREATE TABLE settlement_permits (
  operation_id TEXT PRIMARY KEY, token TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('begin','success','unknown','failed_safe','storage')),
  operation_writes INTEGER NOT NULL DEFAULT 0 CHECK(operation_writes BETWEEN 0 AND 1),
  audit_writes INTEGER NOT NULL DEFAULT 0 CHECK(audit_writes BETWEEN 0 AND 1),
  FOREIGN KEY(operation_id) REFERENCES operations(id)
);
CREATE TRIGGER protocol2_no_downgrade BEFORE UPDATE OF settlement_protocol ON operations
WHEN OLD.settlement_protocol=2 AND NEW.settlement_protocol!=2
BEGIN SELECT RAISE(ABORT,'protocol downgrade refused'); END;
CREATE TRIGGER protocol2_update_permit BEFORE UPDATE ON operations
WHEN (OLD.settlement_protocol=2 OR NEW.settlement_protocol=2) AND NOT EXISTS(
 SELECT 1 FROM settlement_permits p WHERE p.operation_id=OLD.id AND p.operation_writes=0
 AND OLD.id=NEW.id AND OLD.user_id=NEW.user_id AND OLD.account_id=NEW.account_id
 AND ((p.purpose='begin' AND OLD.settlement_protocol=1 AND OLD.state='claimed'
       AND NEW.settlement_protocol=2 AND NEW.state='executing' AND NEW.byte_admitted=1)
   OR (OLD.settlement_protocol=2 AND NEW.settlement_protocol=2
      AND NEW.settlement_context_json IS OLD.settlement_context_json
      AND NEW.rfc822_message_id IS OLD.rfc822_message_id
      AND NEW.idempotency_key IS OLD.idempotency_key AND
      ((p.purpose='success' AND OLD.state IN ('executing','delivery_unknown') AND NEW.state='executed')
       OR (p.purpose='unknown' AND OLD.state='executing' AND NEW.state='delivery_unknown')
       OR (p.purpose='failed_safe' AND OLD.state='claimed' AND OLD.byte_admitted=0 AND NEW.state='failed_safe')))))
BEGIN SELECT RAISE(ABORT,'settlement transition permit required'); END;
CREATE TRIGGER protocol2_count_update AFTER UPDATE ON operations
WHEN NEW.settlement_protocol=2
BEGIN UPDATE settlement_permits SET operation_writes=operation_writes+1 WHERE operation_id=NEW.id; END;
CREATE TRIGGER protocol2_delete_refused BEFORE DELETE ON operations WHEN OLD.settlement_protocol=2
BEGIN SELECT RAISE(ABORT,'retained operation required'); END;
CREATE TRIGGER protocol2_insert_refused BEFORE INSERT ON operations WHEN NEW.settlement_protocol=2
BEGIN SELECT RAISE(ABORT,'begin transaction required'); END;
CREATE TRIGGER protocol2_audit_permit BEFORE INSERT ON audit_log
WHEN NEW.phase='outcome' AND EXISTS(SELECT 1 FROM operations o WHERE (o.id=NEW.operation_id OR o.id IN (SELECT operation_id FROM pending_actions WHERE id=NEW.pending_id)) AND o.settlement_protocol=2)
 AND NOT EXISTS(SELECT 1 FROM settlement_permits p JOIN operations o ON o.id=p.operation_id
 WHERE p.operation_id=NEW.operation_id AND p.operation_writes=1 AND p.audit_writes=0
 AND NEW.user_id=o.user_id AND NEW.account_id=o.account_id
 AND ((p.purpose='success' AND NEW.decision='executed' AND o.state='executed')
   OR (p.purpose='unknown' AND NEW.decision='delivery_unknown' AND o.state='delivery_unknown')
   OR (p.purpose='failed_safe' AND NEW.decision='failed_safe' AND o.state='failed_safe')))
BEGIN SELECT RAISE(ABORT,'outcome transition permit required'); END;
CREATE TRIGGER protocol2_count_audit AFTER INSERT ON audit_log
WHEN NEW.phase='outcome' AND EXISTS(SELECT 1 FROM operations o WHERE (o.id=NEW.operation_id OR o.id IN (SELECT operation_id FROM pending_actions WHERE id=NEW.pending_id)) AND o.settlement_protocol=2)
BEGIN UPDATE settlement_permits SET audit_writes=audit_writes+1 WHERE operation_id=NEW.operation_id; END;
CREATE TRIGGER protocol2_pending_update BEFORE UPDATE ON pending_actions
WHEN EXISTS(SELECT 1 FROM operations o WHERE o.id IN (OLD.operation_id,NEW.operation_id) AND o.settlement_protocol=2
 AND NOT EXISTS(SELECT 1 FROM settlement_permits p WHERE p.operation_id=o.id AND p.purpose IN ('success','unknown','failed_safe')))
BEGIN SELECT RAISE(ABORT,'pending settlement permit required'); END;
CREATE TRIGGER protocol2_pending_binding BEFORE UPDATE ON pending_actions
WHEN EXISTS(SELECT 1 FROM operations o WHERE o.id=OLD.operation_id AND o.settlement_protocol=2)
 AND (NEW.operation_id IS NOT OLD.operation_id OR NEW.id!=OLD.id)
BEGIN SELECT RAISE(ABORT,'pending binding immutable'); END;
CREATE TRIGGER protocol2_pending_insert BEFORE INSERT ON pending_actions
WHEN EXISTS(SELECT 1 FROM operations o WHERE o.id=NEW.operation_id AND o.settlement_protocol=2)
BEGIN SELECT RAISE(ABORT,'pending must precede begin'); END;
CREATE TRIGGER protocol2_pending_delete BEFORE DELETE ON pending_actions
WHEN EXISTS(SELECT 1 FROM operations o WHERE o.id=OLD.operation_id AND o.settlement_protocol=2)
BEGIN SELECT RAISE(ABORT,'retained pending binding required'); END;
ALTER TABLE staging_objects ADD COLUMN settlement_operation_id TEXT REFERENCES operations(id);
CREATE TRIGGER protocol2_staging_update BEFORE UPDATE ON staging_objects
WHEN EXISTS(SELECT 1 FROM operations o
 WHERE o.id IN (OLD.reserved_by_operation_id,NEW.reserved_by_operation_id,OLD.settlement_operation_id,NEW.settlement_operation_id)
 AND o.settlement_protocol=2 AND NOT EXISTS(SELECT 1 FROM settlement_permits p
 WHERE p.operation_id=o.id AND p.purpose IN ('begin','success','failed_safe','storage')))
BEGIN SELECT RAISE(ABORT,'staging settlement permit required'); END;
CREATE TRIGGER protocol2_staging_owner BEFORE UPDATE ON staging_objects
WHEN NEW.settlement_operation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM operations o
 WHERE o.id=NEW.settlement_operation_id AND o.user_id=NEW.user_id AND o.account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT,'staging owner mismatch'); END;
CREATE TRIGGER protocol2_staging_insert BEFORE INSERT ON staging_objects
WHEN NEW.settlement_operation_id IS NOT NULL OR EXISTS(SELECT 1 FROM operations o
 WHERE o.id=NEW.reserved_by_operation_id AND o.settlement_protocol=2)
BEGIN SELECT RAISE(ABORT,'staging must precede begin'); END;
CREATE TRIGGER protocol2_staging_binding BEFORE UPDATE ON staging_objects
WHEN OLD.settlement_operation_id IS NOT NULL AND NEW.settlement_operation_id IS NOT OLD.settlement_operation_id
BEGIN SELECT RAISE(ABORT,'staging binding immutable'); END;
CREATE TRIGGER protocol2_staging_delete BEFORE DELETE ON staging_objects
WHEN EXISTS(SELECT 1 FROM operations o WHERE o.id IN (OLD.reserved_by_operation_id,OLD.settlement_operation_id)
 AND o.settlement_protocol=2 AND NOT EXISTS(SELECT 1 FROM settlement_permits p WHERE p.operation_id=o.id AND p.purpose='storage'))
BEGIN SELECT RAISE(ABORT,'storage cleanup permit required'); END;
CREATE TRIGGER protocol2_key_update BEFORE UPDATE ON idempotency_keys
WHEN EXISTS(SELECT 1 FROM operations o WHERE (o.id=OLD.operation_id OR o.id IN (SELECT operation_id FROM pending_actions WHERE id=OLD.pending_id)) AND o.settlement_protocol=2)
BEGIN SELECT RAISE(ABORT,'retained idempotency binding required'); END;
CREATE TRIGGER protocol2_key_delete BEFORE DELETE ON idempotency_keys
WHEN EXISTS(SELECT 1 FROM operations o WHERE (o.id=OLD.operation_id OR o.id IN (SELECT operation_id FROM pending_actions WHERE id=OLD.pending_id)) AND o.settlement_protocol=2)
BEGIN SELECT RAISE(ABORT,'retained idempotency binding required'); END;
