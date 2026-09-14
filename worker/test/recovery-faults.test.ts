import { expect, it } from "vitest";
import { testEnv } from "./test-env";
import { seedRecovery } from "./recovery-fixtures";
import { settleDirect } from "../src/operations/recovery-state";
const receipt = { gmail_result_id: "m1", message: { id: "m1", thread_id: "t1", label_ids: ["SENT"] } };
it("rolls back every settlement statement boundary, then permits exactly one winner", async () => {
  const e = testEnv();
  const b = await seedRecovery(e, "statement-faults");
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
  }
  const outcomes = await Promise.all([
    settleDirect(e, b.operationId, receipt),
    settleDirect(e, b.operationId, receipt),
  ]);
  expect(outcomes.sort()).toEqual(["replayed", "settled"]);
  expect(
    await e.DB.prepare("SELECT count(*) n FROM audit_log WHERE operation_id=? AND decision='executed'")
      .bind(b.operationId)
      .first("n"),
  ).toBe(1);
});
