import { auditStatement, type AuditBase } from "../audit/log";

export type Settlement = {
  operationId: string | null;
  pendingId: string | null;
  /** null for intent-only reads (spec 3.10). */
  audit: (Omit<AuditBase, "decision"> & { gmailResultId?: string }) | null;
};

/**
 * Spec 3.9's "D1 error after a Gmail side effect" row is why every local consequence of one Gmail
 * result lands in one batch: the operation's terminal state and stored result, the reservations, the
 * pending row's purge, and the outcome audit row. A crash cannot leave the operation executed with its
 * handles still reserved, or the pending row executing after its operation finished.
 */
export async function settleExecuted(
  db: D1Database,
  s: Settlement & { gmailResultId: string | null; result: Record<string, unknown> },
): Promise<void> {
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  if (s.operationId) {
    stmts.push(
      db
        .prepare(
          `UPDATE operations SET state = 'executed', gmail_result_id = ?, result_json = ?, updated_at = ? WHERE id = ? AND state = 'executing'`,
        )
        .bind(s.gmailResultId, JSON.stringify(s.result), now, s.operationId),
      db
        .prepare(
          `INSERT INTO _assert (x) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM operations WHERE id = ? AND state = 'executed')`,
        )
        .bind(s.operationId),
      db
        .prepare(
          `UPDATE staging_objects SET consumed_at = ?, reserved_by_operation_id = NULL WHERE reserved_by_operation_id = ? AND consumed_at IS NULL`,
        )
        .bind(now, s.operationId),
    );
  }
  if (s.pendingId) {
    stmts.push(
      db
        .prepare(
          `UPDATE pending_actions SET state = 'executed', payload_json = NULL, summary = 'redacted', executed_at = ? WHERE id = ? AND state = 'executing'`,
        )
        .bind(now, s.pendingId),
      db
        .prepare(
          `INSERT INTO _assert (x) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM pending_actions WHERE id = ? AND state = 'executed')`,
        )
        .bind(s.pendingId),
    );
  }
  if (s.audit) stmts.push(auditStatement(db, "outcome", { ...s.audit, decision: "executed" }));
  if (stmts.length > 0) await db.batch(stmts);
}

/** Gmail provably did nothing: the operation is failed_safe, its reservations return to the pool, the pending row fails. */
export async function settleFailedSafe(
  db: D1Database,
  s: Settlement & { error: string; decision?: string },
): Promise<void> {
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  if (s.operationId) {
    stmts.push(
      db
        .prepare(
          `UPDATE operations SET state = 'failed_safe', updated_at = ? WHERE id = ? AND state IN ('claimed','executing')`,
        )
        .bind(now, s.operationId),
      db
        .prepare(
          `INSERT INTO _assert (x) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM operations WHERE id = ? AND state = 'failed_safe')`,
        )
        .bind(s.operationId),
      db
        .prepare(
          `UPDATE staging_objects SET reserved_by_operation_id = NULL WHERE reserved_by_operation_id = ? AND consumed_at IS NULL`,
        )
        .bind(s.operationId),
    );
  }
  if (s.pendingId) {
    stmts.push(
      db
        .prepare(
          `UPDATE pending_actions SET state = 'failed', payload_json = NULL, summary = 'redacted', error = ?, executed_at = ? WHERE id = ? AND state = 'executing'`,
        )
        .bind(s.error, now, s.pendingId),
    );
  }
  if (s.audit) stmts.push(auditStatement(db, "outcome", { ...s.audit, decision: s.decision ?? "failed" }));
  if (stmts.length > 0) await db.batch(stmts);
}

/** Gmail may have it: the operation stays executing for the cron; the pending row is finished and says why. */
export async function settleUnknown(db: D1Database, s: Settlement): Promise<void> {
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  if (s.pendingId) {
    stmts.push(
      db
        .prepare(
          `UPDATE pending_actions SET state = 'failed', payload_json = NULL, summary = 'redacted', error = 'delivery_unknown', executed_at = ? WHERE id = ? AND state = 'executing'`,
        )
        .bind(now, s.pendingId),
    );
  }
  if (s.audit) stmts.push(auditStatement(db, "outcome", { ...s.audit, decision: "delivery_unknown" }));
  if (stmts.length > 0) await db.batch(stmts);
}
