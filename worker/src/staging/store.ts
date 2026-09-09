import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Env } from "../env";
import { sha256Hex } from "../crypto/canonical";
import { randomHandle } from "../crypto/random";
import { LIMITS, assertNotBlocked, sanitizeFilename } from "../policy/limits";

export const DOWNLOAD_TTL_MS = 30 * 60_000;

export type StagingRow = {
  handle: string;
  user_id: string;
  account_id: string;
  direction: "download" | "upload";
  r2_key: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  source_message_id: string | null;
  source_attachment_id: string | null;
  reserved_by_operation_id: string | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
};

/**
 * Reads exactly `length` bytes, refusing a body that is shorter or longer.
 *
 * The body is materialised before anything reaches R2. Objects are capped at
 * LIMITS.stagedFileBytes (25 MB) against a 128 MB isolate, so the memory cost is bounded, and in
 * exchange a length or hash mismatch can never leave a partial object behind or abort an in-flight
 * upload. Streaming the body straight into R2 was tried first and aborted uploads surfaced as
 * unhandled rejections inside the storage emulator.
 */
async function readExactly(body: ReadableStream<Uint8Array>, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(new ArrayBuffer(length));
  let offset = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > length) {
        throw new GmailMcpError("limit_exceeded", `limit_exceeded: body longer than declared length ${length}`);
      }
      out.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== length) {
    throw new GmailMcpError("limit_exceeded", `limit_exceeded: body was ${offset} bytes, declared ${length}`);
  }
  return out;
}

export async function ingest(
  env: Env,
  o: {
    userId: string;
    accountId: string;
    direction: "download" | "upload";
    filename: string;
    mime: string;
    length: number;
    body: ReadableStream<Uint8Array>;
    declaredSha256?: string;
    source?: { messageId: string; attachmentId: string };
  },
): Promise<StagingRow> {
  const filename = sanitizeFilename(o.filename);
  // The blocked list describes what Gmail refuses to send, so it gates uploads only, never
  // attachments the owner is saving to their own disk.
  if (o.direction === "upload") assertNotBlocked(filename);
  if (!Number.isInteger(o.length) || o.length < 0 || o.length > LIMITS.stagedFileBytes) {
    throw new GmailMcpError(
      "limit_exceeded",
      `limit_exceeded: length ${o.length} not within 0..${LIMITS.stagedFileBytes}`,
    );
  }

  // Validate the bytes fully before touching storage, so no failure path can orphan an object.
  const bytes = await readExactly(o.body, o.length);
  const sha256 = await sha256Hex(bytes);
  if (o.declaredSha256 && o.declaredSha256.toLowerCase() !== sha256) {
    throw new GmailMcpError("handle_invalid", "handle_invalid: declared sha256 mismatch");
  }

  const handle = randomHandle();
  const r2Key = `stg/${o.userId}/${handle}`;
  await env.STAGING.put(r2Key, bytes, { httpMetadata: { contentType: o.mime } });

  const now = Date.now();
  const row: StagingRow = {
    handle,
    user_id: o.userId,
    account_id: o.accountId,
    direction: o.direction,
    r2_key: r2Key,
    filename,
    mime: o.mime,
    size: o.length,
    sha256,
    source_message_id: o.source?.messageId ?? null,
    source_attachment_id: o.source?.attachmentId ?? null,
    reserved_by_operation_id: null,
    created_at: now,
    expires_at: now + DOWNLOAD_TTL_MS,
    consumed_at: null,
  };
  try {
    await env.DB.prepare(
      `INSERT INTO staging_objects (handle, user_id, account_id, direction, r2_key, filename, mime, size, sha256,
         source_message_id, source_attachment_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.handle,
        row.user_id,
        row.account_id,
        row.direction,
        row.r2_key,
        row.filename,
        row.mime,
        row.size,
        row.sha256,
        row.source_message_id,
        row.source_attachment_id,
        row.created_at,
        row.expires_at,
      )
      .run();
  } catch (e) {
    // The metadata row is the record of existence. Without it the object is unreachable, so drop it.
    await env.STAGING.delete(r2Key).catch(() => {});
    throw e;
  }
  return row;
}

/** Download handles only: a staging bearer must never read back an upload it did not create. */
export async function openForRead(
  env: Env,
  o: { handle: string; userId: string },
): Promise<{ row: StagingRow; body: ReadableStream }> {
  const row = await env.DB.prepare(
    "SELECT * FROM staging_objects WHERE handle = ? AND user_id = ? AND direction = 'download' AND consumed_at IS NULL",
  )
    .bind(o.handle, o.userId)
    .first<StagingRow>();
  if (!row) throw new GmailMcpError("handle_invalid", "handle_invalid");
  if (row.expires_at <= Date.now()) throw new GmailMcpError("handle_expired", "handle_expired");
  const obj = await env.STAGING.get(row.r2_key);
  if (!obj) throw new GmailMcpError("handle_invalid", "handle_invalid: object missing");
  return { row, body: obj.body };
}

/** Acknowledges a completed local write. Re-reads are allowed until this lands. */
export async function ack(env: Env, o: { handle: string; userId: string }): Promise<boolean> {
  const now = Date.now();
  const res = await env.DB.prepare(
    "UPDATE staging_objects SET consumed_at = ? WHERE handle = ? AND user_id = ? AND direction = 'download' AND consumed_at IS NULL AND expires_at > ?",
  )
    .bind(now, o.handle, o.userId, now)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

/** Holds referenced handles open while an approval is pending. Only ever raises the expiry. */
export async function extendExpiry(
  db: D1Database,
  handles: string[],
  userId: string,
  accountId: string,
  until: number,
): Promise<void> {
  if (handles.length === 0) return;
  await db
    .prepare(
      `UPDATE staging_objects SET expires_at = MAX(expires_at, ?)
       WHERE handle IN (${handles.map(() => "?").join(",")}) AND user_id = ? AND account_id = ?`,
    )
    .bind(until, ...handles, userId, accountId)
    .run();
}

/** Marks reserved uploads used and clears the reservation so the purge can collect them. */
export async function consume(db: D1Database, operationId: string): Promise<void> {
  await db
    .prepare(
      "UPDATE staging_objects SET consumed_at = ?, reserved_by_operation_id = NULL WHERE reserved_by_operation_id = ? AND consumed_at IS NULL",
    )
    .bind(Date.now(), operationId)
    .run();
}

/** Returns unconsumed reservations to the pool after an operation failed before its side effect. */
export async function release(db: D1Database, operationId: string): Promise<void> {
  await db
    .prepare(
      "UPDATE staging_objects SET reserved_by_operation_id = NULL WHERE reserved_by_operation_id = ? AND consumed_at IS NULL",
    )
    .bind(operationId)
    .run();
}

/** Collects expired or consumed objects that no operation is holding. Bounded per run. */
export async function purgeExpired(env: Env, now: number, limit = 200): Promise<{ deleted: number }> {
  const rows = await env.DB.prepare(
    `SELECT handle, r2_key FROM staging_objects
     WHERE (expires_at <= ? OR consumed_at IS NOT NULL) AND reserved_by_operation_id IS NULL LIMIT ?`,
  )
    .bind(now, limit)
    .all<{ handle: string; r2_key: string }>();
  if (rows.results.length === 0) return { deleted: 0 };
  await env.STAGING.delete(rows.results.map((r) => r.r2_key));
  await env.DB.batch(
    rows.results.map((r) => env.DB.prepare("DELETE FROM staging_objects WHERE handle = ?").bind(r.handle)),
  );
  return { deleted: rows.results.length };
}
