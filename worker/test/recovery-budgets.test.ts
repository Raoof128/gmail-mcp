import { expect, it } from "vitest";
import { testEnv } from "./test-env";
import { seedRecovery } from "./recovery-fixtures";
import { insertOperation } from "./fixtures";
import { beginRecoverableOperation } from "../src/operations/recovery-state";
import { admitRequest, claimRecovery } from "../src/operations/recovery-admission";
import type { Binding, Lease } from "../src/operations/recovery-types";
it("serializes concurrent account/window claims and rolling request credit", async () => {
  const e = testEnv();
  const bindings: Binding[] = [];
  for (let account = 0; account < 3; account++) {
    const b = await seedRecovery(e, `budget-account-${account}`);
    bindings.push(b);
    for (let op = 1; op < 5; op++) {
      const id = `budget-account-${account}-op-${op}`;
      await insertOperation(e.DB, id, b.userId, b.accountId, "claimed");
      const next = { ...b, operationId: id, generatedMessageId: `<${id}@${e.WORKER_HOSTNAME}>`, startedAt: Date.now() };
      await beginRecoverableOperation(e, next, null);
      await e.DB.prepare("UPDATE operation_recovery SET next_attempt_at=0 WHERE operation_id=?").bind(id).run();
      bindings.push(next);
    }
  }
  const now = Date.now(),
    window = Math.floor(now / 300000),
    until = now + 240000;
  const claims = await Promise.all(bindings.map((b) => claimRecovery(e, b.operationId, window, now, until)));
  expect(claims.filter(Boolean)).toHaveLength(6);
  const counts = await e.DB.prepare(
    "SELECT account_id,count(*) n FROM recovery_attempts WHERE window_id=? GROUP BY account_id",
  )
    .bind(window)
    .all<{ account_id: string; n: number }>();
  expect(counts.results.map((r) => r.n)).toEqual([2, 2, 2]);
  expect(await claimRecovery(e, bindings[0]!.operationId, window, now, until)).toBeNull();
  const other = await Promise.all(Array.from({ length: 12 }, (_, i) => seedRecovery(e, `window-cap-${i}`)));
  const later = await Promise.all(other.map((b) => claimRecovery(e, b.operationId, window - 1, now, until)));
  expect(later.filter(Boolean)).toHaveLength(10);
  const first = claims.findIndex(Boolean),
    second = later.findIndex(Boolean);
  const pair: [[Binding, Lease], [Binding, Lease]] = [
    [bindings[first]!, claims[first]!],
    [other[second]!, later[second]!],
  ];
  let admitted = 0;
  for (let i = 0; i < 40; i++) {
    const [b, lease] = pair[i % 2]!;
    if (
      await admitRequest(
        e,
        b,
        lease,
        { runUntil: until, attemptUntil: now + 45000, requestUntil: now + 15000 },
        i % 3 === 0 ? "refresh" : "gmail",
        now,
      )
    )
      admitted++;
  }
  expect(admitted).toBe(30);
  const [b, lease] = pair[0];
  expect(
    await admitRequest(
      e,
      b,
      lease,
      { runUntil: now, attemptUntil: now + 45000, requestUntil: now + 15000 },
      "gmail",
      now,
    ),
  ).toBe(false);
  expect(await e.DB.prepare("SELECT count(*) n FROM recovery_requests").first("n")).toBe(30);
});
