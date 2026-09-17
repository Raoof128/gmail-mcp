import { describe, it, expect } from "vitest";
import { createWorker } from "../src/index";
import { FakeGoogle } from "./fake-google";
import { mintToken } from "./browser";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import { callTool } from "./mcp-client";
import { testDeps, testEnv } from "./test-env";
import { approvePending } from "../src/approval/pending";

const U = "owner-sub";

/** QA-001: every counter here is asserted non-zero before its consequences are read. */
type Rig = {
  worker: ReturnType<typeof createWorker>;
  e: ReturnType<typeof testEnv>;
  g: FakeGoogle;
  token: string;
  account: string;
  counts: { mutations: number; total: number };
};

async function rig(account: string, intercept: (req: Request, pass: () => Promise<Response>) => Promise<Response>) {
  const e = testEnv();
  const g = await FakeGoogle.create();
  const counts = { mutations: 0, total: 0 };
  const googleFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    counts.total++;
    const mutating =
      url.hostname === "gmail.googleapis.com" &&
      request.method !== "GET" &&
      (url.pathname.includes("/messages/send") || url.pathname.includes("/upload/"));
    if (mutating) counts.mutations++;
    return intercept(request, () => g.fetch(request));
  };
  const worker = createWorker(testDeps(g, { googleFetch }));
  await seedUserAndAccount(e.DB, { userId: U, accountId: account, alias: account });
  await seedAccessToken(e, { userId: U, accountId: account });
  const token = (await mintToken(worker, e, g, { scope: "mcp" })).accessToken;
  return { worker, e, g, token, account, counts };
}

const send = (r: Rig, extra: Record<string, unknown> = {}) =>
  callTool(r.worker, r.e, r.token, "send_message", {
    account: r.account,
    to: ["someone@external.test"],
    subject: "fault",
    body: "b",
    ...extra,
  });

// Storage is isolated per test file, not per test, so every query is scoped to this case's account.
// Filtering on user_id alone counts rows the neighbouring tests in this file created.
const opsOf = (r: Rig) =>
  r.e.DB.prepare("SELECT id, state FROM operations WHERE user_id = ? AND account_id = ?")
    .bind(U, r.account)
    .all<{ id: string; state: string }>();
const auditOf = (r: Rig) =>
  r.e.DB.prepare("SELECT phase, decision FROM audit_log WHERE user_id = ? AND account_id = ?")
    .bind(U, r.account)
    .all<{ phase: string; decision: string }>();

// The design has no production fault selector, so the transport is the earliest point a fault can be
// injected, and beginOperation already ran by then. "Nothing was mutated" is therefore measured by what
// Gmail actually received, not by whether a request was attempted. The companion proof that the row was
// never claimed at that moment lives in operation-state-machine.test.ts.
describe("the transport dies at the first mutating request", () => {
  it("leaves Gmail untouched, records no executed outcome, and puts no second body on the wire", async () => {
    const r = await rig("flt-pre", async (req, pass) => {
      const url = new URL(req.url);
      // Only Gmail is broken. Breaking the identity provider too would fail the login rather than the
      // send, and the test would prove nothing about mutations.
      if (url.hostname === "gmail.googleapis.com") throw new Error("network down before any mutation");
      return pass();
    });
    const asked = await send(r);
    const id = (asked.result as { action_id?: string } | null)?.action_id;
    expect(id).toBeTruthy();
    expect(await approvePending(r.e.DB, { id: id!, userId: U, via: "browser" })).toBe(true);

    const done = await callTool(r.worker, r.e, r.token, "execute_pending", { action_id: id });

    expect(r.counts.total).toBeGreaterThan(0); // the transport really was reached
    expect(r.counts.mutations).toBe(1); // exactly one attempt, so the fault fired where intended
    expect(r.g.gmail.sent.length).toBe(0); // and Gmail received nothing

    const rows = await r.e.DB.prepare(
      "SELECT state, byte_admitted FROM operations WHERE user_id = ? AND account_id = ?",
    )
      .bind(U, r.account)
      .all<{ state: string; byte_admitted: number }>();
    expect(rows.results.length).toBe(1); // the claim opened exactly one
    expect(rows.results[0]!.state).not.toBe("executed");
    // The fixture knows Gmail received nothing. The Worker cannot: once the body was handed to the
    // transport, a thrown fetch looks identical to a commit whose response was lost. So the honest
    // terminal is delivery_unknown, and treating the exception as proof of non-delivery would be the
    // defect. failed_safe stays reserved for byte_admitted = 0.
    expect(rows.results[0]!.byte_admitted).toBe(1);
    expect(rows.results[0]!.state).toBe("delivery_unknown");
    expect(rows.results[0]!.state).not.toBe("failed_safe");

    const audit = await auditOf(r);
    expect(audit.results.length).toBeGreaterThan(0);
    expect(audit.results.some((a) => a.decision === "executed")).toBe(false);
    expect(JSON.stringify(done.result)).not.toMatch(/"status"\s*:\s*"executed"/);
  });
});

