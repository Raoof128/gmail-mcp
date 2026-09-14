import { expect, it } from "vitest";
import { testEnv } from "./test-env";
import { seedRecovery } from "./recovery-fixtures";
import { admitRequest, claimRecovery } from "../src/operations/recovery-admission";
import { cleanupRecovery, recoverDeliveries } from "../src/operations/recovery-cron";
import { defaultDeps } from "../src/deps";
const e = testEnv();
it("three delayed windows share thirty actual-time requests", async () => {
  const now = Date.now();
  let admitted = 0;
  for (let window = 0; window < 3; window++) {
    const b = await seedRecovery(e, `window-${window}`);
    const lease = (await claimRecovery(e, b.operationId, Math.floor(now / 300000) - window, Date.now(), now + 240000))!;
    expect(lease).not.toBeNull();
    for (let i = 0; i < 15; i++)
      if (
        await admitRequest(
          e,
          b,
          lease,
          { requestUntil: now + 15000, attemptUntil: now + 45000, runUntil: now + 240000 },
          i % 2 ? "refresh" : "gmail",
          Date.now(),
        )
      )
        admitted++;
  }
  expect(admitted).toBe(30);
});
it("retention erases session metadata without changing operation truth", async () => {
  const b = await seedRecovery(e, "retained");
  await cleanupRecovery(e, b.startedAt + 604800001);
  expect(
    await e.DB.prepare("SELECT operation_id FROM operation_recovery WHERE operation_id=?").bind(b.operationId).first(),
  ).toBeNull();
  expect(
    await e.DB.prepare("SELECT state,settlement_protocol FROM operations WHERE id=?").bind(b.operationId).first(),
  ).toEqual({ state: "executing", settlement_protocol: 2 });
});
it("scheduled recovery defers absent evidence without another mutation", async () => {
  const b = await seedRecovery(e, "scheduled");
  const methods: string[] = [];
  const deps = {
    ...defaultDeps,
    googleFetch: (_input: RequestInfo | URL, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return Promise.resolve(Response.json({ messages: [] }));
    },
  };
  const now = Date.now();
  const report = await recoverDeliveries(e, deps, now, now);
  expect(report.deferred).toBeGreaterThan(0);
  expect(methods.every((m) => m === "GET")).toBe(true);
  expect(await e.DB.prepare("SELECT state FROM operations WHERE id=?").bind(b.operationId).first("state")).toBe(
    "executing",
  );
  const before = methods.length;
  await recoverDeliveries(e, deps, now, Date.now());
  expect(methods.length).toBe(before);
});
it("filters ineligible rows before applying the due-row limit", async () => {
  const { dueRecoveries } = await import("../src/operations/recovery-cron");
  const blocked = await seedRecovery(e, "older-unqualified");
  const eligible = await seedRecovery(e, "younger-qualified");
  await e.DB.prepare("DELETE FROM recovery_control WHERE user_id=?").bind(blocked.userId).run();
  const now = Date.now();
  const rows = await dueRecoveries(e, now, Math.floor(now / 300000), 1);
  expect(rows.map((r) => r.operation_id)).toEqual([eligible.operationId]);
});
