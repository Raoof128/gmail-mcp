import { clearPermit, permitStatement } from "../operations/recovery-state";
/** Linked storage keeps its operation identity after consumption. No permit spans R2 I/O. */
export async function storageBatch(
  db: D1Database,
  handles: string[],
  statements: D1PreparedStatement[],
): Promise<D1Result[]> {
  const ids = handles.length
    ? await db
        .prepare(
          `SELECT DISTINCT o.id FROM staging_objects s JOIN operations o ON o.id=COALESCE(s.settlement_operation_id,s.reserved_by_operation_id) WHERE o.settlement_protocol=2 AND s.handle IN (${handles.map(() => "?").join(",")})`,
        )
        .bind(...handles)
        .all<{ id: string }>()
    : { results: [] };
  const result = await db.batch([
    ...ids.results.map((r) => permitStatement(db, r.id, "storage")),
    ...statements,
    ...ids.results.map((r) => clearPermit(db, r.id)),
  ]);
  return result.slice(ids.results.length, ids.results.length + statements.length);
}
export async function producerStopped(db: D1Database, key: string): Promise<boolean> {
  return Boolean(
    await db
      .prepare(
        `SELECT 1 WHERE (EXISTS(SELECT 1 FROM staging_ingests WHERE r2_key=? AND writer_stopped=1 AND state='published') OR EXISTS(SELECT 1 FROM upload_generations WHERE r2_key=? AND writer_stopped=1 AND cleanup_state='published')) AND NOT EXISTS(SELECT 1 FROM staging_ingests WHERE r2_key=? AND writer_stopped=0) AND NOT EXISTS(SELECT 1 FROM upload_generations WHERE r2_key=? AND writer_stopped=0)`,
      )
      .bind(key, key, key, key)
      .first(),
  );
}
