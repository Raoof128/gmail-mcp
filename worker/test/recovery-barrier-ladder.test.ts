import { describe, expect, it } from "vitest";
import { createWorker } from "../src/index";
import { FakeGoogle } from "./fake-google";
import { mintToken } from "./browser";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import { callTool } from "./mcp-client";
import { testDeps, testEnv } from "./test-env";
import { ingest } from "../src/staging/store";
import { approvePending } from "../src/approval/pending";
import type { Env } from "../src/env";

/**
 * A ladder of failure points from the first mutating request through to the client's reply, each one
 * measured with the same evidence tuple. The rung that matters is the last column: once bytes могли
 * have reached Gmail, no failure anywhere downstream may report failed_safe, because failed_safe is a
 * promise that Gmail did nothing.
 */
const POSITIONS = [
  "headers", // request accepted, before any body byte was read
  "partial-body", // some of the body admitted, then the transport dies
  "provider-commit", // Gmail committed, response never came back
  "response", // response arrived, the settlement transaction fails
  "settlement-statement", // the settlement transaction fails at one chosen statement boundary
  "settlement-commit", // settlement committed, the reply to the client fails
] as const;
/** "none" runs the same harness with no failure at all: the control for the sweep below. */
type Position = (typeof POSITIONS)[number] | "none";

const BODY_SLICE = 64 * 1024;

type Evidence = {
  providerMutations: number;
  requestsMade: number;
  bodyBytesAdmitted: number;
  operation: string | null;
  byteAdmitted: number | null;
  idempotency: string | null;
  auditTotal: number | null;
  auditExecuted: number | null;
  permits: number | null;
  recovery: string | null;
  pending: string | null;
  staged: { reserved: string | null; consumed: number | null } | null;
};

type Options = {
  attachmentBytes?: number;
  injectAt?: number | null;
  /** Minting an mcp token runs a full OAuth flow. The statement sweep does that once and reuses it. */
  token?: string;
};

