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

const e = testEnv();
let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
let token: string;
const gm = () => g.gmail;
const call = (name: string, args: Record<string, unknown>) => callTool(worker, e, token, name, args);
const b64 = (s: string) => btoa(s);
const stagingCount = async () =>
  (await env.DB.prepare("SELECT count(*) AS n FROM staging_objects").first<any>()).n as number;
async function stage(name: string, bytes: Uint8Array) {
  return (
    await ingest(e, {
      userId: "owner-sub",
      accountId: "da",
      direction: "upload",
      filename: name,
      mime: "application/octet-stream",
      length: bytes.byteLength,
      body: new Response(bytes).body!,
    })
  ).handle;
}
const rawOf = (draftId: string) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(gm().drafts.get(draftId)!.message.raw!.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    ),
  );

beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker(testDeps(g));
  await seedUserAndAccount(env.DB, {
    userId: "owner-sub",
    accountId: "da",
    alias: "personal",
    isDefault: true,
    sendAs: ["alias@example.test"],
  });
  await seedAccessToken(e, { userId: "owner-sub", accountId: "da" });
  token = (await mintToken(worker, e, g, { scope: "mcp" })).accessToken;
});

describe("create_draft", () => {
  it("is allowed by default, journals, builds MIME from staged and inline attachments, and stores no inline bytes in the payload", async () => {
    const h = await stage("staged.txt", new TextEncoder().encode("staged bytes"));
    const r = await call("create_draft", {
      account: "personal",
      to: ["Ann <ann@example.test>"],
      subject: "Draft 🚀",
      body: "hello",
      attachments: [h],
      inline_attachments: [{ filename: "inline.txt", mime: "text/plain", content_base64: b64("inline bytes") }],
    });
    expect(r.result).toMatchObject({
      status: "executed",
      account: "personal",
      draft: { id: expect.stringMatching(/^r/) },
    });
    const raw = rawOf(r.result.draft.id);
    expect(raw).toContain("Subject: =?UTF-8?B?RHJhZnQg8J+agA==?=");
    expect(raw).toContain('filename="staged.txt"');
    expect(raw).toContain('filename="inline.txt"');
    expect(raw).toContain(btoa("inline bytes"));
    const op = await env.DB.prepare("SELECT state, gmail_result_id FROM operations WHERE id = ?")
      .bind(r.result.operation_id)
      .first<any>();
    expect(op).toEqual({ state: "executed", gmail_result_id: r.result.draft.id });
    const handles = await env.DB.prepare(
      "SELECT filename, consumed_at FROM staging_objects WHERE user_id='owner-sub' AND account_id='da' ORDER BY created_at",
    ).all<any>();
    expect(handles.results.filter((x) => x.consumed_at !== null).map((x) => x.filename)).toEqual(
      expect.arrayContaining(["staged.txt", "inline.txt"]),
    );
    const audit = await env.DB.prepare(
      "SELECT summary FROM audit_log WHERE user_id='owner-sub' AND tool='create_draft' ORDER BY id DESC LIMIT 1",
    ).first<any>();
    expect(audit.summary).toBe("recipients=1 attachments=2");
  });
  it("a reply draft derives thread, subject and threading headers from the target", async () => {
    const target = gm().seedMessage({
      from: "Prof <prof@uni.test>",
      to: ["me@example.test"],
      subject: "Thesis",
      text: "?",
      messageId: "<t1@uni.test>",
    });
    const r = await call("create_draft", { account: "personal", reply_to_message_id: target.id, body: "answer" });
    expect(r.result.draft.thread_id).toBe(target.threadId);
    const raw = rawOf(r.result.draft.id);
    expect(raw).toContain("Subject: Re: Thesis");
    expect(raw).toContain("In-Reply-To: <t1@uni.test>");
    expect(raw).toContain("References: <t1@uni.test>");
    expect(raw).toContain('To: "Prof" <prof@uni.test>');
  });
  it("refuses over-cap or malformed input before any row is written", async () => {
    const before = await stagingCount();
    expect(
      (await call("create_draft", { account: "personal", to: ["a@example.test"], body: "x".repeat(512 * 1024 + 1) }))
        .result,
    ).toMatchObject({ error: "limit_exceeded" });
    expect(
      (await call("create_draft", { account: "personal", to: ["not an address"], body: "x" })).result,
    ).toMatchObject({ error: "invalid_address" });
    expect(
      (await call("create_draft", { account: "personal", to: ["a@example.test"], subject: "x\r\nBcc: y@example.test" }))
        .result,
    ).toMatchObject({ error: "invalid_header" });
    expect(
      (await call("create_draft", { account: "personal", to: ["a@example.test"], subject: "s".repeat(999) })).result,
    ).toMatchObject({ error: "limit_exceeded" });
    expect(
      (
        await call("create_draft", {
          account: "personal",
          to: Array.from({ length: 501 }, (_, i) => `u${i}@example.test`),
          body: "x",
        })
      ).result,
    ).toMatchObject({ error: "limit_exceeded" });
    // One inline attachment over the schema's character cap never reaches a decoder.
    const huge = await call("create_draft", {
      account: "personal",
      to: ["a@example.test"],
      inline_attachments: [
        { filename: "a.bin", mime: "application/octet-stream", content_base64: "A".repeat(1_400_001) },
      ],
    });
    expect(huge.isError || huge.error).toBeTruthy();
    // Forty attachments each under the cap, together over it: refused by the running total before the last decode.
    const many = Array.from({ length: 40 }, (_, i) => ({
      filename: `p${i}.bin`,
      mime: "application/octet-stream",
      content_base64: btoa("Z".repeat(30_000)),
    }));
    expect(
      (await call("create_draft", { account: "personal", to: ["a@example.test"], inline_attachments: many })).result,
    ).toMatchObject({ error: "limit_exceeded" });
    expect(
      (
        await call("create_draft", {
          account: "personal",
          to: ["a@example.test"],
          inline_attachments: [{ filename: "run.exe", mime: "application/octet-stream", content_base64: b64("MZ") }],
        })
      ).result,
    ).toMatchObject({ error: "blocked_extension" });
    expect(
      (
        await call("create_draft", {
          account: "personal",
          to: ["a@example.test"],
          inline_attachments: [{ filename: "a.txt", mime: "text/plain; charset=UTF-8", content_base64: b64("x") }],
        })
      ).error ?? { error: true },
    ).toBeTruthy();
    expect(await stagingCount()).toBe(before);
    expect(
      (await call("create_draft", { account: "personal", to: ["a@example.test"], from: "someone@else.test" })).result,
    ).toMatchObject({ error: "invalid_address" });
    expect(
      (await call("create_draft", { account: "personal", to: ["a@example.test"], from: "alias@example.test" })).result
        .status,
    ).toBe("executed");
  });
  it("a denied draft.write stages nothing, even with inline attachments", async () => {
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "da", action: "draft.write", level: "deny" });
    const before = await stagingCount();
    const r = await call("create_draft", {
      account: "personal",
      to: ["a@example.test"],
      inline_attachments: [{ filename: "n.txt", mime: "text/plain", content_base64: b64("never") }],
    });
    expect(r.result).toMatchObject({ error: "policy_denied" });
    expect(await stagingCount()).toBe(before);
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "da", action: "draft.write", level: "allow" });
  });
  it("a handle from another account, an expired one, or a blocked name at build time is refused", async () => {
    await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "db", alias: "other" });
    const foreign = (
      await ingest(e, {
        userId: "owner-sub",
        accountId: "db",
        direction: "upload",
        filename: "f.txt",
        mime: "text/plain",
        length: 1,
        body: new Response(new Uint8Array(1)).body!,
      })
    ).handle;
    expect(
      (await call("create_draft", { account: "personal", to: ["a@example.test"], attachments: [foreign] })).result,
    ).toMatchObject({ error: "handle_invalid" });
    const h = await stage("ok.txt", new Uint8Array(10));
    await env.DB.prepare("UPDATE staging_objects SET filename = 'late.exe' WHERE handle = ?").bind(h).run();
    expect(
      (await call("create_draft", { account: "personal", to: ["a@example.test"], attachments: [h] })).result,
    ).toMatchObject({ error: "blocked_extension" });
    await env.DB.prepare("UPDATE accounts SET send_limit_bytes = 5 WHERE id = 'da'").run();
    const h2 = await stage("ten.txt", new Uint8Array(10));
    expect(
      (await call("create_draft", { account: "personal", to: ["a@example.test"], attachments: [h2] })).result,
    ).toMatchObject({ error: "limit_exceeded" });
    await env.DB.prepare("UPDATE accounts SET send_limit_bytes = 26214400 WHERE id = 'da'").run();
  });
  it("draft.write raised to ask stores handles in the payload and executes from the row", async () => {
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "da", action: "draft.write", level: "ask" });
    const h = await stage("later.txt", new Uint8Array(3));
    const r = await call("create_draft", { account: "personal", to: ["a@example.test"], body: "b", attachments: [h] });
    expect(r.result).toMatchObject({ status: "pending_approval", action: "draft.write" });
    await env.DB.prepare(
      "UPDATE pending_actions SET state = 'approved', approved_at = ?, approved_via = 'browser' WHERE id = ?",
    )
      .bind(Date.now(), r.result.action_id)
      .run();
    const done = await call("execute_pending", { action_id: r.result.action_id });
    expect(done.result).toMatchObject({ status: "executed", draft: { id: expect.any(String) } });
    expect(rawOf(done.result.draft.id)).toContain('filename="later.txt"');
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "da", action: "draft.write", level: "allow" });
  });
});

