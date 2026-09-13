import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { PendingApprovalResult } from "@gmail-mcp/shared/schemas";
import { FakeGoogle } from "./fake-google";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import { testDeps, testEnv } from "./test-env";
import { approvePending, denyPending, getPending } from "../src/approval/pending";
import { setPolicy } from "../src/policy/engine";
import { beginOperation } from "../src/operations/journal";
import { GmailApiError } from "../src/google/gmail";
import {
  executePending,
  registerExecutor,
  resumeGated,
  runGated,
  type GateInput,
  type ToolContext,
} from "../src/tools/gate";
import { guarded } from "../src/tools/results";
import { resolveAccount } from "../src/tools/accounts";
import { APPROVAL_STATE_VERSION, type ApprovalState } from "../src/approval/state";
import { hashCanonical, canonicalize } from "../src/crypto/canonical";
import type { Principal } from "../src/auth/principal";

const e = testEnv();
let g: FakeGoogle;
const principal: Principal = { userId: "tg", email: "tg@example.test", scope: "mcp" };
const calls: unknown[] = [];
const staged: string[] = [];

function ctx(
  o: {
    url?: boolean;
    state?: ApprovalState;
    answer?: "accept" | "decline" | "cancel" | "missing";
    deadlineMs?: number;
  } = {},
): ToolContext {
  return {
    env: e,
    deps: testDeps(g, o.deadlineMs ? { approvalWait: { intervalMs: 5, deadlineMs: o.deadlineMs } } : {}),
    principal,
    urlElicitation: o.url ?? false,
    round: {
      requestState: () => o.state,
      answer: () => o.answer ?? "missing",
      mint: (s) => Promise.resolve(`minted:${s.pending_id}`),
    },
  };
}

async function stageUpload(handle: string, size = 10) {
  await env.DB.prepare(
    `INSERT INTO staging_objects (handle, user_id, account_id, direction, r2_key, filename, mime, size, sha256, created_at, expires_at)
     VALUES (?, 'tg', 'ta', 'upload', ?, 'f.pdf', 'application/pdf', ?, 'h', ?, ?)`,
  )
    .bind(handle, `stg/tg/${handle}`, size, Date.now(), Date.now() + 60_000)
    .run();
}
const H = (s: string) => "sh_" + s.padEnd(43, "B");
const run = (t: ToolContext, i: GateInput) => guarded(t, () => runGated(t, i));
const parse = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

/** A send-shaped input. `args` is the client intent; `handles` become the payload's attachments at build time. */
async function input(
  o: {
    args?: Record<string, unknown>;
    handles?: string[];
    key?: string;
    tool?: string;
    action?: GateInput["action"];
    journal?: boolean;
    stage?: boolean;
  } = {},
): Promise<GateInput> {
  const account = await resolveAccount(e, "tg", "main");
  const tool = o.tool ?? "test_send";
  const args = o.args ?? { to: ["x@example.test"] };
  const intentHash = await hashCanonical(canonicalize({ tool, v: 1, account: "main", args }));
  return {
    tool,
    version: 1,
    action: o.action ?? "send.message",
    journal: o.journal ?? true,
    account,
    intentHash,
    idempotencyKey: o.key,
    modifiers: [],
    summary: "To: x@example.test",
    facts: { recipients: 1, attachments: (o.handles ?? []).length },
    build: () => {
      if (o.stage) staged.push("staged");
      return Promise.resolve({ payload: { ...args, attachments: o.handles ?? [] }, handles: o.handles ?? [] });
    },
  };
}

const audit = (pendingId?: string) =>
  env.DB.prepare(
    `SELECT phase, decision, operation_id, pending_id, summary FROM audit_log WHERE user_id = 'tg' ${pendingId ? "AND pending_id = ?" : ""} ORDER BY id`,
  )
    .bind(...(pendingId ? [pendingId] : []))
    .all<{
      phase: string;
      decision: string;
      operation_id: string | null;
      pending_id: string | null;
      summary: string;
    }>();
const opRow = (id: string) =>
  env.DB.prepare("SELECT state, gmail_result_id, result_json, rfc822_message_id FROM operations WHERE id = ?")
    .bind(id)
    .first<any>();

