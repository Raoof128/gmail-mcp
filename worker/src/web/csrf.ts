import type { Env } from "../env";
import { signToken, verifyToken } from "../crypto/hmac";
import type { Session } from "./session";

const PURPOSE = "gmail-mcp:csrf:v1";
const TTL_MS = 60 * 60_000;

/** Spec 4.6: HMAC over session_id, method, route and object id, with an expiry. Nothing is stored. */
export function csrfToken(env: Env, s: Session, method: string, route: string, objectId: string): Promise<string> {
  return signToken(env.CSRF_HMAC_KEY, PURPOSE, [s.id, method, route, objectId], Date.now() + TTL_MS);
}

export function verifyCsrf(
  env: Env,
  s: Session,
  method: string,
  route: string,
  objectId: string,
  token: string,
): Promise<boolean> {
  return verifyToken(env.CSRF_HMAC_KEY, PURPOSE, [s.id, method, route, objectId], token);
}

/** A cross-site form post carries the attacker's Origin, or "null". A same-site one carries ours. */
export function checkOrigin(request: Request, env: Env): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true;
  const origin = request.headers.get("origin");
  return origin === `https://${env.WORKER_HOSTNAME}`;
}
