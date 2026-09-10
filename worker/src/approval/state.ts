import { createRequestStateCodec, type RequestStateCodec } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import type { Principal } from "../auth/principal";
import { PENDING_TTL_MS } from "./pending";

export const APPROVAL_STATE_VERSION = "gmail-mcp:approval:v1";
export type ApprovalState = {
  v: typeof APPROVAL_STATE_VERSION;
  tool: string;
  pending_id: string;
  account_id: string;
  intent_hash: string;
};

/**
 * Spec 3.4: elicitation approval carries HMAC-signed state bound to the owner. The SDK codec signs with
 * STATE_HMAC_KEY, expires with the pending row, and binds to the principal and the method. The payload
 * is readable by the client, which is fine: it holds ids and a hash, never content.
 */
export function approvalCodec(env: Env, principal: Principal): RequestStateCodec<ApprovalState> {
  return createRequestStateCodec<ApprovalState>({
    key: Uint8Array.from(atob(env.STATE_HMAC_KEY), (c) => c.charCodeAt(0)),
    ttlSeconds: PENDING_TTL_MS / 1000,
    bind: (ctx) => `${principal.userId}\0${ctx.mcpReq.method}`,
  });
}
