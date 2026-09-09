import type { Action, Modifier } from "@gmail-mcp/shared/actions";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import { canonicalize, hashCanonical } from "../crypto/canonical";
import { randomId } from "../crypto/random";
import { LIMITS } from "../policy/limits";

export const PENDING_TTL_MS = 15 * 60_000;

export type PendingState =
  "pending" | "approved" | "executing" | "executed" | "failed" | "denied" | "cancelled" | "expired";
export type PendingRow = {
  id: string;
  user_id: string;
  account_id: string;
  action: Action;
  modifiers: string;
  payload_json: string | null;
  payload_hash: string;
  summary: string;
  state: PendingState;
  operation_id: string | null;
  created_at: number;
  expires_at: number;
  approved_at: number | null;
  approved_via: string | null;
  execution_started_at: number | null;
  executed_at: number | null;
  error: string | null;
};

export async function createPending(
  db: D1Database,
  o: {
    userId: string;
    accountId: string;
    action: Action;
    modifiers: Modifier[];
    payload: unknown;
    summary: string;
    ttlMs?: number;
  },
): Promise<PendingRow> {
  const canonical = canonicalize(o.payload);
  if (new TextEncoder().encode(canonical).length > LIMITS.canonicalPayloadBytes) {
    throw new GmailMcpError("limit_exceeded", "limit_exceeded: canonical payload > 1 MB");
  }
  const hash = await hashCanonical(canonical);
  const id = randomId("pa");
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO pending_actions (id, user_id, account_id, action, modifiers, payload_json, payload_hash, summary, state, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .bind(
      id,
      o.userId,
      o.accountId,
      o.action,
      JSON.stringify(o.modifiers),
      canonical,
      hash,
      o.summary,
      now,
      now + (o.ttlMs ?? PENDING_TTL_MS),
    )
    .run();
  return (await getPending(db, id, o.userId))!;
}

export async function getPending(db: D1Database, id: string, userId: string): Promise<PendingRow | null> {
  return db.prepare("SELECT * FROM pending_actions WHERE id = ? AND user_id = ?").bind(id, userId).first<PendingRow>();
}

async function setState(
  db: D1Database,
  id: string,
  userId: string,
  from: PendingState[],
  to: PendingState,
  extra = "",
  binds: unknown[] = [],
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE pending_actions SET state = ? ${extra} WHERE id = ? AND user_id = ? AND state IN (${from.map(() => "?").join(",")}) AND expires_at > ?`,
    )
    .bind(to, ...binds, id, userId, ...from, Date.now())
    .run();
  return (res.meta.changes ?? 0) === 1;
}

export function approvePending(
  db: D1Database,
  o: { id: string; userId: string; via: "browser" | "elicitation" },
): Promise<boolean> {
  return setState(db, o.id, o.userId, ["pending"], "approved", ", approved_at = ?, approved_via = ?", [
    Date.now(),
    o.via,
  ]);
}
export function denyPending(db: D1Database, o: { id: string; userId: string }): Promise<boolean> {
  return setState(db, o.id, o.userId, ["pending"], "denied", ", payload_json = NULL, summary = 'redacted'");
}
/** The owner may withdraw approval any time before execution starts. */
export function cancelPending(db: D1Database, o: { id: string; userId: string }): Promise<boolean> {
  return setState(
    db,
    o.id,
    o.userId,
    ["pending", "approved"],
    "cancelled",
    ", payload_json = NULL, summary = 'redacted'",
  );
}

/** Terminal purge per spec 3.4. `executed_at` is set only here, when the side effect is confirmed. */
export async function finishPending(
  db: D1Database,
  id: string,
  to: "executed" | "failed",
  error?: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE pending_actions SET state = ?, payload_json = NULL, summary = 'redacted', error = ?, executed_at = ? WHERE id = ? AND state = 'executing'`,
    )
    .bind(to, error ?? null, Date.now(), id)
    .run();
}
