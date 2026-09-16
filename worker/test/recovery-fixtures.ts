import { createPendingStatement } from "../src/approval/pending";
import { bindIdempotencyStatements } from "../src/tools/idempotency";
import { ingest } from "../src/staging/store";
import type { Env } from "../src/env";
import type { Binding } from "../src/operations/recovery-types";
import { beginRecoverableOperation } from "../src/operations/recovery-state";
import { seedAccessToken, seedUserAndAccount, insertOperation } from "./fixtures";
export async function seedRecovery(
  e: Env,
  id: string,
  options: { linked?: boolean; protocol?: 1 | 2 } = {},
): Promise<Binding> {
  await seedUserAndAccount(e.DB, { userId: id, accountId: id, alias: "recovery" });
  await seedAccessToken(e, { userId: id, accountId: id });
  await insertOperation(e.DB, id, id, id, "claimed");
  const b: Binding = {
    operationId: id,
    userId: id,
    accountId: id,
    credentialVersion: 0,
    executor: "send_message",
    resultVersion: "send-v1",
    generatedMessageId: `<${id}@${e.WORKER_HOSTNAME}>`,
    threadId: null,
    pendingId: options.linked ? `${id}-pending` : null,
    startedAt: Date.now(),
    mimeLength: 100,
    buildId: e.BUILD_ID,
    origin: `https://${e.WORKER_HOSTNAME}`,
    audit: { action: "send.message", modifiers: [], recipients: 1, attachments: options.linked ? 1 : 0 },
  };
  if (options.linked) {
    const now = Date.now();
    const staged = await ingest(e, {
      userId: id,
      accountId: id,
      direction: "upload",
      filename: "fault.bin",
      mime: "application/octet-stream",
      length: 1,
      body: new Response(new Uint8Array([1])).body!,
    });
    await e.DB.batch([
      createPendingStatement(e.DB, {
        id: b.pendingId!,
        userId: id,
        accountId: id,
        action: "send.message",
        modifiers: [],
        canonical: "{}",
        hash: "h",
        intentHash: "i",
        idempotencyKey: id,
        summary: "fixture",
        now,
      }),
      e.DB.prepare("UPDATE pending_actions SET state='executing',operation_id=? WHERE id=?").bind(id, b.pendingId),
      ...bindIdempotencyStatements(e.DB, {
        userId: id,
        accountId: id,
        key: id,
        tool: "send_message",
        intentHash: "i",
        pendingId: b.pendingId,
        operationId: null,
        now,
      }),
      e.DB.prepare("UPDATE staging_objects SET reserved_by_operation_id=? WHERE handle=?").bind(id, staged.handle),
    ]);
  }
  if (options.protocol === 1) {
    await e.DB.prepare("UPDATE operations SET state='executing' WHERE id=?").bind(id).run();
    return b;
  }
  await beginRecoverableOperation(e, b, null);
  await e.DB.prepare("UPDATE operation_recovery SET next_attempt_at=0 WHERE operation_id=?").bind(id).run();
  await e.DB.prepare(
    "INSERT INTO recovery_control(origin,build_id,user_id,account_id,credential_version,mode,state,epoch,expires_at,evidence_hash) VALUES(?,?,?,?,0,'generated_search','enabled',?,?,'hash')",
  )
    .bind(b.origin, b.buildId, id, id, "qe_" + "A".repeat(43), Date.now() + 86400000)
    .run();
  return b;
}
