import { expect, it } from "vitest";
import { testEnv } from "./test-env";
import { seedRecovery } from "./recovery-fixtures";
import { claimRecovery, recoveryRow } from "../src/operations/recovery-admission";
import { cleanupRecovery, dueRecoveries } from "../src/operations/recovery-cron";
import { observeDelivery, settleRecovered } from "../src/operations/reconcile";
import { defaultDeps } from "../src/deps";
import type { Deps } from "../src/deps";
import type { Binding, Lease, Observation } from "../src/operations/recovery-types";
import type { Env } from "../src/env";

const e = testEnv();
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

/**
 * Administration lands while a recovery is already holding a lease. The lease names the qualification
 * epoch it was admitted under, and every later fence re-reads that epoch from the control row, so an
 * operator who disables the mode or replaces the epoch stops the run in progress rather than only the
 * next one.
 */
function probe(b: Binding, options: { onLeg?: (leg: "list" | "metadata") => Promise<void> } = {}) {
  const p = { gets: [] as string[], interrupted: 0 };
  const deps: Deps = {
    ...defaultDeps,
    googleFetch: async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith(GMAIL)) return new Response(null, { status: 200 });
      p.gets.push(url);
      const leg = url.includes("q=") ? "list" : "metadata";
      if (options.onLeg) {
        p.interrupted++;
        await options.onLeg(leg);
      }
      if (leg === "list") return Response.json({ messages: [{ id: "madm1" }] });
      return Response.json({
        id: "madm1",
        threadId: "tadm1",
        labelIds: ["SENT"],
        internalDate: String(b.startedAt),
        payload: { headers: [{ name: "Message-ID", value: b.generatedMessageId }] },
      });
    },
  };
  return { deps, p };
}

async function attempt(
  env: Env,
  deps: Deps,
  b: Binding,
  windowOffset: number,
): Promise<{ lease: Lease | null; observation: Observation | null; settle: string | null }> {
  const now = Date.now();
  const lease = await claimRecovery(env, b.operationId, Math.floor(now / 300000) - windowOffset, now, now + 240000);
  if (!lease) return { lease: null, observation: null, settle: null };
  const until = now + 45000;
  const observation = await observeDelivery(env, deps, b, lease, {
    runUntil: now + 240000,
    attemptUntil: until,
    requestUntil: until,
  });
  if (observation.kind !== "confirmed") {
    await release(env, b, lease, observation);
    return { lease, observation, settle: null };
  }
  const settle = await settleRecovered(env, b, lease, observation.proof);
  if (settle !== "settled" && settle !== "replayed") await release(env, b, lease, observation);
  return { lease, observation, settle };
}

/** The tail of recoverDeliveries: without it the lease stays live and the next pass cannot claim. */
async function release(env: Env, b: Binding, lease: Lease, observation: Observation): Promise<void> {
  const suspended = observation.kind === "suspended";
  const next = observation.kind === "deferred" ? observation.retryAt : Date.now() + 300000;
  await env.DB.prepare(
    "UPDATE operation_recovery SET state=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL WHERE operation_id=? AND lease_token=? AND state='active'",
  )
    .bind(suspended ? "manual" : "active", next, b.operationId, lease.token)
    .run();
}

const control = (id: string) =>
  e.DB.prepare("SELECT state,epoch FROM recovery_control WHERE user_id=?")
    .bind(id)
    .first<{ state: string; epoch: string }>();

async function snapshot(id: string) {
  const one = async (sql: string) => await e.DB.prepare(sql).bind(id).first<number>("n");
  return {
    operation: await e.DB.prepare("SELECT state FROM operations WHERE id=?").bind(id).first<string>("state"),
    auditExecuted: await one("SELECT count(*) n FROM audit_log WHERE operation_id=? AND decision='executed'"),
    audit: await one("SELECT count(*) n FROM audit_log WHERE operation_id=?"),
    permits: await one("SELECT count(*) n FROM settlement_permits WHERE operation_id=?"),
    recovery: await e.DB.prepare("SELECT state FROM operation_recovery WHERE operation_id=?")
      .bind(id)
      .first<string>("state"),
  };
}

/** What the disable arm of changeQualification writes, applied to the worker's own database. */
async function disableMode(id: string): Promise<void> {
  await e.DB.batch([
    e.DB.prepare("UPDATE recovery_control SET state='disabled',epoch=?,probe_ids='[]' WHERE user_id=?").bind(
      "qe_" + "D".repeat(43),
      id,
    ),
    e.DB.prepare(
      "UPDATE operation_recovery SET session_enc=NULL,session_key_id=NULL,lease_token=NULL,lease_until=NULL,state=CASE WHEN state='completed' THEN state ELSE 'suspended' END WHERE user_id=?",
    ).bind(id),
  ]);
}

/** The epoch-replacement arm: same mode, still enabled, new epoch. */
async function replaceEpoch(id: string): Promise<string> {
  const epoch = "qe_" + "R".repeat(43);
  await e.DB.prepare("UPDATE recovery_control SET epoch=? WHERE user_id=?").bind(epoch, id).run();
  return epoch;
}

it("settles when administration does not interfere", async () => {
  const b = await seedRecovery(e, "adm-control");
  const { deps, p } = probe(b);
  const { observation, settle } = await attempt(e, deps, b, 0);
  expect(p.gets.length).toBe(2);
  expect(observation?.kind).toBe("confirmed");
  expect(settle).toBe("settled");
  expect(await snapshot("adm-control")).toMatchObject({ operation: "executed", auditExecuted: 1, permits: 0 });
});