beforeAll(async () => {
  g = await FakeGoogle.create();
  await seedUserAndAccount(env.DB, { userId: "tg", accountId: "ta", alias: "main", isDefault: true });
  await seedUserAndAccount(env.DB, { userId: "tg2", accountId: "tb", alias: "main", isDefault: true });
  await seedAccessToken(e, { userId: "tg", accountId: "ta" });
  registerExecutor("test_send", 1, async (_env, _deps, r) => {
    calls.push(r.payload);
    if (r.payload.fail === "before_open") throw new Error("boom before open");
    if (r.operationId) await beginOperation(env.DB, r.operationId, { rfc822_message_id: "<x@test>" });
    if (r.payload.fail === "after_open") throw new Error("boom after open");
    if (r.payload.fail === "gmail_4xx") throw new GmailApiError(400, "Invalid To header", null);
    return { gmail_result_id: "gm1", echoed: r.payload.to };
  });
  registerExecutor("test_read", 1, (_env, _deps, r) => Promise.resolve({ read: r.payload.q }));
  registerExecutor("test_forgot", 1, () => Promise.resolve({ gmail_result_id: "gmX" }));
});

describe("allow", () => {
  it("builds the payload only after the decision, runs the executor, settles the operation, writes intent and outcome, no pending row", async () => {
    await setPolicy(env.DB, { userId: "tg", accountId: null, action: "send.message", level: "allow" });
    const body = parse(await run(ctx(), await input({ stage: true })));
    expect(body).toMatchObject({
      status: "executed",
      account: "main",
      gmail_result_id: "gm1",
      echoed: ["x@example.test"],
    });
    expect(await opRow(body.operation_id)).toMatchObject({
      state: "executed",
      gmail_result_id: "gm1",
      rfc822_message_id: "<x@test>",
    });
    expect(JSON.parse((await opRow(body.operation_id)).result_json)).toEqual({
      gmail_result_id: "gm1",
      echoed: ["x@example.test"],
    });
    const rows = (await audit()).results.slice(-2);
    expect(rows.map((r) => [r.phase, r.decision])).toEqual([
      ["intent", "allow"],
      ["outcome", "executed"],
    ]);
    expect(rows[1]!.operation_id).toBe(body.operation_id);
    expect(rows[0]!.summary).toBe("recipients=1 attachments=0");
    expect(
      (await env.DB.prepare("SELECT count(*) AS n FROM pending_actions WHERE user_id = 'tg'").first<any>()).n,
    ).toBe(0);
    expect(staged).toEqual(["staged"]);
  });
  it("idempotency: the same key and intent replays the stored result without building or running; a different intent conflicts", async () => {
    staged.length = 0;
    const before = calls.length;
    const a = parse(await run(ctx(), await input({ key: "k1", stage: true })));
    const b = parse(await run(ctx(), await input({ key: "k1", stage: true })));
    expect(calls.length).toBe(before + 1);
    expect(staged).toEqual(["staged"]);
    expect(b).toMatchObject({
      status: "executed",
      replayed: true,
      operation_id: a.operation_id,
      gmail_result_id: "gm1",
      echoed: ["x@example.test"],
    });
    const c = parse(await run(ctx(), await input({ key: "k1", args: { to: ["y@example.test"] } })));
    expect(c).toMatchObject({ error: "idempotency_conflict" });
  });
  it("idempotency survives a consumed attachment: the replay is answered before handles are validated", async () => {
    await stageUpload(H("h1"));
    const a = parse(
      await run(ctx(), await input({ key: "k2", handles: [H("h1")], args: { to: ["x@example.test"], files: ["h1"] } })),
    );
    expect(a.status).toBe("executed");
    const row = await env.DB.prepare(
      "SELECT consumed_at, reserved_by_operation_id FROM staging_objects WHERE handle = ?",
    )
      .bind(H("h1"))
      .first<any>();
    expect(row.consumed_at).not.toBeNull();
    expect(row.reserved_by_operation_id).toBeNull();
    const b = parse(
      await run(ctx(), await input({ key: "k2", handles: [H("h1")], args: { to: ["x@example.test"], files: ["h1"] } })),
    );
    expect(b).toMatchObject({ status: "executed", replayed: true, operation_id: a.operation_id });
    // Without a key, the consumed handle fails the reservation inside the gate batch, which rolls back the operation row too.
    const ops = (await env.DB.prepare("SELECT count(*) AS n FROM operations WHERE user_id = 'tg'").first<any>()).n;
    const c = parse(await run(ctx(), await input({ handles: [H("h1")] })));
    expect(c).toMatchObject({ error: "handle_reserved" });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM operations WHERE user_id = 'tg'").first<any>()).n).toBe(
      ops,
    );
  });
  it("after failed_safe the key is rebound to the fresh operation, and a later replay returns that one", async () => {
    const a = parse(
      await run(ctx(), await input({ key: "k3", args: { to: ["x@example.test"], fail: "before_open" } })),
    );
    expect(a).toMatchObject({ error: "internal" });
    const first = (await env.DB.prepare("SELECT operation_id FROM idempotency_keys WHERE key = 'k3'").first<any>())
      .operation_id;
    expect((await opRow(first)).state).toBe("failed_safe");
    const b = parse(
      await run(ctx(), await input({ key: "k3", args: { to: ["x@example.test"], fail: "before_open" } })),
    );
    expect(b).toMatchObject({ error: "internal" });
    const second = (await env.DB.prepare("SELECT operation_id FROM idempotency_keys WHERE key = 'k3'").first<any>())
      .operation_id;
    expect(second).not.toBe(first);
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM operations WHERE user_id='tg' AND action='send.message' AND state='failed_safe' AND payload_hash = (SELECT payload_hash FROM operations WHERE id = ?)",
        )
          .bind(first)
          .first<any>()
      ).n,
    ).toBe(2);
  });
  it("a failure before the request was opened is failed_safe with handles released; a Gmail 4xx after is failed_safe too; anything else after is delivery_unknown", async () => {
    await stageUpload(H("h2"));
    const r1 = parse(
      await run(ctx(), await input({ handles: [H("h2")], args: { to: ["x@example.test"], fail: "before_open" } })),
    );
    expect(r1).toMatchObject({ error: "internal" });
    expect(
      (
        await env.DB.prepare("SELECT reserved_by_operation_id FROM staging_objects WHERE handle = ?")
          .bind(H("h2"))
          .first<any>()
      ).reserved_by_operation_id,
    ).toBeNull();
    const r2 = parse(
      await run(ctx(), await input({ handles: [H("h2")], args: { to: ["x@example.test"], fail: "gmail_4xx" } })),
    );
    expect(r2).toMatchObject({ error: "gmail_error", details: { status: 400 } });
    expect(r2.message).toContain("Invalid To header");
    expect(
      (
        await env.DB.prepare(
          "SELECT state FROM operations WHERE user_id='tg' ORDER BY created_at DESC LIMIT 1",
        ).first<any>()
      ).state,
    ).toBe("failed_safe");
    expect(
      (
        await env.DB.prepare("SELECT reserved_by_operation_id FROM staging_objects WHERE handle = ?")
          .bind(H("h2"))
          .first<any>()
      ).reserved_by_operation_id,
    ).toBeNull();
    const r3 = parse(
      await run(ctx(), await input({ handles: [H("h2")], args: { to: ["x@example.test"], fail: "after_open" } })),
    );
    expect(r3).toMatchObject({ error: "delivery_unknown" });
    expect(r3.message).toContain("Do not retry automatically");
    expect(await opRow(r3.details.operation_id)).toMatchObject({ state: "executing", rfc822_message_id: "<x@test>" });
    expect(
      (
        await env.DB.prepare("SELECT reserved_by_operation_id FROM staging_objects WHERE handle = ?")
          .bind(H("h2"))
          .first<any>()
      ).reserved_by_operation_id,
    ).toBe(r3.details.operation_id);
    expect((await audit()).results.at(-1)).toMatchObject({ phase: "outcome", decision: "delivery_unknown" });
  });
  it("an executor that never opened its operation is a loud internal error, never a success", async () => {
    const r = parse(await run(ctx(), await input({ tool: "test_forgot", args: { to: ["x@example.test"] } })));
    expect(r).toMatchObject({ error: "internal" });
    expect(
      (
        await env.DB.prepare(
          "SELECT state FROM operations WHERE user_id='tg' ORDER BY created_at DESC LIMIT 1",
        ).first<any>()
      ).state,
    ).toBe("failed_safe");
  });
  it("non-journaled reads run with no operation row and one intent row", async () => {
    const before = (await env.DB.prepare("SELECT count(*) AS n FROM operations WHERE user_id='tg'").first<any>()).n;
    const res = parse(
      await run(ctx(), await input({ tool: "test_read", action: "read.search", journal: false, args: { q: "hi" } })),
    );
    expect(res).toMatchObject({ read: "hi", account: "main" });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM operations WHERE user_id='tg'").first<any>()).n).toBe(
      before,
    );
    expect((await audit()).results.at(-1)).toMatchObject({ phase: "intent", decision: "allow" });
  });
});

