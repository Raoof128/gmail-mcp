import { ACTIONS } from "@gmail-mcp/shared/actions";
import { AccountAlias } from "@gmail-mcp/shared/schemas";
import { escapeHtml } from "../html";
import { type Route, page, requireSession } from "../router";

type Row = {
  ts: number;
  alias: string | null;
  tool: string | null;
  action: string | null;
  modifiers: string | null;
  phase: string;
  decision: string | null;
  pending_id: string | null;
  operation_id: string | null;
  summary: string | null;
};

export const auditRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/audit$/,
    handler: async ({ env, request, url }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const alias = AccountAlias.safeParse(url.searchParams.get("account"));
      const action = url.searchParams.get("action");
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 90));
      const where = ["l.user_id = ?", "l.ts >= ?"];
      const binds: unknown[] = [s.userId, Date.now() - days * 86_400_000];
      if (alias.success) {
        where.push("a.alias = ?");
        binds.push(alias.data);
      }
      if (action && (ACTIONS as readonly string[]).includes(action)) {
        where.push("l.action = ?");
        binds.push(action);
      }
      const rows = (
        await env.DB.prepare(
          `SELECT l.ts, a.alias, l.tool, l.action, l.modifiers, l.phase, l.decision, l.pending_id, l.operation_id, l.summary
           FROM audit_log l LEFT JOIN accounts a ON a.id = l.account_id AND a.user_id = l.user_id
           WHERE ${where.join(" AND ")} ORDER BY l.id DESC LIMIT 200`,
        )
          .bind(...binds)
          .all<Row>()
      ).results;
      const cell = (v: string | number | null) => `<td>${v === null ? "" : escapeHtml(String(v))}</td>`;
      const body = `<form method="get" action="/audit" class="inline">
<label>Account <input name="account" value="${alias.success ? escapeHtml(alias.data) : ""}"></label>
<label>Action <select name="action"><option value="">any</option>${ACTIONS.map((a) => `<option${a === action ? " selected" : ""}>${a}</option>`).join("")}</select></label>
<label>Days <input name="days" type="number" min="1" max="90" value="${days}"></label>
<button>Filter</button></form>
<table><tr><th>Time</th><th>Account</th><th>Tool</th><th>Action</th><th>Modifiers</th><th>Phase</th><th>Decision</th><th>Pending</th><th>Operation</th><th>Summary</th></tr>
${rows.map((r) => `<tr>${cell(new Date(r.ts).toISOString())}${cell(r.alias)}${cell(r.tool)}${cell(r.action)}${cell(r.modifiers)}${cell(r.phase)}${cell(r.decision)}${cell(r.pending_id)}${cell(r.operation_id)}${cell(r.summary)}</tr>`).join("")}
</table>
<p class="muted">Metadata only, kept 90 days. Bodies, subjects and tokens are never stored here.</p>`;
      return page(env, s, "Audit", body);
    },
  },
];
