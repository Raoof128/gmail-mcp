import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index";
import { FakeGoogle } from "./fake-google";
import { mintToken } from "./browser";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import { callTool } from "./mcp-client";
import { testDeps, testEnv } from "./test-env";
import { ingest } from "../src/staging/store";
import { setPolicy } from "../src/policy/engine";
import { approvePending, getPending } from "../src/approval/pending";

const e = testEnv();
let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
let token: string;
const gm = () => g.gmail;
const call = (name: string, args: Record<string, unknown>) => callTool(worker, e, token, name, args);
const stagingCount = async () =>
  (await env.DB.prepare("SELECT count(*) AS n FROM staging_objects").first<any>()).n as number;
async function stage(name: string, bytes: Uint8Array) {
  return (
    await ingest(e, {
      userId: "owner-sub",
      accountId: "sa",
      direction: "upload",
      filename: name,
      mime: "application/octet-stream",
      length: bytes.byteLength,
      body: new Response(bytes).body!,
    })
  ).handle;
}
const lastRaw = () => new TextDecoder().decode(gm().sent.at(-1)!.raw);

beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker(testDeps(g));
  await seedUserAndAccount(env.DB, {
    userId: "owner-sub",
    accountId: "sa",
    alias: "uni",
    isDefault: true,
    orgDomains: ["uni.test"],
  });
  await seedAccessToken(e, { userId: "owner-sub", accountId: "sa" });
  await env.DB.prepare(
    "INSERT INTO contact_allowlist (user_id, account_id, pattern) VALUES ('owner-sub', 'sa', 'friend@example.test')",
  ).run();
  token = (await mintToken(worker, e, g, { scope: "mcp" })).accessToken;
});