describe("deny", () => {
  it("writes one intent row, never builds, never runs the executor", async () => {
    await setPolicy(env.DB, { userId: "tg", accountId: "ta", action: "send.message", level: "deny" });
    staged.length = 0;
    const before = calls.length;
    expect(parse(await run(ctx(), await input({ stage: true })))).toMatchObject({ error: "policy_denied" });
    expect(calls.length).toBe(before);
    expect(staged).toEqual([]);
    expect((await audit()).results.at(-1)).toMatchObject({ phase: "intent", decision: "deny" });
    await setPolicy(env.DB, { userId: "tg", accountId: "ta", action: "send.message", level: "ask" });
  });
});

describe("ask without URL elicitation", () => {
  it("stores the canonical payload with tool and version, the intent hash, holds handles, and answers with the 2.6 shape, all in one batch", async () => {
    await stageUpload(H("h3"));
    const i = await input({ handles: [H("h3")] });
    i.modifiers = ["+attachment"];
    const body = PendingApprovalResult.parse(parse(await run(ctx(), i)));
    expect(body).toMatchObject({
      status: "pending_approval",
      action: "send.message",
      modifiers: ["+attachment"],
      account: "main",
      summary: "To: x@example.test",
    });
    expect(body.approval.url).toBe(`https://gmail-mcp.example.workers.dev/approve/${body.action_id}`);
    const row = (await getPending(env.DB, body.action_id, "tg"))!;
    expect(row.payload_json).toBe(`{"attachments":["${H("h3")}"],"to":["x@example.test"],"tool":"test_send","v":1}`);
    expect(row.intent_hash).toBe(i.intentHash);
    expect(
      (await env.DB.prepare("SELECT expires_at FROM staging_objects WHERE handle = ?").bind(H("h3")).first<any>())
        .expires_at,
    ).toBe(row.expires_at + 5 * 60_000);
    expect((await audit(body.action_id)).results.map((r) => r.decision)).toEqual(["ask"]);
  });
  it("idempotency on the ask path: the same key returns the same pending action, and after execution replays its result", async () => {
    const a = PendingApprovalResult.parse(parse(await run(ctx(), await input({ key: "k4" }))));
    const b = PendingApprovalResult.parse(parse(await run(ctx(), await input({ key: "k4" }))));
    expect(b.action_id).toBe(a.action_id);
    expect(
      (await env.DB.prepare("SELECT count(*) AS n FROM pending_actions WHERE idempotency_key = 'k4'").first<any>()).n,
    ).toBe(1);
    await approvePending(env.DB, { id: a.action_id, userId: "tg", via: "browser" });
    const done = await executePending(ctx(), a.action_id);
    expect(done).toMatchObject({ status: "executed", action_id: a.action_id });
    const c = parse(await run(ctx(), await input({ key: "k4" })));
    expect(c).toMatchObject({
      status: "executed",
      replayed: true,
      operation_id: done.operation_id,
      gmail_result_id: "gm1",
    });
    // A cancelled pending releases the key for a fresh attempt.
    const d = PendingApprovalResult.parse(parse(await run(ctx(), await input({ key: "k5" }))));
    await denyPending(env.DB, { id: d.action_id, userId: "tg" });
    const f = PendingApprovalResult.parse(parse(await run(ctx(), await input({ key: "k5" }))));
    expect(f.action_id).not.toBe(d.action_id);
  });
});

