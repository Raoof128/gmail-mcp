import type { Env } from "../src/env";
import type { Binding } from "../src/operations/recovery-types";
import { beginRecoverableOperation } from "../src/operations/recovery-state";
import { seedAccessToken, seedUserAndAccount, insertOperation } from "./fixtures";
export async function seedRecovery(e: Env, id: string): Promise<Binding> {
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
    pendingId: null,
    startedAt: Date.now(),
    mimeLength: 100,
    buildId: e.BUILD_ID,
    origin: `https://${e.WORKER_HOSTNAME}`,
    audit: { action: "send.message", modifiers: [], recipients: 1, attachments: 0 },
  };
  await beginRecoverableOperation(e, b, null);
  await e.DB.prepare("UPDATE operation_recovery SET next_attempt_at=0 WHERE operation_id=?").bind(id).run();
  await e.DB.prepare(
    "INSERT INTO recovery_control(origin,build_id,user_id,account_id,credential_version,mode,state,epoch,expires_at,evidence_hash) VALUES(?,?,?,?,0,'generated_search','enabled',?,?,'hash')",
  )
    .bind(b.origin, b.buildId, id, id, "qe_" + "A".repeat(43), Date.now() + 86400000)
    .run();
  return b;
}
