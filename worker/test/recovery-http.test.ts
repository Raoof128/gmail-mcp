import { expect, it } from "vitest";
import { testEnv } from "./test-env";
import { seedRecovery } from "./recovery-fixtures";
import { defaultDeps } from "../src/deps";
import { claimRecovery } from "../src/operations/recovery-admission";
import { recoveryRequest, retryAtFor } from "../src/google/recovery-http";
const e = testEnv();
it("persists numeric/date provider lower bounds and ignores invalid headers", () => {
  const now = Date.UTC(2026, 8, 13, 9, 0, 0),
    local = now + 300000;
  expect(retryAtFor("3600", now, 1)).toBe(now + 3600000);
  expect(retryAtFor("Sun, 13 Sep 2026 09:30:00 GMT", now, 1)).toBe(now + 1800000);
  for (const h of [null, "bad", "-1", "99999999999999999999999", "Sun, 13 Sep 2026 08:00:00 GMT"])
    expect(retryAtFor(h, now, 1)).toBe(local);
});
it("refuses network on stale qualification and accounts for actual admitted requests", async () => {
  const b = await seedRecovery(e, "http-budget");
  const now = Date.now();
  const lease = await claimRecovery(e, b.operationId, Math.floor(now / 300000), now, now + 240000);
  expect(lease).not.toBeNull();
  let calls = 0;
  const deps = {
    ...defaultDeps,
    googleFetch: () => {
      calls++;
      return Promise.resolve(Response.json({ messages: [] }));
    },
  };
  const request = {
    kind: "gmail" as const,
    url: `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent("rfc822msgid:" + b.generatedMessageId)}&labelIds=SENT&maxResults=2`,
    init: { method: "GET" },
  };
  const deadlines = { runUntil: now + 240000, attemptUntil: now + 45000, requestUntil: now + 15000 };
  expect((await recoveryRequest(e, deps, b, lease!, deadlines, request)).kind).toBe("response");
  await e.DB.prepare("UPDATE recovery_control SET state='disabled'").run();
  expect((await recoveryRequest(e, deps, b, lease!, deadlines, request)).kind).toBe("suspended");
  expect(calls).toBe(1);
});
it("caps response bytes and deadlines through body EOF", async () => {
  const b = await seedRecovery(e, "http-body");
  const now = Date.now();
  const lease = await claimRecovery(e, b.operationId, Math.floor(now / 300000), now, now + 240000);
  const request = {
    kind: "gmail" as const,
    url: `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent("rfc822msgid:" + b.generatedMessageId)}&labelIds=SENT&maxResults=2`,
    init: { method: "GET" },
  };
  const deadlines = { runUntil: now + 240000, attemptUntil: now + 45000, requestUntil: now + 15000 };
  const oversized = { ...defaultDeps, googleFetch: () => Promise.resolve(new Response(new Uint8Array(65537))) };
  expect((await recoveryRequest(e, oversized, b, lease!, deadlines, request)).kind).toBe("deferred");
  const stalls = {
    ...defaultDeps,
    googleFetch: () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array([1]));
            },
          }),
        ),
      ),
  };
  expect(
    (await recoveryRequest(e, stalls, b, lease!, { ...deadlines, requestUntil: Date.now() + 30 }, request)).kind,
  ).toBe("deferred");
});
