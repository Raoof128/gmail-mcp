import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import {
  DownloadAttachmentInput,
  DownloadAttachmentPayload,
  GetDraftInput,
  GetMessageInput,
  GetThreadInput,
  ListDraftsInput,
  ListLabelsInput,
  SearchThreadsInput,
  type MessageFormat,
} from "@gmail-mcp/shared/schemas";
import type { Env } from "../env";
import { fromB64url } from "../crypto/random";
import { gmailJson } from "../google/gmail";
import {
  findAttachment,
  gmailFormatFor,
  messageView,
  partData,
  type GmailDraft,
  type GmailLabel,
  type GmailThread,
} from "../google/messages";
import { LIMITS } from "../policy/limits";
import { withMaterialization } from "../staging/materialization";
import { ingest } from "../staging/store";
import { getMessage } from "./compose";
import { defineTool, type Plan } from "./define";
import type { ExecRun, ToolContext } from "./gate";
import { labelView } from "./labels";

const fmt = (f: MessageFormat | "MESSAGE_FORMAT_UNSPECIFIED"): MessageFormat =>
  f === "MESSAGE_FORMAT_UNSPECIFIED" ? "PLAIN_TEXT" : f;
const acct = (run: ExecRun) => ({ userId: run.userId, accountId: run.account.id });
const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
/** A read's payload is its arguments; nothing is staged, so the build is immediate. */
const readPlan = (args: Record<string, unknown>, summary: string, ids: string[] = []): Promise<Plan> => {
  const { account: _account, ...payload } = args;
  return Promise.resolve({
    modifiers: [],
    summary,
    facts: ids.length ? { ids } : {},
    build: () => Promise.resolve({ payload, handles: [] }),
  });
};

/**
 * Reads pass through the same gate as writes: the policy engine may deny or ask for any action, and
 * every call leaves one intent row. They are not journaled because they change nothing outside.
 */