describe("send_message", () => {
  it("asks by default with modifiers from trust and attachments, and the 2.6 summary", async () => {
    const h = await stage("thesis.pdf", new Uint8Array(2 * 1024 * 1024));
    const r = await call("send_message", {
      account: "uni",
      to: ["prof@uni.test"],
      cc: ["stranger@else.test"],
      subject: "Thesis draft",
      body: "see attached",
      attachments: [h],
    });
    expect(r.result).toMatchObject({ status: "pending_approval", action: "send.message", account: "uni" });
    expect(r.result.modifiers.sort()).toEqual(["+attachment", "+external"]);
    expect(r.result.summary).toBe(
      "To: prof@uni.test · Cc: stranger@else.test · Subject: Thesis draft · 1 attachment (thesis.pdf, 2.0 MB)",
    );
    expect(gm().sent).toHaveLength(0);
    const row = (await getPending(env.DB, r.result.action_id, "owner-sub"))!;
    expect(JSON.parse(row.payload_json!)).toMatchObject({
      tool: "send_message",
      v: 1,
      to: ["prof@uni.test"],
      attachments: [h],
      from: "uni@example.test",
    });
    expect(row.intent_hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("trusted recipients only, no attachments: no modifiers; +bulk above 10 distinct", async () => {
    const r = await call("send_message", {
      account: "uni",
      to: ["prof@uni.test", "friend@example.test", "uni@example.test"],
      subject: "s",
      body: "b",
    });
    expect(r.result.modifiers).toEqual([]);
    const bulk = await call("send_message", {
      account: "uni",
      to: Array.from({ length: 11 }, (_, i) => `p${i}@uni.test`),
      subject: "s",
      body: "b",
    });
    expect(bulk.result.modifiers).toEqual(["+bulk"]);
  });
  it("idempotency on the ask path: the same key returns the same pending action; after approval and execution, it replays", async () => {
    const a = await call("send_message", {
      account: "uni",
      to: ["prof@uni.test"],
      subject: "k",
      body: "b",
      idempotency_key: "ask-1",
    });
    const b = await call("send_message", {
      account: "uni",
      to: ["prof@uni.test"],
      subject: "k",
      body: "b",
      idempotency_key: "ask-1",
    });
    expect(b.result.action_id).toBe(a.result.action_id);
    await approvePending(env.DB, { id: a.result.action_id, userId: "owner-sub", via: "browser" });
    const done = await call("execute_pending", { action_id: a.result.action_id });
    expect(done.result.status).toBe("executed");
    const c = await call("send_message", {
      account: "uni",
      to: ["prof@uni.test"],
      subject: "k",
      body: "b",
      idempotency_key: "ask-1",
    });
    expect(c.result).toMatchObject({
      status: "executed",
      replayed: true,
      operation_id: done.result.operation_id,
      message: { id: done.result.message.id },
    });
    expect(gm().sent.filter((s) => s.id === done.result.message.id)).toHaveLength(1);
    const d = await call("send_message", {
      account: "uni",
      to: ["other@uni.test"],
      subject: "k",
      body: "b",
      idempotency_key: "ask-1",
    });
    expect(d.result).toMatchObject({ error: "idempotency_conflict" });
  });
  it("sends via media upload with our Message-ID, journals, consumes handles, and replays the key even though the handle is now consumed", async () => {
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "sa", action: "send.message", level: "allow" });
    const h = await stage("notes.txt", new Uint8Array(new TextEncoder().encode("notes")));
    const args = {
      account: "uni",
      to: ["Prof <prof@uni.test>"],
      subject: "Hi 🚀",
      body: "hello",
      html_body: "<b>hello</b>",
      attachments: [h],
      idempotency_key: "send-1",
    };
    // An attachment raises allow to ask (invariant 4), so the send still goes through an approval.
    const asked = await call("send_message", args);
    expect(asked.result.status).toBe("pending_approval");
    await approvePending(env.DB, { id: asked.result.action_id, userId: "owner-sub", via: "browser" });
    const r = await call("execute_pending", { action_id: asked.result.action_id });
    expect(r.result).toMatchObject({
      status: "executed",
      account: "uni",
      message: { id: expect.stringMatching(/^m/), thread_id: expect.any(String) },
    });
    const raw = lastRaw();
    expect(raw).toContain(`Message-ID: <${r.result.operation_id}@gmail-mcp.example.workers.dev>`);
    expect(raw).toContain("From: <uni@example.test>");
    expect(raw).toContain('To: "Prof" <prof@uni.test>');
    expect(raw).toContain("Subject: =?UTF-8?B?SGkg8J+agA==?=");
    expect(raw).toContain("multipart/alternative");
    expect(raw).toContain('filename="notes.txt"');
    const op = await env.DB.prepare(
      "SELECT state, rfc822_message_id, gmail_result_id, result_json FROM operations WHERE id = ?",
    )
      .bind(r.result.operation_id)
      .first<any>();
    expect(op).toMatchObject({
      state: "executed",
      rfc822_message_id: `<${r.result.operation_id}@gmail-mcp.example.workers.dev>`,
      gmail_result_id: r.result.message.id,
    });
    expect(JSON.parse(op.result_json)).toEqual({ gmail_result_id: r.result.message.id, message: r.result.message });
    expect(
      (await env.DB.prepare("SELECT consumed_at FROM staging_objects WHERE handle = ?").bind(h).first<any>())
        .consumed_at,
    ).not.toBeNull();
    const again = await call("send_message", args);
    expect(again.result).toMatchObject({
      status: "executed",
      replayed: true,
      operation_id: r.result.operation_id,
      message: { id: r.result.message.id },
    });
    expect(gm().sent.filter((s) => s.id === r.result.message.id)).toHaveLength(1);
    const outcome = await env.DB.prepare(
      "SELECT decision, gmail_result_id, summary FROM audit_log WHERE user_id='owner-sub' AND tool='send_message' AND phase='outcome' ORDER BY id DESC LIMIT 1",
    ).first<any>();
    expect(outcome).toEqual({
      decision: "executed",
      gmail_result_id: r.result.message.id,
      summary: "recipients=1 attachments=1",
    });
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "sa", action: "send.message", level: "ask" });
  });
  it("inline attachments: a replay stages nothing the second time", async () => {
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "sa", action: "send.message", level: "allow" });
    const args = {
      account: "uni",
      to: ["prof@uni.test"],
      subject: "inline",
      body: "b",
      inline_attachments: [{ filename: "i.txt", mime: "text/plain", content_base64: btoa("inline") }],
      idempotency_key: "inline-1",
    };
    const before = await stagingCount();
    // Inline bytes are an attachment, so they raise allow to ask; they are staged once, at build time.
    const asked = await call("send_message", args);
    expect(asked.result.status).toBe("pending_approval");
    expect(await stagingCount()).toBe(before + 1);
    await approvePending(env.DB, { id: asked.result.action_id, userId: "owner-sub", via: "browser" });
    const a = await call("execute_pending", { action_id: asked.result.action_id });
    expect(a.result.status).toBe("executed");
    expect(await stagingCount()).toBe(before + 1);
    const b = await call("send_message", args);
    expect(b.result).toMatchObject({ status: "executed", replayed: true, operation_id: a.result.operation_id });
    expect(await stagingCount()).toBe(before + 1);
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "sa", action: "send.message", level: "ask" });
  });
  it("Gmail rejecting the message after approval is failed_safe and the error is verbatim", async () => {
    const r = await call("send_message", { account: "uni", to: ["prof@uni.test"], subject: "s", body: "b" });
    await approvePending(env.DB, { id: r.result.action_id, userId: "owner-sub", via: "browser" });
    gm().faults.push({ status: 400, message: "Recipient address required" });
    const done = await call("execute_pending", { action_id: r.result.action_id });
    expect(done.result).toMatchObject({ error: "gmail_error" });
    expect(done.result.message).toContain("Recipient address required");
    const row = (await getPending(env.DB, r.result.action_id, "owner-sub"))!;
    expect(row).toMatchObject({ state: "failed", error: "gmail_error" });
    expect(
      (await env.DB.prepare("SELECT state FROM operations WHERE id = ?").bind(row.operation_id).first<any>()).state,
    ).toBe("failed_safe");
  });
  it("a 503 after the body was opened is delivery_unknown and the operation stays executing for the cron", async () => {
    const r = await call("send_message", { account: "uni", to: ["prof@uni.test"], subject: "s", body: "b" });
    await approvePending(env.DB, { id: r.result.action_id, userId: "owner-sub", via: "browser" });
    gm().faults.push({ status: 503 });
    const done = await call("execute_pending", { action_id: r.result.action_id });
    expect(done.result).toMatchObject({ error: "delivery_unknown", details: { operation_id: expect.any(String) } });
    expect(done.result.message).toContain("Do not retry automatically");
    expect(
      (
        await env.DB.prepare("SELECT state FROM operations WHERE id = ?")
          .bind(done.result.details.operation_id)
          .first<any>()
      ).state,
    ).toBe("executing");
    expect((await getPending(env.DB, r.result.action_id, "owner-sub"))!).toMatchObject({
      state: "failed",
      error: "delivery_unknown",
    });
  });
  it("needs at least one recipient and refuses a foreign sender", async () => {
    expect((await call("send_message", { account: "uni", subject: "s", body: "b" })).result).toMatchObject({
      error: "invalid_address",
    });
    expect(
      (await call("send_message", { account: "uni", to: ["prof@uni.test"], from: "x@y.test", body: "b" })).result,
    ).toMatchObject({ error: "invalid_address" });
  });
});

