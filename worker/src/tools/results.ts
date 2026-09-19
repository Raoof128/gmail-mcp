import { inputRequired, type CallToolResult, type InputRequiredResult } from "@modelcontextprotocol/server";
import type { Modifier } from "@gmail-mcp/shared/actions";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { PendingApprovalResult } from "@gmail-mcp/shared/schemas";
import type { Env } from "../env";
import type { PendingRow } from "../approval/pending";
import { connectUrl } from "../google/connect";
import type { ToolContext } from "./gate";

export type ToolResult = CallToolResult | InputRequiredResult;

/**
 * The one place every tool's result is shaped, so all 38 gain the same thing at once.
 *
 * MCP 2026-07-28 carries the machine-readable result in `structuredContent` beside the readable
 * `content` block; before this, an agent had to JSON.parse a string out of prose to read a result
 * it had just asked for. No `outputSchema` is advertised, which the spec allows: the schema is what
 * would bind the server to a shape, and these results are already described by the tool's own
 * documentation. The text block stays because a client that reads only `content` must still work,
 * and the SDK projects both eras from here.
 */
export function text(obj: unknown): CallToolResult {
  const content = [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }];
  // Only an object may ride in the 2025 wire shape, and every result here is one; anything else
  // would be wrapped by the SDK, so leave it in the text block alone rather than change its shape.
  return typeof obj === "object" && obj !== null && !Array.isArray(obj)
    ? { content, structuredContent: obj }
    : { content };
}

/** Every failure a tool reports is a structured, non-throwing result the model can read. */
export function toolError(e: unknown): CallToolResult {
  const err =
    e instanceof GmailMcpError
      ? e
      : new GmailMcpError("internal", "internal: the request failed before it could be classified");
  if (!(e instanceof GmailMcpError)) console.error("tool failure", (e as Error)?.message ?? e);
  const body = { error: err.code, message: err.message, details: err.details ?? {} };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
  };
}

export function approvalUrl(env: Env, pendingId: string): string {
  return `https://${env.WORKER_HOSTNAME}/approve/${pendingId}`;
}

/** Spec 2.6, exactly. */
export function pendingApprovalResult(env: Env, row: PendingRow, alias: string): PendingApprovalResult {
  return {
    status: "pending_approval",
    action_id: row.id,
    action: row.action,
    modifiers: JSON.parse(row.modifiers) as Modifier[],
    account: alias,
    summary: row.summary,
    approval: { mode: "url", url: approvalUrl(env, row.id) },
    expires_at: new Date(row.expires_at).toISOString(),
  };
}

/** Spec 3.3: a needs_reconnect account answers with the connect page, as elicitation when the client can open one. */
export async function connectRequired(t: ToolContext, alias: string): Promise<ToolResult> {
  const url = await connectUrl(t.env, t.principal.userId, alias);
  if (t.urlElicitation) {
    return inputRequired({
      inputRequests: {
        connect: inputRequired.elicitUrl({ message: `Reconnect the Gmail account "${alias}" to continue.`, url }),
      },
    });
  }
  return text({ status: "connect_required", account: alias, url });
}

/**
 * The token layer knows an account id, not the alias the owner types, so a credential failure raised
 * below the tool layer arrives without one. The tool layer, which resolved the account, names it here
 * so `guarded` can answer with the connect page instead of a bare error.
 */
export function withAlias(e: unknown, alias: string): unknown {
  if (e instanceof GmailMcpError && e.code === "account_needs_reconnect" && typeof e.details?.alias !== "string")
    return new GmailMcpError(e.code, e.message, { ...(e.details ?? {}), alias });
  return e;
}

/** Wraps every tool body: GmailMcpError becomes a structured error result; needs_reconnect becomes the connect flow; anything else is logged and reported as internal. */
export async function guarded(t: ToolContext, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof GmailMcpError && e.code === "account_needs_reconnect" && typeof e.details?.alias === "string")
      return connectRequired(t, e.details.alias);
    return toolError(e);
  }
}