async function harness(e: Env, name: string, position: Position, options: Options = {}) {
  const g = await FakeGoogle.create();
  const counters = { providerMutations: 0, requestsMade: 0, bodyBytesAdmitted: 0 };
  let armed = false;
  let committed = false;
  let settlementBatches = 0;
  let settlementLength = 0;

  // The DB proxy exists only to fail the settlement transaction, and only for the two rungs that need
  // it. It counts batches issued after the provider commit rather than inspecting SQL, so it cannot
  // accidentally match an earlier transaction.
  const needsProxy = position === "response" || position === "settlement-commit" || position === "settlement-statement";
  const db = new Proxy(e.DB, {
    get(target, key) {
      if (key === "batch" && needsProxy)
        return async (statements: D1PreparedStatement[]) => {
          if (!committed) return target.batch(statements);
          settlementBatches++;
          if (settlementBatches !== 1) return target.batch(statements);
          settlementLength = statements.length;
          if (position === "response") throw new Error("settlement transaction lost");
          if (position === "settlement-statement") {
            const at = options.injectAt ?? 0;
            // The real transaction, with one guaranteed failure spliced in at position `at`. Nothing
            // production is replaced, so a rollback here is the rollback the database would do.
            return await target.batch([
              ...statements.slice(0, at),
              target.prepare("INSERT INTO _assert(x) VALUES(1)"),
              ...statements.slice(at),
            ]);
          }
          const out = await target.batch(statements);
          if (position === "settlement-commit") throw new Error("reply never reached");
          return out;
        };
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const googleFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const mutating =
      armed &&
      url.hostname === "gmail.googleapis.com" &&
      url.pathname.includes("/upload/") &&
      (request.method === "PUT" || url.searchParams.get("uploadType") !== "resumable");
    if (!mutating) return g.fetch(request);
    counters.requestsMade++;
    if (position === "headers") throw new Error("connection reset before the body moved");
    if (position === "partial-body") {
      const reader = request.body!.getReader();
      while (counters.bodyBytesAdmitted < BODY_SLICE) {
        const { done, value } = await reader.read();
        if (done) break;
        counters.bodyBytesAdmitted += value.length;
      }
      await reader.cancel();
      throw new Error("connection reset mid-body");
    }
    const response = await g.fetch(request);
    counters.providerMutations = g.gmail.sent.length;
    counters.bodyBytesAdmitted = Number(request.headers.get("content-length") ?? 0) || counters.bodyBytesAdmitted;
    committed = true;
    if (position === "provider-commit") throw new Error("response lost after the provider committed");
    return response;
  };

  const worker = createWorker(testDeps(g, { googleFetch }));
  const env = testEnv({ DB: db });
  await seedUserAndAccount(e.DB, { userId: "owner-sub", accountId: name, alias: name });
  await seedAccessToken(e, { userId: "owner-sub", accountId: name });
  const token = options.token ?? (await mintToken(worker, env, g, { scope: "mcp" })).accessToken;

  // Above five megabytes the send is resumable, which is the only transport that streams the body and
  // therefore the only one where "partially admitted" is a real state rather than a hypothetical.
  const bytes = new Uint8Array(options.attachmentBytes ?? 6 * 1024 * 1024);
  const handle = (
    await ingest(e, {
      userId: "owner-sub",
      accountId: name,
      direction: "upload",
      filename: "ladder.bin",
      mime: "application/octet-stream",
      length: bytes.length,
      body: new Response(bytes).body!,
    })
  ).handle;
  const args = {
    account: name,
    idempotency_key: `ladder-${name}`,
    to: [`${name}@example.test`],
    subject: "ladder",
    body: "body",
    attachments: [handle],
  };
  const call = (tool: string, input: Record<string, unknown>) => callTool(worker, env, token, tool, input);
  const pending = await call("send_message", args);
  expect(pending.result.status).toBe("pending_approval");
  const pendingId: string = pending.result.action_id;
  await approvePending(e.DB, { id: pendingId, userId: "owner-sub", via: "browser" });
  armed = true;
  return { call, args, pendingId, handle, counters, g, name, token, settlementLength: () => settlementLength };
}

async function evidence(e: Env, o: { pendingId: string; handle: string; name: string; counters: Evidence }) {
  const pending = await e.DB.prepare("SELECT state,error,operation_id FROM pending_actions WHERE id=?")
    .bind(o.pendingId)
    .first<{ state: string; error: string | null; operation_id: string | null }>();
  const id = pending?.operation_id ?? null;
  const one = async (sql: string, ...binds: unknown[]) =>
    id === null
      ? null
      : await e.DB.prepare(sql)
          .bind(...binds)
          .first<number>("n");
  const op =
    id === null
      ? null
      : await e.DB.prepare("SELECT state,byte_admitted FROM operations WHERE id=?")
          .bind(id)
          .first<{ state: string; byte_admitted: number }>();
  const staged = await e.DB.prepare(
    "SELECT reserved_by_operation_id r,consumed_at c FROM staging_objects WHERE handle=?",
  )
    .bind(o.handle)
    .first<{ r: string | null; c: number | null }>();
  return {
    providerMutations: o.counters.providerMutations,
    requestsMade: o.counters.requestsMade,
    bodyBytesAdmitted: o.counters.bodyBytesAdmitted,
    operation: op?.state ?? null,
    byteAdmitted: op?.byte_admitted ?? null,
    idempotency: await e.DB.prepare("SELECT key FROM idempotency_keys WHERE key=? AND account_id=?")
      .bind(`ladder-${o.name}`, o.name)
      .first<string>("key"),
    auditTotal: await one("SELECT count(*) n FROM audit_log WHERE operation_id=?", id),
    auditExecuted: await one("SELECT count(*) n FROM audit_log WHERE operation_id=? AND decision='executed'", id),
    permits: await one("SELECT count(*) n FROM settlement_permits WHERE operation_id=?", id),
    recovery:
      id === null
        ? null
        : await e.DB.prepare("SELECT state FROM operation_recovery WHERE operation_id=?")
            .bind(id)
            .first<string>("state"),
    pending: pending?.state ?? null,
    pendingError: pending?.error ?? null,
    staged: staged ? { reserved: staged.r, consumed: staged.c } : null,
    operationId: id,
  };
}

describe("the failure ladder from first mutating request to client reply", () => {
  for (const position of POSITIONS.filter((p) => p !== "settlement-statement"))
    it(`${position}: never reports failed_safe and never mutates twice`, async () => {
      const e = testEnv();
      const h = await harness(e, `ld-${position}`, position);
      const result = await h.call("execute_pending", { action_id: h.pendingId });
      const ev = await evidence(e, { ...h, counters: h.counters as unknown as Evidence });

      // The rung was actually reached. Without this the rest of the case is unfalsifiable.
      expect(ev.requestsMade).toBe(1);
      expect(ev.operationId).not.toBeNull();

      // The load-bearing claim. Byte admission is declared before the request, so every rung here is
      // downstream of it and failed_safe must be unreachable at all of them.
      expect(ev.byteAdmitted).toBe(1);
      expect(ev.operation).not.toBe("failed_safe");
      // A pending row does legitimately reach state 'failed'; the error code is what carries the
      // claim. It must never say the send was safe when bytes had already been admitted.
      expect(ev.pendingError).not.toBe("failed_safe");
      if (ev.operation === "delivery_unknown") expect(ev.pendingError).toBe("delivery_unknown");

      // Exactly one provider mutation, and a replay adds none.
      const sentAfterFirst = h.g.gmail.sent.length;
      const replay = await h.call("send_message", h.args);
      expect(h.g.gmail.sent.length).toBe(sentAfterFirst);
      expect(h.counters.requestsMade).toBe(1);
      expect(replay.result.operation_id ?? replay.result.details?.operation_id).toBe(ev.operationId);

      if (position === "headers" || position === "partial-body") {
        // Gmail never assembled a message, but the Worker cannot know that, so the answer is unknown.
        expect(sentAfterFirst).toBe(0);
        expect(result.result.error).toBe("delivery_unknown");
        expect(ev.operation).toBe("delivery_unknown");
        expect(ev.auditExecuted).toBe(0);
        expect(ev.permits).toBe(0);
        expect(ev.staged).toMatchObject({ consumed: null });
        if (position === "partial-body") expect(ev.bodyBytesAdmitted).toBeGreaterThanOrEqual(BODY_SLICE);
      } else if (position === "provider-commit") {
        expect(sentAfterFirst).toBe(1);
        expect(result.result.error).toBe("delivery_unknown");
        expect(ev.operation).toBe("delivery_unknown");
        expect(ev.auditExecuted).toBe(0);
        expect(ev.permits).toBe(0);
      } else if (position === "response") {
        // Gmail has it and the Worker knows, so the client is told executed even though nothing local
        // settled. Reporting a failure here would invite a retry of a delivered message.
        expect(sentAfterFirst).toBe(1);
        expect(result.result.status).toBe("executed");
        expect(result.result.local_settlement_failed).toBe(true);
        expect(ev.operation).toBe("executing");
        expect(ev.auditExecuted).toBe(0);
        expect(ev.permits).toBe(0);
        expect(ev.recovery).toBe("active");
        expect(ev.staged).toMatchObject({ consumed: null });
      } else {
        // The settlement landed; only the reply was lost. The operation is executed and the replay is
        // answered from the stored result.
        expect(sentAfterFirst).toBe(1);
        expect(result.result.status).toBe("executed");
        expect(ev.operation).toBe("executed");
        expect(ev.auditExecuted).toBe(1);
        expect(ev.permits).toBe(0);
        expect(ev.recovery).toBe("completed");
        expect(ev.pending).toBe("executed");
        expect(ev.staged).toMatchObject({ reserved: null });
        expect(ev.staged?.consumed).not.toBeNull();
        expect(replay.result.status).toBe("executed");
      }
    });
});

const SWEEP_TIMEOUT_MS = 30_000;
/**
 * Every statement boundary inside the settlement transaction, driven through the gate rather than by
 * calling settleDirect, so the client-observable result is part of the evidence. A small attachment
 * keeps this on the single-request transport: the rung being tested is local, not the upload.
 *
 * The explicit timeout is the exception the notes allow rather than the contention mask they forbid.
 * This case runs one complete end-to-end send per statement boundary, so its true cost scales with the
 * number of boundaries while the five second default is a single-unit-test budget. CI measured nine
 * seconds at the default before mintToken was hoisted out of the loop; the ceiling is headroom over
 * the measured cost of the sweep.
 */
it(
  "rolls the settlement back at every statement boundary while Gmail keeps the message",
  async () => {
    const e = testEnv();
    const probe = await harness(e, "ld-stmt-0", "settlement-statement", { attachmentBytes: 2048, injectAt: 0 });
    await probe.call("execute_pending", { action_id: probe.pendingId });
    const length = probe.settlementLength();
    expect(length).toBeGreaterThan(5);

    for (let at = 0; at <= length; at++) {
      const h = await harness(e, `ld-stmt-${at + 1}`, "settlement-statement", {
        attachmentBytes: 2048,
        injectAt: at,
        token: probe.token,
      });
      const result = await h.call("execute_pending", { action_id: h.pendingId });
      const ev = await evidence(e, { ...h, counters: h.counters as unknown as Evidence });

      expect(h.g.gmail.sent.length).toBe(1);
      expect(ev.requestsMade).toBe(1);
      expect(ev.byteAdmitted).toBe(1);

      // Nothing local landed, and nothing claims the send was safe.
      expect(ev.operation).toBe("executing");
      expect(ev.auditExecuted).toBe(0);
      expect(ev.permits).toBe(0);
      expect(ev.pending).toBe("executing");
      expect(ev.pendingError).toBeNull();
      expect(ev.staged).toMatchObject({ consumed: null });

      // The client is told the send happened, because it did.
      expect(result.result.status).toBe("executed");
      expect(result.result.local_settlement_failed).toBe(true);
    }

    // The same transaction with nothing spliced in settles exactly once.
    const clean = await harness(e, "ld-stmt-clean", "none", { attachmentBytes: 2048, token: probe.token });
    const ok = await clean.call("execute_pending", { action_id: clean.pendingId });
    expect(ok.result.status).toBe("executed");
    const ev = await evidence(e, { ...clean, counters: clean.counters as unknown as Evidence });
    expect(ev.operation).toBe("executed");
    expect(ev.auditExecuted).toBe(1);
    expect(ev.permits).toBe(0);
    expect(ev.staged).toMatchObject({ reserved: null });
    expect(ev.staged?.consumed).not.toBeNull();
  },
  SWEEP_TIMEOUT_MS,
);