describe("reply", () => {
  it("derives thread, subject, In-Reply-To and References; Reply-To lists win over From; reply_all adds the rest minus self", async () => {
    const t = gm().seedMessage({
      from: "Prof <prof@uni.test>",
      to: ["uni@example.test", "peer@uni.test"],
      cc: ["cc@else.test"],
      subject: "Re: Thesis",
      text: "q",
      messageId: "<q1@uni.test>",
      references: "<root@uni.test>",
      replyTo: '"Office, Dean" <office@uni.test>, ta@uni.test',
    });
    const r = await call("reply", { account: "uni", message_id: t.id, body: "a" });
    expect(r.result).toMatchObject({ status: "pending_approval", modifiers: [] });
    const p = JSON.parse((await getPending(env.DB, r.result.action_id, "owner-sub"))!.payload_json!);
    expect(p).toMatchObject({
      tool: "reply",
      message_id: t.id,
      thread_id: t.threadId,
      subject: "Re: Thesis",
      in_reply_to: "<q1@uni.test>",
      references: "<root@uni.test> <q1@uni.test>",
      // The display name is dropped rather than sent: the address grammar refuses a quoted comma.
      to: ["office@uni.test", "ta@uni.test"],
      cc: [],
      bcc: [],
    });
    const all = await call("reply", {
      account: "uni",
      message_id: t.id,
      body: "a",
      reply_all: true,
      bcc: ["me2@uni.test"],
    });
    const pa = JSON.parse((await getPending(env.DB, all.result.action_id, "owner-sub"))!.payload_json!);
    expect(pa.to).toEqual(["office@uni.test", "ta@uni.test", "peer@uni.test"]);
    expect(pa.cc).toEqual(["cc@else.test"]);
    expect(pa.bcc).toEqual(["me2@uni.test"]);
    expect(all.result.modifiers).toEqual(["+external"]);
  });
  it("once allowed, the sent message lands in the original thread", async () => {
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "sa", action: "send.message", level: "allow" });
    const t = gm().seedMessage({
      from: "prof@uni.test",
      to: ["uni@example.test"],
      subject: "Q",
      text: "q",
      messageId: "<q2@uni.test>",
    });
    const r = await call("reply", { account: "uni", message_id: t.id, body: "a" });
    expect(r.result).toMatchObject({ status: "executed", message: { thread_id: t.threadId } });
    expect(lastRaw()).toContain("In-Reply-To: <q2@uni.test>");
    expect(gm().requests.at(-1)!.url).toContain("uploadType=multipart");
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "sa", action: "send.message", level: "ask" });
  });
});

