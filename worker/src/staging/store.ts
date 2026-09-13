import { withMaterialization, type Materialization } from "./materialization";
import { byteQuota, accountAssert, assertion } from "./transfers";
import { leasedDownload, acknowledgeDownload } from "./downloads";
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
    materialization?: Materialization;
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
  if (!o.materialization)
    return withMaterialization(env, async (materialization) => ingest(env, { ...o, materialization }));
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

  const handle = randomHandle();
  const r2Key = `stg/${o.userId}/${handle}`;
  const account = await env.DB.prepare(
    "SELECT credential_version FROM accounts WHERE id=? AND user_id=? AND status='active'",
  )
    .bind(o.accountId, o.userId)
    .first<{ credential_version: number }>();
  if (!account) throw new GmailMcpError("account_needs_reconnect", "account_needs_reconnect");
  await env.DB.batch([
    env.DB.prepare("UPDATE staging_materializations SET reserved_bytes=0 WHERE id=?").bind(o.materialization.id),
    ...byteQuota(env.DB, o.userId, o.length),
    assertion(env.DB, "(SELECT count(*) FROM staging_ingests)<2000"),
    assertion(env.DB, "EXISTS(SELECT 1 FROM staging_materializations WHERE id=? AND lease_until>?)", [
      o.materialization.id,
      Date.now(),
    ]),
    env.DB.prepare(
      "INSERT INTO staging_ingests(id,user_id,account_id,r2_key,reserved_bytes,lease_until,state) VALUES(?,?,?,?,?,?,'active')",
    ).bind(handle, o.userId, o.accountId, r2Key, o.length, o.materialization.until),
  ]);
  let putStarted = false,
    putReturned = false;
  try {
    const bytes = await readExactly(o.body, o.length);
    const sha256 = await sha256Hex(bytes);
    if (o.declaredSha256 && o.declaredSha256.toLowerCase() !== sha256)
      throw new GmailMcpError("handle_invalid", "handle_invalid: declared sha256 mismatch");
    if (Date.now() >= o.materialization.until)
      throw new GmailMcpError("handle_expired", "handle_expired: materialization");
    putStarted = true;
    await env.STAGING.put(r2Key, bytes, { httpMetadata: { contentType: o.mime } });
    putReturned = true;
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
    await env.DB.batch([
      accountAssert(env.DB, o.userId, o.accountId, account.credential_version),
      assertion(env.DB, "EXISTS(SELECT 1 FROM staging_ingests WHERE id=? AND state='active' AND lease_until>?)", [
        handle,
        Date.now(),
      ]),
      env.DB.prepare(
        `INSERT INTO staging_objects (handle, user_id, account_id, direction, r2_key, filename, mime, size, sha256,
         source_message_id, source_attachment_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
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
      ),
      env.DB.prepare("UPDATE staging_ingests SET state='published',writer_stopped=1 WHERE id=?").bind(handle),
    ]);
    return row;
  } catch (e) {
    if (await env.DB.prepare("SELECT handle FROM staging_objects WHERE handle=?").bind(handle).first()) throw e;
    const stopped = !putStarted || putReturned;
    await env.DB.prepare("UPDATE staging_ingests SET state='debt',writer_stopped=? WHERE id=? AND state!='published'")
      .bind(stopped ? 1 : 0, handle)
      .run();
    if (stopped) {
      if (putReturned) await env.STAGING.delete(r2Key);
      await env.DB.prepare(
        "UPDATE staging_ingests SET state='released' WHERE id=? AND state='debt' AND writer_stopped=1",
      )
        .bind(handle)
        .run();
    }
    throw e;
  }
}

/** Download handles only: a staging bearer must never read back an upload it did not create. */
export async function openForRead(
  env: Env,
  o: { handle: string; userId: string },
): Promise<{ row: StagingRow; body: ReadableStream }> {
  return leasedDownload(env, o.userId, o.handle);
}
export async function ack(env: Env, o: { handle: string; userId: string }): Promise<boolean> {
  return (await acknowledgeDownload(env, o.userId, o.handle)) !== null;
}

/** Holds referenced handles open while an approval is pending. Only ever raises the expiry. */
export async function extendExpiry(
  db: D1Database,
  handles: string[],
  userId: string,
  accountId: string,
  until: number,
): Promise<void> {
  const stmt = extendExpiryStatement(db, handles, userId, accountId, until);
  if (stmt) await stmt.run();
}

export function reserveStatements(
  db: D1Database,
  o: { operationId: string; handles: string[]; userId: string; accountId: string; now: number },
): D1PreparedStatement[] {
  if (o.handles.length === 0) return [];
  return [
    db
      .prepare(
        `UPDATE staging_objects SET reserved_by_operation_id = ?
         WHERE handle IN (${o.handles.map(() => "?").join(",")}) AND user_id = ? AND account_id = ? AND direction = 'upload'
           AND consumed_at IS NULL AND reserved_by_operation_id IS NULL AND cleanup_state='available' AND expires_at > ?`,
      )
      .bind(o.operationId, ...o.handles, o.userId, o.accountId, o.now),
    db
      .prepare(
        `INSERT INTO _assert (x) SELECT 1 WHERE (SELECT count(*) FROM staging_objects WHERE reserved_by_operation_id = ?) != ?`,
      )
      .bind(o.operationId, o.handles.length),
  ];
}

export function extendExpiryStatement(
  db: D1Database,
  handles: string[],
  userId: string,
  accountId: string,
  until: number,
): D1PreparedStatement | null {
  if (handles.length === 0) return null;
  return db
    .prepare(
      `UPDATE staging_objects SET expires_at = MAX(expires_at, ?) WHERE handle IN (${handles.map(() => "?").join(",")}) AND user_id = ? AND account_id = ? AND cleanup_state='available'`,
    )
    .bind(until, ...handles, userId, accountId);
}

export async function listUploadHandles(
  db: D1Database,
  o: { handles: string[]; userId: string; accountId: string },
): Promise<StagingRow[]> {
  if (o.handles.length === 0) return [];
  const rows = await db
    .prepare(
      `SELECT * FROM staging_objects WHERE handle IN (${o.handles.map(() => "?").join(",")}) AND user_id = ? AND account_id = ?
         AND direction = 'upload' AND consumed_at IS NULL AND expires_at > ?`,
    )
    .bind(...o.handles, o.userId, o.accountId, Date.now())
    .all<StagingRow>();
  const found = new Set(rows.results.map((r) => r.handle));
  const missing = o.handles.filter((h) => !found.has(h));
  if (missing.length > 0)
    throw new GmailMcpError("handle_invalid", `handle_invalid: ${missing.join(", ")}`, { handles: missing });
  return o.handles.map((h) => rows.results.find((r) => r.handle === h)!);
}

/** The bytes as a stream, so a 25 MB attachment is never held in the isolate at once. */
export async function openStaged(env: Env, row: StagingRow): Promise<ReadableStream<Uint8Array>> {
  const obj = await env.STAGING.get(row.r2_key);
  if (!obj) throw new GmailMcpError("handle_invalid", `handle_invalid: object missing for ${row.handle}`);
  return obj.body;
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
  const candidates = await env.DB.prepare(
    "SELECT handle,r2_key FROM staging_objects WHERE ((expires_at<=? OR consumed_at IS NOT NULL) AND reserved_by_operation_id IS NULL AND COALESCE(download_lease_until,0)<=?) OR cleanup_state='deleting' LIMIT ?",
  )
    .bind(now, now, limit)
    .all<{ handle: string; r2_key: string }>();
  let deleted = 0;
  for (const row of candidates.results) {
    const claimed = await env.DB.prepare(
      "UPDATE staging_objects SET cleanup_state='deleting' WHERE handle=? AND reserved_by_operation_id IS NULL AND COALESCE(download_lease_until,0)<=? AND (expires_at<=? OR consumed_at IS NOT NULL OR cleanup_state='deleting') RETURNING handle",
    )
      .bind(row.handle, now, now)
      .first();
    if (!claimed) continue;
    await env.STAGING.delete(row.r2_key);
    const result = await env.DB.prepare("DELETE FROM staging_objects WHERE handle=? AND cleanup_state='deleting'")
      .bind(row.handle)
      .run();
    deleted += result.meta.changes ?? 0;
  }
  return { deleted };
}
