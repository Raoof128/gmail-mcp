import { expect, it } from "vitest";
import { testEnv } from "./test-env";
import { seedRecovery } from "./recovery-fixtures";
import { claimRecovery } from "../src/operations/recovery-admission";
import { defaultDeps } from "../src/deps";
import { observeDelivery, settleRecovered, verifiesCandidate } from "../src/operations/reconcile";
const e = testEnv();
it("requires unique exact generated identity, SENT, thread and valid time", async () => {
  const b = await seedRecovery(e, "candidate");
  const c = {
    id: "m1",
    threadId: "t1",
    labels: ["SENT"],
    messageIds: [b.generatedMessageId!],
    internalDate: b.startedAt,
  };
  expect(verifiesCandidate(b, c)).toBe(true);
  for (const changed of [
    { labels: [] },
    { messageIds: [b.generatedMessageId!, b.generatedMessageId!] },
    { internalDate: b.startedAt - 120001 },
    { internalDate: NaN },
  ])
    expect(verifiesCandidate(b, { ...c, ...changed })).toBe(false);
  expect(verifiesCandidate({ ...b, executor: "send_draft" }, c)).toBe(false);
  expect(verifiesCandidate({ ...b, threadId: "other" }, c)).toBe(false);
});
it("empty search defers, while qualified exact metadata settles only once", async () => {
  const b = await seedRecovery(e, "observe");
  const now = Date.now();
  const lease = (await claimRecovery(e, b.operationId, Math.floor(now / 300000), now, now + 240000))!;
  const deadlines = { runUntil: now + 240000, attemptUntil: now + 45000, requestUntil: now + 15000 };
  const empty = { ...defaultDeps, googleFetch: () => Promise.resolve(Response.json({ messages: [] })) };
  expect(await observeDelivery(e, empty, b, lease, deadlines)).toMatchObject({ kind: "deferred", reason: "not_found" });
  const positive = {
    ...defaultDeps,
    googleFetch: (input: RequestInfo | URL) =>
      Promise.resolve(
        Response.json(
          (input instanceof Request ? input.url : input.toString()).includes("/messages/m1")
            ? {
                id: "m1",
                threadId: "t1",
                labelIds: ["SENT"],
                internalDate: String(b.startedAt),
                payload: { headers: [{ name: "Message-ID", value: b.generatedMessageId }] },
              }
            : { messages: [{ id: "m1" }] },
        ),
      ),
  };
  const observation = await observeDelivery(e, positive, b, lease, deadlines);
  expect(observation.kind).toBe("confirmed");
  if (observation.kind !== "confirmed") throw new Error("missing proof");
  expect(await settleRecovered(e, b, lease, observation.proof)).toBe("settled");
  expect(await settleRecovered(e, b, lease, observation.proof)).toBe("replayed");
});
it("a disabled epoch fences proof received before disable", async () => {
  const b = await seedRecovery(e, "fenced");
  const now = Date.now();
  const lease = (await claimRecovery(e, b.operationId, Math.floor(now / 300000), now, now + 240000))!;
  await e.DB.prepare("UPDATE recovery_control SET state='disabled' WHERE account_id=?").bind(b.accountId).run();
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
  expect(await e.DB.prepare("SELECT state FROM operations WHERE id=?").bind(b.operationId).first("state")).toBe(
    "executing",
  );
});
