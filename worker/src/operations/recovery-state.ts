import { installationAssertion } from "./installation";
import { z } from "zod";
import { MODIFIERS } from "@gmail-mcp/shared/actions";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Env } from "../env";
import { validateSessionUrl } from "../google/resumable";
import { Keyring } from "../crypto/keyring";
import { hashCanonical } from "../crypto/canonical";
import { randomId } from "../crypto/random";
import type { Binding, SendResult } from "./recovery-types";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const count = z.number().int().min(0).max(1000);
export const settlementContext = z
  .object({
    executor: z.enum(["send_message", "reply", "forward", "send_draft"]),
    resultVersion: z.literal("send-v1"),
    pendingId: id.nullable(),
    audit: z
      .object({
        action: z.enum(["send.message", "send.forward", "send.draft"]),
        modifiers: z.array(z.enum(MODIFIERS)).max(5),
        recipients: count,
        attachments: count,
      })
      .strict(),
  })
  .strict();
export const sendResult = z
  .object({ gmail_result_id: id, message: z.object({ id, thread_id: id, label_ids: z.array(id).max(1000) }).strict() })
  .strict()
  .refine((r) => r.gmail_result_id === r.message.id);
const bindingSchema = settlementContext
  .extend({
    operationId: id,
    userId: id,
    accountId: id,
    credentialVersion: z.number().int().nonnegative(),
    generatedMessageId: z.string().max(512).nullable(),
    threadId: id.nullable(),
    startedAt: z.number().int().nonnegative(),
    mimeLength: z.number().int().min(0).max(36700160).nullable(),
    buildId: z.string().min(1).max(128),
    origin: z.string().url().max(512),
  })
  .strict();
export const parseBinding = (input: unknown): Binding => bindingSchema.parse(input);
export type RecoveryOperation = {
  id: string;
  user_id: string;
  account_id: string;
  state: string;
  settlement_protocol: number;
  byte_admitted: number;
  result_identity: string | null;
  result_json: string | null;
  settlement_context_json: string | null;
};
export const operationFor = (db: D1Database, operationId: string) =>
  db.prepare("SELECT * FROM operations WHERE id=?").bind(operationId).first<RecoveryOperation>();
export const assertion = (db: D1Database, condition: string, ...values: unknown[]) =>
  db.prepare(`INSERT INTO _assert(x) SELECT 1 WHERE NOT (${condition})`).bind(...values);
export const permitStatement = (db: D1Database, operationId: string, purpose: string) =>
  db
    .prepare("INSERT INTO settlement_permits(operation_id,token,purpose) VALUES(?,?,?)")
    .bind(operationId, randomId("permit"), purpose);
export const clearPermit = (db: D1Database, operationId: string) =>
  db.prepare("DELETE FROM settlement_permits WHERE operation_id=?").bind(operationId);

