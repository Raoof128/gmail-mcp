import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import { CreateDraftInput, UpdateDraftInput } from "@gmail-mcp/shared/schemas";
import type { Env } from "../env";
import type { Deps } from "../deps";
import { gmailJson } from "../google/gmail";
import { messageView, type GmailDraft } from "../google/messages";
import { uploadDraft } from "../operations/send";
import { defineTool, type Plan } from "./define";
import type { AccountRef } from "./accounts";
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
  type ComposePayload,
  type DecodedInline,
} from "./compose";
import type { ExecRun, ToolContext } from "./gate";

type DraftPayload = ComposePayload & {
  draft_id: string | null;
  thread_id: string | null;
  reply_to_message_id: string | null;
};
type ComposeLike = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string | undefined;
  body?: string | undefined;
  html_body?: string | undefined;
  from?: string | undefined;
  attachments?: string[] | undefined;
};
type Threading = {
  draft_id: string | null;
  thread_id: string | null;
  reply_to_message_id: string | null;
  in_reply_to: string | null;
  references: string | null;
};

/**
 * Everything the decision needs, and a deferred build for everything the execution needs. The build is
 * the only step that writes: it stages the inline bytes decoded earlier and returns the payload.
 */
async function planCompose(
  env: Env,
  userId: string,
  account: AccountRef,
  args: ComposeLike,
  inline: DecodedInline[],
  base: Threading,
): Promise<Plan> {
  validateCompose(args);
  const from = senderFor(account, args.from);
  const given = args.attachments ?? [];
  const { rows } = await attachmentsFor(
    env,
    userId,
    account,
    given,
    inline.reduce((n, d) => n + d.size, 0),
  );
  const files = [
    ...rows.map((r) => ({ filename: r.filename, size: r.size })),
    ...inline.map((d) => ({ filename: d.filename, size: d.size })),
  ];
  return {
    modifiers: [],
    summary: `${base.draft_id ? "Update draft" : "Create draft"} · ${recipientSummary(args)} · ${attachmentSummary(files)}`,
    facts: {
      recipients: args.to.length + args.cc.length + args.bcc.length,
      attachments: given.length + inline.length,
      ...(base.draft_id ? { ids: [base.draft_id] } : {}),
    },
    build: async () => {
      const attachments = [...given, ...(await stageInline(env, userId, account.id, inline))];
      const payload: DraftPayload = {
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        body: args.body,
        html_body: args.html_body,
        from,
        attachments,
        carry: [],
        ...base,
      };
      return { payload: payload as unknown as Record<string, unknown>, handles: attachments };
    },
  };
}

async function executeDraft(env: Env, deps: Deps, run: ExecRun) {
  const p = run.payload as unknown as DraftPayload;
  if (!run.operationId) throw new GmailMcpError("internal", "draft.write runs with an operation");
  const { body, length, rfc822MessageId } = await composeMime(env, deps, run, p, run.operationId);
  const d = await uploadDraft(env, deps, {
    userId: run.userId,
    accountId: run.account.id,
    operationId: run.operationId,
    body,
    length,
    threadId: p.thread_id,
    rfc822MessageId,
    draftId: p.draft_id,
  });
  return { gmail_result_id: d.id, draft: { id: d.id, message_id: d.message_id, thread_id: d.thread_id } };
}

const acct = (userId: string, account: AccountRef) => ({ userId, accountId: account.id });
const none: Threading = {
  draft_id: null,
  thread_id: null,
  reply_to_message_id: null,
  in_reply_to: null,
  references: null,
};

export function registerDraftTools(
  server: McpServer,
  toolContext: (ctx: ServerContext) => ToolContext,
  env: Env,
): void {
  defineTool(server, toolContext, env, {
    name: "create_draft",
    version: 1,
    description:
      "Create a draft, optionally as a reply. Attachments are staging handles; inline_attachments are converted to handles (1 MB total).",
    input: CreateDraftInput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    action: "draft.write",
    journal: true,
    plan: async (e, t, account, args, inline) => {
      let base = none;
      let subject = args.subject;
      let to = args.to;
      if (args.reply_to_message_id) {
        const th = threadingFor(
          await getMessage(e, t.deps, acct(t.principal.userId, account), args.reply_to_message_id, "METADATA_ONLY"),
        );
        base = {
          ...none,
          thread_id: th.thread_id,
          reply_to_message_id: args.reply_to_message_id,
          in_reply_to: th.in_reply_to,
          references: th.references,
        };
        subject ??= th.subject;
        if (to.length === 0 && args.cc.length === 0 && args.bcc.length === 0)
          to = th.reply_to.length ? th.reply_to : th.from ? [th.from] : [];
      }
      return planCompose(e, t.principal.userId, account, { ...args, subject, to }, inline, base);
    },
    execute: executeDraft,
  });

  defineTool(server, toolContext, env, {
    name: "update_draft",
    version: 1,
    description:
      "Update a draft. Each text field and recipient list the call gives replaces the draft's; each it omits is kept. The attachments given replace the set; give none and the draft has none.",
    input: UpdateDraftInput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    action: "draft.write",
    journal: true,
    plan: async (e, t, account, args, inline) => {
      const dr = await gmailJson<GmailDraft>(e, t.deps, acct(t.principal.userId, account), {
        method: "GET",
        path: `drafts/${encodeURIComponent(args.draft_id)}`,
        query: { format: "full" },
        retry: "safe",
      });
      const v = messageView(dr.message, { format: "FULL_CONTENT", bodyCharLimit: 1_000_000, includeBody: true });
      const merged: ComposeLike = {
        to: args.to ?? v.to,
        cc: args.cc ?? v.cc,
        bcc: args.bcc ?? v.bcc,
        subject: args.subject ?? v.subject ?? undefined,
        body: args.body ?? v.plaintext_body,
        html_body: args.html_body ?? v.html_body,
        from: args.from,
        attachments: args.attachments,
      };
      return planCompose(e, t.principal.userId, account, merged, inline, {
        draft_id: args.draft_id,
        thread_id: dr.message.threadId,
        reply_to_message_id: null,
        in_reply_to: v.in_reply_to,
        references: v.references,
      });
    },
    execute: executeDraft,
  });
}
