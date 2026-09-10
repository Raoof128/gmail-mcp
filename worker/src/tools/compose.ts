import { GmailMcpError } from "@gmail-mcp/shared/errors";
import { MediaType, type InlineAttachment, type MessageFormat } from "@gmail-mcp/shared/schemas";
import type { Env } from "../env";
import type { Deps } from "../deps";
import { sha256Hex } from "../crypto/canonical";
import { fromB64url } from "../crypto/random";
import { gmailJson } from "../google/gmail";
import { gmailFormatFor, splitAddressList, type GmailMessage } from "../google/messages";
import { buildMimeStream, type MimeAttachment } from "../mime/build";
import { messageIdFor } from "../operations/send";
import { LIMITS, assertHeaderSafe, assertNotBlocked, utf8Length } from "../policy/limits";
import { parseAddress } from "../policy/recipients";
import { ingest, listUploadHandles, openStaged, type StagingRow } from "../staging/store";
import type { AccountRef } from "./accounts";
import type { ExecRun } from "./gate";

export type ComposeArgs = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string | undefined;
  body?: string | undefined;
  html_body?: string | undefined;
};

/** Spec 2.7 and 3.8, before policy and before any row: addresses parse, headers are clean, sizes fit. */
export function validateCompose(a: ComposeArgs): void {
  const all = [...a.to, ...a.cc, ...a.bcc];
  if (all.length > 500) throw new GmailMcpError("limit_exceeded", `limit_exceeded: recipients ${all.length} > 500`);
  for (const r of all) parseAddress(r);
  if (a.subject !== undefined) assertHeaderSafe("subject", a.subject);
  const bodyBytes = utf8Length(a.body ?? "") + utf8Length(a.html_body ?? "");
  if (bodyBytes > LIMITS.bodyBytes)
    throw new GmailMcpError("limit_exceeded", `limit_exceeded: body ${bodyBytes} > ${LIMITS.bodyBytes} bytes`);
}

export function senderFor(account: AccountRef, from?: string): string {
  if (from === undefined) return account.email;
  const norm = parseAddress(from).normalized;
  const allowed = [account.email, ...account.sendAs].map((s) => parseAddress(s).normalized);
  if (!allowed.includes(norm))
    throw new GmailMcpError("invalid_address", `invalid_address: ${from} is not a verified sender on this account`);
  return from;
}

export type DecodedInline = { filename: string; mime: string; size: number; sha256: string; bytes: Uint8Array };

function decodeBase64(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, "");
  try {
    return Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
  } catch {
    return fromB64url(clean);
  }
}

/**
 * Spec 2.7's 1 MB is enforced before the bytes exist: each string's decoded size is projected from its
 * length, the running total is checked before the decode, and the blocked list and media type are
 * checked before that. Fifty strings just under the per-item cap cannot add up to more than 1 MiB decoded.
 */
export async function decodeInline(inline: InlineAttachment[] | undefined): Promise<DecodedInline[]> {
  const out: DecodedInline[] = [];
  let total = 0;
  for (const i of inline ?? []) {
    assertNotBlocked(i.filename);
    MediaType.parse(i.mime);
    const projected = Math.floor((i.content_base64.length * 3) / 4) - 2;
    if (total + projected > LIMITS.inlineAttachmentBytes) {
      throw new GmailMcpError(
        "limit_exceeded",
        `limit_exceeded: inline attachments exceed ${LIMITS.inlineAttachmentBytes} bytes`,
      );
    }
    const bytes = decodeBase64(i.content_base64);
    total += bytes.byteLength;
    if (total > LIMITS.inlineAttachmentBytes) {
      throw new GmailMcpError(
        "limit_exceeded",
        `limit_exceeded: inline attachments exceed ${LIMITS.inlineAttachmentBytes} bytes`,
      );
    }
    out.push({
      filename: i.filename,
      mime: i.mime,
      size: bytes.byteLength,
      sha256: await sha256Hex(new Uint8Array(bytes)),
      bytes,
    });
  }
  return out;
}

/** The client's arguments as the intent hash sees them: inline bytes replaced by their digest. */
export function intentArgs(args: Record<string, unknown>, inline: DecodedInline[]): Record<string, unknown> {
  const { inline_attachments: _dropped, ...rest } = args;
  for (const k of Object.keys(rest)) if (rest[k] === undefined) delete rest[k];
  return inline.length === 0
    ? rest
    : {
        ...rest,
        inline_attachments: inline.map((d) => ({ filename: d.filename, mime: d.mime, size: d.size, sha256: d.sha256 })),
      };
}

/** Called only from a build step, after the decision: turns decoded inline bytes into upload handles. */
export async function stageInline(
  env: Env,
  userId: string,
  accountId: string,
  inline: DecodedInline[],
): Promise<string[]> {
  const handles: string[] = [];
  for (const d of inline) {
    const row = await ingest(env, {
      userId,
      accountId,
      direction: "upload",
      filename: d.filename,
      mime: d.mime,
      length: d.bytes.byteLength,
      body: new Response(d.bytes).body as ReadableStream<Uint8Array>,
      declaredSha256: d.sha256,
    });
    handles.push(row.handle);
  }
  return handles;
}

/** Ownership, expiry, the blocked list again (spec 2.7), and the account's aggregate cap. A read; writes nothing. */
export async function attachmentsFor(
  env: Env,
  userId: string,
  account: AccountRef,
  handles: string[],
  extraBytes = 0,
): Promise<{ rows: StagingRow[]; total: number }> {
  const rows = await listUploadHandles(env.DB, { handles, userId, accountId: account.id });
  for (const r of rows) assertNotBlocked(r.filename);
  const total = rows.reduce((n, r) => n + r.size, 0) + extraBytes;
  if (total > account.sendLimitBytes)
    throw new GmailMcpError(
      "limit_exceeded",
      `limit_exceeded: attachments ${total} > send limit ${account.sendLimitBytes} bytes`,
    );
  return { rows, total };
}

