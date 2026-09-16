import { LegacyCoverage } from "./legacy-coverage";
import { afterAll, expect, it } from "vitest";
import { legacyWriterCorpus } from "./fixtures/legacy-writer-corpus";
import { seedRecovery } from "./recovery-fixtures";
import { testEnv } from "./test-env";
import { settleDirect } from "../src/operations/recovery-state";

const sites = legacyWriterCorpus.filter(
  (s) => s.file === "worker/src/tools/settle.ts" || s.file === "worker/src/audit/log.ts",
);
function parameters(file: string, line: string, id: string): unknown[] {
  const now = Date.now();
  if (file.endsWith("audit/log.ts"))
    return [
      now,
      id,
      id,
      "send_message",
      "send.message",
      "[]",
      "outcome",
      "executed",
      `${id}-pending`,
      id,
      "legacy-result",
      "legacy",
      null,
    ];
  switch (Number(line)) {
    case 26:
      return ["legacy-result", "{}", now, id];
    case 31:
    case 75:
      return [id];
    case 36:
    case 70:
      return [now, id];
    case 45:
    case 106:
      return [now, `${id}-pending`];
    case 50:
      return [`${id}-pending`];
    case 80:
      return [id];
    case 89:
      return ["legacy-error", now, `${id}-pending`];
    default:
      throw new Error("unmapped writer site");
  }
}
for (const site of sites) {
  for (const phase of ["before", "after"] as const) {
    it(`executes captured ${site.file}:${site.line} ${phase} a protocol-2 winner`, async () => {
      const e = testEnv();
      const id = `legacy-${site.file.includes("audit") ? "audit" : "settle"}-${site.line}-${phase}`;
      const b = await seedRecovery(e, id, { linked: true });
      if (phase === "after")
        await settleDirect(e, id, {
          gmail_result_id: "winner",
          message: { id: "winner", thread_id: "thread", label_ids: ["SENT"] },
        });
      const snapshot = async () => ({
        operation: await e.DB.prepare("SELECT * FROM operations WHERE id=?").bind(id).first(),
        pending: await e.DB.prepare("SELECT * FROM pending_actions WHERE id=?").bind(b.pendingId).first(),
        storage: (await e.DB.prepare("SELECT * FROM staging_objects WHERE user_id=?").bind(id).all()).results,
        audit: (await e.DB.prepare("SELECT * FROM audit_log WHERE operation_id=? ORDER BY id").bind(id).all()).results,
        key: (await e.DB.prepare("SELECT * FROM idempotency_keys WHERE user_id=?").bind(id).all()).results,
      });
      const initial = await snapshot();
      const statement = e.DB.prepare(site.sql).bind(...parameters(site.file, site.line, id));
      const assertion = site.table === "_assert";
      const noopAfter = phase === "after" && site.verb === "UPDATE";
      const succeeds = noopAfter || (assertion && phase === "after" && site.line !== "75");
      if (succeeds) await statement.run();
      else {
        const refusal =
          site.table === "operations"
            ? "settlement transition permit required"
            : site.table === "pending_actions"
              ? "pending settlement permit required"
              : site.table === "staging_objects"
                ? "staging settlement permit required"
                : site.table === "audit_log"
                  ? "outcome transition permit required"
                  : "CHECK constraint failed";
        await expect(statement.run()).rejects.toThrow(refusal);
      }
      expect(await snapshot()).toEqual(initial);
    });
  }
  it(`executes matched protocol-1 control for ${site.file}:${site.line}`, async () => {
    const e = testEnv();
    const id = `legacy-control-${site.file.includes("audit") ? "audit" : "settle"}-${site.line}`;
    await seedRecovery(e, id, { linked: true, protocol: 1 });
    if (site.table === "_assert") {
      await expect(
        e.DB.prepare(site.sql)
          .bind(...parameters(site.file, site.line, id))
          .run(),
      ).rejects.toThrow(/CHECK constraint failed/i);
      if (site.line === "50")
        await e.DB.prepare("UPDATE pending_actions SET state='executed' WHERE id=?").bind(`${id}-pending`).run();
      else
        await e.DB.prepare("UPDATE operations SET state=? WHERE id=?")
          .bind(site.line === "75" ? "failed_safe" : "executed", id)
          .run();
    }
    const result = await e.DB.prepare(site.sql)
      .bind(...parameters(site.file, site.line, id))
      .run();
    expect(result.success).toBe(true);
    if (site.table !== "_assert") expect(result.meta.changes).toBeGreaterThan(0);
    coverage.record(site);
  });
}
it("keeps duplicate-body site identities and exact immutable SQL digests", async () => {
  expect(legacyWriterCorpus).toHaveLength(136);
  expect(new Set(legacyWriterCorpus.map((s) => `${s.file}:${s.line}:${s.sha256}`)).size).toBe(136);
  for (const site of legacyWriterCorpus) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(site.sql));
    expect(Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, "0")).join("")).toBe(site.sha256);
  }
});
for (const variant of ["success", "failed-safe", "unknown"] as const) {
  for (const state of ["legacy", "before", "after"] as const) {
    it(`executes original ${variant} transaction in ${state} state`, async () => {
      const e = testEnv(),
        id = `legacy-batch-${variant}-${state}`;
      await seedRecovery(e, id, { linked: true, protocol: state === "legacy" ? 1 : 2 });
      if (state === "after")
        await settleDirect(e, id, {
          gmail_result_id: "winner",
          message: { id: "winner", thread_id: "thread", label_ids: ["SENT"] },
        });
      const snapshot = async () => ({
        operation: await e.DB.prepare("SELECT * FROM operations WHERE id=?").bind(id).first(),
        pending: await e.DB.prepare("SELECT * FROM pending_actions WHERE id=?").bind(`${id}-pending`).first(),
        storage: (await e.DB.prepare("SELECT * FROM staging_objects WHERE user_id=?").bind(id).all()).results,
        audit: (await e.DB.prepare("SELECT * FROM audit_log WHERE operation_id=? ORDER BY id").bind(id).all()).results,
        keys: (await e.DB.prepare("SELECT * FROM idempotency_keys WHERE user_id=?").bind(id).all()).results,
      });
      const initial = await snapshot();
      const lines =
        variant === "success"
          ? ["26", "31", "36", "45", "50"]
          : variant === "failed-safe"
            ? ["70", "75", "80", "89"]
            : ["106"];
      const statements = lines.map((line) => {
        const site = sites.find((s) => s.file.endsWith("tools/settle.ts") && s.line === line)!;
        return e.DB.prepare(site.sql).bind(...parameters(site.file, line, id));
      });
      const audit = sites.find((s) => s.file.endsWith("audit/log.ts"))!;
      const auditBinds = parameters(audit.file, audit.line, id);
      auditBinds[7] = variant === "success" ? "executed" : variant === "failed-safe" ? "failed" : "delivery_unknown";
      statements.push(e.DB.prepare(audit.sql).bind(...auditBinds));
      if (state !== "legacy") {
        await expect(e.DB.batch(statements)).rejects.toThrow();
        expect(await snapshot()).toEqual(initial);
      } else {
        await e.DB.batch(statements);
        const final = await snapshot();
        expect(final.pending).toMatchObject({
          state: variant === "success" ? "executed" : "failed",
          payload_json: null,
        });
        expect(final.operation).toMatchObject({
          state: variant === "success" ? "executed" : variant === "failed-safe" ? "failed_safe" : "executing",
        });
        expect(final.audit).toHaveLength(1);
        expect(final.keys).toEqual(initial.keys);
      }
    });
  }
}

const coverage = new LegacyCoverage("settlement");
afterAll(() => coverage.verify());
