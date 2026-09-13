import type { Env } from "../env";
import { assertion, auditFor, type TransferRow } from "./transfers";
import { auditStatement } from "../audit/log";

/** Expiry fences publication; it never certifies that a remote writer has stopped. */
export async function recoverUploads(env: Env, now: number, limit = 200): Promise<void> {
  const db = env.DB;
  await db.batch([
    db
      .prepare(
        "UPDATE upload_generations SET state='expired',cleanup_state='released',writer_stopped=1 WHERE ticket_id IN (SELECT ticket_id FROM upload_generations WHERE state='issued' AND issued_until<=? LIMIT ?)",
      )
      .bind(now, limit),
    db
      .prepare(
        "UPDATE upload_generations SET state='abandoned',cleanup_state='debt' WHERE ticket_id IN (SELECT ticket_id FROM upload_generations WHERE state IN ('uploading','stored') AND lease_until<=? LIMIT ?)",
      )
      .bind(now, limit),
  ]);
  const expired = await db
    .prepare(
      "SELECT * FROM upload_transfers WHERE authority_until<=? AND state IN ('authorized','awaiting_approval','in_progress') AND NOT EXISTS(SELECT 1 FROM upload_generations g WHERE g.user_id=upload_transfers.user_id AND g.transfer_id=upload_transfers.id AND g.generation=upload_transfers.active_generation AND g.state IN ('uploading','stored') AND g.lease_until>?) LIMIT ?",
    )
    .bind(now, now, limit)
    .all<TransferRow>();
  for (const t of expired.results) {
    try {
      await db.batch([
        assertion(
          db,
          "EXISTS(SELECT 1 FROM upload_transfers WHERE user_id=? AND id=? AND authority_until<=? AND state IN ('authorized','awaiting_approval','in_progress') AND NOT EXISTS(SELECT 1 FROM upload_generations g WHERE g.user_id=upload_transfers.user_id AND g.transfer_id=upload_transfers.id AND g.generation=upload_transfers.active_generation AND g.state IN ('uploading','stored') AND g.lease_until>?))",
          [t.user_id, t.id, now, now],
        ),
        db
          .prepare("UPDATE upload_transfers SET state='expired',error='pending_expired' WHERE user_id=? AND id=?")
          .bind(t.user_id, t.id),
        db
          .prepare(
            "UPDATE operations SET state='failed_safe',updated_at=? WHERE id=? AND action='attachment.stage_upload' AND state IN ('claimed','executing')",
          )
          .bind(now, t.operation_id),
        db
          .prepare(
            "UPDATE pending_actions SET state='expired',payload_json=NULL,summary='redacted' WHERE id=? AND action='attachment.stage_upload' AND state IN ('pending','approved','executing')",
          )
          .bind(t.pending_id),
        auditStatement(db, "outcome", auditFor(t, "expired")),
      ]);
    } catch {
      // A concurrent completion can win; never overwrite that durable outcome.
      const current = await db
        .prepare("SELECT state FROM upload_transfers WHERE user_id=? AND id=?")
        .bind(t.user_id, t.id)
        .first<{ state: string }>();
      if (current && ["authorized", "awaiting_approval", "in_progress"].includes(current.state))
        throw new Error("upload recovery transaction failed");
    }
  }
  const debt = await db
    .prepare("SELECT ticket_id,r2_key,writer_stopped FROM upload_generations WHERE cleanup_state='debt' LIMIT ?")
    .bind(limit)
    .all<{ ticket_id: string; r2_key: string; writer_stopped: number }>();
  for (const g of debt.results) {
    await env.STAGING.delete(g.r2_key);
    if (g.writer_stopped === 1)
      await db
        .prepare(
          "UPDATE upload_generations SET cleanup_state='released' WHERE ticket_id=? AND cleanup_state='debt' AND writer_stopped=1",
        )
        .bind(g.ticket_id)
        .run();
  }
  await db.prepare("UPDATE staging_ingests SET state='debt' WHERE state='active' AND lease_until<=?").bind(now).run();
  const ingests = await db
    .prepare("SELECT id,r2_key,writer_stopped FROM staging_ingests WHERE state='debt' LIMIT ?")
    .bind(limit)
    .all<{ id: string; r2_key: string; writer_stopped: number }>();
  for (const job of ingests.results) {
    await env.STAGING.delete(job.r2_key);
    if (job.writer_stopped === 1)
      await db
        .prepare("UPDATE staging_ingests SET state='released' WHERE id=? AND state='debt' AND writer_stopped=1")
        .bind(job.id)
        .run();
  }
  await db
    .prepare(
      "DELETE FROM staging_ingests WHERE state IN ('released','published') AND NOT EXISTS(SELECT 1 FROM staging_objects s WHERE s.handle=staging_ingests.id)",
    )
    .run();
  await db
    .prepare(
      "DELETE FROM staging_recovery_slots WHERE retain_until<=? AND NOT EXISTS(SELECT 1 FROM upload_transfers t WHERE t.user_id=staging_recovery_slots.user_id AND staging_recovery_slots.key='upload:'||t.id)",
    )
    .bind(now)
    .run();
  await db.prepare("DELETE FROM staging_materializations WHERE lease_until<=?").bind(now).run();
  await db.batch([
    db.prepare("DELETE FROM download_streams WHERE lease_until<=?").bind(now),
    db
      .prepare(
        "DELETE FROM staging_acknowledgements WHERE retain_until<=? AND NOT EXISTS(SELECT 1 FROM staging_objects s WHERE s.handle=staging_acknowledgements.handle)",
      )
      .bind(now),
    db
      .prepare(
        "DELETE FROM download_admissions WHERE retain_until<=? AND NOT EXISTS(SELECT 1 FROM download_streams s WHERE s.handle=download_admissions.handle AND s.user_id=download_admissions.user_id)",
      )
      .bind(now),
    db
      .prepare(
        "DELETE FROM upload_retry_requests WHERE EXISTS(SELECT 1 FROM upload_transfers t WHERE t.user_id=upload_retry_requests.user_id AND t.id=upload_retry_requests.transfer_id AND t.retain_until<=? AND t.state IN ('completed','failed','expired','denied') AND NOT EXISTS(SELECT 1 FROM upload_generations g WHERE g.user_id=t.user_id AND g.transfer_id=t.id AND g.cleanup_state IN ('debt','deleting','reserved')))",
      )
      .bind(now),
    db
      .prepare(
        "DELETE FROM upload_generations WHERE EXISTS(SELECT 1 FROM upload_transfers t WHERE t.user_id=upload_generations.user_id AND t.id=upload_generations.transfer_id AND t.retain_until<=? AND t.state IN ('completed','failed','expired','denied') AND NOT EXISTS(SELECT 1 FROM upload_generations g WHERE g.user_id=t.user_id AND g.transfer_id=t.id AND g.cleanup_state IN ('debt','deleting','reserved')))",
      )
      .bind(now),
    db
      .prepare(
        "DELETE FROM upload_transfers WHERE retain_until<=? AND state IN ('completed','failed','expired','denied') AND NOT EXISTS(SELECT 1 FROM upload_generations g WHERE g.user_id=upload_transfers.user_id AND g.transfer_id=upload_transfers.id)",
      )
      .bind(now),
  ]);
}
