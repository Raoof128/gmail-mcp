"""Read-only Plan 6 review probes. These establish counterexamples, not runtime acceptance."""

import csv
import json
from pathlib import Path
import re
import sqlite3
import unittest

ROOT = Path(__file__).resolve().parents[3]


class PlanSixReview(unittest.TestCase):
    def test_hash_set_accepts_seven_missing_writer_sites(self):
        with (ROOT / "docs/superpowers/reviews/2026-09-13-plan-5-writer-inventory.csv").open(newline="") as source:
            rows = list(csv.DictReader(source))
        by_hash = {row["sha256"]: row for row in rows}
        self.assertEqual(len(rows), 136)
        self.assertEqual(len(by_hash), 129)
        # The plan's proposed set equality passes despite omitting seven locations.
        self.assertEqual({row["sha256"] for row in rows}, set(by_hash))
        self.assertEqual(len(rows) - len(by_hash), 7)

    def test_actual_due_query_excludes_normal_profile_probe(self):
        source = (ROOT / "worker/src/operations/recovery-cron.ts").read_text()
        function = source.split("export async function dueRecoveries", 1)[1]
        query = re.search(r"`(WITH eligible AS .*?)`", function, re.S).group(1)
        # Minimal SQLite fixture runs the real selection query. It is not workerd/D1 proof.
        with sqlite3.connect(":memory:") as db:
            db.executescript("""
                CREATE TABLE operation_recovery(operation_id TEXT,user_id TEXT,account_id TEXT,
                  credential_version INTEGER,state TEXT,next_attempt_at INTEGER,deadline INTEGER,
                  attempts INTEGER,lease_until INTEGER,last_window INTEGER,binding_json TEXT,
                  started_at INTEGER,session_enc BLOB);
                CREATE TABLE accounts(user_id TEXT,id TEXT,status TEXT,credential_version INTEGER);
                CREATE TABLE operations(id TEXT,settlement_protocol INTEGER,state TEXT);
                CREATE TABLE recovery_attempts(window_id INTEGER,account_id TEXT);
                CREATE TABLE recovery_control(origin TEXT,build_id TEXT,user_id TEXT,account_id TEXT,
                  credential_version INTEGER,expires_at INTEGER,state TEXT,probe_ids TEXT,mode TEXT);
            """)
            binding = json.dumps({"executor": "send_message", "buildId": "build",
                                  "origin": "https://worker.example", "generatedMessageId": "<op@worker.example>"})
            db.execute("INSERT INTO operation_recovery VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       ("op", "owner", "account", 1, "active", 0, 999999999, 0, 0, None, binding, 0, None))
            db.execute("INSERT INTO accounts VALUES('owner','account','active',1)")
            db.execute("INSERT INTO operations VALUES('op',2,'delivery_unknown')")
            db.execute("INSERT INTO recovery_control VALUES(?,?,?,?,?,?,?,?,?)",
                       ("https://worker.example", "build", "owner", "account", 1, 999999999,
                        "probe", '["op"]', "generated_search"))
            def selected(profile):
                return db.execute(query, (300000, 300000, 300000, 1, "build",
                                          "https://worker.example", 1, 300000, profile, 200)).fetchall()
            self.assertEqual(len(selected("scratch")), 1)
            self.assertEqual(len(selected("normal")), 0)

    def test_current_admin_probe_expiry_is_not_authorization_expiry(self):
        source = (ROOT / "scripts/qualification/admin.ts").read_text()
        self.assertIn("now + 604800000", source)
        self.assertNotIn("authorization.expiresAt", source)
        now = 1000
        authorization_until = now + 60000
        inherited_control_until = now + 604800000
        self.assertGreater(inherited_control_until, authorization_until)


if __name__ == "__main__":
    unittest.main(verbosity=2)
