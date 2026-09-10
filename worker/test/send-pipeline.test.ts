import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { FakeGoogle } from "./fake-google";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import { testDeps, testEnv } from "./test-env";
import { insertOperationStatement } from "../src/operations/journal";
import { randomId } from "../src/crypto/random";
import {
  sendMime,
  sendDraft,
  uploadDraft,
  messageIdFor,
  MEDIA_UPLOAD_MAX,
  GMAIL_SEND_MAX,
} from "../src/operations/send";
import { buildMimeStream, fromBytes } from "../src/mime/build";

const e = testEnv();
let g: FakeGoogle;
const gm = () => g.gmail;
const acct = { userId: "su", accountId: "sa" };

beforeAll(async () => {
  g = await FakeGoogle.create();
  await seedUserAndAccount(env.DB, { userId: "su", accountId: "sa", alias: "main", isDefault: true });
  await seedAccessToken(e, acct);
});

async function op() {
  const id = randomId("op");
  await insertOperationStatement(env.DB, {
    id,
    ...acct,
    action: "send.message",
    payloadHash: "h",
    now: Date.now(),
  }).run();
  return id;
}
const opRow = (id: string) =>
  env.DB.prepare("SELECT state, rfc822_message_id, gmail_result_id FROM operations WHERE id = ?").bind(id).first<any>();
const mime = (extra: Partial<Parameters<typeof buildMimeStream>[0]> = {}) =>
  buildMimeStream({
    from: "me@example.test",
    to: ["a@example.test"],
    cc: [],
    bcc: [],
    subject: "s",
    messageId: "<x@y>",
    text: "t",
    attachments: [],
    ...extra,
  });
const send = (id: string, m: ReturnType<typeof mime>, threadId: string | null = null) =>
  sendMime(e, testDeps(g), {
    ...acct,
    operationId: id,
    body: m.stream,
    length: m.length,
    threadId,
    rfc822MessageId: "<x@y>",
  });

