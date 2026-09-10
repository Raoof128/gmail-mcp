import { ACTIONS, DEFAULT_POLICY, LEVELS, type Action, type Level } from "@gmail-mcp/shared/actions";
import type { Env } from "../../env";
import { applyPolicyEdit, type PolicyChange } from "../../policy/engine";
import { BLOCKED_EXTENSIONS } from "../../policy/limits";
import { csrfToken } from "../csrf";
import { escapeHtml, redirect } from "../html";
import { type Route, guardPost, page, readForm, requireRecent, requireSession } from "../router";
import type { Session } from "../session";

const EDITABLE = ACTIONS.filter((a) => DEFAULT_POLICY[a] !== "browser");
const OPTIONS = ["inherit", ...LEVELS] as const;

function select(name: string, current: string): string {
  return `<select name="${escapeHtml(name)}">${OPTIONS.map((o) => `<option value="${o}"${o === current ? " selected" : ""}>${o}</option>`).join("")}</select>`;
}

async function render(env: Env, s: Session): Promise<Response> {
  const accounts = (
    await env.DB.prepare("SELECT id, alias FROM accounts WHERE user_id = ? AND status != 'revoked' ORDER BY alias")
      .bind(s.userId)
      .all<{ id: string; alias: string }>()
  ).results;
  const overrides = (
    await env.DB.prepare("SELECT account_id, action, level FROM policies WHERE user_id = ?")
      .bind(s.userId)
      .all<{ account_id: string | null; action: string; level: string }>()
  ).results;
  const current = (accountId: string | null, action: string) =>
    overrides.find((o) => o.account_id === accountId && o.action === action)?.level ?? "inherit";
  const csrf = await csrfToken(env, s, "POST", "/policy", "policy");
  const head = `<tr><th>Action</th><th>Default</th><th>All accounts</th>${accounts.map((a) => `<th>${escapeHtml(a.alias)}</th>`).join("")}</tr>`;
  const rows = EDITABLE.map(
    (a) =>
      `<tr><td>${escapeHtml(a)}</td><td>${DEFAULT_POLICY[a]}</td><td>${select(`g:${a}`, current(null, a))}</td>${accounts
        .map((acc) => `<td>${select(`a:${acc.id}:${a}`, current(acc.id, a))}</td>`)
        .join("")}</tr>`,
  );
  rows.push(`<tr><td>policy.edit</td><td colspan="${2 + accounts.length}">browser only</td></tr>`);
  const body = `<p>Effective level is the account column, else the all-accounts column, else the default. Modifiers can only raise a level. Saving signs out every other browser session.</p>
<form method="post" action="/policy"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<table>${head}${rows.join("")}</table>
<p><button>Save policy</button></p></form>
<h2>Blocked upload extensions</h2>
<p class="muted">What Gmail refuses to send. Applies to uploads only.</p>
<p>${[...BLOCKED_EXTENSIONS]
    .sort()
    .map((e) => `.${escapeHtml(e)}`)
    .join(" ")}</p>`;
  return page(env, s, "Policy", body);
}

export const policyRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/policy$/,
    handler: async ({ env, request }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      return render(env, s);
    },
  },
  {
    method: "POST",
    pattern: /^\/policy$/,
    handler: async ({ env, request }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const form = await readForm(request);
      const refused = await guardPost(env, request, s, form, "/policy", "policy");
      if (refused) return refused;
      const recent = await requireRecent(env, s, request);
      if (recent) return recent;

      const accounts = new Set(
        (
          await env.DB.prepare("SELECT id FROM accounts WHERE user_id = ?").bind(s.userId).all<{ id: string }>()
        ).results.map((r) => r.id),
      );
      const overrides = (
        await env.DB.prepare("SELECT account_id, action, level FROM policies WHERE user_id = ?")
          .bind(s.userId)
          .all<{ account_id: string | null; action: string; level: string }>()
      ).results;
      const current = (accountId: string | null, action: string) =>
        overrides.find((o) => o.account_id === accountId && o.action === action)?.level ?? "inherit";

      // Validate everything before writing anything: a bad level anywhere means no change at all.
      const changes: (PolicyChange & { field: string })[] = [];
      for (const [field, value] of form.entries()) {
        const m = /^(g|a):(?:([^:]+):)?([a-z_.]+)$/.exec(field);
        if (!m) continue;
        const accountId = m[1] === "a" ? m[2]! : null;
        const action = m[3]!;
        if (!(EDITABLE as readonly string[]).includes(action)) continue;
        if (accountId !== null && !accounts.has(accountId)) continue;
        if (!(OPTIONS as readonly string[]).includes(value))
          return page(env, s, "Not saved", `<p>Unknown level for ${escapeHtml(field)}.</p>`, 400);
        if (value === current(accountId, action)) continue;
        changes.push({ accountId, action: action as Action, level: value as Level | "inherit", field });
      }
      await applyPolicyEdit(env.DB, {
        userId: s.userId,
        sessionIdHash: s.idHash,
        changes,
        audit: {
          userId: s.userId,
          accountId: null,
          tool: "policy_page",
          action: "policy.edit",
          modifiers: [],
          decision: "edited",
          facts: { ids: changes.map((c) => c.field) },
        },
      });
      return redirect("/policy");
    },
  },
];
