import { randomUUID } from "node:crypto";
import { z } from "zod";
import { manifestSchema, hash, type Manifest } from "./manifest.ts";
import type { AdminPort, Statement } from "./admin.ts";
export interface StoragePort extends AdminPort {
  select(statement: Statement): Promise<unknown[]>;
  remove(key: string): Promise<void>;
}
const producer = `(EXISTS(SELECT 1 FROM staging_ingests i WHERE i.r2_key=s.r2_key AND i.writer_stopped=1 AND i.state='published') OR EXISTS(SELECT 1 FROM upload_generations g WHERE g.r2_key=s.r2_key AND g.writer_stopped=1 AND g.cleanup_state='published')) AND NOT EXISTS(SELECT 1 FROM staging_ingests i WHERE i.r2_key=s.r2_key AND i.writer_stopped=0) AND NOT EXISTS(SELECT 1 FROM upload_generations g WHERE g.r2_key=s.r2_key AND g.writer_stopped=0)`;
/** Deletes only stopped, operation-bound source objects. Delivery truth and keys are untouched. */
export async function abandonStorage(
  input: Manifest,
  intentHash: string,
  port: StoragePort,
): Promise<{ deleted: number; intent_sha256: string }> {
  const m = manifestSchema.parse(input);
  hash.parse(intentHash);
  const intent = m.storageIntent;
  if (
    !m.operationId ||
    !intent ||
    intent.expiresAt <= Date.now() ||
    new Set(intent.handles).size !== intent.handles.length
  )
    throw new Error("explicit storage intent required");
  await port.verify(m);
  const placeholders = intent.handles.map(() => "?").join(",");
  const scope = `s.user_id=? AND s.account_id=? AND s.settlement_operation_id=? AND s.handle IN (${placeholders})`;
  const params = [m.userId, m.accountId, m.operationId, ...intent.handles];
  const rows = z.array(z.object({ handle: z.string(), r2_key: z.string(), stopped: z.literal(1) }).strict()).parse(
    await port.select({
      sql: `SELECT s.handle,s.r2_key,CASE WHEN ${producer} THEN 1 ELSE 0 END AS stopped FROM staging_objects s WHERE ${scope}`,
      params,
    }),
  );
  if (rows.length !== intent.handles.length) throw new Error("storage scope refused");
  const permit = (): Statement => ({
    sql: "INSERT INTO settlement_permits(operation_id,token,purpose) VALUES(?,?,'storage')",
    params: [m.operationId!, randomUUID()],
  });
  const clear: Statement = { sql: "DELETE FROM settlement_permits WHERE operation_id=?", params: [m.operationId] };
  const installed: Statement = {
    sql: "INSERT INTO _assert(x) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM recovery_installation WHERE singleton=1 AND schema_version=5 AND restore_generation=? AND mutation_state='active')",
    params: [m.restoreGeneration],
  };
  await port.batch([
    installed,
    permit(),
    {
      sql: `INSERT INTO _assert(x) SELECT 1 WHERE (SELECT count(*) FROM staging_objects s JOIN operations o ON o.id=s.settlement_operation_id WHERE ${scope} AND ${producer} AND o.user_id=s.user_id AND o.account_id=s.account_id AND o.settlement_protocol=2 AND o.state='delivery_unknown')!=?`,
      params: [...params, rows.length],
    },
    { sql: `UPDATE staging_objects AS s SET cleanup_state='deleting' WHERE ${scope}`, params },
    clear,
  ]);
  let deleted = 0;
  for (const row of rows) {
    await port.verify(m);
    await port.remove(row.r2_key);
    // If publication succeeds but bookkeeping fails, retry retains the deleting row and its debt.
    await port.batch([
      installed,
      permit(),
      {
        sql: "DELETE FROM staging_objects WHERE handle=? AND user_id=? AND account_id=? AND settlement_operation_id=? AND cleanup_state='deleting'",
        params: [row.handle, m.userId, m.accountId, m.operationId],
      },
      clear,
    ]);
    deleted++;
  }
  return { deleted, intent_sha256: intentHash };
}