describe("ask with URL elicitation and resume", () => {
  const stateFor = async (id: string, tool = "test_send"): Promise<ApprovalState> => ({
    v: APPROVAL_STATE_VERSION,
    tool,
    pending_id: id,
    account_id: "ta",
    intent_hash: (await getPending(env.DB, id, "tg"))!.intent_hash!,
  });
  const resume = (t: ToolContext, i: GateInput, state: ApprovalState) =>
    guarded(t, () => resumeGated(t, { tool: i.tool, account: i.account, intentHash: i.intentHash, state }));
  it("returns input_required with the approval URL and minted state; the accepted retry waits, then executes, without building again", async () => {
    staged.length = 0;
    const first = await run(ctx({ url: true }), await input({ stage: true }));
    expect(first).toMatchObject({ resultType: "input_required" });
    const ir = first as { inputRequests: Record<string, { params: { url: string } }>; requestState: string };
    const id = ir.inputRequests.approval!.params.url.split("/approve/")[1]!;
    expect(ir.requestState).toBe(`minted:${id}`);
    expect(staged).toEqual(["staged"]);
    const state = await stateFor(id);
    setTimeout(() => void approvePending(env.DB, { id, userId: "tg", via: "elicitation" }), 15);
    const body = parse(await resume(ctx({ url: true, answer: "accept" }), await input({ stage: true }), state));
    expect(body).toMatchObject({ status: "executed", action_id: id, gmail_result_id: "gm1" });
    expect(staged).toEqual(["staged"]);
    expect((await getPending(env.DB, id, "tg"))!).toMatchObject({
      state: "executed",
      payload_json: null,
      summary: "redacted",
    });
    expect((await audit(id)).results.map((r) => [r.phase, r.decision])).toEqual([
      ["intent", "ask"],
      ["outcome", "executed"],
    ]);
  });
  it("a retry whose arguments changed is denied and audited; tampered state is refused; the row stays pending", async () => {
    const first = await run(ctx({ url: true }), await input());
    const id = (first as any).inputRequests.approval.params.url.split("/approve/")[1];
    const good = await stateFor(id);
    const changed = parse(
      await resume(ctx({ url: true, answer: "accept" }), await input({ args: { to: ["evil@example.test"] } }), good),
    );
    expect(changed).toMatchObject({ error: "payload_mismatch" });
    expect((await audit(id)).results.at(-1)).toMatchObject({ phase: "intent", decision: "payload_mismatch" });
    for (const bad of [
      { ...good, account_id: "tb" },
      { ...good, tool: "test_read" },
      { ...good, v: "gmail-mcp:approval:v0" as typeof APPROVAL_STATE_VERSION },
      { ...good, intent_hash: "0".repeat(64) },
      { ...good, pending_id: "pa_" + "Z".repeat(22) },
    ]) {
      const r = parse(await resume(ctx({ url: true, answer: "accept" }), await input(), bad));
      expect(r.error).toMatch(/payload_mismatch|pending_not_approved/);
    }
    expect((await getPending(env.DB, id, "tg"))!.state).toBe("pending");
  });
  it("deadline without approval returns pending_approval and leaves the row pending", async () => {
    const first = await run(ctx({ url: true }), await input());
    const id = (first as any).inputRequests.approval.params.url.split("/approve/")[1];
    const res = parse(
      await resume(ctx({ url: true, answer: "accept", deadlineMs: 30 }), await input(), await stateFor(id)),
    );
    expect(PendingApprovalResult.parse(res).action_id).toBe(id);
    expect((await getPending(env.DB, id, "tg"))!.state).toBe("pending");
  });
  it("a declined elicitation cancels; a denied row surfaces as pending_not_approved", async () => {
    const first = await run(ctx({ url: true }), await input());
    const id = (first as any).inputRequests.approval.params.url.split("/approve/")[1];
    expect(parse(await resume(ctx({ url: true, answer: "decline" }), await input(), await stateFor(id)))).toMatchObject(
      { error: "pending_not_approved" },
    );
    expect((await getPending(env.DB, id, "tg"))!.state).toBe("cancelled");
    const second = await run(ctx({ url: true }), await input());
    const id2 = (second as any).inputRequests.approval.params.url.split("/approve/")[1];
    const st = await stateFor(id2);
    await denyPending(env.DB, { id: id2, userId: "tg" });
    expect(parse(await resume(ctx({ url: true, answer: "accept" }), await input(), st))).toMatchObject({
      error: "pending_not_approved",
    });
  });
});