export async function beginRecoverableOperation(env: Env, input: Binding, sessionUrl: string | null): Promise<void> {
  const b = bindingSchema.parse(input);
  const context = settlementContext.parse({
    executor: b.executor,
    resultVersion: b.resultVersion,
    pendingId: b.pendingId,
    audit: b.audit,
  });
  const now = Date.now();
  if (
    b.origin !== `https://${env.WORKER_HOSTNAME}` ||
    b.buildId !== env.BUILD_ID ||
    b.startedAt > now ||
    b.startedAt < now - 60000 ||
    (b.executor === "send_draft"
      ? b.generatedMessageId !== null
      : b.generatedMessageId !== `<${b.operationId}@${env.WORKER_HOSTNAME}>`)
  ) {
    throw new GmailMcpError("internal", "recovery binding refused");
  }
  if (sessionUrl !== null && (b.executor === "send_draft" || b.mimeLength === null))
    throw new GmailMcpError("internal", "invalid session binding");
  if (sessionUrl !== null) validateSessionUrl(sessionUrl, { kind: "send" });
  const encrypted =
    sessionUrl === null
      ? null
      : await Keyring.fromEnv(env).encrypt(sessionUrl, {
          userId: b.userId,
          accountId: b.accountId,
          field: `send_session:${b.operationId}`,
        });
  const digest = sessionUrl === null ? null : await hashCanonical(sessionUrl);
  const db = env.DB;
  await db.batch([
    installationAssertion(env),
    permitStatement(db, b.operationId, "begin"),
    assertion(
      db,
      "EXISTS(SELECT 1 FROM operations o JOIN accounts a ON a.id=o.account_id AND a.user_id=o.user_id WHERE o.id=? AND o.user_id=? AND o.account_id=? AND o.state='claimed' AND o.settlement_protocol=1 AND a.status='active' AND a.credential_version=?)",
      b.operationId,
      b.userId,
      b.accountId,
      b.credentialVersion,
    ),
    assertion(
      db,
      "(SELECT count(*) FROM operation_recovery)<2000 AND (SELECT count(*) FROM operation_recovery WHERE user_id=?)<1000",
      b.userId,
    ),
    assertion(
      db,
      "? IS NULL OR EXISTS(SELECT 1 FROM pending_actions WHERE id=? AND operation_id=? AND user_id=? AND account_id=? AND state='executing')",
      b.pendingId,
      b.pendingId,
      b.operationId,
      b.userId,
      b.accountId,
    ),
    db
      .prepare(
        "INSERT INTO operation_recovery(operation_id,user_id,account_id,credential_version,binding_json,state,started_at,deadline,retain_until,next_attempt_at,mime_length,session_enc,session_key_id,session_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        b.operationId,
        b.userId,
        b.accountId,
        b.credentialVersion,
        JSON.stringify(b),
        b.executor === "send_draft" ? "manual" : "active",
        b.startedAt,
        b.startedAt + 86400000,
        b.startedAt + 604800000,
        b.startedAt + 300000,
        b.mimeLength,
        encrypted?.ciphertext ?? null,
        encrypted?.keyId ?? null,
        digest,
      ),
    db
      .prepare(
        "UPDATE operations SET settlement_protocol=2,byte_admitted=1,state='executing',rfc822_message_id=COALESCE(?,rfc822_message_id),settlement_context_json=?,updated_at=? WHERE id=?",
      )
      .bind(b.generatedMessageId, JSON.stringify(context), now, b.operationId),
    db
      .prepare("UPDATE staging_objects SET settlement_operation_id=? WHERE reserved_by_operation_id=?")
      .bind(b.operationId, b.operationId),
    clearPermit(db, b.operationId),
  ]);
}

function audit(db: D1Database, op: RecoveryOperation, decision: string, now: number, resultId: string | null) {
  const c = settlementContext.parse(JSON.parse(op.settlement_context_json ?? "null"));
  return db
    .prepare(
      "INSERT INTO audit_log(ts,user_id,account_id,tool,action,modifiers,phase,decision,pending_id,operation_id,gmail_result_id,summary) VALUES(?,?,?,?,?,?,'outcome',?,?,?,?,?)",
    )
    .bind(
      now,
      op.user_id,
      op.account_id,
      c.executor,
      c.audit.action,
      JSON.stringify(c.audit.modifiers),
      decision,
      c.pendingId,
      op.id,
      resultId,
      `recipients=${c.audit.recipients} attachments=${c.audit.attachments}`,
    );
}

export async function settleDirect(
  env: Env,
  operationId: string,
  input: SendResult,
): Promise<"settled" | "replayed" | "conflict"> {
  return settlePositive(env.DB, operationId, sendResult.parse(input), [installationAssertion(env)]);
}