describe("a provider commit whose response is lost", () => {
  it("never becomes failed_safe, sends exactly one body, and holds the idempotency key", async () => {
    let committed = 0;
    const r = await rig("flt-lost", async (req, pass) => {
      const url = new URL(req.url);
      const mutating = req.method !== "GET" && url.pathname.includes("/messages/send");
      const response = await pass();
      if (mutating) {
        committed++;
        // Gmail took it; the caller never learns that.
        return new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error("response lost after commit"));
            },
          }),
        );
      }
      return response;
    });

    const asked = await send(r, { idempotency_key: "lost-response-key" });
    const id = (asked.result as { action_id?: string }).action_id;
    expect(id).toBeTruthy();
    expect(await approvePending(r.e.DB, { id: id!, userId: U, via: "browser" })).toBe(true);
    const done = await callTool(r.worker, r.e, r.token, "execute_pending", { action_id: id });

    expect(committed).toBe(1); // the commit really happened
    expect(r.g.gmail.sent.length).toBe(1);
    expect(JSON.stringify(done.result)).toMatch(/delivery_unknown/);

    const rows = await r.e.DB.prepare(
      "SELECT state, byte_admitted FROM operations WHERE user_id = ? AND account_id = ?",
    )
      .bind(U, r.account)
      .all<{ state: string; byte_admitted: number }>();
    expect(rows.results.length).toBe(1);
    // The rule is in recovery-state.ts: failed_safe requires claimed AND byte_admitted = 0. Bytes went
    // out here, so the ambiguous outcome cannot structurally be downgraded to "Gmail did nothing".
    expect(rows.results[0]!.state).not.toBe("failed_safe");
    expect(rows.results[0]!.state).toBe("delivery_unknown");
    expect(rows.results[0]!.byte_admitted).toBe(1);

    // A retry with the same key must not put a second body on the wire.
    const replay = await send(r, { idempotency_key: "lost-response-key" });
    expect(r.g.gmail.sent.length).toBe(1);
    expect(r.counts.mutations).toBe(1);
    expect(JSON.stringify(replay.result)).toMatch(/delivery_unknown|operation/);

    const audit = await auditOf(r);
    expect(audit.results.filter((a) => a.decision === "executed").length).toBe(0);
  });
});

describe("two contenders for one approved action", () => {
  it("produce one external mutation, one terminal result and one executed audit", async () => {
    const r = await rig("flt-race", async (_req, pass) => pass());
    const asked = await send(r);
    const id = (asked.result as { action_id?: string }).action_id;
    expect(id).toBeTruthy();
    expect(await approvePending(r.e.DB, { id: id!, userId: U, via: "browser" })).toBe(true);

    const both = await Promise.all([
      callTool(r.worker, r.e, r.token, "execute_pending", { action_id: id }),
      callTool(r.worker, r.e, r.token, "execute_pending", { action_id: id }),
    ]);

    expect(r.counts.mutations).toBe(1);
    expect(r.g.gmail.sent.length).toBe(1);
    const texts = both.map((b) => JSON.stringify(b.result));
    expect(texts.filter((t) => /"status"\s*:\s*"executed"/.test(t)).length).toBe(1);
    expect(texts.filter((t) => /replay|pending_replayed|not_approved/.test(t)).length).toBe(1);

    const ops = await opsOf(r);
    expect(ops.results.length).toBe(1);
    expect(ops.results[0]!.state).toBe("executed");
    const audit = await auditOf(r);
    expect(audit.results.filter((a) => a.decision === "executed").length).toBe(1);
  });
});