export function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
export function attachmentSummary(files: { filename: string; size: number }[]): string {
  if (files.length === 0) return "no attachments";
  return `${files.length} attachment${files.length === 1 ? "" : "s"} (${files.map((f) => `${f.filename}, ${human(f.size)}`).join("; ")})`;
}
export function recipientSummary(p: {
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string | null | undefined;
}): string {
  const parts = [`To: ${p.to.join(", ") || "none"}`];
  if (p.cc.length) parts.push(`Cc: ${p.cc.join(", ")}`);
  if (p.bcc.length) parts.push(`Bcc: ${p.bcc.join(", ")}`);
  parts.push(`Subject: ${p.subject ?? "(none)"}`);
  return parts.join(" · ");
}

export async function getMessage(
  env: Env,
  deps: Deps,
  acct: { userId: string; accountId: string },
  id: string,
  format: MessageFormat,
): Promise<GmailMessage> {
  const q = gmailFormatFor(format);
  return gmailJson<GmailMessage>(env, deps, acct, {
    method: "GET",
    path: `messages/${encodeURIComponent(id)}`,
    query: { format: q.format, metadataHeaders: q.metadataHeaders },
    retry: "safe",
  });
}

export async function fetchAttachmentBytes(
  env: Env,
  deps: Deps,
  acct: { userId: string; accountId: string },
  messageId: string,
  attachmentId: string,
): Promise<Uint8Array> {
  const body = await gmailJson<{ data?: string }>(env, deps, acct, {
    method: "GET",
    path: `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    retry: "safe",
  });
  if (!body.data) throw new GmailMcpError("handle_invalid", "handle_invalid: attachment body empty");
  return fromB64url(body.data);
}

export type CarriedAttachment = {
  message_id: string;
  attachment_id: string;
  filename: string;
  mime: string;
  size: number;
};
export type ComposePayload = ComposeArgs & {
  from: string;
  attachments: string[];
  carry: CarriedAttachment[];
  in_reply_to?: string | null | undefined;
  references?: string | null | undefined;
};

/**
 * Staged attachments stream from R2; carried originals are fetched from Gmail when their segment is
 * reached (one at a time, the JSON body of attachments.get is the bound). The message is never whole in memory.
 */
export async function composeMime(
  env: Env,
  deps: Deps,
  run: ExecRun,
  p: ComposePayload,
  operationId: string,
): Promise<{ body: ReadableStream<Uint8Array>; length: number; rfc822MessageId: string }> {
  const carryBytes = p.carry.reduce((n, c) => n + c.size, 0);
  const { rows } = await attachmentsFor(env, run.userId, run.account, p.attachments, carryBytes);
  const acct = { userId: run.userId, accountId: run.account.id };
  const attachments: MimeAttachment[] = [
    ...rows.map((r) => ({ filename: r.filename, mime: r.mime, size: r.size, open: () => openStaged(env, r) })),
    ...p.carry.map((c) => {
      assertNotBlocked(c.filename);
      return {
        filename: c.filename,
        mime: c.mime,
        size: c.size,
        open: async () =>
          new Response(await fetchAttachmentBytes(env, deps, acct, c.message_id, c.attachment_id)).body!,
      };
    }),
  ];
  const rfc822MessageId = messageIdFor(env, operationId);
  const { stream, length } = buildMimeStream({
    from: p.from,
    to: p.to,
    cc: p.cc,
    bcc: p.bcc,
    subject: p.subject ?? "",
    messageId: rfc822MessageId,
    inReplyTo: p.in_reply_to ?? undefined,
    references: p.references ?? undefined,
    text: p.body,
    html: p.html_body,
    attachments,
  });
  return { body: stream, length, rfc822MessageId };
}

/** Reply headers derived from the target (spec 2.3 `reply`): the Worker, not the model, threads the message. */
const isAddress = (s: string | null): s is string => s !== null;

/**
 * A header may hold a display name the restricted grammar of spec 2.7 refuses, such as
 * `"Office, Dean" <office@uni.test>`. A derived recipient keeps the address and drops the name: the
 * grammar is not loosened for addresses this server did not receive from its owner.
 */
function derivedMailbox(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const angled = /^[^<>]*<([^<>]+)>$/.exec(trimmed)?.[1]?.trim() ?? trimmed;
  for (const candidate of [trimmed, angled]) {
    try {
      parseAddress(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export function threadingFor(target: GmailMessage): {
  thread_id: string;
  subject: string;
  in_reply_to: string | null;
  references: string | null;
  from: string | null;
  reply_to: string[];
  to: string[];
  cc: string[];
} {
  const h = (n: string) => target.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? null;
  const subjectRaw = h("subject") ?? "";
  const subject = /^\s*re:/i.test(subjectRaw) ? subjectRaw : `Re: ${subjectRaw}`;
  const mid = h("message-id");
  const refs = [h("references"), mid].filter((x): x is string => !!x).join(" ");
  const split = (v: string | null) => (v ? splitAddressList(v).map(derivedMailbox).filter(isAddress) : []);
  return {
    thread_id: target.threadId,
    subject,
    in_reply_to: mid,
    references: refs || null,
    from: derivedMailbox(h("from") ?? ""),
    reply_to: split(h("reply-to")),
    to: split(h("to")),
    cc: split(h("cc")),
  };
}
