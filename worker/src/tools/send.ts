import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { Modifier } from "@gmail-mcp/shared/actions";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import { ForwardInput, ReplyInput, SendDraftInput, SendMessageInput } from "@gmail-mcp/shared/schemas";
import type { Env } from "../env";
import type { Deps } from "../deps";
import { canonicalize, hashCanonical } from "../crypto/canonical";
import { gmailJson } from "../google/gmail";
import { messageView, type GmailDraft } from "../google/messages";
import { sendDraft, sendMime } from "../operations/send";
import { parseAddress, recipientModifiers } from "../policy/recipients";
import { trustContext, type AccountRef } from "./accounts";
import {
  attachmentSummary,
  attachmentsFor,
  composeMime,
  getMessage,
  recipientSummary,
  senderFor,
  stageInline,
  threadingFor,
  validateCompose,
  type CarriedAttachment,
  type ComposePayload,
  type DecodedInline,
} from "./compose";
import { defineTool, type Plan } from "./define";
import type { ExecRun, ToolContext } from "./gate";

type SendPayload = ComposePayload & {
  message_id?: string;
  thread_id?: string | null;
  include_original_attachments?: boolean;
};
type SendArgs = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string | undefined;
  body?: string | undefined;
  html_body?: string | undefined;
  from?: string | undefined;
  attachments?: string[] | undefined;
  idempotency_key?: string | undefined;
};
const acct = (userId: string, account: AccountRef) => ({ userId, accountId: account.id });
const openWorld = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

async function modifiersFor(
  env: Env,
  userId: string,
  account: AccountRef,
  p: { to: string[]; cc: string[]; bcc: string[] },
  hasAttachments: boolean,
): Promise<Modifier[]> {
  const mods = recipientModifiers([...p.to, ...p.cc, ...p.bcc], await trustContext(env, userId, account));
  if (hasAttachments) mods.unshift("+attachment");
  return mods;
}

function dedupe(list: string[], exclude: string[] = []): string[] {
  const seen = new Set(exclude.map((s) => parseAddress(s).normalized));
  const out: string[] = [];
  for (const r of list) {
    const n = parseAddress(r).normalized;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(r);
  }
  return out;
}

/** Shared plan for send_message, reply and forward once recipients and threading are settled. Writes nothing; the build does. */
async function planSend(
  env: Env,
  userId: string,
  account: AccountRef,
  args: SendArgs,
  inline: DecodedInline[],
  extra: Partial<SendPayload> & { carry: CarriedAttachment[] },
  verb: string,
): Promise<Plan> {
  validateCompose(args);
  if (args.to.length + args.cc.length + args.bcc.length === 0)
    throw new GmailMcpError("invalid_address", "invalid_address: at least one recipient is required");
  const from = senderFor(account, args.from);
  const given = args.attachments ?? [];
  const { rows } = await attachmentsFor(
    env,
    userId,
    account,
    given,
    extra.carry.reduce((n, c) => n + c.size, 0) + inline.reduce((n, d) => n + d.size, 0),
  );
  const files = [
    ...rows.map((r) => ({ filename: r.filename, size: r.size })),
    ...inline.map((d) => ({ filename: d.filename, size: d.size })),
    ...extra.carry,
  ];
  const recipients = { to: args.to, cc: args.cc, bcc: args.bcc };
  return {
    modifiers: await modifiersFor(
      env,
      userId,
      account,
      recipients,
      given.length + inline.length + extra.carry.length > 0,
    ),
    // Spec 2.6's summary opens with the recipients; a reply or a forward names itself first because the
    // owner needs to know which of the three they are approving, and a plain send has nothing to add.
    summary: `${verb ? `${verb} · ` : ""}${recipientSummary({ ...recipients, subject: args.subject })} · ${attachmentSummary(files)}`,
    facts: {
      recipients: args.to.length + args.cc.length + args.bcc.length,
      attachments: given.length + inline.length + extra.carry.length,
      ...(extra.message_id ? { ids: [extra.message_id] } : {}),
    },
    idempotencyKey: args.idempotency_key,
    build: async () => {
      const attachments = [...given, ...(await stageInline(env, userId, account.id, inline))];
      const payload: SendPayload = {
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        body: args.body,
        html_body: args.html_body,
        from,
        attachments,
        ...extra,
      };
      return { payload: payload as unknown as Record<string, unknown>, handles: attachments };
    },
  };
}

