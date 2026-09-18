import { expect, it } from "vitest";
import { testEnv } from "./test-env";
import { seedRecovery } from "./recovery-fixtures";
import { seedAccessToken } from "./fixtures";
import { claimRecovery } from "../src/operations/recovery-admission";
import { cleanupRecovery, dueRecoveries } from "../src/operations/recovery-cron";
import { observeDelivery, settleRecovered } from "../src/operations/reconcile";
import { upsertAccount } from "../src/google/connect";
import { revokeAccount } from "../src/google/tokens";
import { defaultDeps } from "../src/deps";
import type { Deps } from "../src/deps";
import type { Binding, Observation } from "../src/operations/recovery-types";
import type { Env } from "../src/env";

const e = testEnv();
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

/**
 * A recovery binds one grant epoch for its whole life. These cases move the epoch underneath a
 * recovery that is already mid-flight and require that it stops, rather than finishing its work
 * against whatever grant happens to be current. The inverse matters as much: an ordinary access
 * token refresh is not a new grant and must leave the recovery alone.
 */
type Probe = {
  deps: Deps;
  gets: string[];
  refreshes: number;
  /** Set by whichever leg of the observation the case chose to interrupt. */
  interrupted: number;
};

function probe(
  b: Binding,
  options: { interruptOn?: "list" | "metadata" | "refresh"; onInterrupt?: () => Promise<void> } = {},
) {
  const p: Probe = { deps: defaultDeps, gets: [], refreshes: 0, interrupted: 0 };
  const candidate = { id: "mgrant1", threadId: "tgrant1" };
  p.deps = {
    ...defaultDeps,
    googleFetch: async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        p.refreshes++;
        if (options.interruptOn === "refresh" && options.onInterrupt) {
          p.interrupted++;
          await options.onInterrupt();
        }
        return Response.json({ access_token: "refreshed", expires_in: 3600, token_type: "Bearer" });
      }
      if (!url.startsWith(GMAIL)) return new Response(null, { status: 200 });
      p.gets.push(url);
      const leg = url.includes("?q=") || url.includes("&q=") ? "list" : "metadata";
      if (options.interruptOn === leg && options.onInterrupt) {
        p.interrupted++;
        await options.onInterrupt();
      }
      if (leg === "list") return Response.json({ messages: [{ id: candidate.id }] });
      return Response.json({
        id: candidate.id,
        threadId: candidate.threadId,
        labelIds: ["SENT"],
        internalDate: String(b.startedAt),
        payload: { headers: [{ name: "Message-ID", value: b.generatedMessageId }] },
      });
    },
  };
  return p;
}

/** One cron pass over a single operation: exactly what recoverDeliveries does per due row. */
async function runOnce(
  env: Env,
  deps: Deps,
  b: Binding,
  windowOffset: number,
): Promise<{ observation: Observation | null; settle: string | null }> {
  const now = Date.now();
  const window = Math.floor(now / 300000) - windowOffset;
  const lease = await claimRecovery(env, b.operationId, window, now, now + 240000);
  if (!lease) return { observation: null, settle: null };
  const until = now + 45000;
  const observation = await observeDelivery(env, deps, b, lease, {
    runUntil: now + 240000,
    attemptUntil: until,
    requestUntil: until,
  });
  if (observation.kind !== "confirmed") return { observation, settle: null };
  return { observation, settle: await settleRecovered(env, b, lease, observation.proof) };
}

async function reconnect(env: Env, id: string): Promise<void> {
  await upsertAccount(env, {
    userId: id,
    alias: "recovery",
    googleSub: `sub-${id}`,
    email: "recovery@example.test",
    sendAs: [],
    scopes: "gmail.modify",
    refreshToken: "rt-reconnected",
    accessToken: "at-reconnected",
    accessExpiresAt: Date.now() + 3_600_000,
  });
}

