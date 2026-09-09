import type { Action } from "@gmail-mcp/shared/actions";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import { randomId } from "../crypto/random";

export type OpState = "claimed" | "executing" | "delivery_unknown" | "executed" | "failed_safe";
export type OperationRow = {
  id: string;
  user_id: string;
  account_id: string;
  action: string;
  idempotency_key: string | null;
  state: OpState;
  payload_hash: string;
  rfc822_message_id: string | null;
  gmail_result_id: string | null;
  created_at: number;
  updated_at: number;
};

/**
 * Insert-or-return. The unique partial index on (user_id, account_id, idempotency_key) is the arbiter:
 * INSERT OR IGNORE either creates the row or does nothing, and the SELECT that follows returns the winner.
 * A winner with a different action or payload hash is a conflict, never a silent reuse.
 */
export async function acquire(
  db: D1Database,
  o: { userId: string; accountId: string; action: Action; idempotencyKey?: string; payloadHash: string },
): Promise<{ operationId: string; existing: OperationRow | null }> {
  const id = randomId("op");
  const now = Date.now();
  if (!o.idempotencyKey) {
    await db
      .prepare(
        `INSERT INTO operations (id, user_id, account_id, action, idempotency_key, state, payload_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'claimed', ?, ?, ?)`,
      )
      .bind(id, o.userId, o.accountId, o.action, o.payloadHash, now, now)
      .run();
    return { operationId: id, existing: null };
  }
  await db
    .prepare(
      `INSERT OR IGNORE INTO operations (id, user_id, account_id, action, idempotency_key, state, payload_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?)`,
    )
    .bind(id, o.userId, o.accountId, o.action, o.idempotencyKey, o.payloadHash, now, now)
    .run();
  const row = await db
    .prepare("SELECT * FROM operations WHERE user_id = ? AND account_id = ? AND idempotency_key = ?")
    .bind(o.userId, o.accountId, o.idempotencyKey)
    .first<OperationRow>();
  if (!row) throw new GmailMcpError("internal", "acquire: row vanished after insert");
  if (row.action !== o.action || row.payload_hash !== o.payloadHash) {
    throw new GmailMcpError(
      "idempotency_conflict",
      "idempotency_conflict: key previously used for a different operation",
    );
  }
  if (row.id === id) return { operationId: id, existing: null };
  return { operationId: row.id, existing: row };
}

export async function transition(
  db: D1Database,
  operationId: string,
  from: OpState[],
  to: OpState,
  patch: { gmail_result_id?: string; rfc822_message_id?: string } = {},
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE operations SET state = ?, updated_at = ?,
         gmail_result_id = COALESCE(?, gmail_result_id), rfc822_message_id = COALESCE(?, rfc822_message_id)
       WHERE id = ? AND state IN (${from.map(() => "?").join(",")})`,
    )
    .bind(to, Date.now(), patch.gmail_result_id ?? null, patch.rfc822_message_id ?? null, operationId, ...from)
    .run();
  return (res.meta.changes ?? 0) === 1;
}
