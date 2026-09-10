import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Deps } from "../deps";
import type { Env } from "../env";
import { gmailFetch, gmailJson, openResumableSession, putResumable, type Upload } from "../google/gmail";
import { beginOperation } from "./journal";

export const MEDIA_UPLOAD_MAX = 5 * 1024 * 1024;
/** Gmail's own ceiling for the send and draft uploads (discovery document, revision 20260907). */
export const GMAIL_SEND_MAX = 36_700_160;

export type SentMessage = { id: string; thread_id: string; label_ids: string[] };
type Wire = { id: string; threadId: string; labelIds?: string[] };
type Acct = { userId: string; accountId: string };
type Body = { body: ReadableStream<Uint8Array>; length: number; threadId: string | null; rfc822MessageId: string };

export function messageIdFor(env: Env, operationId: string): string {
  return `<${operationId}@${env.WORKER_HOSTNAME}>`;
}

/** Exactly `length` bytes, for the small-message path where the whole body is one request. */
export async function collect(stream: ReadableStream<Uint8Array>, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(new ArrayBuffer(length));
  let o = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (o + value.byteLength > length) throw new GmailMcpError("internal", "mime stream longer than declared");
    out.set(value, o);
    o += value.byteLength;
  }
  if (o !== length) throw new GmailMcpError("internal", `mime stream was ${o} bytes, declared ${length}`);
  return out;
}

/**
 * Spec 3.5 steps 3 and 3.9. Under 5 MB the message is one request; above, the session is opened first
 * with the safe retry policy because it moves no bytes, and only then does the operation move to
 * `executing`, immediately before the PUT. Nothing here settles the operation or classifies a failure:
 * the gate reads the operation's state afterwards and decides.
 */
async function upload(
  env: Env,
  deps: Deps,
  acct: Acct,
  o: Body & { operationId: string; path: string; method: "POST" | "PUT"; contentType: string },
): Promise<Response> {
  if (o.length > GMAIL_SEND_MAX)
    throw new GmailMcpError(
      "limit_exceeded",
      `limit_exceeded: message is ${o.length} bytes, Gmail's ceiling is ${GMAIL_SEND_MAX}`,
    );
  const metadata = o.threadId ? { threadId: o.threadId } : undefined;
  if (o.length <= MEDIA_UPLOAD_MAX) {
    const bytes = await collect(o.body, o.length);
    const up: Upload = metadata
      ? { kind: "multipart", contentType: o.contentType, bytes, metadata }
      : { kind: "media", contentType: o.contentType, bytes };
    await beginOperation(env.DB, o.operationId, { rfc822_message_id: o.rfc822MessageId });
    return gmailFetch(env, deps, acct, { method: o.method, path: o.path, upload: up, retry: "none" });
  }
  const session = await openResumableSession(env, deps, acct, {
    path: o.path,
    contentType: o.contentType,
    length: o.length,
    ...(metadata ? { metadata } : {}),
  });
  await beginOperation(env.DB, o.operationId, { rfc822_message_id: o.rfc822MessageId });
  return putResumable(env, deps, acct, session, { contentType: o.contentType, length: o.length, body: o.body });
}

export async function sendMime(env: Env, deps: Deps, o: Acct & Body & { operationId: string }): Promise<SentMessage> {
  const res = await upload(env, deps, o, {
    ...o,
    path: "messages/send",
    method: "POST",
    contentType: "message/rfc822",
  });
  const m = await res.json<Wire>();
  return { id: m.id, thread_id: m.threadId, label_ids: m.labelIds ?? [] };
}

export async function uploadDraft(
  env: Env,
  deps: Deps,
  o: Acct & Body & { operationId: string; draftId: string | null },
): Promise<{ id: string; message_id: string; thread_id: string }> {
  const res = await upload(env, deps, o, {
    ...o,
    path: o.draftId ? `drafts/${encodeURIComponent(o.draftId)}` : "drafts",
    method: o.draftId ? "PUT" : "POST",
    contentType: "message/rfc822",
  });
  const d = await res.json<{ id: string; message: Wire }>();
  return { id: d.id, message_id: d.message.id, thread_id: d.message.threadId };
}

export async function sendDraft(
  env: Env,
  deps: Deps,
  o: Acct & { operationId: string; draftId: string; rfc822MessageId: string | null },
): Promise<SentMessage> {
  await beginOperation(env.DB, o.operationId, o.rfc822MessageId ? { rfc822_message_id: o.rfc822MessageId } : {});
  const m = await gmailJson<Wire>(env, deps, o, {
    method: "POST",
    path: "drafts/send",
    json: { id: o.draftId },
    retry: "none",
  });
  return { id: m.id, thread_id: m.threadId, label_ids: m.labelIds ?? [] };
}
