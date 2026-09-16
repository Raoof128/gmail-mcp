import { readMutationReceipt } from "../google/mutation-receipt";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Deps } from "../deps";
import type { Env } from "../env";
import { gmailFetch, openResumableSession, putResumable, type Upload } from "../google/gmail";
import { beginRecoverableOperation } from "./recovery-state";
import type { Binding } from "./recovery-types";
import { beginOperation } from "./journal";

export const MEDIA_UPLOAD_MAX = 5 * 1024 * 1024;
/** Gmail's own ceiling for the send and draft uploads (discovery document, revision 20260907). */
export const GMAIL_SEND_MAX = 36_700_160;

export type SentMessage = { id: string; thread_id: string; label_ids: string[] };
type Wire = { id: string; threadId: string; labelIds?: string[] };
type Acct = { userId: string; accountId: string };
export type SendRecoveryContext = Pick<Binding, "executor" | "pendingId" | "audit">;
type Body = {
  recoveryContext?: SendRecoveryContext | undefined;
  body: ReadableStream<Uint8Array>;
  length: number;
  threadId: string | null;
  rfc822MessageId: string;
};

export function messageIdFor(env: Env, operationId: string): string {
  return `<${operationId}@${env.WORKER_HOSTNAME}>`;
}

async function beginSend(
  env: Env,
  acct: Acct,
  operationId: string,
  body: {
    recoveryContext?: SendRecoveryContext | undefined;
    rfc822MessageId: string | null;
    threadId: string | null;
    length: number | null;
  },
  sessionUrl: string | null,
  expectedVersion?: number,
): Promise<number | undefined> {
  if (!body.recoveryContext) {
    await beginOperation(env.DB, operationId, body.rfc822MessageId ? { rfc822_message_id: body.rfc822MessageId } : {});
    return undefined;
  }
  const row = await env.DB.prepare(
    "SELECT credential_version FROM accounts WHERE user_id=? AND id=? AND status='active'",
  )
    .bind(acct.userId, acct.accountId)
    .first<{ credential_version: number }>();
  if (!row || (expectedVersion !== undefined && row.credential_version !== expectedVersion))
    throw new GmailMcpError("account_needs_reconnect", "account_needs_reconnect");
  if (body.recoveryContext.executor === "send_draft" && body.rfc822MessageId) {
    await env.DB.prepare(
      "UPDATE operations SET rfc822_message_id=? WHERE id=? AND user_id=? AND account_id=? AND state='claimed' AND settlement_protocol=1",
    )
      .bind(body.rfc822MessageId, operationId, acct.userId, acct.accountId)
      .run();
  }
  await beginRecoverableOperation(
    env,
    {
      ...body.recoveryContext,
      operationId,
      userId: acct.userId,
      accountId: acct.accountId,
      credentialVersion: row.credential_version,
      resultVersion: "send-v1",
      generatedMessageId: body.recoveryContext.executor === "send_draft" ? null : body.rfc822MessageId,
      threadId: body.threadId,
      startedAt: Date.now(),
      mimeLength: body.length,
      buildId: env.BUILD_ID,
      origin: `https://${env.WORKER_HOSTNAME}`,
    },
    sessionUrl,
  );
  return row.credential_version;
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
    const expectedCredentialVersion = await beginSend(env, acct, o.operationId, o, null);
    return gmailFetch(env, deps, acct, {
      method: o.method,
      path: o.path,
      upload: up,
      retry: "none",
      expectedCredentialVersion,
    });
  }
  const initiationVersion = o.recoveryContext
    ? await env.DB.prepare("SELECT credential_version FROM accounts WHERE user_id=? AND id=? AND status='active'")
        .bind(acct.userId, acct.accountId)
        .first<number>("credential_version")
    : undefined;
  if (initiationVersion === null) throw new GmailMcpError("account_needs_reconnect", "account_needs_reconnect");
  const session = await openResumableSession(env, deps, acct, {
    path: o.path,
    expectedCredentialVersion: initiationVersion,
    contentType: o.contentType,
    length: o.length,
    ...(metadata ? { metadata } : {}),
  });
  const expectedCredentialVersion = await beginSend(env, acct, o.operationId, o, session, initiationVersion);
  return putResumable(env, deps, acct, session, {
    expectedCredentialVersion,
    endpoint:
      o.path === "messages/send"
        ? { kind: "send" }
        : o.path === "drafts"
          ? { kind: "draft_create" }
          : { kind: "draft_update", draftId: decodeURIComponent(o.path.slice(7)) },
    contentType: o.contentType,
    length: o.length,
    body: o.body,
  });
}

export async function sendMime(env: Env, deps: Deps, o: Acct & Body & { operationId: string }): Promise<SentMessage> {
  const res = await upload(env, deps, o, {
    ...o,
    path: "messages/send",
    method: "POST",
    contentType: "message/rfc822",
  });
  const m = await readMutationReceipt<Wire>(res);
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
  const d = await readMutationReceipt<{ id: string; message: Wire }>(res);
  return { id: d.id, message_id: d.message.id, thread_id: d.message.threadId };
}

export async function sendDraft(
  env: Env,
  deps: Deps,
  o: Acct & {
    operationId: string;
    draftId: string;
    rfc822MessageId: string | null;
    recoveryContext?: SendRecoveryContext | undefined;
  },
): Promise<SentMessage> {
  const expectedCredentialVersion = await beginSend(
    env,
    o,
    o.operationId,
    { ...o, threadId: null, length: null },
    null,
  );
  const response = await gmailFetch(env, deps, o, {
    method: "POST",
    path: "drafts/send",
    expectedCredentialVersion,
    json: { id: o.draftId },
    retry: "none",
  });
  const m = await readMutationReceipt<Wire>(response);
  return { id: m.id, thread_id: m.threadId, label_ids: m.labelIds ?? [] };
}
