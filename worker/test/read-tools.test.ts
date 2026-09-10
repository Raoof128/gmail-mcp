import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { StagingHandleResponse } from "@gmail-mcp/shared/schemas";
import { createWorker } from "../src/index";
import { FakeGoogle } from "./fake-google";
import { mintToken } from "./browser";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import { callTool } from "./mcp-client";
import { testDeps, testEnv } from "./test-env";
import { setPolicy } from "../src/policy/engine";
import { sha256Hex } from "../src/crypto/canonical";

const e = testEnv();
let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
let token: string;
const gm = () => g.gmail;
const call = (name: string, args: Record<string, unknown>) => callTool(worker, e, token, name, args);

beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker(testDeps(g));
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "ra", alias: "personal", isDefault: true });
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "rb", alias: "work" });
  await seedAccessToken(e, { userId: "owner-sub", accountId: "ra" });
  await seedAccessToken(e, { userId: "owner-sub", accountId: "rb" });
  token = (await mintToken(worker, e, g, { scope: "mcp" })).accessToken;
  for (let i = 0; i < 25; i++)
    gm().seedMessage({ from: "a@x.test", to: ["me@x.test"], subject: `bulk ${i}`, text: `body ${i}` });
});

describe("reads", () => {
  it("search_threads pages at the limit, echoes the default account, and writes one intent row per call", async () => {
    const r = await call("search_threads", { query: "subject:bulk", limit: 10 });
    expect(r.result.account).toBe("personal");
    expect(r.result.threads).toHaveLength(10);
    expect(r.result.threads[0]).toMatchObject({ id: expect.any(String), snippet: expect.any(String) });
    expect(r.result.next_page_token).toBeTruthy();
    const r2 = await call("search_threads", { query: "subject:bulk", limit: 10, page_token: r.result.next_page_token });
    expect(r2.result.threads[0].id).not.toBe(r.result.threads[0].id);
    const url = gm().requests.at(-1)!.url;
    expect(url).toContain("maxResults=10");
    expect(url).toContain("includeSpamTrash=false");
    const rows = await env.DB.prepare(
      "SELECT phase, decision FROM audit_log WHERE user_id='owner-sub' AND tool='search_threads' ORDER BY id DESC LIMIT 2",
    ).all<any>();
    expect(rows.results.every((x) => x.phase === "intent" && x.decision === "allow")).toBe(true);
    const over = await call("search_threads", { limit: 51 });
    expect(over.isError || over.error).toBeTruthy();
  });
  it("get_thread returns messages in PLAIN_TEXT by default, capped by max_messages and body_char_limit", async () => {
    const root = gm().seedMessage({ from: "a@x.test", to: ["me@x.test"], subject: "thread", text: "one ".repeat(100) });
    gm().seedMessage({
      threadId: root.threadId,
      from: "me@x.test",
      to: ["a@x.test"],
      subject: "Re: thread",
      text: "two",
      html: "<i>two</i>",
    });
    gm().seedMessage({
      threadId: root.threadId,
      from: "a@x.test",
      to: ["me@x.test"],
      subject: "Re: thread",
      text: "three",
    });
    const r = await call("get_thread", { thread_id: root.threadId, max_messages: 2, body_char_limit: 8 });
    expect(r.result.account).toBe("personal");
    expect(r.result.thread.messages).toHaveLength(2);
    expect(r.result.thread.messages[0]).toMatchObject({
      plaintext_body: "one one ",
      body_truncated: true,
      subject: "thread",
    });
    expect(r.result.thread.messages[1].html_body).toBeUndefined();
    expect(r.result.thread.messages_omitted).toBe(1);
    const full = await call("get_thread", { thread_id: root.threadId, message_format: "FULL_CONTENT" });
    expect(full.result.thread.messages[1].html_body).toBe("<i>two</i>");
    const meta = await call("get_thread", { thread_id: root.threadId, message_format: "METADATA_ONLY" });
    expect(meta.result.thread.messages[0].plaintext_body).toBeUndefined();
    expect(gm().requests.at(-1)!.url).toContain("format=metadata");
  });
  it("get_thread has a total body budget across messages", async () => {
    const root = gm().seedMessage({ from: "a@x.test", to: ["me@x.test"], subject: "budget", text: "x".repeat(150) });
    for (let i = 0; i < 4; i++)
      gm().seedMessage({
        threadId: root.threadId,
        from: "a@x.test",
        to: ["me@x.test"],
        subject: "Re: budget",
        text: "y".repeat(150),
      });
    const r = await call("get_thread", { thread_id: root.threadId, total_body_char_limit: 400 });
    const withBody = r.result.thread.messages.filter(
      (m: { plaintext_body?: string }) => m.plaintext_body !== undefined,
    );
    expect(withBody.length).toBeLessThanOrEqual(3);
    expect(r.result.thread.bodies_omitted).toBe(5 - withBody.length);
    expect(r.result.thread.messages).toHaveLength(5);
  });
  it("get_message exposes attachment metadata only and honours include_body", async () => {
    const m = gm().seedMessage({
      from: "a@x.test",
      to: ["me@x.test"],
      subject: "att",
      text: "see attached",
      attachments: [{ filename: "a.pdf", mime: "application/pdf", bytes: new Uint8Array(3000) }],
    });
    const r = await call("get_message", { message_id: m.id });
    expect(r.result.message.attachments).toEqual([
      { part_id: "2", attachment_id: `att${m.id}_0`, filename: "a.pdf", mime: "application/pdf", size: 3000 },
    ]);
    expect(r.result.message.plaintext_body).toBe("see attached");
    expect(
      (await call("get_message", { message_id: m.id, include_body: false })).result.message.plaintext_body,
    ).toBeUndefined();
    expect(
      (await call("get_message", { message_id: m.id, message_format: "MESSAGE_FORMAT_UNSPECIFIED" })).result.message
        .plaintext_body,
    ).toBe("see attached");
    expect((await call("get_message", { account: "work", message_id: m.id })).result.account).toBe("work");
  });
  it("list_drafts, get_draft and list_labels", async () => {
    const d = gm().seedDraft({ from: "me@x.test", to: ["a@x.test"], subject: "draft one", text: "d1" });
    const list = await call("list_drafts", { limit: 5 });
    expect(list.result.drafts.map((x: { id: string }) => x.id)).toContain(d.id);
    const one = await call("get_draft", { draft_id: d.id });
    expect(one.result.draft).toMatchObject({ id: d.id, message: { subject: "draft one", plaintext_body: "d1" } });
    const labels = await call("list_labels", {});
    expect(labels.result.labels.map((l: { id: string }) => l.id)).toEqual(
      expect.arrayContaining(["INBOX", "SENT", "DRAFT"]),
    );
  });
  it("reads obey policy: a denied read.search writes one intent row and returns policy_denied", async () => {
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "ra", action: "read.search", level: "deny" });
    expect((await call("search_threads", { query: "x" })).result).toMatchObject({ error: "policy_denied" });
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "ra", action: "read.search", level: "allow" });
  });
});

