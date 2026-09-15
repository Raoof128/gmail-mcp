import { installationAssertion } from "./installation";
import type { Env } from "../env";
import type { Binding, Deadlines, Lease, RecoveryMode } from "./recovery-types";
import { assertion, parseBinding } from "./recovery-state";
import { randomId } from "../crypto/random";

export type RecoveryRow = {
  operation_id: string;
  binding_json: string;
  state: string;
  started_at: number;
  deadline: number;
  retain_until: number;
  next_attempt_at: number;
  attempts: number;
  last_window: number | null;
  lease_token: string | null;
  lease_until: number | null;
  session_enc: ArrayBuffer | null;
  session_key_id: string | null;
  session_digest: string | null;
  mime_length: number | null;
  confirmed_offset: number;
};
export const recoveryRow = (db: D1Database, id: string) =>
  db.prepare("SELECT * FROM operation_recovery WHERE operation_id=?").bind(id).first<RecoveryRow>();
export function qualificationFence(env: Env, b: Binding, lease: Lease, now: number): D1PreparedStatement {
  return assertion(
    env.DB,
    `EXISTS(SELECT 1 FROM recovery_control c WHERE c.origin=? AND c.build_id=? AND c.user_id=? AND c.account_id=? AND c.credential_version=? AND c.mode=? AND c.epoch=? AND c.expires_at>? AND (c.state='enabled' OR (c.state='probe' AND ? IN ('normal','scratch') AND EXISTS(SELECT 1 FROM json_each(c.probe_ids) WHERE value=?))))`,
    b.origin,
    env.BUILD_ID,
    b.userId,
    b.accountId,
    b.credentialVersion,
    lease.mode,
    lease.qualificationEpoch,
    now,
    env.RECOVERY_PROFILE,
    b.operationId,
  );
}
export function recoveryFences(env: Env, b: Binding, lease: Lease, now: number): D1PreparedStatement[] {
  return [
    installationAssertion(env),
    assertion(env.DB, "?=? AND ?=?", b.buildId, env.BUILD_ID, b.origin, `https://${env.WORKER_HOSTNAME}`),
    qualificationFence(env, b, lease, now),
    assertion(
      env.DB,
      `EXISTS(SELECT 1 FROM operation_recovery r JOIN accounts a ON a.id=r.account_id AND a.user_id=r.user_id JOIN operations o ON o.id=r.operation_id WHERE r.operation_id=? AND r.user_id=? AND r.account_id=? AND r.credential_version=? AND r.state='active' AND r.lease_token=? AND r.lease_until>? AND r.deadline>? AND a.status='active' AND a.credential_version=r.credential_version AND o.settlement_protocol=2 AND o.state IN ('executing','delivery_unknown'))`,
      b.operationId,
      b.userId,
      b.accountId,
      b.credentialVersion,
      lease.token,
      now,
      now,
    ),
  ];
}
export async function claimRecovery(
  env: Env,
  operationId: string,
  windowId: number,
  now: number,
  runUntil: number,
): Promise<Lease | null> {
  if (
    !Number.isSafeInteger(windowId) ||
    windowId < 0 ||
    windowId > Math.floor(now / 300000) ||
    windowId * 300000 < now - 86400000 ||
    runUntil <= now
  )
    return null;
  const r = await recoveryRow(env.DB, operationId);
  if (!r) return null;
  const b = parseBinding(JSON.parse(r.binding_json));
  if (b.executor === "send_draft" || b.buildId !== env.BUILD_ID || b.origin !== `https://${env.WORKER_HOSTNAME}`)
    return null;
  const controls = await env.DB.prepare(
    `SELECT mode,epoch FROM recovery_control c WHERE origin=? AND build_id=? AND user_id=? AND account_id=? AND credential_version=? AND expires_at>? AND (state='enabled' OR (state='probe' AND ? IN ('normal','scratch') AND EXISTS(SELECT 1 FROM json_each(c.probe_ids) WHERE value=?))) ORDER BY CASE mode WHEN 'send_session_status' THEN 0 ELSE 1 END`,
  )
    .bind(b.origin, env.BUILD_ID, b.userId, b.accountId, b.credentialVersion, now, env.RECOVERY_PROFILE, operationId)
    .all<{ mode: RecoveryMode; epoch: string }>();
  const control = controls.results.find((c) =>
    c.mode === "generated_search" ? b.generatedMessageId !== null : r.session_enc !== null,
  );
  if (!control) return null;
  const lease: Lease = {
    operationId,
    token: randomId("lease"),
    until: Math.min(now + 60000, runUntil, r.deadline),
    qualificationEpoch: control.epoch,
    mode: control.mode,
  };
  const db = env.DB;
  try {
    await db.batch([
      installationAssertion(env),
      qualificationFence(env, b, lease, now),
      assertion(
        db,
        `EXISTS(SELECT 1 FROM operation_recovery r JOIN accounts a ON a.id=r.account_id AND a.user_id=r.user_id WHERE r.operation_id=? AND r.state='active' AND r.deadline>? AND r.next_attempt_at<=? AND r.attempts<288 AND COALESCE(r.lease_until,0)<=? AND (r.last_window IS NULL OR r.last_window!=?) AND a.status='active' AND a.credential_version=r.credential_version)`,
        operationId,
        now,
        now,
        now,
        windowId,
      ),
      assertion(
        db,
        "(SELECT count(*) FROM recovery_attempts)<3000 AND (SELECT count(*) FROM recovery_attempts WHERE window_id=?)<10 AND (SELECT count(*) FROM recovery_attempts WHERE window_id=? AND account_id=?)<2",
        windowId,
        windowId,
        b.accountId,
      ),
      db
        .prepare(
          "INSERT INTO recovery_attempts(window_id,operation_id,user_id,account_id,admitted_at) VALUES(?,?,?,?,?)",
        )
        .bind(windowId, operationId, b.userId, b.accountId, now),
      db
        .prepare(
          "UPDATE operation_recovery SET attempts=attempts+1,last_window=?,lease_token=?,lease_until=? WHERE operation_id=?",
        )
        .bind(windowId, lease.token, lease.until, operationId),
    ]);
    return lease;
  } catch {
    return null;
  }
}
export async function admitRequest(
  env: Env,
  b: Binding,
  lease: Lease,
  deadlines: Deadlines,
  kind: "gmail" | "refresh",
  now: number,
): Promise<boolean> {
  const db = env.DB;
  try {
    await db.batch([
      ...recoveryFences(env, b, lease, now),
      assertion(
        db,
        "?>? AND ?>? AND ?>?",
        deadlines.requestUntil,
        now,
        deadlines.attemptUntil,
        now,
        deadlines.runUntil,
        now,
      ),
      assertion(
        db,
        "(SELECT count(*) FROM recovery_requests)<9000 AND (SELECT count(*) FROM recovery_requests WHERE window_id=(SELECT last_window FROM operation_recovery WHERE operation_id=?))<30 AND (SELECT count(*) FROM recovery_requests WHERE admitted_at>?)<30",
        b.operationId,
        now - 300000,
      ),
      db
        .prepare(
          "INSERT INTO recovery_requests(id,window_id,operation_id,admitted_at,kind) SELECT ?,last_window,operation_id,?,? FROM operation_recovery WHERE operation_id=? AND lease_token=?",
        )
        .bind(randomId("request"), now, kind, b.operationId, lease.token),
    ]);
    return true;
  } catch {
    return false;
  }
}
