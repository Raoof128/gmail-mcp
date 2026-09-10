import type { Env } from "../env";
import { signToken, verifyToken } from "../crypto/hmac";

export const APPROVED_COOKIE = "__Host-approved";
const APPROVED_PURPOSE = "gmail-mcp:approved-clients:v1";
const APPROVED_TTL_MS = 30 * 86_400_000;

type Remembered = { sub: string; clients: string[] };

/** Remembered clients for this owner only. A cookie signed for another sub is treated as absent. */
export async function readApproved(env: Env, request: Request, userId: string): Promise<string[]> {
  const raw = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${APPROVED_COOKIE}=`));
  if (!raw) return [];
  const [payload, exp, sig] = raw.slice(APPROVED_COOKIE.length + 1).split(".");
  if (!payload || !exp || !sig) return [];
  if (!(await verifyToken(env.STATE_HMAC_KEY, APPROVED_PURPOSE, [payload], `${exp}.${sig}`))) return [];
  try {
    const rec = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as Partial<Remembered>;
    if (rec.sub !== userId || !Array.isArray(rec.clients) || !rec.clients.every((x) => typeof x === "string")) {
      return [];
    }
    return rec.clients;
  } catch {
    return [];
  }
}

export async function approvedCookie(env: Env, userId: string, ids: string[]): Promise<string> {
  const rec: Remembered = { sub: userId, clients: ids.slice(-20) };
  const payload = btoa(JSON.stringify(rec)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const token = await signToken(env.STATE_HMAC_KEY, APPROVED_PURPOSE, [payload], Date.now() + APPROVED_TTL_MS);
  return `${APPROVED_COOKIE}=${payload}.${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${APPROVED_TTL_MS / 1000}`;
}

export function clearApprovedCookie(): string {
  return `${APPROVED_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