async function executeSend(env: Env, deps: Deps, run: ExecRun) {
  const p = run.payload as unknown as SendPayload;
  if (!run.operationId) throw new GmailMcpError("internal", "send runs with an operation");
  const { body, length, rfc822MessageId } = await composeMime(env, deps, run, p, run.operationId);
  const m = await sendMime(env, deps, {
    userId: run.userId,
    accountId: run.account.id,
    operationId: run.operationId,
    body,
    length,
    threadId: p.thread_id ?? null,
    rfc822MessageId,
  });
  return { gmail_result_id: m.id, message: m };
}

function quoted(v: ReturnType<typeof messageView>): string {
  return [
    "---------- Forwarded message ---------",
    `From: ${v.from ?? ""}`,
    `Date: ${v.date ?? ""}`,
    `Subject: ${v.subject ?? ""}`,
    `To: ${v.to.join(", ")}`,
    ...(v.cc.length ? [`Cc: ${v.cc.join(", ")}`] : []),
    "",
    v.plaintext_body ?? "",
  ].join("\n");
}

async function draftPayload(env: Env, deps: Deps, userId: string, account: AccountRef, draftId: string) {
  const dr = await gmailJson<GmailDraft>(env, deps, acct(userId, account), {
    method: "GET",
    path: `drafts/${encodeURIComponent(draftId)}`,
    query: { format: "full" },
    retry: "safe",
  });
  const v = messageView(dr.message, { format: "PLAIN_TEXT", bodyCharLimit: 1, includeBody: false });
  return {
    draft_id: draftId,
    message_id: dr.message.id,
    thread_id: dr.message.threadId,
    rfc822_message_id: v.message_id_header,
    to: v.to,
    cc: v.cc,
    bcc: v.bcc,
    subject: v.subject,
    attachments: [] as string[],
    draft_attachments: v.attachments.map((a) => ({ filename: a.filename, size: a.size })),
  };
}

