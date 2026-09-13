import type { Env } from "../env";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import { STAGING_LIMITS as L } from "@gmail-mcp/shared/staging";
import { randomId } from "../crypto/random";
import { assertion, byteQuota, accountAssert } from "./transfers";
export type Materialization = { id: string; until: number };
export async function withMaterialization<T>(
  env: Env,
  run: (lease: Materialization) => Promise<T>,
  reservation?: { userId: string; accountId: string; bytes: number },
): Promise<T> {
  const now = Date.now(),
    id = randomId("mat"),
    until = now + L.leaseMs;
  try {
    await env.DB.batch([
      ...(reservation
        ? [
            ...byteQuota(env.DB, reservation.userId, reservation.bytes),
            accountAssert(env.DB, reservation.userId, reservation.accountId),
          ]
        : []),
      assertion(env.DB, "(SELECT count(*) FROM staging_materializations WHERE lease_until>?)=0", [now]),
      assertion(
        env.DB,
        "(SELECT count(*) FROM upload_generations WHERE state IN ('uploading','stored') AND lease_until>?)=0",
        [now],
      ),
      env.DB.prepare("INSERT INTO staging_materializations VALUES(?,?,?,?,?)").bind(
        id,
        until,
        reservation?.userId ?? null,
        reservation?.accountId ?? null,
        reservation?.bytes ?? 0,
      ),
    ]);
  } catch {
    throw new GmailMcpError("limit_exceeded", "limit_exceeded: materialization busy");
  }
  try {
    return await run({ id, until });
  } finally {
    await env.DB.prepare("DELETE FROM staging_materializations WHERE id=?").bind(id).run();
  }
}