/** Extra recovery assertions precede all effects in the SAME transaction as the direct winner. */
export async function settlePositive(
  db: D1Database,
  operationId: string,
  result: SendResult,
  fences: D1PreparedStatement[],
): Promise<"settled" | "replayed" | "conflict"> {
  const op = await operationFor(db, operationId);
  if (!op || op.settlement_protocol !== 2) throw new GmailMcpError("internal", "recovery operation unavailable");
  const identity = JSON.stringify([result.message.id, result.message.thread_id]);
  if (op.state === "executed") return op.result_identity === identity ? "replayed" : "conflict";
  const context = settlementContext.parse(JSON.parse(op.settlement_context_json ?? "null"));
  const now = Date.now();
  try {
    await db.batch([
      permitStatement(db, operationId, "success"),
      ...fences,
      assertion(
        db,
        "EXISTS(SELECT 1 FROM operations WHERE id=? AND settlement_protocol=2 AND state IN ('executing','delivery_unknown'))",
        operationId,
      ),
      db
        .prepare(
          "UPDATE operations SET state='executed',gmail_result_id=?,result_json=?,result_identity=?,updated_at=? WHERE id=?",
        )
        .bind(result.gmail_result_id, JSON.stringify(result), identity, now, operationId),
      db
        .prepare(
          "UPDATE staging_objects SET consumed_at=?,reserved_by_operation_id=NULL WHERE reserved_by_operation_id=? AND consumed_at IS NULL",
        )
        .bind(now, operationId),
      db
        .prepare(
          "UPDATE pending_actions SET state='executed',payload_json=NULL,summary='redacted',error=NULL,executed_at=? WHERE id=? AND operation_id=? AND (state='executing' OR (state='failed' AND error='delivery_unknown'))",
        )
        .bind(now, context.pendingId, operationId),
      audit(db, op, "executed", now, result.gmail_result_id),
      db
        .prepare(
          "UPDATE operation_recovery SET state='completed',session_enc=NULL,session_key_id=NULL,lease_token=NULL,lease_until=NULL WHERE operation_id=?",
        )
        .bind(operationId),
      clearPermit(db, operationId),
    ]);
    return "settled";
  } catch (error) {
    const winner = await operationFor(db, operationId);
    if (winner?.state === "executed") return winner.result_identity === identity ? "replayed" : "conflict";
    throw error;
  }
}

export async function recordFailure(
  env: Env,
  operationId: string,
): Promise<"failed_safe" | "delivery_unknown" | "executed"> {
  const db = env.DB;
  const op = await operationFor(db, operationId);
  if (!op || op.settlement_protocol !== 2) throw new GmailMcpError("internal", "recovery operation unavailable");
  if (op.state === "executed" || op.state === "delivery_unknown" || op.state === "failed_safe") return op.state;
  const state = op.state === "claimed" && op.byte_admitted === 0 ? "failed_safe" : "delivery_unknown";
  const now = Date.now();
  const c = settlementContext.parse(JSON.parse(op.settlement_context_json ?? "null"));
  try {
    await db.batch([
      installationAssertion(env),
      permitStatement(db, operationId, state === "failed_safe" ? "failed_safe" : "unknown"),
      assertion(
        db,
        "EXISTS(SELECT 1 FROM operations WHERE id=? AND state=? AND byte_admitted=?)",
        operationId,
        op.state,
        op.byte_admitted,
      ),
      db.prepare("UPDATE operations SET state=?,updated_at=? WHERE id=?").bind(state, now, operationId),
      db
        .prepare(
          "UPDATE pending_actions SET state='failed',payload_json=NULL,summary='redacted',error=?,executed_at=? WHERE id=? AND operation_id=? AND state='executing'",
        )
        .bind(state, now, c.pendingId, operationId),
      ...(state === "failed_safe"
        ? [
            db
              .prepare(
                "UPDATE staging_objects SET reserved_by_operation_id=NULL WHERE reserved_by_operation_id=? AND consumed_at IS NULL",
              )
              .bind(operationId),
          ]
        : []),
      audit(db, op, state, now, null),
      clearPermit(db, operationId),
    ]);
    return state;
  } catch (error) {
    const winner = await operationFor(db, operationId);
    if (winner?.state === "executed" || winner?.state === "delivery_unknown" || winner?.state === "failed_safe")
      return winner.state;
    throw error;
  }
}