export function registerSendTools(server: McpServer, toolContext: (ctx: ServerContext) => ToolContext, env: Env): void {
  defineTool(server, toolContext, env, {
    name: "send_message",
    version: 1,
    description:
      "Send new mail. Replies go through `reply`, existing drafts through `send_draft`. Attachments are staging handles.",
    input: SendMessageInput,
    annotations: openWorld,
    action: "send.message",
    journal: true,
    plan: (e, t, account, args, inline) => planSend(e, t.principal.userId, account, args, inline, { carry: [] }, ""),
    execute: executeSend,
  });

  defineTool(server, toolContext, env, {
    name: "reply",
    version: 1,
    description:
      "Reply to a message. The Worker derives the thread, subject, In-Reply-To and References. reply_all adds the original To and Cc minus this account.",
    input: ReplyInput,
    annotations: openWorld,
    action: "send.message",
    journal: true,
    plan: async (e, t, account, args, inline) => {
      const th = threadingFor(
        await getMessage(e, t.deps, acct(t.principal.userId, account), args.message_id, "METADATA_ONLY"),
      );
      const self = [account.email, ...account.sendAs];
      const primary = th.reply_to.length ? th.reply_to : th.from ? [th.from] : [];
      const to = dedupe([...primary, ...(args.reply_all ? th.to : []), ...args.to], self);
      const cc = dedupe(args.reply_all ? [...th.cc, ...args.cc] : args.cc, [...self, ...to]);
      return planSend(
        e,
        t.principal.userId,
        account,
        { ...args, to, cc, subject: th.subject },
        inline,
        {
          carry: [],
          message_id: args.message_id,
          thread_id: th.thread_id,
          in_reply_to: th.in_reply_to,
          references: th.references,
        },
        "Reply",
      );
    },
    execute: executeSend,
  });

  defineTool(server, toolContext, env, {
    name: "forward",
    version: 1,
    description:
      "Forward a message with optional text. Original attachments are excluded unless include_original_attachments is true.",
    input: ForwardInput,
    annotations: openWorld,
    action: "send.forward",
    journal: true,
    plan: async (e, t, account, args, inline) => {
      const v = messageView(
        await getMessage(e, t.deps, acct(t.principal.userId, account), args.message_id, "PLAIN_TEXT"),
        { format: "PLAIN_TEXT", bodyCharLimit: 200_000, includeBody: true },
      );
      const carry: CarriedAttachment[] = args.include_original_attachments
        ? v.attachments
            .filter((a) => a.attachment_id !== null)
            .map((a) => ({
              message_id: args.message_id,
              attachment_id: a.attachment_id!,
              filename: a.filename,
              mime: a.mime,
              size: a.size,
            }))
        : [];
      const subjectRaw = v.subject ?? "";
      const subject = /^\s*fwd?:/i.test(subjectRaw) ? subjectRaw : `Fwd: ${subjectRaw}`;
      const body = `${args.forward_text ? args.forward_text + "\n\n" : ""}${quoted(v)}`;
      return planSend(
        e,
        t.principal.userId,
        account,
        { ...args, subject, body },
        inline,
        {
          carry,
          message_id: args.message_id,
          thread_id: null,
          include_original_attachments: args.include_original_attachments,
        },
        "Forward",
      );
    },
    execute: executeSend,
  });

  defineTool(server, toolContext, env, {
    name: "send_draft",
    version: 1,
    description:
      "Send an existing draft. Recipients and attachments are read from the draft; a draft changed after approval is refused.",
    input: SendDraftInput,
    annotations: openWorld,
    action: "send.draft",
    journal: true,
    plan: async (e, t, account, args) => {
      const p = await draftPayload(e, t.deps, t.principal.userId, account, args.draft_id);
      // A draft with no subject stores null, which the approval page renders; the validator takes the
      // absent form.
      validateCompose({ ...p, subject: p.subject ?? undefined });
      return {
        modifiers: await modifiersFor(e, t.principal.userId, account, p, p.draft_attachments.length > 0),
        summary: `Send draft ${args.draft_id} · ${recipientSummary(p)} · ${attachmentSummary(p.draft_attachments)}`,
        facts: {
          recipients: p.to.length + p.cc.length + p.bcc.length,
          attachments: p.draft_attachments.length,
          ids: [args.draft_id],
        },
        idempotencyKey: args.idempotency_key,
        build: () => Promise.resolve({ payload: p, handles: [] }),
      };
    },
    execute: async (e, d, run) => {
      if (!run.operationId) throw new GmailMcpError("internal", "send.draft runs with an operation");
      const stored = run.payload as { draft_id: string; rfc822_message_id: string | null; tool: string; v: number };
      // Spec 3.4 "one approval covers one action": the draft must still be what the owner approved.
      const fresh = {
        ...(await draftPayload(e, d, run.userId, run.account, stored.draft_id)),
        tool: stored.tool,
        v: stored.v,
      };
      if ((await hashCanonical(canonicalize(fresh))) !== (await hashCanonical(canonicalize(run.payload)))) {
        throw new GmailMcpError("payload_mismatch", "payload_mismatch: the draft changed after it was approved");
      }
      const m = await sendDraft(e, d, {
        userId: run.userId,
        accountId: run.account.id,
        operationId: run.operationId,
        draftId: stored.draft_id,
        rfc822MessageId: stored.rfc822_message_id,
      });
      return { gmail_result_id: m.id, message: m };
    },
  });
}
