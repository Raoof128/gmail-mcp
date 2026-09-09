import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Env } from "../env";
import { randomHandle } from "../crypto/random";
import { LIMITS, assertNotBlocked, sanitizeFilename } from "../policy/limits";

export const DOWNLOAD_TTL_MS = 30 * 60_000;

export type StagingRow = {
  handle: string; user_id: string; account_id: string; direction: "download" | "upload";
  r2_key: string; filename: string; mime: string; size: number; sha256: string;
  source_message_id: string | null; source_attachment_id: string | null;
  reserved_by_operation_id: string | null; created_at: number; expires_at: number; consumed_at: number | null;
};

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function ingest(
  env: Env,
  o: {
    userId: string; accountId: string; direction: "download" | "upload"; filename: string; mime: string;
    length: number; body: ReadableStream<Uint8Array>; declaredSha256?: string;
    source?: { messageId: string; attachmentId: string };
  },
): Promise<StagingRow> {
  const filename = sanitizeFilename(o.filename);
  // The blocked list describes what Gmail refuses to send, so it gates uploads only.
  if (o.direction === "upload") assertNotBlocked(filename);
  if (!Number.isInteger(o.length) || o.length < 0 || o.length > LIMITS.stagedFileBytes) {
    throw new GmailMcpError("limit_exceeded", `limit_exceeded: length ${o.length} not within 0..${LIMITS.stagedFileBytes}`);
  }
  const handle = randomHandle();
  const r2Key = `stg/${o.userId}/${handle}`;
  // FixedLengthStream errors if the body is shorter or longer than `length`, so the cap is exact
  // and R2 receives a known-length stream.
  const fixed = new FixedLengthStream(o.length);
  const pumping = o.body.pipeTo(fixed.writable);
  const [forR2, forDigest] = fixed.readable.tee();
  const digest = new crypto.DigestStream("SHA-256");
  // All three run concurrently and every rejection is observed: an unobserved rejection from the
  // digest branch would surface as an unhandled promise rejection.
  const settled = await Promise.allSettled([
    env.STAGING.put(r2Key, forR2, { httpMetadata: { contentType: o.mime } }),
    forDigest.pipeTo(digest),
    pumping,
  ]);
  const failure = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failure) {
    await env.STAGING.delete(r2Key).catch(() => {});
    if (failure.reason instanceof GmailMcpError) throw failure.reason;
    throw new GmailMcpError("internal", `ingest failed: ${String((failure.reason as Error)?.message ?? failure.reason)}`);
  }
  const sha256 = hex(await digest.digest);
  if (o.declaredSha256 && o.declaredSha256.toLowerCase() !== sha256) {
    await env.STAGING.delete(r2Key);
    throw new GmailMcpError("handle_invalid", "handle_invalid: declared sha256 mismatch");
  }
  const now = Date.now();
  const row: StagingRow = {
    handle, user_id: o.userId, account_id: o.accountId, direction: o.direction, r2_key: r2Key,
    filename, mime: o.mime, size: o.length, sha256,
    source_message_id: o.source?.messageId ?? null, source_attachment_id: o.source?.attachmentId ?? null,
    reserved_by_operation_id: null, created_at: now, expires_at: now + DOWNLOAD_TTL_MS, consumed_at: null,
  };
  try {
    await env.DB.prepare(
      `INSERT INTO staging_objects (handle, user_id, account_id, direction, r2_key, filename, mime, size, sha256,
         source_message_id, source_attachment_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(row.handle, row.user_id, row.account_id, row.direction, row.r2_key, row.filename, row.mime, row.size, row.sha256,
      row.source_message_id, row.source_attachment_id, row.created_at, row.expires_at).run();
  } catch (e) {
    await env.STAGING.delete(r2Key).catch(() => {});
    throw e;
  }
  return row;
}

export async function openForRead(env: Env, o: { handle: string; userId: string }): Promise<{ row: StagingRow; body: ReadableStream }> {
  const row = await env.DB
    .prepare("SELECT * FROM staging_objects WHERE handle = ? AND user_id = ? AND direction = 'download' AND consumed_at IS NULL")
    .bind(o.handle, o.userId).first<StagingRow>();
  if (!row) throw new GmailMcpError("handle_invalid", "handle_invalid");
  if (row.expires_at <= Date.now()) throw new GmailMcpError("handle_expired", "handle_expired");
  const obj = await env.STAGING.get(row.r2_key);
  if (!obj) throw new GmailMcpError("handle_invalid", "handle_invalid: object missing");
  return { row, body: obj.body };
}

export async function ack(env: Env, o: { handle: string; userId: string }): Promise<boolean> {
  const now = Date.now();
  const res = await env.DB
    .prepare("UPDATE staging_objects SET consumed_at = ? WHERE handle = ? AND user_id = ? AND direction = 'download' AND consumed_at IS NULL AND expires_at > ?")
    .bind(now, o.handle, o.userId, now).run();
  return (res.meta.changes ?? 0) === 1;
}

export async function extendExpiry(db: D1Database, handles: string[], userId: string, accountId: string, until: number): Promise<void> {
  if (handles.length === 0) return;
  await db.prepare(
    `UPDATE staging_objects SET expires_at = MAX(expires_at, ?) WHERE handle IN (${handles.map(() => "?").join(",")}) AND user_id = ? AND account_id = ?`,
  ).bind(until, ...handles, userId, accountId).run();
}

/** Marks reserved uploads used and clears the reservation so the purge can collect them. */
export async function consume(db: D1Database, operationId: string): Promise<void> {
  await db.prepare("UPDATE staging_objects SET consumed_at = ?, reserved_by_operation_id = NULL WHERE reserved_by_operation_id = ? AND consumed_at IS NULL")
    .bind(Date.now(), operationId).run();
}

export async function release(db: D1Database, operationId: string): Promise<void> {
  await db.prepare("UPDATE staging_objects SET reserved_by_operation_id = NULL WHERE reserved_by_operation_id = ? AND consumed_at IS NULL")
    .bind(operationId).run();
}

export async function purgeExpired(env: Env, now: number, limit = 200): Promise<{ deleted: number }> {
  const rows = await env.DB
    .prepare(`SELECT handle, r2_key FROM staging_objects
              WHERE (expires_at <= ? OR consumed_at IS NOT NULL) AND reserved_by_operation_id IS NULL LIMIT ?`)
    .bind(now, limit).all<{ handle: string; r2_key: string }>();
  if (rows.results.length === 0) return { deleted: 0 };
  await env.STAGING.delete(rows.results.map((r) => r.r2_key));
  await env.DB.batch(rows.results.map((r) => env.DB.prepare("DELETE FROM staging_objects WHERE handle = ?").bind(r.handle)));
  return { deleted: rows.results.length };
}
