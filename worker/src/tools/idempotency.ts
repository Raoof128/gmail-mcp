import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Env } from "../env";
import { getPending, type PendingRow } from "../approval/pending";
import type { OperationRow } from "../operations/journal";
import { pendingApprovalResult } from "./results";

export type IdempotencyRow = {
  user_id: string;
  account_id: string;
  key: string;
  tool: string;
  intent_hash: string;
  pending_id: string | null;
  operation_id: string | null;
};

export function lookupIdempotency(
  db: D1Database,
  o: { userId: string; accountId: string; key: string },
): Promise<IdempotencyRow | null> {
  return db
    .prepare("SELECT * FROM idempotency_keys WHERE user_id = ? AND account_id = ? AND key = ?")
    .bind(o.userId, o.accountId, o.key)
    .first<IdempotencyRow>();
}

/**
 * Bind the key to a new pending action or operation. The upsert only moves a key whose current holder is
 * retired (a failed_safe operation, or a pending action that is denied, cancelled, expired or failed);
 * the assertion then fails the batch when the key still belongs to a live holder, which is how two
 * concurrent first calls with one key yield one send: the loser re-reads the key and replays.
 */
export function bindIdempotencyStatements(
  db: D1Database,
  o: {
    userId: string;
    accountId: string;
    key: string;
    tool: string;
    intentHash: string;
    pendingId: string | null;
    operationId: string | null;
    now: number;
  },
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO idempotency_keys (user_id, account_id, key, tool, intent_hash, pending_id, operation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, account_id, key) DO UPDATE SET
           pending_id = excluded.pending_id, operation_id = excluded.operation_id, updated_at = excluded.updated_at
         WHERE idempotency_keys.tool = excluded.tool AND idempotency_keys.intent_hash = excluded.intent_hash
           AND (idempotency_keys.operation_id IS NULL OR idempotency_keys.operation_id IN (SELECT id FROM operations WHERE state = 'failed_safe'))
           AND (idempotency_keys.pending_id IS NULL OR idempotency_keys.pending_id IN (
                 SELECT id FROM pending_actions WHERE state IN ('denied','cancelled','expired','failed')
                   OR (state IN ('executing','executed') AND operation_id IN (SELECT id FROM operations WHERE state = 'failed_safe'))))`,
      )
      .bind(o.userId, o.accountId, o.key, o.tool, o.intentHash, o.pendingId, o.operationId, o.now, o.now),
    db
      .prepare(
        `INSERT INTO _assert (x) SELECT 1 WHERE NOT EXISTS (
           SELECT 1 FROM idempotency_keys WHERE user_id = ? AND account_id = ? AND key = ?
             AND ((? IS NOT NULL AND pending_id = ?) OR (? IS NOT NULL AND operation_id = ?)))`,
      )
      .bind(o.userId, o.accountId, o.key, o.pendingId, o.pendingId, o.operationId, o.operationId),
  ];
}

const opRow = (db: D1Database, id: string) =>
  db.prepare("SELECT * FROM operations WHERE id = ?").bind(id).first<OperationRow>();

function replayOperation(op: OperationRow, alias: string): Record<string, unknown> | "fresh" {
  if (op.state === "failed_safe") return "fresh";
  if (op.state === "executed") {
    return {
      status: "executed",
      replayed: true,
      account: alias,
      operation_id: op.id,
      gmail_result_id: op.gmail_result_id,
      ...(JSON.parse(op.result_json ?? "{}") as object),
    };
  }
  return {
    status: "delivery_unknown",
    account: alias,
    operation_id: op.id,
    message: "The Gmail request may have succeeded. Do not retry automatically.",
  };
}

/**
 * Spec 3.5 step 1 over the whole lifecycle: executed replays the stored result, in flight or unknown
 * answers delivery_unknown, a live pending action is returned again, and a retired holder yields "fresh".
 * A key reused with a different tool or intent is a conflict, never a quiet replay.
 */
export async function replayFor(
  env: Env,
  row: IdempotencyRow,
  o: { tool: string; intentHash: string; alias: string; userId: string },
): Promise<Record<string, unknown> | "fresh"> {
  if (row.tool !== o.tool || row.intent_hash !== o.intentHash) {
    throw new GmailMcpError(
      "idempotency_conflict",
      "idempotency_conflict: key previously used for a different request",
    );
  }
  if (row.operation_id) {
    const op = await opRow(env.DB, row.operation_id);
    return op ? replayOperation(op, o.alias) : "fresh";
  }
  if (row.pending_id) {
    const p: PendingRow | null = await getPending(env.DB, row.pending_id, o.userId);
    if (!p) return "fresh";
    if (p.operation_id) {
      const op = await opRow(env.DB, p.operation_id);
      return op ? replayOperation(op, o.alias) : "fresh";
    }
    if (p.state === "pending" || p.state === "approved") return pendingApprovalResult(env, p, o.alias);
    return "fresh";
  }
  return "fresh";
}
