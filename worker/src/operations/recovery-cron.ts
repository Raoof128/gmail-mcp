import { assertInstallation, installationAssertion } from "./installation";
import type { Env } from "../env";
import type { Deps } from "../deps";
import { claimRecovery, type RecoveryRow } from "./recovery-admission";
import { parseBinding, recordFailure } from "./recovery-state";
import { observeDelivery, settleRecovered } from "./reconcile";

/** Bounded metadata maintenance cannot release a delivery key or declare non-delivery. */
export async function cleanupRecovery(env: Env, now: number, limit = 200): Promise<void> {
  const db = env.DB;
  await db.batch([
    installationAssertion(env),
    db
      .prepare(
        `UPDATE operation_recovery SET session_enc=NULL,session_key_id=NULL,state=CASE WHEN state='completed' THEN state WHEN deadline<=? THEN 'manual' ELSE 'suspended' END,lease_token=NULL,lease_until=NULL WHERE operation_id IN (SELECT r.operation_id FROM operation_recovery r JOIN accounts a ON a.id=r.account_id AND a.user_id=r.user_id WHERE (r.state='active' OR r.session_enc IS NOT NULL) AND (r.deadline<=? OR a.status!='active' OR a.credential_version!=r.credential_version OR EXISTS(SELECT 1 FROM recovery_control c WHERE c.user_id=r.user_id AND c.account_id=r.account_id AND c.build_id=json_extract(r.binding_json,'$.buildId') AND c.credential_version=r.credential_version AND c.mode='send_session_status' AND c.state='disabled')) LIMIT ?)`,
      )
      .bind(now, now, limit),
    db
      .prepare(
        "DELETE FROM operation_recovery WHERE operation_id IN (SELECT operation_id FROM operation_recovery WHERE retain_until<=? LIMIT ?)",
      )
      .bind(now, limit),
    db
      .prepare(
        "DELETE FROM recovery_requests WHERE id IN (SELECT id FROM recovery_requests WHERE admitted_at<=? LIMIT ?)",
      )
      .bind(now - 86400000, limit),
    db
      .prepare(
        "DELETE FROM recovery_attempts WHERE rowid IN (SELECT rowid FROM recovery_attempts WHERE admitted_at<=? LIMIT ?)",
      )
      .bind(now - 86400000, limit),
    db
      .prepare(
        "DELETE FROM recovery_control WHERE rowid IN (SELECT rowid FROM recovery_control WHERE expires_at<=? LIMIT ?)",
      )
      .bind(now, limit),
  ]);
}
/** Filter durable eligibility before LIMIT so blocked owners cannot hide other accounts. */
export async function dueRecoveries(env: Env, now: number, window: number, limit = 200): Promise<RecoveryRow[]> {
  const rows = await env.DB.prepare(
    `WITH eligible AS (SELECT r.*, ROW_NUMBER() OVER (PARTITION BY r.account_id ORDER BY r.next_attempt_at,r.attempts,r.started_at,r.operation_id) AS account_rank FROM operation_recovery r
    JOIN accounts a ON a.user_id=r.user_id AND a.id=r.account_id
    JOIN operations o ON o.id=r.operation_id
    WHERE r.state='active' AND r.next_attempt_at<=? AND r.deadline>? AND r.attempts<288
    AND COALESCE(r.lease_until,0)<=? AND (r.last_window IS NULL OR r.last_window!=?)
    AND a.status='active' AND a.credential_version=r.credential_version
    AND o.settlement_protocol=2 AND o.state IN ('executing','delivery_unknown')
    AND json_extract(r.binding_json,'$.executor')!='send_draft'
    AND json_extract(r.binding_json,'$.buildId')=? AND json_extract(r.binding_json,'$.origin')=?
    AND (SELECT count(*) FROM recovery_attempts t WHERE t.window_id=? AND t.account_id=r.account_id)<2
    AND EXISTS(SELECT 1 FROM recovery_control c WHERE c.origin=json_extract(r.binding_json,'$.origin')
      AND c.build_id=json_extract(r.binding_json,'$.buildId') AND c.user_id=r.user_id AND c.account_id=r.account_id
      AND c.credential_version=r.credential_version AND c.expires_at>?
      AND (c.state='enabled' OR (c.state='probe' AND ?='scratch' AND EXISTS(SELECT 1 FROM json_each(c.probe_ids) WHERE value=r.operation_id)))
      AND ((c.mode='generated_search' AND json_extract(r.binding_json,'$.generatedMessageId') IS NOT NULL) OR (c.mode='send_session_status' AND r.session_enc IS NOT NULL)))
    ) SELECT * FROM eligible WHERE account_rank<=2 ORDER BY next_attempt_at,attempts,started_at,operation_id LIMIT ?`,
  )
    .bind(
      now,
      now,
      now,
      window,
      env.BUILD_ID,
      `https://${env.WORKER_HOSTNAME}`,
      window,
      now,
      env.RECOVERY_PROFILE,
      limit,
    )
    .all<RecoveryRow>();
  return rows.results;
}
export async function recoverDeliveries(
  env: Env,
  deps: Deps,
  scheduledTime: number,
  now: number,
): Promise<{ checked: number; confirmed: number; deferred: number; manual: number }> {
  await assertInstallation(env);
  const report = { checked: 0, confirmed: 0, deferred: 0, manual: 0 };
  if (!Number.isSafeInteger(scheduledTime) || scheduledTime > now || scheduledTime < now - 86400000) return report;
  const runUntil = now + 240000;
  const monotonicStart = performance.now();
  let lastTime = now;
  await cleanupRecovery(env, now);
  const stale = await env.DB.prepare(
    "SELECT id FROM operations WHERE settlement_protocol=2 AND state='executing' AND updated_at<=? LIMIT 200",
  )
    .bind(now - 120000)
    .all<{ id: string }>();
  for (const op of stale.results) {
    if (Date.now() >= runUntil || performance.now() - monotonicStart >= 240000) return report;
    await recordFailure(env, op.id);
  }
  const due = await dueRecoveries(env, now, Math.floor(scheduledTime / 300000));
  for (const r of due) {
    const current = Date.now();
    if (current < lastTime || current >= runUntil || performance.now() - monotonicStart >= 240000) break;
    lastTime = current;
    const lease = await claimRecovery(env, r.operation_id, Math.floor(scheduledTime / 300000), current, runUntil);
    if (!lease) continue;
    report.checked++;
    const b = parseBinding(JSON.parse(r.binding_json));
    const attemptUntil = Math.min(runUntil, current + 45000, r.deadline);
    const observation = await observeDelivery(env, deps, b, lease, {
      runUntil,
      attemptUntil,
      requestUntil: attemptUntil,
    });
    if (observation.kind === "confirmed") {
      const result = await settleRecovered(env, b, lease, observation.proof);
      if (result === "settled" || result === "replayed") {
        report.confirmed++;
        continue;
      }
    }
    const suspended = observation.kind === "suspended";
    const next = observation.kind === "deferred" ? observation.retryAt : Date.now() + 300000;
    const manual = suspended || next >= r.deadline;
    await env.DB.prepare(
      "UPDATE operation_recovery SET state=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL,session_enc=CASE WHEN ? THEN NULL ELSE session_enc END,session_key_id=CASE WHEN ? THEN NULL ELSE session_key_id END WHERE operation_id=? AND lease_token=? AND state='active'",
    )
      .bind(manual ? "manual" : "active", next, manual ? 1 : 0, manual ? 1 : 0, r.operation_id, lease.token)
      .run();
    if (manual) report.manual++;
    else report.deferred++;
  }
  return report;
}
