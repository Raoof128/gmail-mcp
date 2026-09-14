"""Revision-3 planning checks. No Worker, Gmail, credentials, or persistent DB."""

import csv
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import unittest

ROOT = Path(__file__).resolve().parents[3]
APPENDIX = ROOT / "docs/superpowers/plans/2026-09-13-plan-5-contracts.md"


def schema():
    """Execute the proposed SQL block over the actual existing migrations."""
    db = sqlite3.connect(":memory:", isolation_level=None)
    db.execute("PRAGMA foreign_keys=ON")
    for path in sorted((ROOT / "worker/migrations").glob("*.sql")):
        db.executescript(path.read_text())
    blocks = re.findall(r"```sql\n(.*?)\n```", APPENDIX.read_text(), re.S)
    db.executescript(blocks[0])
    for owner in ("one", "two"):
        db.execute("INSERT INTO users VALUES(?,?,?)", (owner, owner + "@example.test", 0))
        db.execute(
            "INSERT INTO accounts(id,user_id,alias,google_sub,google_email,scopes,status,created_at) "
            "VALUES(?,?,?,?,?,?,'active',0)",
            (owner, owner, owner, owner, owner + "@example.test", "[]"),
        )
    db.execute(
        "INSERT INTO operations(id,user_id,account_id,action,state,payload_hash,created_at,updated_at) "
        "VALUES('op','one','one','send.message','claimed','hash',0,0)"
    )
    return db


def bind(db, owner="one", body="{}"):
    db.execute(
        "INSERT INTO operation_recovery(operation_id,user_id,account_id,credential_version,"
        "binding_json,state,started_at,deadline,retain_until,next_attempt_at) "
        "VALUES('op',?,?,0,?,'active',0,86400000,604800000,0)",
        (owner, owner, body),
    )


def range_rule(value, total, previous):
    """Reference rule only; production tests must import the implementation."""
    if value is None:
        return ("incomplete", 0) if previous == 0 else ("invalid", None)
    match = re.fullmatch(r"(?:bytes=)?0-(\d+)", value.strip())
    if not match:
        return ("invalid", None)
    end = int(match[1])
    if end > 9007199254740991 or not previous <= end + 1 <= total:
        return ("invalid", None)
    return ("awaiting_final", None) if end + 1 == total else ("incomplete", end + 1)


