import type { Env } from "../env";

export type Principal = { userId: string; scope: "mcp" | "staging" };

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Dev only. Both secrets must be present; a bypass never manufactures an identity. Plan 2 deletes this file. */
export function authenticateDev(request: Request, env: Env): Principal | null {
  if (!env.DEV_STATIC_TOKEN || !env.DEV_STATIC_USER) return null;
  const m = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (!m || !constantTimeEqual(m[1]!, env.DEV_STATIC_TOKEN)) return null;
  return { userId: env.DEV_STATIC_USER, scope: "mcp" };
}
