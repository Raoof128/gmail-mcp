export type StateKind = "login" | "reauth" | "connect" | "authreq";

/** Dead rows stay this long past expiry before they may be collected. */
const GRACE_MS = 3_600_000;
/**
 * Rows one insert may collect. Creating state is unauthenticated (GET /login, and /authorize for any
 * registered client), so a caller that only ever inserts would grow this table without bound: the
 * cron drains at most `limit` rows every five minutes. Collecting on the write path makes the fill
 * pay for the drain, so the table converges instead of growing with request volume.
 */
const COLLECT_PER_INSERT = 4;

const collectStatement = (db: D1Database, now: number, limit: number) =>
  db
    .prepare("DELETE FROM oauth_states WHERE id IN (SELECT id FROM oauth_states WHERE expires_at <= ? LIMIT ?)")
    .bind(now - GRACE_MS, limit);

export async function putState(
  db: D1Database,
  kind: StateKind,
  id: string,
  payload: object,
  ttlMs: number,
): Promise<void> {
  const now = Date.now();
  // One batch: a duplicate id still fails the whole write, exactly as the single insert did.
  await db.batch([
    db
      .prepare("INSERT INTO oauth_states (id, kind, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(id, kind, JSON.stringify(payload), now, now + ttlMs),
    collectStatement(db, now, COLLECT_PER_INSERT),
  ]);
}

/**
 * One statement, one winner. A second caller with the same id sees zero rows, whether the first
 * consumed it a millisecond ago or in another colo. This is the property KV could not give.
 */
export async function consumeState<T>(db: D1Database, kind: StateKind, id: string | null): Promise<T | null> {
  if (!id || !/^[a-z]{2}_[A-Za-z0-9_-]{22}$/.test(id)) return null;
  const now = Date.now();
  const row = await db
    .prepare(
      "UPDATE oauth_states SET consumed_at = ? WHERE id = ? AND kind = ? AND consumed_at IS NULL AND expires_at > ? RETURNING payload",
    )
    .bind(now, id, kind, now)
    .first<{ payload: string }>();
  return row ? (JSON.parse(row.payload) as T) : null;
}

export async function purgeStates(db: D1Database, now: number, limit = 200): Promise<number> {
  const res = await collectStatement(db, now, limit).run();
  return res.meta.changes ?? 0;
}
