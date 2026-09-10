import type { Env } from "./env";
import { purgeExpired } from "./staging/store";
import { purgeStates } from "./web/state";

export type CronReport = {
  expiredPending: number;
  promotedUnknown: number;
  failedSafe: number;
  purgedStaging: number;
  purgedAudit: number;
  purgedStates: number;
};

const STALE_MS = 2 * 60_000;
const AUDIT_RETENTION_MS = 90 * 86_400_000;

/**
 * One transactional recovery for a stale `claimed` operation: the transition is asserted, so if the send
 * worker moved the row to `executing` in the meantime, nothing else in the batch runs.
 */
export async function recoverClaimed(db: D1Database, operationId: string, now: number): Promise<boolean> {
  try {
    await db.batch([
      db
        .prepare(`UPDATE operations SET state = 'failed_safe', updated_at = ? WHERE id = ? AND state = 'claimed'`)
        .bind(now, operationId),
      db
        .prepare(
          `INSERT INTO _assert (x) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM operations WHERE id = ? AND state = 'failed_safe')`,
        )
        .bind(operationId),
      db
        .prepare(
          `UPDATE staging_objects SET reserved_by_operation_id = NULL WHERE reserved_by_operation_id = ? AND consumed_at IS NULL`,
        )
        .bind(operationId),
      db
        .prepare(
          `UPDATE pending_actions SET state = 'failed', payload_json = NULL, summary = 'redacted', error = 'failed_safe' WHERE operation_id = ? AND state = 'executing'`,
        )
        .bind(operationId),
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function runCron(env: Env, now: number, limit = 200): Promise<CronReport> {
  const expired = await env.DB.prepare(
    `UPDATE pending_actions SET state = 'expired', payload_json = NULL, summary = 'redacted'
     WHERE id IN (SELECT id FROM pending_actions WHERE state IN ('pending','approved') AND expires_at <= ? LIMIT ?)`,
  )
    .bind(now, limit)
    .run();

  const promoted = await env.DB.prepare(
    `UPDATE operations SET state = 'delivery_unknown', updated_at = ?
     WHERE id IN (SELECT id FROM operations WHERE state = 'executing' AND updated_at <= ? LIMIT ?)`,
  )
    .bind(now, now - STALE_MS, limit)
    .run();

  const stale = await env.DB.prepare(`SELECT id FROM operations WHERE state = 'claimed' AND updated_at <= ? LIMIT ?`)
    .bind(now - STALE_MS, limit)
    .all<{ id: string }>();
  let failedSafe = 0;
  for (const r of stale.results) if (await recoverClaimed(env.DB, r.id, now)) failedSafe++;

  const staging = await purgeExpired(env, now, limit);
  const audit = await env.DB.prepare(
    `DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE ts <= ? LIMIT ?)`,
  )
    .bind(now - AUDIT_RETENTION_MS, limit)
    .run();

  return {
    expiredPending: expired.meta.changes ?? 0,
    promotedUnknown: promoted.meta.changes ?? 0,
    failedSafe,
    purgedStaging: staging.deleted,
    purgedAudit: audit.meta.changes ?? 0,
    purgedStates: await purgeStates(env.DB, now, limit),
  };
}
