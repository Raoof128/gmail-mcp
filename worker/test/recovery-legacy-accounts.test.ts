import { LegacyCoverage } from "./legacy-coverage";
import { afterAll, expect, it } from "vitest";
import { legacyWriterCorpus } from "./fixtures/legacy-writer-corpus";
import { seedRecovery } from "./recovery-fixtures";
import { testEnv } from "./test-env";
const files = ["google/connect", "google/tokens", "policy/engine", "web/pages/accounts"];
for (const site of legacyWriterCorpus.filter((s) => files.some((f) => s.file === `worker/src/${f}.ts`))) {
  it(`executes captured account/policy writer ${site.file}:${site.line}`, async () => {
    const e = testEnv(),
      id = `account-${site.file.split("/").at(-1)!.replace(".ts", "")}-${site.line}`,
      now = Date.now();
    await seedRecovery(e, id, { linked: true });
    const operation = await e.DB.prepare("SELECT * FROM operations WHERE id=?").bind(id).first();
    const key = await e.DB.prepare("SELECT * FROM idempotency_keys WHERE user_id=?").bind(id).first();
    const blob = new Uint8Array([1, 2, 3]).buffer;
    let sql: string = site.sql,
      binds: unknown[];
    if (site.file.endsWith("google/connect.ts")) {
      binds =
        site.line === "55"
          ? ["new@example.test", "[]", "[]", blob, "test-key", blob, "test-key", now + 60000, now, id, id]
          : [
              `${id}-new`,
              id,
              "additional",
              `${id}-sub`,
              "new@example.test",
              "[]",
              "[]",
              ...(site.line === "83" ? [id] : []),
              blob,
              "test-key",
              blob,
              "test-key",
              now + 60000,
              now,
              now,
            ];
    } else if (site.file.endsWith("google/tokens.ts")) {
      if (site.line === "90" || site.line === "124") {
        // The inventory records the SET fragment; preserve guardedWrite's original suffix and binding order.
        sql += " WHERE id = ? AND user_id = ? AND status = 'active' AND credential_version = ?";
        binds =
          site.line === "90"
            ? [blob, "new-key", null, null, id, id, 0]
            : [blob, "new-key", now + 60000, now, null, null, id, id, 0];
      } else binds = [id, id, 0];
    } else if (site.file.endsWith("policy/engine.ts")) {
      const global = ["51", "78", "96"].includes(site.line);
      if (site.verb === "DELETE FROM") {
        await e.DB.prepare("INSERT INTO policies(user_id,account_id,action,level,updated_at) VALUES(?,?,?,'ask',?)")
          .bind(id, global ? null : id, "send.message", now)
          .run();
        binds = global ? [id, "send.message"] : [id, id, "send.message"];
      } else binds = global ? [id, "send.message", "deny", now] : [id, id, "send.message", "deny", now];
    } else {
      if (site.line === "146") {
        await e.DB.prepare("UPDATE accounts SET is_default=1 WHERE id=?").bind(id).run();
        binds = [id];
      } else if (site.line === "147") binds = [id, id];
      else if (site.line === "174" || site.line === "182") {
        if (site.line === "182")
          await e.DB.prepare("INSERT INTO contact_allowlist(user_id,account_id,pattern) VALUES(?,?,?)")
            .bind(id, id, "fixture@example.test")
            .run();
        binds = [id, id, "fixture@example.test"];
      } else if (site.line === "192") binds = [100, id, id];
      else binds = ['["example.test"]', id, id];
    }
    const statement = e.DB.prepare(sql).bind(...binds);
    expect((await statement.run()).meta.changes).toBe(site.file.endsWith("policy/engine.ts") ? 2 : 1);
    if (site.file.endsWith("google/connect.ts")) {
      expect(
        await e.DB.prepare("SELECT google_email,status,credential_version FROM accounts WHERE id=?")
          .bind(site.line === "55" ? id : `${id}-new`)
          .first(),
      ).toEqual({ google_email: "new@example.test", status: "active", credential_version: site.line === "55" ? 1 : 0 });
    } else if (site.file.endsWith("google/tokens.ts")) {
      const row = await e.DB.prepare("SELECT status,credential_version,access_token_key_id FROM accounts WHERE id=?")
        .bind(id)
        .first();
      expect(row).toMatchObject(
        site.line === "144"
          ? { status: "revoked", credential_version: 1, access_token_key_id: null }
          : site.line === "110"
            ? { status: "needs_reconnect", credential_version: 0, access_token_key_id: null }
            : { status: "active", access_token_key_id: "new-key" },
      );
      if (site.line === "90" || site.line === "124")
        await e.DB.prepare("UPDATE accounts SET credential_version=1 WHERE id=?").bind(id).run();
      expect((await statement.run()).meta.changes).toBe(0);
    } else if (site.file.endsWith("policy/engine.ts")) {
      const rows = (await e.DB.prepare("SELECT level FROM policies WHERE user_id=?").bind(id).all()).results;
      expect(rows).toEqual(site.verb === "DELETE FROM" ? [] : [{ level: "deny" }]);
      if (site.verb !== "DELETE FROM") {
        await statement.run();
        expect((await e.DB.prepare("SELECT level FROM policies WHERE user_id=?").bind(id).all()).results).toHaveLength(
          1,
        );
      }
    } else if (site.line === "174" || site.line === "182") {
      expect(await e.DB.prepare("SELECT count(*) n FROM contact_allowlist WHERE user_id=?").bind(id).first("n")).toBe(
        site.line === "174" ? 1 : 0,
      );
    } else {
      expect(
        await e.DB.prepare("SELECT is_default,send_limit_bytes,org_domains FROM accounts WHERE id=?").bind(id).first(),
      ).toMatchObject(
        site.line === "192"
          ? { send_limit_bytes: 100 }
          : site.line === "209"
            ? { org_domains: '["example.test"]' }
            : { is_default: site.line === "147" ? 1 : 0 },
      );
    }
    expect(await e.DB.prepare("SELECT * FROM operations WHERE id=?").bind(id).first()).toEqual(operation);
    expect(await e.DB.prepare("SELECT * FROM idempotency_keys WHERE user_id=?").bind(id).first()).toEqual(key);
    coverage.record(site);
  });
}

const coverage = new LegacyCoverage("accounts");
afterAll(() => coverage.verify());
