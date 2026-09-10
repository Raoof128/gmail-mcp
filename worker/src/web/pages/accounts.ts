import type { Env } from "../../env";
import { auditOutcome } from "../../audit/log";
import { getCompanionClientId, registerCompanionClient } from "../../auth/companion";
import { auditIntent } from "../../audit/log";
import { revokeAccount } from "../../google/tokens";
import { parseAddress, toAsciiDomain } from "../../policy/recipients";
import { csrfToken } from "../csrf";
import { escapeHtml, redirect } from "../html";
import { type Route, guardPost, page, readForm, requireRecent, requireSession } from "../router";
import { revokeOtherSessions, type Session } from "../session";

const MAX_SEND_LIMIT = 26_214_400;

type AccountRow = {
  id: string;
  alias: string;
  google_email: string;
  status: string;
  is_default: number;
  send_limit_bytes: number;
  org_domains: string | null;
};

/**
 * Stored exactly as isTrusted() will read it, through the same two functions. A pattern that these
 * reject is not a trust decision we could later honour, so it is refused here with the same error.
 */
function canonicalPattern(raw: string): string {
  const p = raw.trim();
  if (p.startsWith("@")) return `@${toAsciiDomain(p.slice(1))}`;
  return parseAddress(p).normalized;
}

async function render(env: Env, s: Session, notice?: string): Promise<Response> {
  const accounts = (
    await env.DB.prepare(
      "SELECT id, alias, google_email, status, is_default, send_limit_bytes, org_domains FROM accounts WHERE user_id = ? ORDER BY alias",
    )
      .bind(s.userId)
      .all<AccountRow>()
  ).results;
  const allow = (
    await env.DB.prepare("SELECT account_id, pattern FROM contact_allowlist WHERE user_id = ? ORDER BY pattern")
      .bind(s.userId)
      .all<{ account_id: string; pattern: string }>()
  ).results;
  const companion = await getCompanionClientId(env.DB);
  const rows: string[] = [];
  for (const a of accounts) {
    const csrf = await csrfToken(env, s, "POST", "/accounts", a.id);
    const hidden = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="account" value="${escapeHtml(a.id)}">`;
    const patterns = allow.filter((x) => x.account_id === a.id).map((x) => x.pattern);
    rows.push(`<section data-account="${escapeHtml(a.id)}">
<h2>${escapeHtml(a.alias)} <span class="muted">${escapeHtml(a.google_email)} · ${escapeHtml(a.status)}${a.is_default ? " · default" : ""}</span></h2>
<p><a href="/connect?alias=${encodeURIComponent(a.alias)}">Reconnect</a></p>
<form method="post" action="/accounts" class="inline">${hidden}<button name="op" value="default"${a.is_default || a.status !== "active" ? " disabled" : ""}>Make default</button></form>
<form method="post" action="/accounts" class="inline">${hidden}<button name="op" value="revoke" class="deny"${a.status === "revoked" ? " disabled" : ""}>Revoke</button></form>
<h3>Trusted recipients</h3>
<ul>${patterns.map((p) => `<li>${escapeHtml(p)} <form method="post" action="/accounts" class="inline">${hidden}<input type="hidden" name="pattern" value="${escapeHtml(p)}"><button name="op" value="allowlist_remove">Remove</button></form></li>`).join("")}</ul>
<form method="post" action="/accounts">${hidden}<input name="pattern" placeholder="name@example.com or @example.com" required> <button name="op" value="allowlist_add">Add</button></form>
<h3>Limits</h3>
<form method="post" action="/accounts">${hidden}<label>Send limit (bytes) <input name="bytes" type="number" min="1" max="${MAX_SEND_LIMIT}" value="${a.send_limit_bytes}"></label> <button name="op" value="send_limit">Save</button></form>
<form method="post" action="/accounts">${hidden}<label>Organisation domains (Workspace only, comma separated) <input name="domains" value="${escapeHtml((JSON.parse(a.org_domains ?? "[]") as string[]).join(", "))}"></label> <button name="op" value="org_domains">Save</button></form>
</section>`);
  }
  const companionCsrf = await csrfToken(env, s, "POST", "/accounts", "companion");
  const body = `${notice ? `<p><strong>${escapeHtml(notice)}</strong></p>` : ""}
<form method="get" action="/connect"><label>Connect a Google account as <input name="alias" pattern="[a-z0-9_-]{1,32}" required placeholder="personal"></label> <button>Connect</button></form>
${rows.join("\n")}
<section data-account="companion">
<h2>Local companion</h2>
${
  companion
    ? `<p>Client id for <code>gmail-mcp-companion login</code>:</p><pre>${escapeHtml(companion)}</pre>`
    : `<form method="post" action="/accounts"><input type="hidden" name="csrf" value="${escapeHtml(companionCsrf)}"><input type="hidden" name="account" value="companion"><button name="op" value="register_companion">Register the companion client</button></form>`
}
</section>`;
  return page(env, s, "Accounts", body);
}

export const accountsRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/accounts$/,
    handler: async ({ env, request }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      return render(env, s);
    },
  },
  {
    method: "POST",
    pattern: /^\/accounts$/,
    handler: async ({ env, deps, request }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const form = await readForm(request);
      const objectId = form.get("account") ?? "";
      const refused = await guardPost(env, request, s, form, "/accounts", objectId);
      if (refused) return refused;
      const op = form.get("op") ?? "";
      const bad = (msg: string) => page(env, s, "Not saved", `<p>${escapeHtml(msg)}</p>`, 400);
      const auditTrust = (accountId: string | null) =>
        auditIntent(env.DB, {
          userId: s.userId,
          accountId,
          tool: "accounts_page",
          action: "policy.edit",
          modifiers: [],
          decision: "edited",
          facts: { ids: [op] },
        });

      if (op === "register_companion") {
        if (objectId !== "companion") return bad("wrong object");
        const recent = await requireRecent(env, s, request);
        if (recent) return recent;
        await registerCompanionClient(env, env.OAUTH_PROVIDER);
        await auditTrust(null);
        return redirect("/accounts");
      }

      // Ownership in the query, for every per-account op. A wrong id is a 403 rather than a 404 because
      // the CSRF token already bound the form to this account id; a mismatch here is a forged form.
      const acc = await env.DB.prepare("SELECT id, status, send_limit_bytes FROM accounts WHERE id = ? AND user_id = ?")
        .bind(objectId, s.userId)
        .first<{ id: string; status: string; send_limit_bytes: number }>();
      if (!acc) return page(env, s, "Refused", "<p>Not your account.</p>", 403);

      // Anything that widens what a send may do without asking is a trust decision: recent login, audited.
      const widens =
        op === "revoke" ||
        op === "allowlist_add" ||
        op === "allowlist_remove" ||
        op === "org_domains" ||
        (op === "send_limit" && Number(form.get("bytes")) > acc.send_limit_bytes);
      if (widens) {
        const recent = await requireRecent(env, s, request);
        if (recent) return recent;
      }

      switch (op) {
        case "default": {
          if (acc.status !== "active") return bad("only an active account can be the default");
          await env.DB.batch([
            env.DB.prepare("UPDATE accounts SET is_default = 0 WHERE user_id = ? AND is_default = 1").bind(s.userId),
            env.DB.prepare("UPDATE accounts SET is_default = 1 WHERE id = ? AND user_id = ?").bind(acc.id, s.userId),
          ]);
          return redirect("/accounts");
        }
        case "revoke": {
          await revokeAccount(env, deps, s.userId, acc.id);
          await revokeOtherSessions(env.DB, s.userId, s.idHash);
          await auditOutcome(env.DB, {
            userId: s.userId,
            accountId: acc.id,
            tool: "accounts_page",
            action: "account.connect",
            modifiers: [],
            decision: "revoked",
            facts: { ids: [acc.id] },
          });
          await auditTrust(acc.id);
          return redirect("/accounts");
        }
        case "allowlist_add": {
          let pattern: string;
          try {
            pattern = canonicalPattern(form.get("pattern") ?? "");
          } catch {
            return bad("a trusted recipient is an address or @domain");
          }
          await env.DB.prepare(
            "INSERT OR IGNORE INTO contact_allowlist (user_id, account_id, pattern) VALUES (?, ?, ?)",
          )
            .bind(s.userId, acc.id, pattern)
            .run();
          await auditTrust(acc.id);
          return redirect("/accounts");
        }
        case "allowlist_remove": {
          await env.DB.prepare("DELETE FROM contact_allowlist WHERE user_id = ? AND account_id = ? AND pattern = ?")
            .bind(s.userId, acc.id, form.get("pattern") ?? "")
            .run();
          await auditTrust(acc.id);
          return redirect("/accounts");
        }
        case "send_limit": {
          const bytes = Number(form.get("bytes"));
          if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_SEND_LIMIT)
            return bad(`send limit must be 1..${MAX_SEND_LIMIT} bytes`);
          await env.DB.prepare("UPDATE accounts SET send_limit_bytes = ? WHERE id = ? AND user_id = ?")
            .bind(bytes, acc.id, s.userId)
            .run();
          if (widens) await auditTrust(acc.id);
          return redirect("/accounts");
        }
        case "org_domains": {
          let domains: string[];
          try {
            domains = (form.get("domains") ?? "")
              .split(",")
              .map((d) => d.trim())
              .filter((d) => d !== "")
              .map(toAsciiDomain);
          } catch {
            return bad("each organisation domain must be a valid domain name");
          }
          await env.DB.prepare("UPDATE accounts SET org_domains = ? WHERE id = ? AND user_id = ?")
            .bind(domains.length ? JSON.stringify(domains) : null, acc.id, s.userId)
            .run();
          await auditTrust(acc.id);
          return redirect("/accounts");
        }
        default:
          return bad("unknown operation");
      }
    },
  },
];