describe("executePending", () => {
  it("refuses staging approval before claiming it through the MCP executor", async () => {
    const id = await pendingId();
    await env.DB.prepare("UPDATE pending_actions SET action='attachment.stage_upload' WHERE id=?").bind(id).run();
    await approvePending(env.DB, { id, userId: "tg", via: "browser" });
    await expect(executePending(ctx(), id)).rejects.toMatchObject({ code: "pending_not_approved" });
    expect(await getPending(env.DB, id, "tg")).toMatchObject({ state: "approved", operation_id: null });
  });
  async function pendingId(): Promise<string> {
    return parse(await run(ctx(), await input())).action_id as string;
  }
  it("claims, executes, settles in one batch, purges; a second call is a replay", async () => {
    const id = await pendingId();
    await approvePending(env.DB, { id, userId: "tg", via: "browser" });
    const out = await executePending(ctx(), id);
    expect(out).toMatchObject({ status: "executed", action_id: id, gmail_result_id: "gm1" });
    expect((await getPending(env.DB, id, "tg"))!).toMatchObject({ state: "executed", payload_json: null });
    expect((await opRow(out.operation_id as string)).state).toBe("executed");
    await expect(executePending(ctx(), id)).rejects.toMatchObject({ code: "pending_replayed" });
    await expect(
      executePending({ ...ctx(), principal: { userId: "tg2", email: "x", scope: "mcp" } }, id),
    ).rejects.toMatchObject({ code: "pending_not_approved" });
  });
  it("a policy tightened to deny between approval and execution wins", async () => {
    const id = await pendingId();
    await approvePending(env.DB, { id, userId: "tg", via: "browser" });
    await setPolicy(env.DB, { userId: "tg", accountId: "ta", action: "send.message", level: "deny" });
    await expect(executePending(ctx(), id)).rejects.toMatchObject({ code: "policy_denied" });
    await setPolicy(env.DB, { userId: "tg", accountId: "ta", action: "send.message", level: "ask" });
    const row = (await getPending(env.DB, id, "tg"))!;
    expect(row).toMatchObject({ state: "failed", error: "policy_denied", payload_json: null });
    expect((await opRow(row.operation_id!)).state).toBe("failed_safe");
    expect((await audit(id)).results.at(-1)).toMatchObject({ phase: "outcome", decision: "denied" });
  });
  it("a payload whose executor version moved on is refused, never run", async () => {
    const id = await pendingId();
    await env.DB.prepare(
      "UPDATE pending_actions SET payload_json = replace(payload_json, '\"v\":1', '\"v\":0') WHERE id = ?",
    )
      .bind(id)
      .run();
    await approvePending(env.DB, { id, userId: "tg", via: "browser" });
    const before = calls.length;
    await expect(executePending(ctx(), id)).rejects.toMatchObject({ code: "payload_mismatch" });
    expect(calls.length).toBe(before);
    expect((await getPending(env.DB, id, "tg"))!.state).toBe("failed");
  });
  it("an unapproved or expired row cannot be executed; a needs_reconnect account refuses before claiming", async () => {
    const id = await pendingId();
    await expect(executePending(ctx(), id)).rejects.toMatchObject({ code: "pending_not_approved" });
    await env.DB.prepare("UPDATE pending_actions SET state = 'approved', expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, id)
      .run();
    await expect(executePending(ctx(), id)).rejects.toMatchObject({ code: "pending_expired" });
    const id2 = await pendingId();
    await approvePending(env.DB, { id: id2, userId: "tg", via: "browser" });
    await env.DB.prepare("UPDATE accounts SET status = 'needs_reconnect' WHERE id = 'ta'").run();
    await expect(executePending(ctx(), id2)).rejects.toMatchObject({ code: "account_needs_reconnect" });
    expect((await getPending(env.DB, id2, "tg"))!.state).toBe("approved");
    await env.DB.prepare("UPDATE accounts SET status = 'active' WHERE id = 'ta'").run();
  });
});