it("stops a recovery mid-flight when the operator disables the mode", async () => {
  const b = await seedRecovery(e, "adm-disable");
  const before = await snapshot("adm-disable");
  const { deps, p } = probe(b, { onLeg: (leg) => (leg === "list" ? disableMode("adm-disable") : Promise.resolve()) });
  const { lease, observation, settle } = await attempt(e, deps, b, 1);

  expect(lease).not.toBeNull();
  expect(p.interrupted).toBeGreaterThan(0);
  expect((await control("adm-disable"))?.state).toBe("disabled");

  // The second leg is refused, because the qualification fence re-reads the control row per request.
  expect(p.gets.length).toBe(1);
  expect(observation).toEqual({ kind: "suspended", reason: "disabled" });
  expect(settle).toBeNull();
  expect(await snapshot("adm-disable")).toMatchObject({
    operation: before.operation,
    auditExecuted: 0,
    permits: 0,
    recovery: "suspended",
  });

  // And it does not come back.
  const now = Date.now();
  expect((await dueRecoveries(e, now, Math.floor(now / 300000))).map((r) => r.operation_id)).not.toContain(
    b.operationId,
  );
  expect(await claimRecovery(e, b.operationId, Math.floor(now / 300000) - 2, now, now + 240000)).toBeNull();
});

it("invalidates a lease minted under a replaced qualification epoch", async () => {
  const b = await seedRecovery(e, "adm-epoch");
  const before = await snapshot("adm-epoch");
  const original = (await control("adm-epoch"))!.epoch;
  let replaced = "";
  const { deps, p } = probe(b, {
    onLeg: async (leg) => {
      if (leg === "list") replaced = await replaceEpoch("adm-epoch");
    },
  });
  const { lease, observation, settle } = await attempt(e, deps, b, 3);

  // The lease really was minted under the old epoch, and the row really moved.
  expect(lease?.qualificationEpoch).toBe(original);
  expect(replaced).not.toBe(original);
  expect((await control("adm-epoch"))?.epoch).toBe(replaced);
  expect((await control("adm-epoch"))?.state).toBe("enabled");

  // Still enabled, so this is the epoch alone doing the work.
  expect(p.gets.length).toBe(1);
  expect(observation).toEqual({ kind: "suspended", reason: "disabled" });
  expect(settle).toBeNull();

  // Delivery truth is untouched, and nothing settled.
  expect(await snapshot("adm-epoch")).toMatchObject({
    operation: before.operation,
    audit: before.audit,
    auditExecuted: 0,
    permits: 0,
  });

  // The recovery row is the one thing that does change, and it parks at manual rather than retrying.
  // An epoch replacement under a running recovery is treated as an administrative stop, not a
  // transient deferral, so the automatic loop will not pick it up again.
  expect(await snapshot("adm-epoch")).toMatchObject({ recovery: "manual" });
  const now = Date.now();
  expect((await dueRecoveries(e, now, Math.floor(now / 300000))).map((r) => r.operation_id)).not.toContain(
    b.operationId,
  );

  // Re-admitting it is an operator act. Once re-armed, the new epoch is what the lease binds, and the
  // same evidence settles: replacement stops the run without condemning the operation.
  await e.DB.prepare("UPDATE operation_recovery SET state='active',next_attempt_at=0 WHERE operation_id=?")
    .bind(b.operationId)
    .run();
  const fresh = probe(b);
  const second = await attempt(e, fresh.deps, b, 4);
  expect(second.lease?.qualificationEpoch).toBe(replaced);
  expect(second.settle).toBe("settled");
  expect(await snapshot("adm-epoch")).toMatchObject({ operation: "executed", auditExecuted: 1 });
});

it("suspends a recovery whose control row was disabled between cron passes", async () => {
  const b = await seedRecovery(e, "adm-sweep");
  await e.DB.prepare("UPDATE recovery_control SET state='disabled',mode='send_session_status' WHERE user_id=?")
    .bind("adm-sweep")
    .run();
  await cleanupRecovery(e, Date.now());
  expect(await snapshot("adm-sweep")).toMatchObject({ recovery: "suspended", operation: "executing" });
  expect(await recoveryRow(e.DB, b.operationId)).toMatchObject({ lease_token: null, session_enc: null });
});

/**
 * The disable arm writes the control row and suspends the recovery row in one transaction, so in
 * production they always land together. This case separates them on purpose, to find out which of the
 * two is actually refusing. Without it, a regression in the qualification fence would stay hidden
 * behind the row suspension.
 */
it("refuses on the control row alone, before the recovery row is suspended", async () => {
  const b = await seedRecovery(e, "adm-control-only");
  const before = await snapshot("adm-control-only");
  const { deps, p } = probe(b, {
    onLeg: async (leg) => {
      if (leg === "list")
        await e.DB.prepare("UPDATE recovery_control SET state='disabled' WHERE user_id='adm-control-only'").run();
    },
  });
  const { lease, observation, settle } = await attempt(e, deps, b, 5);

  expect(lease).not.toBeNull();
  expect((await control("adm-control-only"))?.state).toBe("disabled");
  // The recovery row is still active at the moment of refusal: only the control row said no.
  expect(p.gets.length).toBe(1);
  expect(observation).toEqual({ kind: "suspended", reason: "disabled" });
  expect(settle).toBeNull();
  expect(await snapshot("adm-control-only")).toMatchObject({
    operation: before.operation,
    auditExecuted: 0,
    permits: 0,
  });
});
