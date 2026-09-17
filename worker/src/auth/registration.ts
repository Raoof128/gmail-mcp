/**
 * Dynamic client registration (RFC 7591) is how a Claude client enrols itself, so the endpoint has to
 * exist. Left open it is also how an attacker mints a client with their own redirect URI and then
 * phishes the owner's consent page on this origin, which is the one origin the owner has reason to
 * trust. This deployment has a single owner, so registration is closed by default and the owner opens
 * a short window when they are actually adding a client.
 *
 * The window lives in the database, not in the request: no header, body or client metadata can lift
 * the refusal. The companion does not use the public endpoint at all; it calls createClient directly.
 */
export const REGISTRATION_KEY = "client_registration_open_until";
export const REGISTRATION_WINDOW_MS = 10 * 60_000;

export async function isRegistrationOpen(db: D1Database, now: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind(REGISTRATION_KEY)
    .first<{ value: string }>();
  if (!row) return false;
  const until = Number(row.value);
  return Number.isSafeInteger(until) && until > now;
}

/** Returns the instant the window closes. Reopening simply moves it; there is nothing to leak. */
export async function openRegistration(db: D1Database, now: number): Promise<number> {
  const until = now + REGISTRATION_WINDOW_MS;
  await db
    .prepare(
      "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    )
    .bind(REGISTRATION_KEY, String(until), now)
    .run();
  return until;
}

export async function closeRegistration(db: D1Database): Promise<void> {
  await db
    .prepare(
      "INSERT INTO settings(key,value,updated_at) VALUES(?,'0',?) ON CONFLICT(key) DO UPDATE SET value='0', updated_at=excluded.updated_at",
    )
    .bind(REGISTRATION_KEY, Date.now())
    .run();
}
