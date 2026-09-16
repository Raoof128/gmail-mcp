import { LegacyCoverage } from "./legacy-coverage";
import { afterAll, expect, it } from "vitest";
import { legacyWriterCorpus } from "./fixtures/legacy-writer-corpus";
import { seedRecovery } from "./recovery-fixtures";
import { testEnv } from "./test-env";
const files = ["auth/companion", "web/login", "web/session", "web/state"];
for (const site of legacyWriterCorpus.filter((s) => files.some((f) => s.file === `worker/src/${f}.ts`))) {
  it(`executes captured non-settlement writer ${site.file}:${site.line}`, async () => {
    const e = testEnv(),
      id = `auth-${site.file.split("/").at(-1)!.replace(".ts", "")}-${site.line}`,
      now = Date.now();
    await seedRecovery(e, id, { linked: true });
    const operation = await e.DB.prepare("SELECT * FROM operations WHERE id=?").bind(id).first();
    const key = await e.DB.prepare("SELECT * FROM idempotency_keys WHERE user_id=?").bind(id).first();
    let binds: unknown[];
    if (site.file.endsWith("auth/companion.ts")) {
      if (site.line === "52") binds = [id, "original", now];
      else {
        await e.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,'original',0)").bind(id).run();
        binds = ["next", now, id, "original"];
      }
    } else if (site.file.endsWith("web/login.ts")) binds = [id, "changed@example.test", now];
    else if (site.file.endsWith("web/session.ts")) {
      if (site.line === "43") binds = [id, id, now, now, now, now + 60000];
      else {
        await e.DB.prepare(
          "INSERT INTO web_sessions(id_hash,user_id,created_at,authenticated_at,last_seen_at,expires_at) VALUES(?,?,0,0,0,?)",
        )
          .bind(id, id, now + 60000)
          .run();
        if (site.line === "98") {
          await e.DB.prepare(
            "INSERT INTO web_sessions(id_hash,user_id,created_at,authenticated_at,last_seen_at,expires_at) VALUES(?,?,0,0,0,?)",
          )
            .bind(`${id}-keep`, id, now + 60000)
            .run();
          binds = [now, id, `${id}-keep`];
        } else binds = [now, id];
      }
    } else {
      if (site.line === "12") binds = [id, "login", "private-fixture", now, now + 60000];
      else {
        await e.DB.prepare(
          "INSERT INTO oauth_states(id,kind,payload,created_at,expires_at) VALUES(?,'login','private-fixture',0,?)",
        )
          .bind(id, site.line === "35" ? 0 : now + 60000)
          .run();
        binds = site.line === "26" ? [now, id, "login", now] : [1, 200];
      }
    }
    const statement = e.DB.prepare(site.sql).bind(...binds);
    const result = await statement.run();
    expect(result.meta.changes).toBe(1);
    if (site.file.endsWith("auth/companion.ts")) {
      expect(await e.DB.prepare("SELECT value FROM settings WHERE key=?").bind(id).first("value")).toBe(
        site.line === "52" ? "original" : "next",
      );
      expect((await statement.run()).meta.changes).toBe(0);
    } else if (site.file.endsWith("web/login.ts")) {
      expect(await e.DB.prepare("SELECT email FROM users WHERE id=?").bind(id).first("email")).toBe(
        "changed@example.test",
      );
    } else if (site.file.endsWith("web/session.ts")) {
      const row = await e.DB.prepare("SELECT * FROM web_sessions WHERE id_hash=?").bind(id).first();
      expect(row).toMatchObject(
        site.line === "75"
          ? { last_seen_at: now }
          : site.line === "86"
            ? { authenticated_at: now }
            : ["91", "98"].includes(site.line)
              ? { revoked_at: now }
              : { user_id: id, expires_at: now + 60000 },
      );
      if (site.line === "98")
        expect(
          await e.DB.prepare("SELECT revoked_at FROM web_sessions WHERE id_hash=?")
            .bind(`${id}-keep`)
            .first("revoked_at"),
        ).toBeNull();
    } else {
      if (site.line === "35")
        expect(await e.DB.prepare("SELECT id FROM oauth_states WHERE id=?").bind(id).first()).toBeNull();
      else {
        expect(await e.DB.prepare("SELECT consumed_at,payload FROM oauth_states WHERE id=?").bind(id).first()).toEqual({
          consumed_at: site.line === "26" ? now : null,
          payload: "private-fixture",
        });
        if (site.line === "26") expect((await statement.run()).meta.changes).toBe(0);
      }
    }
    expect(await e.DB.prepare("SELECT * FROM operations WHERE id=?").bind(id).first()).toEqual(operation);
    expect(await e.DB.prepare("SELECT * FROM idempotency_keys WHERE user_id=?").bind(id).first()).toEqual(key);
    coverage.record(site);
  });
}

const coverage = new LegacyCoverage("auth");
afterAll(() => coverage.verify());