const epoch = (id: string) =>
  e.DB.prepare("SELECT credential_version FROM accounts WHERE id=?").bind(id).first<number>("credential_version");
const boundEpoch = (id: string) =>
  e.DB.prepare("SELECT credential_version FROM operation_recovery WHERE operation_id=?")
    .bind(id)
    .first<number>("credential_version");

async function snapshot(id: string) {
  const one = async (sql: string) => await e.DB.prepare(sql).bind(id).first<number>("n");
  return {
    operation: await e.DB.prepare("SELECT state FROM operations WHERE id=?").bind(id).first<string>("state"),
    executedAudit: await one("SELECT count(*) n FROM audit_log WHERE operation_id=? AND decision='executed'"),
    audit: await one("SELECT count(*) n FROM audit_log WHERE operation_id=?"),
    permits: await one("SELECT count(*) n FROM settlement_permits WHERE operation_id=?"),
    recovery: await e.DB.prepare("SELECT state FROM operation_recovery WHERE operation_id=?")
      .bind(id)
      .first<string>("state"),
  };
}

// The control. Every case below asserts an absence, which proves nothing unless the same harness can
// produce the presence. This is the one run where the grant is left alone.
it("settles a recovery whose grant epoch never moves", async () => {
  const b = await seedRecovery(e, "epoch-control");
  const p = probe(b);
  const { observation, settle } = await runOnce(e, p.deps, b, 0);
  expect(p.gets.length).toBe(2);
  expect(observation?.kind).toBe("confirmed");
  expect(settle).toBe("settled");
  expect(await epoch("epoch-control")).toBe(0);
  expect(await snapshot("epoch-control")).toMatchObject({
    operation: "executed",
    executedAudit: 1,
    permits: 0,
    recovery: "completed",
  });
});

it("refuses the next request when a reconnect moves the epoch mid-observation", async () => {
  const b = await seedRecovery(e, "epoch-midflight");
  const before = await snapshot("epoch-midflight");
  const p = probe(b, { interruptOn: "list", onInterrupt: () => reconnect(e, "epoch-midflight") });
  const { observation, settle } = await runOnce(e, p.deps, b, 1);

  // The trigger fired and the epoch really moved: without both, the refusal below is meaningless.
  expect(p.interrupted).toBe(1);
  expect(await epoch("epoch-midflight")).toBe(1);

  // The second leg was never issued. For a gmail request getAccessTokenPinned runs before the
  // admission gate, so the pinned epoch refuses at token acquisition and the durable budget is
  // never even consulted: reason is account_changed rather than disabled.
  expect(p.gets.length).toBe(1);
  expect(observation).toEqual({ kind: "suspended", reason: "account_changed" });
  expect(settle).toBeNull();
  expect(await snapshot("epoch-midflight")).toEqual(before);
  expect(await boundEpoch("epoch-midflight")).toBe(0);
});

it("fences settlement when the epoch moves after the evidence was already read", async () => {
  const b = await seedRecovery(e, "epoch-settle");
  const before = await snapshot("epoch-settle");
  const p = probe(b, { interruptOn: "metadata", onInterrupt: () => reconnect(e, "epoch-settle") });
  const { observation, settle } = await runOnce(e, p.deps, b, 2);

  expect(p.interrupted).toBe(1);
  expect(await epoch("epoch-settle")).toBe(1);

  // Delivery was genuinely confirmed. The refusal is the identity fence, not absent evidence.
  expect(observation?.kind).toBe("confirmed");
  expect(settle).toBe("fenced");
  expect(await snapshot("epoch-settle")).toEqual(before);
  expect(await boundEpoch("epoch-settle")).toBe(0);

  // And it cannot resume against the replacement grant on any later pass.
  const now = Date.now();
  expect((await dueRecoveries(e, now, Math.floor(now / 300000))).map((r) => r.operation_id)).not.toContain(
    b.operationId,
  );
  expect(await claimRecovery(e, b.operationId, Math.floor(now / 300000) - 3, now, now + 240000)).toBeNull();
  await cleanupRecovery(e, now);
  expect(await snapshot("epoch-settle")).toMatchObject({ operation: "executing", recovery: "suspended" });
});

