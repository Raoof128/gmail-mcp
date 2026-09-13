import { recoveryBudget } from "./budgets";
import { STAGING_LIMITS as L, UploadMetadata, type TransferResult } from "@gmail-mcp/shared/staging";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Env } from "../env";
import type { Principal } from "../auth/principal";
import { sha256Hex } from "../crypto/canonical";
import { randomHandle } from "../crypto/random";
import { assertNotBlocked } from "../policy/limits";
import { auditStatement } from "../audit/log";
import {
  terminalBeforeAdmission,
  accountAssert,
  assertion,
  auditFor,
  policyAssert,
  policySnapshot,
  readTransfer,
  transferView,
  type GenerationRow,
  type TransferRow,
} from "./transfers";

class InterruptedUpload extends Error {}
class UploadIntegrityError extends GmailMcpError {
  constructor() {
    super("handle_invalid", "handle_invalid: upload integrity");
  }
}

async function readBody(request: Request, size: number): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(size);
  let offset = 0;
  if (!request.body) {
    if (size === 0) return out;
    throw new UploadIntegrityError();
  }
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => {});
      reject(new InterruptedUpload("upload interrupted"));
    }, L.bodyMs);
  });
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), deadline]).catch(() => {
        throw new InterruptedUpload("upload interrupted");
      });
      if (part.done) break;
      if (offset + part.value.byteLength > size) throw new UploadIntegrityError();
      out.set(part.value, offset);
      offset += part.value.byteLength;
    }
    if (offset !== size) throw new UploadIntegrityError();
    return out;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function acceptUpload(
  env: Env,
  p: Principal,
  ticket: string,
  request: Request,
  hooks: { afterStored?: () => Promise<void> } = {},
): Promise<TransferResult> {
  const db = env.DB;
  const now = Date.now();
  const g = await db
    .prepare("SELECT * FROM upload_generations WHERE user_id=? AND ticket_id=?")
    .bind(p.userId, ticket)
    .first<GenerationRow>();
  if (!g || g.state !== "issued" || g.issued_until <= now)
    throw new GmailMcpError("handle_invalid", "handle_invalid: ticket unavailable");
  const t = (await readTransfer(db, p.userId, g.transfer_id))!;
  if (t.active_generation !== g.generation || t.authority_until <= now)
    throw new GmailMcpError("handle_invalid", "handle_invalid: stale ticket");
  const m = UploadMetadata.parse(JSON.parse(t.metadata_json));
  if (
    request.headers.get("content-length") !== String(m.size) ||
    request.headers.get("content-type") !== m.mime ||
    ![null, "identity"].includes(request.headers.get("content-encoding"))
  )
    throw new GmailMcpError("handle_invalid", "handle_invalid: upload headers");
  assertNotBlocked(m.filename);
  const policy = await policySnapshot(env, p.userId, t.account_id);
  if (policy.level === "deny") {
    await terminalBeforeAdmission(env, t, "denied", "policy_denied");
    throw new GmailMcpError("policy_denied", "policy_denied: upload admission");
  }
  if (policy.level === "ask") {
    const approved = t.pending_id
      ? await db
          .prepare(
            "SELECT 1 FROM pending_actions WHERE id=? AND user_id=? AND state='executing' AND operation_id=? AND action='attachment.stage_upload'",
          )
          .bind(t.pending_id, t.user_id, t.operation_id)
          .first()
      : null;
    if (!approved) {
      await db.batch([
        db
          .prepare(
            "UPDATE upload_generations SET state='expired',cleanup_state='released',writer_stopped=1 WHERE ticket_id=? AND state='issued'",
          )
          .bind(ticket),
        db
          .prepare(
            "UPDATE upload_transfers SET state='awaiting_approval' WHERE user_id=? AND id=? AND state!='completed'",
          )
          .bind(t.user_id, t.id),
      ]);
      throw new GmailMcpError("pending_not_approved", "pending_not_approved: policy now requires approval");
    }
  }
  const account = await db
    .prepare("SELECT credential_version FROM accounts WHERE user_id=? AND id=? AND status='active'")
    .bind(t.user_id, t.account_id)
    .first<{ credential_version: number }>();
  if (!account) {
    await terminalBeforeAdmission(env, t, "failed", "account_needs_reconnect");
    throw new GmailMcpError("account_needs_reconnect", "account_needs_reconnect: upload");
  }
  const until = now + L.leaseMs;
  try {
    await db.batch([
      assertion(db, "(SELECT count(*) FROM staging_materializations WHERE lease_until>?)=0", [now]),
      policyAssert(db, policy.rev),
      accountAssert(db, t.user_id, t.account_id, account.credential_version),
      assertion(
        db,
        "(SELECT count(*) FROM upload_generations WHERE state IN ('uploading','stored') AND lease_until>?)<?",
        [now, L.uploadsGlobal],
      ),
      assertion(
        db,
        "EXISTS(SELECT 1 FROM upload_transfers WHERE user_id=? AND id=? AND active_generation=? AND state='in_progress')",
        [t.user_id, t.id, g.generation],
      ),
      db
        .prepare(
          "UPDATE upload_generations SET state='uploading',admitted_at=?,lease_until=?,credential_version=? WHERE ticket_id=? AND state='issued' AND issued_until>?",
        )
        .bind(now, until, account.credential_version, ticket, now),
      assertion(
        db,
        "EXISTS(SELECT 1 FROM upload_generations WHERE ticket_id=? AND state='uploading' AND admitted_at=? AND lease_until=?)",
        [ticket, now, until],
      ),
      db
        .prepare("UPDATE operations SET state='executing',updated_at=? WHERE id=? AND action='attachment.stage_upload'")
        .bind(now, t.operation_id),
    ]);
  } catch {
    throw new GmailMcpError("handle_invalid", "handle_invalid: upload admission lost or busy");
  }
  let putStarted = false;
  let putReturned = false;
  try {
    const bytes = await readBody(request, m.size);
    const digest = await sha256Hex(bytes);
    if (digest !== m.sha256) throw new UploadIntegrityError();
    if (Date.now() >= until) throw new GmailMcpError("handle_invalid", "handle_invalid: upload lease expired");
    putStarted = true;
    await env.STAGING.put(g.r2_key, bytes, {
      httpMetadata: { contentType: m.mime },
      customMetadata: {
        intent_hash: t.intent_hash,
        size: String(m.size),
        sha256: digest,
        generation: String(g.generation),
      },
    });
    putReturned = true;
    await db.batch([
      db
        .prepare(
          "UPDATE upload_generations SET state='stored' WHERE ticket_id=? AND state='uploading' AND lease_until>?",
        )
        .bind(ticket, Date.now()),
      assertion(db, "EXISTS(SELECT 1 FROM upload_generations WHERE ticket_id=? AND state='stored')", [ticket]),
    ]);
    await hooks.afterStored?.();
    const handle = randomHandle();
    const finished = Date.now();
    const expires = finished + 30 * 60_000;
    const stmts = [
      ...recoveryBudget(db, t.user_id, "upload:" + t.id, 1, finished + L.retentionMs),
      accountAssert(db, t.user_id, t.account_id, account.credential_version),
      assertion(
        db,
        "EXISTS(SELECT 1 FROM upload_transfers WHERE user_id=? AND id=? AND active_generation=? AND state='in_progress')",
        [t.user_id, t.id, g.generation],
      ),
      assertion(db, "EXISTS(SELECT 1 FROM upload_generations WHERE ticket_id=? AND state='stored' AND lease_until>?)", [
        ticket,
        finished,
      ]),
      db
        .prepare(
          "INSERT INTO staging_objects(handle,user_id,account_id,direction,r2_key,filename,mime,size,sha256,created_at,expires_at) VALUES(?,?,?,'upload',?,?,?,?,?,?,?)",
        )
        .bind(handle, t.user_id, t.account_id, g.r2_key, m.filename, m.mime, m.size, digest, finished, expires),
      db
        .prepare(
          "UPDATE upload_generations SET state='completed',cleanup_state='published',writer_stopped=1 WHERE ticket_id=?",
        )
        .bind(ticket),
      db
        .prepare(
          "UPDATE upload_transfers SET state='completed',handle=?,handle_expires_at=?,retain_until=? WHERE user_id=? AND id=?",
        )
        .bind(handle, expires, finished + L.retentionMs, t.user_id, t.id),
      db
        .prepare("UPDATE operations SET state='executed',updated_at=? WHERE id=? AND action='attachment.stage_upload'")
        .bind(finished, t.operation_id),
      auditStatement(db, "outcome", auditFor(t, "executed")),
    ];
    if (t.pending_id)
      stmts.push(
        db
          .prepare(
            "UPDATE pending_actions SET state='executed',executed_at=?,payload_json=NULL,summary='redacted' WHERE id=? AND state='executing' AND operation_id=?",
          )
          .bind(finished, t.pending_id, t.operation_id),
      );
    await db.batch(stmts);
    return transferView(env, (await readTransfer(db, t.user_id, t.id))!);
  } catch (e) {
    // A response/commit ambiguity must not destroy an object that a completed transfer references.
    const latest = await readTransfer(db, t.user_id, t.id);
    if (latest?.state === "completed") return transferView(env, latest);
    const currentAccount = await db
      .prepare("SELECT 1 FROM accounts WHERE user_id=? AND id=? AND status='active' AND credential_version=?")
      .bind(t.user_id, t.account_id, account.credential_version)
      .first();
    const retryable =
      currentAccount !== null &&
      !(e instanceof UploadIntegrityError) &&
      (e instanceof InterruptedUpload || (putStarted && !putReturned) || Date.now() >= until);
    await failUpload(env, t, g, retryable ? "abandoned" : "failed", putStarted, putReturned);
    throw e;
  }
}
async function failUpload(
  env: Env,
  t: TransferRow,
  g: GenerationRow,
  state: "failed" | "abandoned",
  putStarted: boolean,
  putReturned: boolean,
) {
  const db = env.DB;
  const writerStopped = !putStarted || putReturned;
  await db.batch([
    db
      .prepare(
        "UPDATE upload_generations SET state=?,cleanup_state='debt',writer_stopped=? WHERE ticket_id=? AND state IN ('uploading','stored','abandoned')",
      )
      .bind(state, writerStopped ? 1 : 0, g.ticket_id),
    ...(state === "failed"
      ? [
          db
            .prepare(
              "UPDATE upload_transfers SET state='failed',error='upload_failed' WHERE user_id=? AND id=? AND state!='completed'",
            )
            .bind(t.user_id, t.id),
          db
            .prepare(
              "UPDATE operations SET state='failed_safe',updated_at=? WHERE id=? AND action='attachment.stage_upload'",
            )
            .bind(Date.now(), t.operation_id),
        ]
      : []),
    ...(state === "failed" && t.pending_id
      ? [
          db
            .prepare(
              "UPDATE pending_actions SET state='failed',payload_json=NULL,summary='redacted',error='upload_failed' WHERE id=? AND state='executing' AND operation_id=?",
            )
            .bind(t.pending_id, t.operation_id),
        ]
      : []),
    auditStatement(db, "outcome", auditFor(t, state)),
  ]);
  // This invocation knows its own put has returned, so it can prove writer termination.
  // A rejected put can have an unknown remote outcome. Keep its debt charged;
  // neither a timer nor an absent object proves a delayed writer has stopped.
  if (!writerStopped) return;
  if (putReturned) await env.STAGING.delete(g.r2_key);
  await db
    .prepare(
      "UPDATE upload_generations SET cleanup_state='released' WHERE ticket_id=? AND state IN ('failed','abandoned') AND writer_stopped=1",
    )
    .bind(g.ticket_id)
    .run();
}
