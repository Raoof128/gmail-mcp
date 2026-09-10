import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ACTIONS, DEFAULT_POLICY } from "@gmail-mcp/shared/actions";
import { AccountAlias } from "@gmail-mcp/shared/schemas";
import type { Env } from "../env";
import type { Deps } from "../deps";
import type { Principal } from "../auth/principal";
import { auditIntent } from "../audit/log";
import { approvalCodec } from "../approval/state";
import { cancelPending } from "../approval/pending";
import { effectiveLevel } from "../policy/engine";
import { resolveAccount } from "../tools/accounts";
import { executePending, roundOf, type ToolContext } from "../tools/gate";
import { connectRequired, guarded, text } from "../tools/results";
import { registerLabelTools } from "../tools/labels";

export type Era = "legacy" | "modern";

/**
 * The seven control tools registered here read the owner's own state or are the approval mechanism
 * itself, and do not pass through the policy engine. Every Gmail tool is registered by the family
 * modules through defineTool, which is the only path to the gate.
 */
export function buildServer(env: Env, principal: Principal, deps: Deps, era: Era): McpServer {
  const codec = approvalCodec(env, principal);
  const server = new McpServer(
    { name: "gmail-mcp", version: "0.0.1" },
    // Wrapped rather than passed by reference: the codec's verify is a method and must keep its receiver.
    { requestState: { verify: (state, ctx) => codec.verify(state, ctx) } },
  );

  /** One ToolContext per call: the era and the request's capabilities decide whether a URL can be opened. */
  const toolContext = (ctx: ServerContext): ToolContext => ({
    env,
    deps,
    principal,
    urlElicitation: era === "modern" && server.server.getClientCapabilities()?.elicitation?.url !== undefined,
    round: roundOf(ctx, codec),
  });

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
    async ({ account }, ctx) =>
      guarded(toolContext(ctx), async () => {
        const acc = await resolveAccount(env, principal.userId, account);
        const policy: Record<string, string> = {};
        for (const a of ACTIONS)
          policy[a] =
            DEFAULT_POLICY[a] === "browser" ? "browser" : await effectiveLevel(env.DB, principal.userId, acc.id, a);
        return text({ account: acc.alias, policy });
      }),
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
    "execute_pending",
    {
      description: "Execute an action the owner approved in the browser. Claimable once; a replay is refused.",
      inputSchema: z.object({ action_id: z.string().regex(/^pa_[A-Za-z0-9_-]{22}$/) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ action_id }, ctx) => {
      const t = toolContext(ctx);
      return guarded(t, async () => text(await executePending(t, action_id)));
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

  server.registerTool(
    "connect_account",
    {
      description:
        "Connect or reconnect a Google account under an alias. Completes in the owner's browser; opens the page when the client can, else returns its URL.",
      inputSchema: z.object({ alias: AccountAlias }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ alias }, ctx) => {
      await auditIntent(env.DB, {
        userId: principal.userId,
        accountId: null,
        tool: "connect_account",
        action: "account.connect",
        modifiers: [],
        decision: "browser",
        facts: {},
      });
      return connectRequired(toolContext(ctx), alias);
    },
  );

  server.registerTool(
    "open_policy_editor",
    {
      description: "Policy is edited in the browser only. Returns the policy page URL.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      await auditIntent(env.DB, {
        userId: principal.userId,
        accountId: null,
        tool: "open_policy_editor",
        action: "policy.read",
        modifiers: [],
        decision: "browser",
        facts: {},
      });
      return text({ url: `https://${env.WORKER_HOSTNAME}/policy` });
    },
  );

  registerLabelTools(server, toolContext, env);

  return server;
}