describe("download_attachment", () => {
  it("stages the decoded bytes as a download handle with sha256 and a 30 minute expiry", async () => {
    const data = new Uint8Array(5000).map((_, i) => i % 251);
    const m = gm().seedMessage({
      from: "a@x.test",
      to: ["me@x.test"],
      subject: "dl",
      text: "t",
      attachments: [{ filename: "..\\evil‮.pdf", mime: "application/pdf", bytes: data }],
    });
    const r = await call("download_attachment", { message_id: m.id, attachment_id: `att${m.id}_0` });
    const h = StagingHandleResponse.parse(r.result);
    expect(h).toMatchObject({
      account: "personal",
      filename: "evil_.pdf",
      mime: "application/pdf",
      size: 5000,
      sha256: await sha256Hex(data),
    });
    expect(Date.parse(h.expires_at) - Date.now()).toBeGreaterThan(29 * 60_000);
    const row = await env.DB.prepare(
      "SELECT direction, user_id, account_id, source_message_id, source_attachment_id FROM staging_objects WHERE handle = ?",
    )
      .bind(h.handle)
      .first<any>();
    expect(row).toEqual({
      direction: "download",
      user_id: "owner-sub",
      account_id: "ra",
      source_message_id: m.id,
      source_attachment_id: `att${m.id}_0`,
    });
    expect(JSON.stringify(r.result)).not.toContain("data");
  });
  it("downloads a part whose bytes are inline in the message body, by part_id", async () => {
    const m = gm().seedMessage({
      from: "a@x.test",
      to: ["me@x.test"],
      subject: "inline",
      text: "t",
      attachments: [
        {
          filename: "tiny.txt",
          mime: "text/plain",
          bytes: new Uint8Array(new TextEncoder().encode("tiny")),
          inline: true,
        },
      ],
    });
    const meta = (await call("get_message", { message_id: m.id })).result.message.attachments[0];
    expect(meta).toMatchObject({ filename: "tiny.txt", attachment_id: null, part_id: expect.any(String), size: 4 });
    const before = gm().requests.length;
    const r = await call("download_attachment", { message_id: m.id, part_id: meta.part_id });
    expect(r.result).toMatchObject({ filename: "tiny.txt", size: 4 });
    expect(
      gm()
        .requests.slice(before)
        .some((q) => q.url.includes("/attachments/")),
    ).toBe(false);
    const neither = await call("download_attachment", { message_id: m.id });
    expect(neither.isError || neither.error).toBeTruthy();
  });
  it("refuses an attachment above 25 MB by size before fetching bytes, and an unknown attachment id", async () => {
    const m = gm().seedMessage({
      from: "a@x.test",
      to: ["me@x.test"],
      subject: "big",
      text: "t",
      attachments: [{ filename: "big.bin", mime: "application/octet-stream", bytes: new Uint8Array(10) }],
    });
    const part = gm()
      .messages.get(m.id)!
      .payload.parts!.find((p) => p.filename === "big.bin")!;
    part.body.size = 25 * 1024 * 1024 + 1;
    const before = gm().requests.length;
    const r = await call("download_attachment", { message_id: m.id, attachment_id: part.body.attachmentId });
    expect(r.result).toMatchObject({ error: "limit_exceeded" });
    expect(
      gm()
        .requests.slice(before)
        .some((q) => q.url.includes("/attachments/")),
    ).toBe(false);
    expect((await call("download_attachment", { message_id: m.id, attachment_id: "nope" })).result).toMatchObject({
      error: "handle_invalid",
    });
  });
  it("is audited as read.attachment with the ids and writes an outcome row", async () => {
    const rows = await env.DB.prepare(
      "SELECT phase, decision, action, summary FROM audit_log WHERE user_id='owner-sub' AND tool='download_attachment' ORDER BY id",
    ).all<any>();
    expect(rows.results[0]).toMatchObject({ phase: "intent", decision: "allow", action: "read.attachment" });
    expect(rows.results[1]).toMatchObject({ phase: "outcome", decision: "executed" });
    expect(rows.results[0].summary).toMatch(/^ids=/);
  });
});