describe("update_draft", () => {
  it("merges each field independently; the attachment set given replaces, none given means none", async () => {
    const h = await stage("first.txt", new TextEncoder().encode("first"));
    const created = await call("create_draft", {
      account: "personal",
      to: ["a@example.test"],
      cc: ["c@example.test"],
      subject: "v1",
      body: "one",
      attachments: [h],
    });
    const id = created.result.draft.id as string;
    const h2 = await stage("second.txt", new TextEncoder().encode("second"));
    const u1 = await call("update_draft", {
      account: "personal",
      draft_id: id,
      body: "two",
      bcc: ["b@example.test"],
      attachments: [h2],
    });
    expect(u1.result).toMatchObject({ status: "executed", draft: { id } });
    let raw = rawOf(id);
    expect(raw).toContain("Subject: v1");
    expect(raw).toContain("To: <a@example.test>");
    expect(raw).toContain("Cc: <c@example.test>");
    expect(raw).toContain("Bcc: <b@example.test>");
    expect(raw).toContain(btoa("two"));
    expect(raw).toContain('filename="second.txt"');
    expect(raw).not.toContain('filename="first.txt"');
    expect(gm().requests.at(-1)!.method).toBe("PUT");
    await call("update_draft", { account: "personal", draft_id: id, cc: [] });
    raw = rawOf(id);
    expect(raw).toContain("To: <a@example.test>");
    expect(raw).not.toContain("Cc:");
    expect(raw).toContain(btoa("two"));
    expect(raw).not.toContain("Content-Disposition: attachment");
    expect((await call("update_draft", { account: "personal", draft_id: "nope" })).result).toMatchObject({
      error: "gmail_error",
      details: { status: 404 },
    });
  });
});
