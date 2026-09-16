import { LegacyCoverage } from "./legacy-coverage";
import { afterAll, expect, it } from "vitest";
import { legacyWriterCorpus } from "./fixtures/legacy-writer-corpus";
import { seedRecovery } from "./recovery-fixtures";
import { testEnv } from "./test-env";
import { settleDirect } from "../src/operations/recovery-state";
const sites = legacyWriterCorpus.filter((s) => s.file === "worker/src/cron.ts");
for (const site of sites) {
  it(`executes captured cron site ${site.line} against matched legacy rows`, async () => {
    const e = testEnv(),
      id = `cron-legacy-${site.line}`,
      now = Date.now();
    await seedRecovery(e, id, { linked: true, protocol: 1 });
    let binds: unknown[];
    switch (site.line) {
      case "27":
        await e.DB.prepare("UPDATE operations SET state='claimed' WHERE id=?").bind(id).run();
        binds = [now, id];
        break;
      case "32":
        await expect(e.DB.prepare(site.sql).bind(id).run()).rejects.toThrow("CHECK constraint failed");
        await e.DB.prepare("UPDATE operations SET state='failed_safe' WHERE id=?").bind(id).run();
        binds = [id];
        break;
      case "37":
      case "42":
        binds = [id];
        break;
      case "54":
        await e.DB.prepare("UPDATE pending_actions SET state='pending',expires_at=0 WHERE id=?")
          .bind(`${id}-pending`)
          .run();
        binds = [now, 200];
        break;
      case "61":
        await e.DB.prepare("UPDATE operations SET updated_at=0 WHERE id=?").bind(id).run();
        binds = [now, 1, 200];
        break;
      case "78":
        await e.DB.prepare(
          "INSERT INTO audit_log(ts,user_id,account_id,phase,decision,operation_id) VALUES(0,?,?,'intent','allow',?)",
        )
          .bind(id, id, id)
          .run();
        binds = [1, 200];
        break;
      default:
        throw new Error("unmapped cron site");
    }
    const result = await e.DB.prepare(site.sql)
      .bind(...binds)
      .run();
    expect(result.success).toBe(true);
    if (site.line !== "32") expect(result.meta.changes).toBeGreaterThan(0);
    if (site.line === "27")
      expect(await e.DB.prepare("SELECT state FROM operations WHERE id=?").bind(id).first("state")).toBe("failed_safe");
    if (site.line === "37")
      expect(
        await e.DB.prepare("SELECT reserved_by_operation_id FROM staging_objects WHERE user_id=?")
          .bind(id)
          .first("reserved_by_operation_id"),
      ).toBeNull();
    if (site.line === "42" || site.line === "54")
      expect(
        await e.DB.prepare("SELECT state FROM pending_actions WHERE id=?").bind(`${id}-pending`).first("state"),
      ).toBe(site.line === "42" ? "failed" : "expired");
    if (site.line === "61")
      expect(await e.DB.prepare("SELECT state FROM operations WHERE id=?").bind(id).first("state")).toBe(
        "delivery_unknown",
      );
    if (site.line === "78")
      expect(await e.DB.prepare("SELECT count(*) n FROM audit_log WHERE operation_id=?").bind(id).first("n")).toBe(0);
    coverage.record(site);
  });
}
for (const line of ["27", "32", "37", "42", "54", "61"]) {
  it(`checks captured cron site ${line} before and after a protocol-2 winner`, async () => {
    const e = testEnv(),
      id = `cron-protocol2-${line}`,
      now = Date.now();
    await seedRecovery(e, id, { linked: true });
    const site = sites.find((s) => s.line === line)!;
    const params =
      line === "27" ? [now, id] : line === "54" ? [now, 200] : line === "61" ? [now, Date.now(), 200] : [id];
    const snapshot = async () => ({
      operation: await e.DB.prepare("SELECT * FROM operations WHERE id=?").bind(id).first(),
      pending: await e.DB.prepare("SELECT * FROM pending_actions WHERE id=?").bind(`${id}-pending`).first(),
      storage: (await e.DB.prepare("SELECT * FROM staging_objects WHERE user_id=?").bind(id).all()).results,
      keys: (await e.DB.prepare("SELECT * FROM idempotency_keys WHERE user_id=?").bind(id).all()).results,
    });
    const before = await snapshot();
    const statement = e.DB.prepare(site.sql).bind(...params);
    if (line === "27" || line === "54")
      await statement.run(); // Their claimed/pending predicates exclude enrolled rows.
    else
      await expect(statement.run()).rejects.toThrow(
        line === "32"
          ? "CHECK constraint failed"
          : line === "37"
            ? "staging settlement permit required"
            : line === "42"
              ? "pending settlement permit required"
              : "settlement transition permit required",
      );
    expect(await snapshot()).toEqual(before);
    await settleDirect(e, id, {
      gmail_result_id: "winner",
      message: { id: "winner", thread_id: "thread", label_ids: ["SENT"] },
    });
    const after = await snapshot();
    if (line === "32") await expect(statement.run()).rejects.toThrow("CHECK constraint failed");
    else await statement.run();
    expect(await snapshot()).toEqual(after);
  });
}
for (const phase of ["legacy", "before", "after"] as const) {
  it(`executes the original recoverClaimed batch in ${phase} state`, async () => {
    const e = testEnv(),
      id = `claimed-batch-${phase}`;
    await seedRecovery(e, id, { linked: true, protocol: phase === "legacy" ? 1 : 2 });
    if (phase === "legacy") await e.DB.prepare("UPDATE operations SET state='claimed' WHERE id=?").bind(id).run();
    if (phase === "after")
      await settleDirect(e, id, {
        gmail_result_id: "winner",
        message: { id: "winner", thread_id: "thread", label_ids: ["SENT"] },
      });
    const snapshot = async () => ({
      operation: await e.DB.prepare("SELECT * FROM operations WHERE id=?").bind(id).first(),
      pending: await e.DB.prepare("SELECT * FROM pending_actions WHERE id=?").bind(`${id}-pending`).first(),
      storage: (await e.DB.prepare("SELECT * FROM staging_objects WHERE user_id=?").bind(id).all()).results,
      keys: (await e.DB.prepare("SELECT * FROM idempotency_keys WHERE user_id=?").bind(id).all()).results,
    });
    const before = await snapshot();
    const statements = ["27", "32", "37", "42"].map((line) =>
      e.DB.prepare(sites.find((s) => s.line === line)!.sql).bind(...(line === "27" ? [Date.now(), id] : [id])),
    );
    if (phase === "legacy") {
      await e.DB.batch(statements);
      const after = await snapshot();
      expect(after.operation).toMatchObject({ state: "failed_safe" });
      expect(after.pending).toMatchObject({ state: "failed", error: "failed_safe" });
      expect(after.storage).toHaveLength(1);
      expect(after.storage[0]).toMatchObject({ reserved_by_operation_id: null, consumed_at: null });
      expect(after.keys).toEqual(before.keys);
    } else {
      await expect(e.DB.batch(statements)).rejects.toThrow("CHECK constraint failed");
      expect(await snapshot()).toEqual(before);
    }
  });
}

const coverage = new LegacyCoverage("cron");
afterAll(() => coverage.verify());
