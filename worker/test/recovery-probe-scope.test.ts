import { afterEach, expect, it, vi } from "vitest";
import { testEnv } from "./test-env";
import { seedRecovery } from "./recovery-fixtures";
import { dueRecoveries, recoverDeliveries } from "../src/operations/recovery-cron";
import { admitRequest, claimRecovery } from "../src/operations/recovery-admission";
import { settleRecovered } from "../src/operations/reconcile";
import { defaultDeps } from "../src/deps";
afterEach(async () => {
  await testEnv().DB.prepare("DELETE FROM recovery_control").run();
});
for (const profile of ["normal", "scratch"] as const) {
  it(`selects and settles only listed ${profile} probes through scheduled zero-body requests`, async () => {
    const e = { ...testEnv(), RECOVERY_PROFILE: profile };
    const b = await seedRecovery(e, `listed-${profile}`);
    await e.DB.prepare("UPDATE recovery_control SET state='probe',probe_ids=? WHERE account_id=?")
      .bind(JSON.stringify([b.operationId]), b.accountId)
      .run();
    const now = Date.now();
    expect((await dueRecoveries(e, now, Math.floor(now / 300000))).map((r) => r.operation_id)).toEqual([b.operationId]);
    const requests: { method: string; body: unknown }[] = [];
    const report = await recoverDeliveries(
      e,
      {
        ...defaultDeps,
        googleFetch: (input, init) => {
          requests.push({ method: init?.method ?? "GET", body: init?.body });
          const url = input instanceof Request ? input.url : String(input);
          return Promise.resolve(
            Response.json(
              url.includes("/messages/m1")
                ? {
                    id: "m1",
                    threadId: "t1",
                    labelIds: ["SENT"],
                    internalDate: String(b.startedAt),
                    payload: { headers: [{ name: "Message-ID", value: b.generatedMessageId }] },
                  }
                : { messages: [{ id: "m1" }] },
            ),
          );
        },
      },
      now,
      now,
    );
    expect(report.confirmed).toBe(1);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.method === "GET" && r.body == null)).toBe(true);
    expect(await e.DB.prepare("SELECT state FROM operations WHERE id=?").bind(b.operationId).first("state")).toBe(
      "executed",
    );
  });
}
it("refuses unlisted, foreign, disabled and expired probe selection", async () => {
  const e = { ...testEnv(), RECOVERY_PROFILE: "normal" as const };
  const b = await seedRecovery(e, "probe-refusal");
  const now = Date.now();
  for (const [state, ids, expiry] of [
    ["probe", ["foreign"], now + 10000],
    ["disabled", [b.operationId], now + 10000],
    ["probe", [b.operationId], now],
  ] as const) {
    await e.DB.prepare("UPDATE recovery_control SET state=?,probe_ids=?,expires_at=? WHERE account_id=?")
      .bind(state, JSON.stringify(ids), expiry, b.accountId)
      .run();
    expect(await dueRecoveries(e, now, Math.floor(now / 300000))).toEqual([]);
    expect(await claimRecovery(e, b.operationId, Math.floor(now / 300000), now, now + 10000)).toBeNull();
  }
});
it("fences a previously admitted probe at exact expiry for refresh, request and settlement", async () => {
  const e = { ...testEnv(), RECOVERY_PROFILE: "normal" as const };
  const b = await seedRecovery(e, "probe-expiry");
  const now = Date.now(),
    expiry = now + 1000;
  await e.DB.prepare("UPDATE recovery_control SET state='probe',probe_ids=?,expires_at=? WHERE account_id=?")
    .bind(JSON.stringify([b.operationId]), expiry, b.accountId)
    .run();
  const lease = await claimRecovery(e, b.operationId, Math.floor(now / 300000), now, now + 20000);
  expect(lease).not.toBeNull();
  if (!lease) throw new Error("missing lease");
  const deadlines = { runUntil: now + 20000, attemptUntil: now + 10000, requestUntil: now + 10000 };
  expect(await admitRequest(e, b, lease, deadlines, "gmail", expiry - 1)).toBe(true);
  for (const time of [expiry, expiry + 1]) {
    expect(await admitRequest(e, b, lease, deadlines, "gmail", time)).toBe(false);
    expect(await admitRequest(e, b, lease, deadlines, "refresh", time)).toBe(false);
  }
  expect(
    await admitRequest(e, b, { ...lease, qualificationEpoch: "qe_" + "Z".repeat(43) }, deadlines, "gmail", expiry - 1),
  ).toBe(false);
  const clock = vi.spyOn(Date, "now").mockReturnValue(expiry);
  try {
    expect(
      await settleRecovered(e, b, lease, {
        kind: "generated_search",
        operationId: b.operationId,
        candidate: {
          id: "m1",
          threadId: "t1",
          labels: ["SENT"],
          messageIds: [b.generatedMessageId!],
          internalDate: b.startedAt,
        },
      }),
    ).toBe("fenced");
  } finally {
    clock.mockRestore();
  }
});