describe("forward", () => {
  it("quotes the original, excludes original attachments by default, lists them in the summary when included, and streams them at send", async () => {
    const t = gm().seedMessage({
      from: "prof@uni.test",
      to: ["uni@example.test"],
      subject: "Slides",
      text: "here are the slides",
      attachments: [{ filename: "slides.pdf", mime: "application/pdf", bytes: new Uint8Array(1500) }],
    });
    const r = await call("forward", {
      account: "uni",
      message_id: t.id,
      to: ["friend@example.test"],
      forward_text: "FYI",
    });
    expect(r.result).toMatchObject({ status: "pending_approval", action: "send.forward", modifiers: [] });
    expect(r.result.summary).toContain("no attachments");
    const p = JSON.parse((await getPending(env.DB, r.result.action_id, "owner-sub"))!.payload_json!);
    expect(p).toMatchObject({
      tool: "forward",
      subject: "Fwd: Slides",
      include_original_attachments: false,
      carry: [],
    });
    expect(p.body).toMatch(/^FYI\n\n---------- Forwarded message ---------\nFrom: prof@uni.test\n/);
    expect(p.body).toContain("here are the slides");
    const inc = await call("forward", {
      account: "uni",
      message_id: t.id,
      to: ["friend@example.test"],
      include_original_attachments: true,
    });
    expect(inc.result.modifiers).toEqual(["+attachment"]);
    expect(inc.result.summary).toContain("1 attachment (slides.pdf, 1.5 KB)");
    // Carrying the original attachments is +attachment, which raises allow to ask, so the send that
    // proves the bytes are streamed goes through an approval.
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "sa", action: "send.forward", level: "allow" });
    const asked = await call("forward", {
      account: "uni",
      message_id: t.id,
      to: ["friend@example.test"],
      include_original_attachments: true,
    });
    await approvePending(env.DB, { id: asked.result.action_id, userId: "owner-sub", via: "browser" });
    const sent = await call("execute_pending", { action_id: asked.result.action_id });
    expect(sent.result.status).toBe("executed");
    expect(lastRaw()).toContain('filename="slides.pdf"');
    expect(lastRaw()).toContain("Subject: Fwd: Slides");
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "sa", action: "send.forward", level: "ask" });
  });
});

describe("send_draft", () => {
  it("derives recipients, attachments and the draft's Message-ID, +attachment when it has any, and sends via drafts.send", async () => {
    const d = gm().seedDraft({
      from: "uni@example.test",
      to: ["prof@uni.test"],
      subject: "Draft",
      text: "d",
      messageId: "<draft1@example.test>",
      attachments: [{ filename: "a.pdf", mime: "application/pdf", bytes: new Uint8Array(10) }],
    });
    const r = await call("send_draft", { account: "uni", draft_id: d.id });
    expect(r.result).toMatchObject({ status: "pending_approval", action: "send.draft", modifiers: ["+attachment"] });
    expect(r.result.summary).toContain("1 attachment (a.pdf, 10 B)");
    const p = JSON.parse((await getPending(env.DB, r.result.action_id, "owner-sub"))!.payload_json!);
    expect(p).toMatchObject({
      tool: "send_draft",
      draft_id: d.id,
      to: ["prof@uni.test"],
      subject: "Draft",
      rfc822_message_id: "<draft1@example.test>",
      draft_attachments: [{ filename: "a.pdf", size: 10 }],
    });
    await approvePending(env.DB, { id: r.result.action_id, userId: "owner-sub", via: "browser" });
    const done = await call("execute_pending", { action_id: r.result.action_id });
    expect(done.result).toMatchObject({ status: "executed", message: { id: expect.stringMatching(/^m/) } });
    expect(gm().sent.at(-1)!.via).toBe("draft");
    expect(
      (
        await env.DB.prepare("SELECT rfc822_message_id FROM operations WHERE id = ?")
          .bind(done.result.operation_id)
          .first<any>()
      ).rfc822_message_id,
    ).toBe("<draft1@example.test>");
  });
  it("a draft edited between approval and execution is a payload mismatch and nothing is sent", async () => {
    const d = gm().seedDraft({ from: "uni@example.test", to: ["prof@uni.test"], subject: "Edit me", text: "d" });
    const r = await call("send_draft", { account: "uni", draft_id: d.id });
    await approvePending(env.DB, { id: r.result.action_id, userId: "owner-sub", via: "browser" });
    gm().drafts.get(d.id)!.message.payload.headers.push({ name: "Bcc", value: "sneaky@else.test" });
    const before = gm().sent.length;
    const done = await call("execute_pending", { action_id: r.result.action_id });
    expect(done.result).toMatchObject({ error: "payload_mismatch" });
    expect(gm().sent.length).toBe(before);
    const row = (await getPending(env.DB, r.result.action_id, "owner-sub"))!;
    expect(row.state).toBe("failed");
    expect(
      (await env.DB.prepare("SELECT state FROM operations WHERE id = ?").bind(row.operation_id).first<any>()).state,
    ).toBe("failed_safe");
  });
});
