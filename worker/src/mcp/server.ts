import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ACTIONS, DEFAULT_POLICY } from "@gmail-mcp/shared/actions";
import { AccountAlias } from "@gmail-mcp/shared/schemas";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Env } from "../env";
import type { Principal } from "./auth-dev";
import { effectiveLevel } from "../policy/engine";
import { cancelPending } from "../approval/pending";

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

async function resolveAccount(env: Env, userId: string, alias?: string): Promise<{ id: string; alias: string }> {
  const row = alias
    ? await env.DB.prepare("SELECT id, alias FROM accounts WHERE user_id = ? AND alias = ?")
        .bind(userId, alias)
        .first<{ id: string; alias: string }>()
    : await env.DB.prepare("SELECT id, alias FROM accounts WHERE user_id = ? AND is_default = 1")
        .bind(userId)
        .first<{ id: string; alias: string }>();
  if (!row)
    throw new GmailMcpError(
      "account_not_found",
      alias ? `account_not_found: ${alias}` : "account_not_found: no default account",
    );
  return row;
}

export function buildServer(env: Env, principal: Principal): McpServer {
  const server = new McpServer({ name: "gmail-mcp", version: "0.0.1" });

  server.registerTool(
    "list_accounts",
    {
      description: "List connected Gmail accounts: alias, email, status, default flag. Never returns tokens.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const rows = await env.DB.prepare(
        "SELECT alias, google_email AS email, status, is_default, scopes FROM accounts WHERE user_id = ? ORDER BY alias",
      )
        .bind(principal.userId)
        .all();
      return text({ accounts: rows.results });
    },
  );

  server.registerTool(
    "get_policy",
    {
      description: "Effective allow/ask/deny policy for an account after overrides.",
      inputSchema: z.object({ account: AccountAlias.optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ account }) => {
      const acc = await resolveAccount(env, principal.userId, account);
      const policy: Record<string, string> = {};
      for (const a of ACTIONS)
        policy[a] =
          DEFAULT_POLICY[a] === "browser" ? "browser" : await effectiveLevel(env.DB, principal.userId, acc.id, a);
      return text({ account: acc.alias, policy });
    },
  );

  server.registerTool(
    "list_pending",
    {
      description: "List pending and approved-but-unexecuted approvals for the caller.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const rows = await env.DB.prepare(
        `SELECT p.id, a.alias AS account, p.action, p.modifiers, p.summary, p.state, p.expires_at
         FROM pending_actions p JOIN accounts a ON a.id = p.account_id AND a.user_id = p.user_id
         WHERE p.user_id = ? AND p.state IN ('pending','approved') ORDER BY p.created_at DESC LIMIT 50`,
      )
        .bind(principal.userId)
        .all();
      return text({ pending: rows.results });
    },
  );

  server.registerTool(
    "cancel_pending",
    {
      description: "Withdraw a pending or approved action before it executes.",
      inputSchema: z.object({ action_id: z.string().regex(/^pa_[A-Za-z0-9_-]{22}$/) }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ action_id }) =>
      text({ cancelled: await cancelPending(env.DB, { id: action_id, userId: principal.userId }) }),
  );

  return server;
}