export function registerReadTools(server: McpServer, toolContext: (ctx: ServerContext) => ToolContext, env: Env): void {
  defineTool(server, toolContext, env, {
    name: "search_threads",
    version: 1,
    description: "Search threads with Gmail query syntax. Paginated; limit at most 50.",
    input: SearchThreadsInput,
    annotations: ro,
    action: "read.search",
    journal: false,
    plan: (_e, _t, _a, args) => readPlan(args, `Search threads: ${args.query ?? "(all)"}`),
    execute: async (e, d, run) => {
      const p = SearchThreadsInput.omit({ account: true }).parse(run.payload);
      const res = await gmailJson<{
        threads?: { id: string; snippet?: string }[];
        nextPageToken?: string;
        resultSizeEstimate?: number;
      }>(e, d, acct(run), {
        method: "GET",
        path: "threads",
        query: { q: p.query, maxResults: p.limit, pageToken: p.page_token, includeSpamTrash: p.include_spam_trash },
        retry: "safe",
      });
      return {
        threads: (res.threads ?? []).map((t) => ({ id: t.id, snippet: t.snippet ?? "" })),
        result_size_estimate: res.resultSizeEstimate ?? 0,
        ...(res.nextPageToken ? { next_page_token: res.nextPageToken } : {}),
      };
    },
  });

  defineTool(server, toolContext, env, {
    name: "get_thread",
    version: 1,
    description:
      "A thread and its messages. PLAIN_TEXT by default; bodies cut at body_char_limit and under total_body_char_limit across the thread; at most max_messages.",
    input: GetThreadInput,
    annotations: ro,
    action: "read.message",
    journal: false,
    plan: (_e, _t, _a, args) => readPlan(args, `Get thread ${args.thread_id}`, [args.thread_id]),
    execute: async (e, d, run) => {
      const p = GetThreadInput.omit({ account: true }).parse(run.payload);
      const f = fmt(p.message_format);
      const q = gmailFormatFor(f);
      const t = await gmailJson<GmailThread>(e, d, acct(run), {
        method: "GET",
        path: `threads/${encodeURIComponent(p.thread_id)}`,
        query: { format: q.format, metadataHeaders: q.metadataHeaders },
        retry: "safe",
      });
      const all = t.messages ?? [];
      const shown = all.slice(0, p.max_messages);
      let budget = p.total_body_char_limit;
      let omitted = 0;
      const messages = shown.map((m) => {
        const view = messageView(m, {
          format: f,
          bodyCharLimit: Math.min(p.body_char_limit, Math.max(budget, 0)),
          includeBody: p.include_body && budget > 0,
        });
        if (p.include_body && budget <= 0) omitted++;
        budget -= (view.plaintext_body?.length ?? 0) + (view.html_body?.length ?? 0) + (view.raw?.length ?? 0);
        return view;
      });
      return { thread: { id: t.id, messages, messages_omitted: all.length - shown.length, bodies_omitted: omitted } };
    },
  });

  defineTool(server, toolContext, env, {
    name: "get_message",
    version: 1,
    description: "One message. Attachments are listed as metadata; use download_attachment for bytes.",
    input: GetMessageInput,
    annotations: ro,
    action: "read.message",
    journal: false,
    plan: (_e, _t, _a, args) => readPlan(args, `Get message ${args.message_id}`, [args.message_id]),
    execute: async (e, d, run) => {
      const p = GetMessageInput.omit({ account: true }).parse(run.payload);
      const f = fmt(p.message_format);
      return {
        message: messageView(await getMessage(e, d, acct(run), p.message_id, f), {
          format: f,
          bodyCharLimit: p.body_char_limit,
          includeBody: p.include_body,
        }),
      };
    },
  });

  defineTool(server, toolContext, env, {
    name: "list_drafts",
    version: 1,
    description: "List drafts, optionally filtered by a Gmail query. Paginated.",
    input: ListDraftsInput,
    annotations: ro,
    action: "read.message",
    journal: false,
    plan: (_e, _t, _a, args) => readPlan(args, "List drafts"),
    execute: async (e, d, run) => {
      const p = ListDraftsInput.omit({ account: true }).parse(run.payload);
      const res = await gmailJson<{
        drafts?: { id: string; message: { id: string; threadId: string } }[];
        nextPageToken?: string;
      }>(e, d, acct(run), {
        method: "GET",
        path: "drafts",
        query: { q: p.query, maxResults: p.limit, pageToken: p.page_token },
        retry: "safe",
      });
      return {
        drafts: (res.drafts ?? []).map((x) => ({ id: x.id, message_id: x.message.id, thread_id: x.message.threadId })),
        ...(res.nextPageToken ? { next_page_token: res.nextPageToken } : {}),
      };
    },
  });

  defineTool(server, toolContext, env, {
    name: "get_draft",
    version: 1,
    description: "One draft with its message.",
    input: GetDraftInput,
    annotations: ro,
    action: "read.message",
    journal: false,
    plan: (_e, _t, _a, args) => readPlan(args, `Get draft ${args.draft_id}`, [args.draft_id]),
    execute: async (e, d, run) => {
      const p = GetDraftInput.omit({ account: true }).parse(run.payload);
      const f = fmt(p.message_format);
      const dr = await gmailJson<GmailDraft>(e, d, acct(run), {
        method: "GET",
        path: `drafts/${encodeURIComponent(p.draft_id)}`,
        query: { format: gmailFormatFor(f).format },
        retry: "safe",
      });
      return {
        draft: {
          id: dr.id,
          message: messageView(dr.message, { format: f, bodyCharLimit: p.body_char_limit, includeBody: true }),
        },
      };
    },
  });

  defineTool(server, toolContext, env, {
    name: "list_labels",
    version: 1,
    description: "All labels. System labels are read-only.",
    input: ListLabelsInput,
    annotations: ro,
    action: "read.message",
    journal: false,
    plan: () => readPlan({}, "List labels"),
    execute: async (e, d, run) => ({
      labels: (
        (await gmailJson<{ labels?: GmailLabel[] }>(e, d, acct(run), { method: "GET", path: "labels", retry: "safe" }))
          .labels ?? []
      ).map(labelView),
    }),
  });

  defineTool(server, toolContext, env, {
    name: "download_attachment",
    version: 1,
    description:
      "Fetch one attachment into staging by attachment_id or part_id and return a handle. Bytes never enter the result. 25 MB ceiling.",
    input: DownloadAttachmentInput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    action: "read.attachment",
    journal: false,
    plan: (_e, _t, _a, args) =>
      readPlan(
        args,
        `Download attachment ${args.attachment_id ?? `part ${args.part_id}`} of message ${args.message_id}`,
        [args.message_id],
      ),
    execute: async (e, d, run) =>
      withMaterialization(
        e,
        async (materialization) => {
          const p = DownloadAttachmentPayload.parse(run.payload);
          // Spec 3.7: the part's size comes from the message's part tree (format=full carries sizes, not
          // bytes for external parts), and anything over the ceiling is refused before attachments.get.
          const m = await getMessage(e, d, acct(run), p.message_id, "PLAIN_TEXT");
          const meta = p.attachment_id
            ? findAttachment(m, { attachmentId: p.attachment_id })
            : findAttachment(m, { partId: p.part_id! });
          if (!meta)
            throw new GmailMcpError("handle_invalid", `handle_invalid: no such attachment on message ${p.message_id}`);
          if (meta.size > LIMITS.stagedFileBytes)
            throw new GmailMcpError(
              "limit_exceeded",
              `limit_exceeded: attachment is ${meta.size} bytes, ceiling ${LIMITS.stagedFileBytes}`,
            );
          let bytes: Uint8Array;
          if (meta.attachment_id) {
            const body = await gmailJson<{ data?: string }>(e, d, acct(run), {
              method: "GET",
              path: `messages/${encodeURIComponent(p.message_id)}/attachments/${encodeURIComponent(meta.attachment_id)}`,
              retry: "safe",
            });
            if (!body.data) throw new GmailMcpError("handle_invalid", "handle_invalid: attachment body empty");
            bytes = fromB64url(body.data);
          } else {
            const data = partData(m, meta.part_id);
            if (!data) throw new GmailMcpError("handle_invalid", "handle_invalid: inline part without data");
            bytes = fromB64url(data);
          }
          const row = await ingest(e, {
            userId: run.userId,
            accountId: run.account.id,
            materialization,
            direction: "download",
            filename: meta.filename,
            mime: meta.mime,
            length: bytes.byteLength,
            body: new Response(bytes).body as ReadableStream<Uint8Array>,
            source: { messageId: p.message_id, attachmentId: meta.attachment_id ?? `part:${meta.part_id}` },
          });
          return {
            handle: row.handle,
            filename: row.filename,
            mime: row.mime,
            size: row.size,
            sha256: row.sha256,
            expires_at: new Date(row.expires_at).toISOString(),
          };
        },
        { userId: run.userId, accountId: run.account.id, bytes: LIMITS.stagedFileBytes },
      ),
  });
}
