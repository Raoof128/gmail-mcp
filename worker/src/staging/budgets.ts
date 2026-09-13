import { STAGING_LIMITS as L } from "@gmail-mcp/shared/staging";
import { assertion } from "./transfers";
/** A download reserves its admission and future ACK before accepting bytes. */
export function recoveryBudget(db: D1Database, user: string, key: string, units: number, until: number) {
  const delta = "MAX(0,?-COALESCE((SELECT units FROM staging_recovery_slots WHERE user_id=? AND key=?),0))";
  return [
    assertion(db, `COALESCE((SELECT sum(units) FROM staging_recovery_slots),0)+${delta}<=?`, [
      units,
      user,
      key,
      L.recordsGlobal,
    ]),
    assertion(db, `COALESCE((SELECT sum(units) FROM staging_recovery_slots WHERE user_id=?),0)+${delta}<=?`, [
      user,
      units,
      user,
      key,
      L.recordsOwner,
    ]),
    db
      .prepare(
        "INSERT INTO staging_recovery_slots VALUES(?,?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET units=MAX(units,excluded.units),retain_until=MAX(retain_until,excluded.retain_until)",
      )
      .bind(user, key, units, until),
  ];
}
