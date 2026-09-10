import { sha256Hex } from "../crypto/canonical";
import { b64url } from "../crypto/random";

export const SESSION_COOKIE = "__Host-session";
export const ABSOLUTE_MS = 12 * 3_600_000;
export const IDLE_MS = 2 * 3_600_000;
export const RECENT_AUTH_MS = 15 * 60_000;
const TOUCH_EVERY_MS = 60_000;

export type Session = {
  id: string;
  idHash: string;
  userId: string;
  authenticatedAt: number;
  lastSeenAt: number;
};

function hashId(id: string): Promise<string> {
  return sha256Hex(new Uint8Array(new TextEncoder().encode(id)));
}

function cookieFor(id: string): string {
  // __Host- means the browser only sends it on this exact host over https with Path=/, which is
  // the whole reason the prefix is used: a cookie a subdomain could set would not pass this check.
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function createSession(
  db: D1Database,
  userId: string,
): Promise<{ id: string; idHash: string; cookie: string }> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const id = b64url(raw);
  const idHash = await hashId(id);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO web_sessions (id_hash, user_id, created_at, authenticated_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(idHash, userId, now, now, now, now + ABSOLUTE_MS)
    .run();
  return { id, idHash, cookie: cookieFor(id) };
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export async function readSession(db: D1Database, request: Request): Promise<Session | null> {
  const id = cookieValue(request, SESSION_COOKIE);
  if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
  const idHash = await hashId(id);
  const now = Date.now();
  const row = await db
    .prepare(
      `SELECT user_id, authenticated_at, last_seen_at FROM web_sessions
       WHERE id_hash = ? AND revoked_at IS NULL AND expires_at > ? AND last_seen_at > ?`,
    )
    .bind(idHash, now, now - IDLE_MS)
    .first<{ user_id: string; authenticated_at: number; last_seen_at: number }>();
  if (!row) return null;
  if (now - row.last_seen_at >= TOUCH_EVERY_MS) {
    await db.prepare("UPDATE web_sessions SET last_seen_at = ? WHERE id_hash = ?").bind(now, idHash).run();
  }
  return { id, idHash, userId: row.user_id, authenticatedAt: row.authenticated_at, lastSeenAt: row.last_seen_at };
}

/** Spec 4.6: only a fresh Google login counts. Activity never extends it. */
export function isRecentlyAuthenticated(s: Session, now = Date.now()): boolean {
  return now - s.authenticatedAt < RECENT_AUTH_MS;
}

export async function markReauthenticated(db: D1Database, idHash: string): Promise<void> {
  await db.prepare("UPDATE web_sessions SET authenticated_at = ? WHERE id_hash = ?").bind(Date.now(), idHash).run();
}

export async function revokeSession(db: D1Database, idHash: string): Promise<void> {
  await db
    .prepare("UPDATE web_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL")
    .bind(Date.now(), idHash)
    .run();
}

export async function revokeOtherSessions(db: D1Database, userId: string, keepIdHash: string): Promise<void> {
  await db
    .prepare("UPDATE web_sessions SET revoked_at = ? WHERE user_id = ? AND id_hash != ? AND revoked_at IS NULL")
    .bind(Date.now(), userId, keepIdHash)
    .run();
}
