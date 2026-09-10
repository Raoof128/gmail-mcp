import { GmailMcpError } from "@gmail-mcp/shared/errors";
import { StagingHandle } from "@gmail-mcp/shared/schemas";
import { randomId } from "../crypto/random";
import { reserveStatements } from "../staging/store";
import { getPending, type PendingRow } from "./pending";

/** Handles come from the approved payload only. Any other shape is a payload_mismatch, never a guess. */
export function handlesFromPayload(payloadJson: string | null): string[] {
  if (payloadJson === null) throw new GmailMcpError("payload_mismatch", "payload_mismatch: payload purged");
  const parsed = JSON.parse(payloadJson) as { attachments?: unknown };
  const list = parsed.attachments ?? [];
  if (!Array.isArray(list) || !list.every((h) => StagingHandle.safeParse(h).success)) {
    throw new GmailMcpError("payload_mismatch", "payload_mismatch: attachments must be staging handles");
  }
  return [...new Set(list as string[])];
}

/**
 * Spec 3.4: one D1 batch, in this order because foreign keys are immediate:
 * 1 insert operation (claimed) -> 2 claim pending (approved -> executing) -> 3 assert the claim happened ->
 * 4 reserve payload handles -> 5 assert the reservation count. `_assert` has CHECK (x = 0); an inserted 1
 * raises and rolls the whole batch back.
 */
export async function claimPending(
  db: D1Database,
  o: { id: string; userId: string },
): Promise<{ operationId: string; pending: PendingRow; handles: string[] }> {
  const before = await getPending(db, o.id, o.userId);
  if (!before) throw new GmailMcpError("pending_not_approved", "pending_not_approved: unknown");
  if (before.expires_at <= Date.now()) throw new GmailMcpError("pending_expired", "pending_expired");
  if (before.state !== "approved") {
    // An action already running or already run is a replay, not a missing approval. The distinction is
    // what tells a retrying caller "this happened once" apart from "this will never happen".
    if (before.state === "executing" || before.state === "executed")
      throw new GmailMcpError("pending_replayed", `pending_replayed: ${before.state}`);
    throw new GmailMcpError("pending_not_approved", `pending_not_approved: ${before.state}`);
  }
  const handles = handlesFromPayload(before.payload_json);

  const operationId = randomId("op");
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO operations (id, user_id, account_id, action, idempotency_key, state, payload_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?)`,
      )
      .bind(operationId, before.user_id, before.account_id, before.action, before.id, before.payload_hash, now, now),
    db
      .prepare(
        `UPDATE pending_actions SET state = 'executing', operation_id = ?, execution_started_at = ?
       WHERE id = ? AND user_id = ? AND state = 'approved' AND expires_at > ?`,
      )
      .bind(operationId, now, o.id, o.userId, now),
    db
      .prepare(
        `INSERT INTO _assert (x) SELECT 1 WHERE NOT EXISTS (
         SELECT 1 FROM pending_actions WHERE id = ? AND operation_id = ? AND state = 'executing')`,
      )
      .bind(o.id, operationId),
  ];
  stmts.push(
    ...reserveStatements(db, { operationId, handles, userId: before.user_id, accountId: before.account_id, now }),
  );
  try {
    await db.batch(stmts);
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    const after = await getPending(db, o.id, o.userId);
    if (after?.state === "approved" && handles.length > 0) {
      throw new GmailMcpError("handle_reserved", `handle_reserved: one or more payload handles unavailable (${msg})`);
    }
    if (after?.state !== "approved")
      throw new GmailMcpError("pending_replayed", `pending_replayed: ${after?.state ?? "unknown"}`);
    throw new GmailMcpError("internal", msg);
  }
  return { operationId, pending: (await getPending(db, o.id, o.userId))!, handles };
}