class PlanConformance(unittest.TestCase):
    def setUp(self):
        self.db = schema()

    def tearDown(self):
        self.db.close()

    def test_migration_and_owner_binding(self):
        with self.assertRaises(sqlite3.IntegrityError):
            bind(self.db, "two")
        bind(self.db)
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_metadata_bound_and_horizon(self):
        with self.assertRaises(sqlite3.IntegrityError):
            bind(self.db, body=json.dumps({"value": "x" * 8193}))
        bind(self.db)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE operation_recovery SET deadline=10")

    def test_old_writer_refused(self):
        self.db.execute("BEGIN")
        self.db.execute("INSERT INTO settlement_permits(operation_id,token,purpose) VALUES('op','p','begin')")
        self.db.execute("UPDATE operations SET settlement_protocol=2,state='executing',byte_admitted=1")
        self.db.execute("DELETE FROM settlement_permits")
        self.db.execute("COMMIT")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE operations SET state='executed' WHERE id='op'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "INSERT INTO audit_log(ts,user_id,account_id,phase,decision,operation_id) VALUES(0,'one','one','outcome','executed','op')"
            )
        self.assertEqual(self.db.execute("SELECT count(*) FROM audit_log").fetchone()[0], 0)

    def test_permit_rollback_and_no_downgrade(self):
        self.db.execute("BEGIN")
        self.db.execute("INSERT INTO settlement_permits(operation_id,token,purpose) VALUES('op','p','begin')")
        self.db.execute("UPDATE operations SET settlement_protocol=2,state='executing',byte_admitted=1")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE operations SET settlement_protocol=1")
        self.db.execute("ROLLBACK")
        self.assertEqual(self.db.execute("SELECT count(*) FROM settlement_permits").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT settlement_protocol FROM operations").fetchone()[0], 1)

    def test_second_success_guard(self):
        self.mark_protocol2()
        self.db.execute("BEGIN")
        self.db.execute("INSERT INTO settlement_permits(operation_id,token,purpose) VALUES('op','p','success')")
        self.db.execute("UPDATE operations SET state='executed',result_identity='ids'")
        self.db.execute("INSERT INTO audit_log(ts,user_id,account_id,phase,decision,operation_id) VALUES(0,'one','one','outcome','executed','op')")
        self.db.execute("DELETE FROM settlement_permits")
        self.db.execute("COMMIT")
        self.db.execute("BEGIN")
        self.db.execute("INSERT INTO settlement_permits(operation_id,token,purpose) VALUES('op','second','success')")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "INSERT INTO _assert(x) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM operations "
                "WHERE id='op' AND state IN ('executing','delivery_unknown'))"
            )
        self.db.execute("ROLLBACK")
        self.assertEqual(self.db.execute("SELECT count(*) FROM audit_log WHERE decision='executed'").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM settlement_permits").fetchone()[0], 0)

    def test_range_vectors(self):
        for value in ("bytes=0-42", "0-42"):
            self.assertEqual(range_rule(value, 100, 0), ("incomplete", 43))
        self.assertEqual(range_rule("0-99", 100, 0), ("awaiting_final", None))
        for value in (None, "0-9007199254740992", "0-100", "0-42,0-80", "items=0-42"):
            self.assertEqual(range_rule(value, 100, 43)[0], "invalid")

    def test_rolling_credit_cap_across_windows(self):
        bind(self.db)
        self.db.execute("UPDATE operation_recovery SET lease_token='lease',lease_until=60000")
        blocks = re.findall(r"```sql\n(.*?)\n```", APPENDIX.read_text(), re.S)
        statements = [part.strip() for part in blocks[1].split(";") if part.strip()]
        for number in range(30):
            args = dict(op="op", lease="lease", now=1000, request_until=16000,
                        attempt_until=46000, run_until=241000, window=0,
                        id=str(number), kind="refresh" if number % 2 else "gmail")
            self.db.execute("BEGIN")
            for statement in statements:
                self.db.execute(statement, args)
            self.db.execute("COMMIT")
        args.update(id="overflow", window=1)
        self.db.execute("BEGIN")
        with self.assertRaises(sqlite3.IntegrityError):
            for statement in statements:
                self.db.execute(statement, args)
        self.db.execute("ROLLBACK")
        self.assertEqual(self.db.execute("SELECT count(*) FROM recovery_requests").fetchone()[0], 30)

    def test_epoch_recreation_does_not_match_old_lease(self):
        old_epoch, new_epoch = "qe_" + "A" * 43, "qe_" + "B" * 43
        values = ("https://example.test", "build", "one", "one", 0,
                  "generated_search", "enabled", old_epoch, 1000, "hash", "[]")
        self.db.execute("INSERT INTO recovery_control VALUES(?,?,?,?,?,?,?,?,?,?,?)", values)
        self.db.execute("DELETE FROM recovery_control")
        values = values[:7] + (new_epoch,) + values[8:]
        self.db.execute("INSERT INTO recovery_control VALUES(?,?,?,?,?,?,?,?,?,?,?)", values)
        self.assertIsNone(self.db.execute("SELECT 1 FROM recovery_control WHERE epoch=?", (old_epoch,)).fetchone())

    def mark_protocol2(self):
        self.db.execute("BEGIN")
        self.db.execute("INSERT INTO settlement_permits(operation_id,token,purpose) VALUES('op','begin','begin')")
        self.db.execute("UPDATE operations SET settlement_protocol=2,state='executing',byte_admitted=1")
        self.db.execute("DELETE FROM settlement_permits")
        self.db.execute("COMMIT")

    def test_one_permit_cannot_authorize_two_transitions_or_audits(self):
        self.mark_protocol2()
        self.db.execute("BEGIN")
        self.db.execute("INSERT INTO settlement_permits(operation_id,token,purpose) VALUES('op','p','success')")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE operations SET state='delivery_unknown'")
        self.db.execute("UPDATE operations SET state='executed'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE operations SET state='executed'")
        audit = "INSERT INTO audit_log(ts,user_id,account_id,phase,decision,operation_id) VALUES(0,?,'one','outcome','executed','op')"
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(audit, ('two',))
        self.db.execute(audit, ('one',))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(audit, ('one',))
        self.db.execute("ROLLBACK")
        self.assertEqual(self.db.execute("SELECT state FROM operations").fetchone()[0], 'executing')
        self.assertEqual(self.db.execute("SELECT count(*) FROM settlement_permits").fetchone()[0], 0)

    def test_actual_legacy_pending_and_staging_sql(self):
        self.db.execute("INSERT INTO pending_actions(id,user_id,account_id,action,modifiers,payload_hash,summary,state,operation_id,created_at,expires_at) VALUES('pending','one','one','send.message','[]','h','s','executing','op',0,1000)")
        self.db.execute("INSERT INTO staging_objects(handle,user_id,account_id,direction,r2_key,filename,mime,size,sha256,reserved_by_operation_id,created_at,expires_at) VALUES('handle','one','one','upload','key','file','text/plain',1,'h','op',0,1000)")
        with Path(__file__).with_name('2026-09-13-plan-5-writer-inventory.csv').open() as stream:
            rows=list(csv.DictReader(stream))
        cases=[(next(x['sql'] for x in rows if x['file']=='worker/src/tools/settle.ts' and x['table']=='pending_actions'), (10,'pending')),
               (next(x['sql'] for x in rows if x['file']=='worker/src/tools/settle.ts' and x['table']=='staging_objects'), (10,'op'))]
        for sql,args in cases:
            self.db.execute('BEGIN')
            self.assertEqual(self.db.execute(sql,args).rowcount,1)
            self.db.execute('ROLLBACK')
        self.mark_protocol2()
        for sql,args in cases:
            self.db.execute('BEGIN')
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(sql,args)
            self.db.execute('ROLLBACK')
        self.assertEqual(self.db.execute('SELECT state FROM pending_actions').fetchone()[0],'executing')
        self.assertEqual(self.db.execute('SELECT reserved_by_operation_id FROM staging_objects').fetchone()[0],'op')

    def test_pending_only_idempotency_key_is_retained(self):
        self.db.execute("INSERT INTO pending_actions(id,user_id,account_id,action,modifiers,payload_hash,summary,state,operation_id,created_at,expires_at) VALUES('pending','one','one','send.message','[]','h','s','executing','op',0,1000)")
        self.db.execute("INSERT INTO idempotency_keys VALUES('one','one','key','send_message','h','pending',NULL,0,0)")
        self.mark_protocol2()
        for sql in ("DELETE FROM idempotency_keys", "UPDATE idempotency_keys SET pending_id=NULL"):
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(sql)

    def test_exact_payload_budget(self):
        # ASCII JSON encoded size exactly 8192; raw ciphertext is separately capped.
        body=json.dumps({'v':'x'*8183},separators=(',',':'))
        self.assertEqual(len(body.encode()),8191)
        bind(self.db,body=body+' ')
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE operation_recovery SET binding_json=binding_json||' '")
        self.db.execute("UPDATE operation_recovery SET binding_json='{}'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE operation_recovery SET session_enc=zeroblob(4125),session_key_id='k'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE operation_recovery SET binding_json=?",(json.dumps({'v':'é'*4096},ensure_ascii=False),))

    def test_restored_generation_and_frozen_marker_refuse_admission(self):
        query="SELECT 1 FROM recovery_installation WHERE schema_version=5 AND restore_generation=? AND mutation_state='active'"
        self.assertIsNone(self.db.execute(query,('new',)).fetchone())
        self.db.execute("INSERT INTO recovery_installation VALUES(1,5,'old','active')")
        self.assertIsNone(self.db.execute(query,('new',)).fetchone())
        self.db.execute("UPDATE recovery_installation SET restore_generation='new',mutation_state='frozen'")
        self.assertIsNone(self.db.execute(query,('new',)).fetchone())
        self.db.execute("DROP TABLE recovery_installation")
        with self.assertRaises(sqlite3.OperationalError):
            self.db.execute(query,('new',))

    def test_late_direct_context_survives_recovery_retention(self):
        bind(self.db)
        context='{"executor":"send_message","resultVersion":"send-v1","pendingId":null,"audit":{"action":"send.message","modifiers":[],"recipients":1,"attachments":0}}'
        self.db.execute('UPDATE operations SET settlement_context_json=?',(context,))
        self.mark_protocol2()
        self.db.execute('DELETE FROM operation_recovery')
        self.db.execute('BEGIN')
        self.db.execute("INSERT INTO settlement_permits(operation_id,token,purpose) VALUES('op','late','success')")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE operations SET state='executed',settlement_context_json='{}'")
        self.db.execute("UPDATE operations SET state='executed',result_identity='ids'")
        self.db.execute("INSERT INTO audit_log(ts,user_id,account_id,phase,decision,operation_id) VALUES(0,'one','one','outcome','executed','op')")
        self.db.execute('DELETE FROM settlement_permits')
        self.db.execute('COMMIT')
        self.assertEqual(self.db.execute('SELECT settlement_context_json FROM operations').fetchone()[0],context)

    def test_pending_only_outcome_cannot_bypass_fence(self):
        self.db.execute("INSERT INTO pending_actions(id,user_id,account_id,action,modifiers,payload_hash,summary,state,operation_id,created_at,expires_at) VALUES('pending','one','one','send.message','[]','h','s','executing','op',0,1000)")
        self.mark_protocol2()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO audit_log(ts,phase,decision,pending_id) VALUES(0,'outcome','executed','pending')")

    def test_inventory_source_hashes(self):
        with Path(__file__).with_name('2026-09-13-plan-5-writer-inventory.csv').open() as stream:
            rows=list(csv.DictReader(stream))
        self.assertGreater(len(rows),80)
        discovered=[]
        pattern=re.compile(r"([\'\"`])((?:UPDATE\s|INSERT\s|DELETE\s)[\s\S]*?)\1")
        for source in sorted((ROOT/'worker/src').rglob('*.ts')):
            for match in pattern.finditer(source.read_text()):
                if re.match(r'(UPDATE|INSERT(?: OR \w+)? INTO|DELETE FROM)\s+(\w+)',match[2]):
                    discovered.append((str(source.relative_to(ROOT)),match[2]))
        self.assertEqual(discovered,[(row['file'],row['sql']) for row in rows])
        for row in rows:
            self.assertEqual(hashlib.sha256(row['sql'].encode()).hexdigest(),row['sha256'])
            self.assertIn(row['sql'],(ROOT/row['file']).read_text())

    def test_registry_names(self):
        text = APPENDIX.read_text()
        names = re.search(r'executor:\s*([^;]+);', text, re.S).group(1)
        source = (ROOT / "worker/src/tools/send.ts").read_text()
        for name in re.findall(r'"(.*?)"', names):
            self.assertIn('name: "' + name + '"', source)

    def test_historical_ledger_complete(self):
        path = Path(__file__).with_name("2026-09-13-plan-5-line-review.csv")
        with path.open() as stream:
            rows = list(csv.DictReader(stream))
        self.assertEqual(len(rows), 325)
        self.assertEqual(len({(r["document"], r["line"]) for r in rows}), 325)
        expected = {
            "specs/2026-09-13-gmail-mcp-plan-5-recovery-design.md": "6b258912853b5ee2983d5ee4e3bf715fbe39c014a666f178096e25651914efa9",
            "plans/2026-09-13-gmail-mcp-plan-5-recovery-and-release.md": "70b16b5a5bf55b0047b3aeaa305ab5f1c2332f0fff2c6017c85a22aec9b3e398",
        }
        for filename, digest in expected.items():
            original = "\n".join(r["source_text"] for r in rows if r["document"] == filename) + "\n"
            self.assertEqual(hashlib.sha256(original.encode()).hexdigest(), digest)


if __name__ == "__main__":
    unittest.main(verbosity=2)
