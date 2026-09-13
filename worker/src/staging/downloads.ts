import { STAGING_LIMITS as L } from "@gmail-mcp/shared/staging";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Env } from "../env";
import type { StagingRow } from "./store";
import { randomId } from "../crypto/random";
import { recoveryBudget } from "./budgets";
import { assertion, accountAssert } from "./transfers";

export async function leasedDownload(
  env: Env,
  user: string,
  handle: string,
): Promise<{ row: StagingRow; body: ReadableStream<Uint8Array> }> {
  const db = env.DB;
  const now = Date.now();
  const row = await db
    .prepare(
      "SELECT s.* FROM staging_objects s JOIN accounts a ON a.id=s.account_id AND a.user_id=s.user_id WHERE s.handle=? AND s.user_id=? AND s.direction='download' AND s.consumed_at IS NULL AND s.cleanup_state='available' AND a.status='active'",
    )
    .bind(handle, user)
    .first<StagingRow>();
  if (!row) throw new GmailMcpError("handle_invalid", "handle_invalid");
  if (row.expires_at <= now || row.created_at + 60 * 60_000 <= now)
    throw new GmailMcpError("handle_expired", "handle_expired");
  const until = Math.min(now + L.leaseMs, row.created_at + 60 * 60_000);
  const id = randomId("ds");
  try {
    await db.batch([
      accountAssert(db, user, row.account_id),
      ...recoveryBudget(db, user, "download:" + handle, 2, now + L.retentionMs),
      assertion(db, "(SELECT count(*) FROM download_streams WHERE lease_until>?)<?", [now, L.downloadsGlobal]),
      assertion(db, "(SELECT count(*) FROM download_streams WHERE user_id=? AND lease_until>?)<?", [
        user,
        now,
        L.downloadsOwner,
      ]),
      assertion(
        db,
        "EXISTS(SELECT 1 FROM staging_objects WHERE handle=? AND user_id=? AND cleanup_state='available' AND consumed_at IS NULL AND expires_at>?)",
        [handle, user, now],
      ),
      db
        .prepare(
          "INSERT INTO download_admissions(user_id,handle,account_id,admitted_at,lease_until,retain_until) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,handle) DO UPDATE SET lease_until=MAX(lease_until,excluded.lease_until),retain_until=MAX(retain_until,excluded.retain_until)",
        )
        .bind(user, handle, row.account_id, now, until, now + L.retentionMs),
      db.prepare("INSERT INTO download_streams VALUES(?,?,?,?)").bind(id, user, handle, until),
      db
        .prepare(
          "UPDATE staging_objects SET download_lease_until=MAX(COALESCE(download_lease_until,0),?) WHERE handle=? AND user_id=?",
        )
        .bind(until, handle, user),
    ]);
  } catch {
    throw new GmailMcpError("handle_invalid", "handle_invalid: download admission lost or busy");
  }
  const release = async () => {
    await db.batch([
      db.prepare("DELETE FROM download_streams WHERE id=?").bind(id),
      db
        .prepare(
          "UPDATE staging_objects SET download_lease_until=COALESCE((SELECT MAX(lease_until) FROM download_streams WHERE handle=? AND user_id=?),0) WHERE handle=? AND user_id=?",
        )
        .bind(handle, user, handle, user),
    ]);
  };
  let object: R2ObjectBody | null;
  try {
    object = await env.STAGING.get(row.r2_key);
  } catch (e) {
    await release();
    throw e;
  }
  if (!object) {
    await release();
    throw new GmailMcpError("handle_invalid", "handle_invalid: object missing");
  }
  const reader = (object.body as ReadableStream<Uint8Array>).getReader();
  let done = false;
  const finish = async () => {
    if (!done) {
      done = true;
      await release();
    }
  };
  return {
    row,
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const value = await reader.read();
          if (value.done) {
            await finish();
            controller.close();
          } else controller.enqueue(value.value);
        } catch (e) {
          await finish();
          controller.error(e);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          await finish();
        }
      },
    }),
  };
}
export async function acknowledgeDownload(
  env: Env,
  user: string,
  handle: string,
): Promise<{ acknowledged: true; replayed: boolean } | null> {
  const db = env.DB;
  const now = Date.now();
  const old = await db
    .prepare("SELECT 1 FROM staging_acknowledgements WHERE user_id=? AND handle=? AND retain_until>?")
    .bind(user, handle, now)
    .first();
  if (old) return { acknowledged: true, replayed: true };
  const row = await db
    .prepare(
      "SELECT account_id FROM staging_objects WHERE handle=? AND user_id=? AND direction='download' AND consumed_at IS NULL AND expires_at>? UNION SELECT account_id FROM download_admissions WHERE user_id=? AND handle=? AND retain_until>? LIMIT 1",
    )
    .bind(handle, user, now, user, handle, now)
    .first<{ account_id: string }>();
  if (!row) return null;
  const budget = recoveryBudget(db, user, "download:" + handle, 1, now + L.retentionMs);
  const inserted = await db.batch([
    ...budget,
    db
      .prepare("INSERT OR IGNORE INTO staging_acknowledgements VALUES(?,?,?,?,?)")
      .bind(user, handle, row.account_id, now, now + L.retentionMs),
    db
      .prepare(
        "UPDATE staging_objects SET consumed_at=? WHERE handle=? AND user_id=? AND direction='download' AND consumed_at IS NULL",
      )
      .bind(now, handle, user),
  ]);
  return { acknowledged: true, replayed: (inserted[budget.length]!.meta.changes ?? 0) === 0 };
}
