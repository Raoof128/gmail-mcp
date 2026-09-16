import { expect, it } from "vitest";
import { testEnv } from "./test-env";
import { seedRecovery } from "./recovery-fixtures";
import { settleDirect } from "../src/operations/recovery-state";
const receipt = { gmail_result_id: "m1", message: { id: "m1", thread_id: "t1", label_ids: ["SENT"] } };
it("rolls back every settlement statement boundary, then permits exactly one winner", async () => {
  const e = testEnv();
  const b = await seedRecovery(e, "statement-faults", { linked: true });
  const linked = async () => ({
    pending: await e.DB.prepare("SELECT * FROM pending_actions WHERE id=?").bind(b.pendingId).first(),
    key: await e.DB.prepare("SELECT * FROM idempotency_keys WHERE user_id=?").bind(b.userId).first(),
    storage: await e.DB.prepare("SELECT * FROM staging_objects WHERE user_id=?").bind(b.userId).first(),
    recovery: await e.DB.prepare("SELECT * FROM operation_recovery WHERE operation_id=?").bind(b.operationId).first(),
  });
  const initial = await linked();
  expect(initial.pending).not.toBeNull();
  expect(initial.key).not.toBeNull();
  expect(initial.storage).not.toBeNull();
  let count = 0;
  // Inspect the real transaction without replacing any production statement with a test double.
  const capture = new Proxy(e.DB, {
    get(target, key) {
      if (key === "batch")
        return (statements: D1PreparedStatement[]) => {
          count = statements.length;
          return Promise.reject(new Error("capture"));
        };
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(settleDirect(testEnv({ DB: capture }), b.operationId, receipt)).rejects.toThrow();
  expect(count).toBeGreaterThan(5);
  for (let position = 0; position <= count; position++) {
    const db = new Proxy(e.DB, {
      get(target, key) {
        if (key === "batch")
          return (statements: D1PreparedStatement[]) =>
            target.batch([
              ...statements.slice(0, position),
              target.prepare("INSERT INTO _assert(x) VALUES(1)"),
              ...statements.slice(position),
            ]);
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(settleDirect(testEnv({ DB: db }), b.operationId, receipt)).rejects.toThrow();
    expect(await e.DB.prepare("SELECT state FROM operations WHERE id=?").bind(b.operationId).first("state")).toBe(
      "executing",
    );
    expect(
      await e.DB.prepare("SELECT count(*) n FROM audit_log WHERE operation_id=?").bind(b.operationId).first("n"),
    ).toBe(0);
    expect(await e.DB.prepare("SELECT count(*) n FROM settlement_permits").first("n")).toBe(0);
    expect(await linked()).toEqual(initial);
  }
  const outcomes = await Promise.all([
    settleDirect(e, b.operationId, receipt),
    settleDirect(e, b.operationId, receipt),
  ]);
  expect(outcomes.sort()).toEqual(["replayed", "settled"]);
  const finished = await linked();
  expect(finished.pending).toMatchObject({ state: "executed", operation_id: b.operationId, payload_json: null });
  expect(finished.storage).toMatchObject({ reserved_by_operation_id: null, consumed_at: expect.any(Number) });
  expect(finished.key).toEqual(initial.key);
  expect(finished.recovery).toMatchObject({ state: "completed" });
  expect(
    await e.DB.prepare("SELECT count(*) n FROM audit_log WHERE operation_id=? AND decision='executed'")
      .bind(b.operationId)
      .first("n"),
  ).toBe(1);
});