describe("sendMime", () => {
  it("small: media upload; the operation is executing with the Message-ID before the request opens; nothing settles here", async () => {
    const id = await op();
    const mid = messageIdFor(e, id);
    expect(mid).toBe(`<${id}@gmail-mcp.example.workers.dev>`);
    let seenState: string | undefined;
    gm().before = async () => {
      seenState = (await opRow(id)).state;
      return undefined;
    };
    const m = mime({ messageId: mid });
    const sent = await sendMime(e, testDeps(g), {
      ...acct,
      operationId: id,
      body: m.stream,
      length: m.length,
      threadId: null,
      rfc822MessageId: mid,
    });
    gm().before = null;
    expect(seenState).toBe("executing");
    expect(sent).toMatchObject({ id: expect.stringMatching(/^m/), thread_id: expect.any(String), label_ids: ["SENT"] });
    expect(await opRow(id)).toEqual({ state: "executing", rfc822_message_id: mid, gmail_result_id: null });
    expect(gm().sent.at(-1)!.via).toBe("media");
    expect(gm().requests.at(-1)!.url).toContain("uploadType=media");
  });
  it("with a thread id: multipart upload carries threadId metadata and Gmail files it in that thread", async () => {
    const root = gm().seedMessage({ from: "a@example.test", to: ["me@example.test"], subject: "root", text: "r" });
    const sent = await send(await op(), mime({ inReplyTo: `<${root.id}@fake.test>` }), root.threadId);
    expect(sent.thread_id).toBe(root.threadId);
    const req = gm().requests.at(-1)!;
    expect(req.url).toContain("uploadType=multipart");
    expect(req.headers.get("content-type")).toMatch(/^multipart\/related; boundary=/);
  });
  it("above 5 MB: the session opens before the operation, then the PUT streams the exact length with threadId in the session metadata", async () => {
    const id = await op();
    const big = new Uint8Array(MEDIA_UPLOAD_MAX).fill(1);
    const m = mime({
      attachments: [
        { filename: "big.bin", mime: "application/octet-stream", size: big.byteLength, open: fromBytes(big) },
      ],
    });
    expect(m.length).toBeGreaterThan(MEDIA_UPLOAD_MAX);
    const states: string[] = [];
    gm().before = async () => {
      states.push((await opRow(id)).state);
      return undefined;
    };
    const sent = await send(id, m, "t-res");
    gm().before = null;
    expect(states).toEqual(["claimed", "executing"]);
    expect(sent.thread_id).toBe("t-res");
    expect(gm().sent.at(-1)!.via).toBe("resumable");
    expect(gm().sent.at(-1)!.raw.byteLength).toBe(m.length);
    const [start] = gm().requests.slice(-2);
    expect(await start!.clone().json()).toEqual({ threadId: "t-res" });
    expect(start!.headers.get("x-upload-content-length")).toBe(String(m.length));
  });
  it("a failure opening the session is retried and never touches the operation; three failures leave it claimed", async () => {
    const id = await op();
    const big = new Uint8Array(MEDIA_UPLOAD_MAX).fill(2);
    gm().faults.push({ status: 503 });
    const sent = await send(
      id,
      mime({
        attachments: [
          { filename: "b.bin", mime: "application/octet-stream", size: big.byteLength, open: fromBytes(big) },
        ],
      }),
    );
    expect(sent.id).toMatch(/^m/);
    const id2 = await op();
    gm().faults.push({ status: 503 }, { status: 503 }, { status: 503 });
    await expect(
      send(
        id2,
        mime({
          attachments: [
            { filename: "b.bin", mime: "application/octet-stream", size: big.byteLength, open: fromBytes(big) },
          ],
        }),
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect((await opRow(id2)).state).toBe("claimed");
  });
  it("a failed PUT after the operation opened leaves it executing; the caller classifies", async () => {
    const id = await op();
    const big = new Uint8Array(MEDIA_UPLOAD_MAX).fill(3);
    gm().afterSession = { status: 503 };
    await expect(
      send(
        id,
        mime({
          attachments: [
            { filename: "b.bin", mime: "application/octet-stream", size: big.byteLength, open: fromBytes(big) },
          ],
        }),
      ),
    ).rejects.toMatchObject({ status: 503 });
    gm().afterSession = null;
    expect((await opRow(id)).state).toBe("executing");
  });
  it("a 401 on a small send refreshes and re-sends once, because Gmail never processed the first body", async () => {
    const id = await op();
    await seedAccessToken(e, { ...acct, access: "at-stale", refresh: "rt-x" });
    g.refreshTokens.set("rt-x", "ok");
    gm().rejectTokens.add("at-stale");
    const sent = await send(id, mime());
    expect(sent.id).toMatch(/^m/);
    expect(gm().sent.filter((s) => s.id === sent.id)).toHaveLength(1);
    await seedAccessToken(e, acct);
  });
  it("refuses a message over Gmail's ceiling before any request", async () => {
    const id = await op();
    const before = gm().requests.length;
    const fake = { stream: new ReadableStream<Uint8Array>(), length: GMAIL_SEND_MAX + 1 };
    await expect(send(id, fake)).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(gm().requests.length).toBe(before);
    expect((await opRow(id)).state).toBe("claimed");
  });
});

describe("drafts and send_draft", () => {
  it("uploadDraft creates then updates a draft via the same protocol; sendDraft posts the id with the draft's Message-ID on the operation", async () => {
    const id = await op();
    const m1 = mime({ subject: "d1" });
    const created = await uploadDraft(e, testDeps(g), {
      ...acct,
      operationId: id,
      body: m1.stream,
      length: m1.length,
      threadId: null,
      rfc822MessageId: "<d@y>",
      draftId: null,
    });
    expect(created).toMatchObject({
      id: expect.stringMatching(/^r/),
      message_id: expect.any(String),
      thread_id: expect.any(String),
    });
    expect((await opRow(id)).state).toBe("executing");
    const id2 = await op();
    const m2 = mime({ subject: "d2" });
    const updated = await uploadDraft(e, testDeps(g), {
      ...acct,
      operationId: id2,
      body: m2.stream,
      length: m2.length,
      threadId: null,
      rfc822MessageId: "<d@y>",
      draftId: created.id,
    });
    expect(updated.id).toBe(created.id);
    expect(gm().requests.at(-1)!.method).toBe("PUT");
    const id3 = await op();
    const sent = await sendDraft(e, testDeps(g), {
      ...acct,
      operationId: id3,
      draftId: created.id,
      rfc822MessageId: "<d@y>",
    });
    expect(sent).toMatchObject({ id: expect.stringMatching(/^m/), thread_id: expect.any(String) });
    expect(gm().sent.at(-1)!.via).toBe("draft");
    expect(gm().drafts.has(created.id)).toBe(false);
    expect(await opRow(id3)).toMatchObject({ state: "executing", rfc822_message_id: "<d@y>" });
    const id4 = await op();
    await expect(
      sendDraft(e, testDeps(g), { ...acct, operationId: id4, draftId: created.id, rfc822MessageId: null }),
    ).rejects.toMatchObject({ status: 404 });
    expect((await opRow(id4)).state).toBe("executing");
  });
});