it("fences a recovery when the owner revokes the grant it was bound to", async () => {
  const b = await seedRecovery(e, "epoch-revoked");
  const before = await snapshot("epoch-revoked");
  const p = probe(b, {
    interruptOn: "metadata",
    onInterrupt: () => revokeAccount(e, defaultDeps, "epoch-revoked", "epoch-revoked"),
  });
  const { observation, settle } = await runOnce(e, p.deps, b, 4);

  expect(p.interrupted).toBe(1);
  expect(await epoch("epoch-revoked")).toBe(1);
  expect(await e.DB.prepare("SELECT status FROM accounts WHERE id='epoch-revoked'").first<string>("status")).toBe(
    "revoked",
  );
  expect(observation?.kind).toBe("confirmed");
  expect(settle).toBe("fenced");
  expect(await snapshot("epoch-revoked")).toEqual(before);
});

// The boring inverse, and the one most likely to be broken by a careless fix to the cases above:
// refreshing an access token is not a new grant.
it("survives an ordinary access token refresh under the same grant", async () => {
  const b = await seedRecovery(e, "epoch-refresh");
  // Force the refresh leg: the cached token is already past the one-minute margin.
  await seedAccessToken(e, { userId: "epoch-refresh", accountId: "epoch-refresh", expiresInMs: 1000 });
  const p = probe(b);
  const { observation, settle } = await runOnce(e, p.deps, b, 5);

  // The refresh actually happened. Otherwise this is just the control test again.
  expect(p.refreshes).toBeGreaterThan(0);
  expect(observation?.kind).toBe("confirmed");
  expect(settle).toBe("settled");
  expect(await epoch("epoch-refresh")).toBe(0);
  expect(await boundEpoch("epoch-refresh")).toBe(0);
  expect(await snapshot("epoch-refresh")).toMatchObject({
    operation: "executed",
    executedAudit: 1,
    recovery: "completed",
  });
});

it("discards a token acquired across a reconnect and never reaches the provider", async () => {
  const b = await seedRecovery(e, "epoch-token");
  const before = await snapshot("epoch-token");
  await seedAccessToken(e, { userId: "epoch-token", accountId: "epoch-token", expiresInMs: 1000 });
  const p = probe(b, { interruptOn: "refresh", onInterrupt: () => reconnect(e, "epoch-token") });
  const { observation, settle } = await runOnce(e, p.deps, b, 6);

  expect(p.interrupted).toBe(1);
  expect(p.refreshes).toBe(1);
  expect(await epoch("epoch-token")).toBe(1);

  // The version-guarded credential write matched nothing, so the fresh token was thrown away and no
  // Gmail request was ever made with it. Three independent guards cover this leg: the zero-row check
  // in guardedWrite, the trailing re-read in checkPinned, and the durable admission fence. Measured
  // by mutation: removing any one of them still refuses, removing all three still refuses but at the
  // admission fence instead, which reports "disabled". The reason is asserted rather than merely the
  // refusal, so a change in which layer stops this is a review event rather than silent drift.
  expect(p.gets).toEqual([]);
  expect(observation).toEqual({ kind: "suspended", reason: "account_changed" });
  expect(settle).toBeNull();
  expect(await snapshot("epoch-token")).toEqual(before);
  expect(await boundEpoch("epoch-token")).toBe(0);

  // The replacement grant's own token is the one that survived, untouched by the stale write.
  expect(
    await e.DB.prepare("SELECT access_expires_at FROM accounts WHERE id='epoch-token'").first<number>(
      "access_expires_at",
    ),
  ).toBeGreaterThan(Date.now() + 3_000_000);
});
