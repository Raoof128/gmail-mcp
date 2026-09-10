import type { Env } from "../../env";
import { auditStatement } from "../../audit/log";
import {
  approveStatement,
  assertStillPending,
  denyStatement,
  getPending,
  type PendingRow,
} from "../../approval/pending";
import { approvalView, type ApprovalView } from "../../approval/view";
import { csrfToken } from "../csrf";
import { escapeHtml, escapeVisible, redirect } from "../html";
import { type Route, guardPost, page, readForm, requireSession } from "../router";
import type { Session } from "../session";

const PREVIEW_BYTES = 2048;

function cutBytes(s: string, max: number): { text: string; truncated: boolean } {
  let out = "";
  let n = 0;
  for (const ch of s) {
    const len = new TextEncoder().encode(ch).length;
    if (n + len > max) return { text: out, truncated: true };
    out += ch;
    n += len;
  }
  return { text: out, truncated: false };
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const list = (items: string[]) => (items.length === 0 ? "none" : items.map(escapeVisible).join("<br>"));
const row = (th: string, td: string) => `<tr><th>${th}</th><td>${td}</td></tr>`;

/** Recipient and attachment counts for the audit summary; the audit module renders the text itself. */
function facts(view: ApprovalView): { recipients?: number; attachments?: number; ids?: string[] } {
  if (view.kind === "send")
    return { recipients: view.to.length + view.cc.length + view.bcc.length, attachments: view.handles.length };
  if (view.kind === "targets") return { ids: [...view.messageIds, ...view.threadIds] };
  if (view.kind === "label") return { ids: view.labelId ? [view.labelId] : [] };
  return {};
}

async function viewRows(env: Env, pending: PendingRow, view: ApprovalView): Promise<string> {
  switch (view.kind) {
    case "send": {
      const files =
        view.handles.length > 0
          ? (
              await env.DB.prepare(
                `SELECT handle, filename, size FROM staging_objects WHERE user_id = ? AND account_id = ? AND handle IN (${view.handles.map(() => "?").join(",")})`,
              )
                .bind(pending.user_id, pending.account_id, ...view.handles)
                .all<{ handle: string; filename: string; size: number }>()
            ).results
          : [];
      const attachments =
        files.length === 0 && view.handles.length === 0
          ? "none"
          : files.map((f) => `${escapeVisible(f.filename)} (${human(f.size)})`).join("<br>") +
            (files.length < view.handles.length
              ? `<br><em>${view.handles.length - files.length} handle(s) not found</em>`
              : "");
      return [
        view.messageId ? row("In reply to / forwarding", escapeVisible(view.messageId)) : "",
        view.draftId ? row("Draft", escapeVisible(view.draftId)) : "",
        row("To", list(view.to)),
        row("Cc", list(view.cc)),
        row("Bcc", list(view.bcc)),
        row("Subject", view.subject === null ? "none" : escapeVisible(view.subject)),
        row("Attachments", attachments),
        view.includeOriginalAttachments === null
          ? ""
          : row("Original attachments included", view.includeOriginalAttachments ? "yes" : "no"),
      ].join("");
    }
    case "targets":
      return [
        row("Messages", `${view.messageIds.length} message(s)<br>${list(view.messageIds)}`),
        row("Threads", `${view.threadIds.length} thread(s)<br>${list(view.threadIds)}`),
        view.add.length ? row("Add labels", list(view.add)) : "",
        view.remove.length ? row("Remove labels", list(view.remove)) : "",
      ].join("");
    case "label":
      return [
        row("Operation", escapeHtml(view.op ?? "?")),
        row("Label id", view.labelId ? escapeVisible(view.labelId) : "new"),
        row("Name", view.name ? escapeVisible(view.name) : "unchanged"),
      ].join("");
    case "upload":
      return [
        row("File", escapeVisible(view.filename)),
        row("Size", human(view.size)),
        row("Type", escapeVisible(view.mime)),
      ].join("");
    case "raw":
      return row(
        "Payload",
        `<p class="untrusted-label">This payload could not be summarised (${escapeHtml(view.reason)}). Read it in full before deciding.</p><pre class="untrusted">${escapeVisible(pending.payload_json ?? "")}</pre>`,
      );
  }
}

async function render(env: Env, s: Session, pending: PendingRow): Promise<Response> {
  const account = await env.DB.prepare("SELECT alias FROM accounts WHERE id = ? AND user_id = ?")
    .bind(pending.account_id, pending.user_id)
    .first<{ alias: string }>();
  if (pending.state !== "pending" || pending.expires_at <= Date.now()) {
    const state = pending.state === "pending" ? "expired" : pending.state;
    return page(
      env,
      s,
      "Action " + state,
      `<p>This action is <strong>${escapeHtml(state)}</strong>. Nothing more can be done with it here.</p>`,
    );
  }
  const view = approvalView(pending.action, pending.payload_json ? JSON.parse(pending.payload_json) : {});
  const preview = view.kind === "send" && view.body !== null ? cutBytes(view.body, PREVIEW_BYTES) : null;
  const csrf = await csrfToken(env, s, "POST", "/approve", pending.id);
  const modifiers = (JSON.parse(pending.modifiers) as string[]).map(escapeHtml).join(" ") || "none";
  const body = `
<table>
${row("Action", escapeHtml(pending.action))}
${row("Account", escapeHtml(account?.alias ?? pending.account_id))}
${row("Modifiers", modifiers)}
${await viewRows(env, pending, view)}
${row("Expires", new Date(pending.expires_at).toISOString())}
</table>
${
  preview === null
    ? ""
    : `<p class="untrusted-label">Untrusted email content follows. It was written by whoever composed this message, which may be the model. Links are not clickable.</p>
<pre class="untrusted">${escapeVisible(preview.text)}</pre>
${preview.truncated ? '<p class="muted">Preview truncated at 2 KB.</p>' : ""}`
}
<form method="post" action="/approve/${escapeHtml(pending.id)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<button name="decision" value="approve" class="approve">Approve</button>
<button name="decision" value="deny" class="deny">Deny</button>
</form>`;
  return page(env, s, "Approve this action?", body);
}

export const approveRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/approve\/(pa_[A-Za-z0-9_-]{22})$/,
    handler: async ({ env, request, params }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const pending = await getPending(env.DB, params[0]!, s.userId);
      if (!pending) return page(env, s, "Not found", "<p>No such action.</p>", 404);
      return render(env, s, pending);
    },
  },
  {
    method: "POST",
    pattern: /^\/approve\/(pa_[A-Za-z0-9_-]{22})$/,
    handler: async ({ env, request, params }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const form = await readForm(request);
      const refused = await guardPost(env, request, s, form, "/approve", params[0]!);
      if (refused) return refused;
      const pending = await getPending(env.DB, params[0]!, s.userId);
      if (!pending) return page(env, s, "Not found", "<p>No such action.</p>", 404);
      const decision = form.get("decision");
      if (decision !== "approve" && decision !== "deny")
        return page(env, s, "Not applied", "<p>Unknown decision.</p>", 400);
      const view = approvalView(pending.action, pending.payload_json ? JSON.parse(pending.payload_json) : {});
      const base = {
        userId: s.userId,
        accountId: pending.account_id,
        tool: "approve_page",
        action: pending.action,
        modifiers: JSON.parse(pending.modifiers) as string[],
        decision: decision === "approve" ? "approved" : "denied",
        pendingId: pending.id,
        facts: facts(view),
      };
      // One batch: the transition, an assertion that it happened, and the audit row. If the row was
      // already decided, the assertion fails, the batch rolls back, and no audit row claims otherwise.
      try {
        await env.DB.batch([
          assertStillPending(env.DB, pending.id),
          decision === "approve"
            ? approveStatement(env.DB, { id: pending.id, userId: s.userId, via: "browser" })
            : denyStatement(env.DB, { id: pending.id, userId: s.userId }),
          auditStatement(env.DB, "outcome", base),
        ]);
      } catch {
        return page(env, s, "Not applied", "<p>This action was already decided, cancelled or expired.</p>", 409);
      }
      return redirect(`/approve/${pending.id}`);
    },
  },
];
