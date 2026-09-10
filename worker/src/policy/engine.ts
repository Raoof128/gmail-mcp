import { DEFAULT_POLICY, raise, type Action, type Level, type Modifier } from "@gmail-mcp/shared/actions";
import { auditStatement, type AuditBase } from "../audit/log";
import { revokeOtherSessionsStatement } from "../web/session";
import { GmailMcpError } from "@gmail-mcp/shared/errors";

export type Decision = { level: Level; base: Level; modifiers: Modifier[] };

export async function assertAccount(db: D1Database, userId: string, accountId: string): Promise<void> {
  const row = await db
    .prepare("SELECT id FROM accounts WHERE id = ? AND user_id = ?")
    .bind(accountId, userId)
    .first<{ id: string }>();
  if (!row) throw new GmailMcpError("account_not_found", "account_not_found");
}

export async function effectiveLevel(
  db: D1Database,
  userId: string,
  accountId: string,
  action: Action,
): Promise<Level> {
  const def = DEFAULT_POLICY[action];
  if (def === "browser") throw new Error(`action ${action} is browser-only`);
  await assertAccount(db, userId, accountId);
  const row = await db
    .prepare(
      `SELECT level FROM policies WHERE user_id = ? AND action = ? AND (account_id = ? OR account_id IS NULL)
              ORDER BY account_id IS NULL ASC LIMIT 1`,
    )
    .bind(userId, action, accountId)
    .first<{ level: Level }>();
  return row?.level ?? def;
}

export async function decide(
  db: D1Database,
  o: { userId: string; accountId: string; action: Action; modifiers: Modifier[] },
): Promise<Decision> {
  const base = await effectiveLevel(db, o.userId, o.accountId, o.action);
  return { base, level: o.modifiers.length > 0 ? raise(base) : base, modifiers: [...o.modifiers] };
}

export async function setPolicy(
  db: D1Database,
  o: { userId: string; accountId: string | null; action: Action; level: Level },
): Promise<void> {
  const now = Date.now();
  if (o.accountId === null) {
    await db
      .prepare(
        `INSERT INTO policies (user_id, account_id, action, level, updated_at) VALUES (?, NULL, ?, ?, ?)
       ON CONFLICT(user_id, action) WHERE account_id IS NULL DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`,
      )
      .bind(o.userId, o.action, o.level, now)
      .run();
  } else {
    await assertAccount(db, o.userId, o.accountId);
    await db
      .prepare(
        `INSERT INTO policies (user_id, account_id, action, level, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, account_id, action) WHERE account_id IS NOT NULL DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`,
      )
      .bind(o.userId, o.accountId, o.action, o.level, now)
      .run();
  }
}

export type PolicyChange = { accountId: string | null; action: Action; level: Level | "inherit" };

export function setPolicyStatement(
  db: D1Database,
  o: { userId: string; accountId: string | null; action: Action; level: Level },
): D1PreparedStatement {
  const now = Date.now();
  return o.accountId === null
    ? db
        .prepare(
          `INSERT INTO policies (user_id, account_id, action, level, updated_at) VALUES (?, NULL, ?, ?, ?)
           ON CONFLICT(user_id, action) WHERE account_id IS NULL DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`,
        )
        .bind(o.userId, o.action, o.level, now)
    : db
        .prepare(
          `INSERT INTO policies (user_id, account_id, action, level, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, account_id, action) WHERE account_id IS NOT NULL DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`,
        )
        .bind(o.userId, o.accountId, o.action, o.level, now);
}

export function clearPolicyStatement(
  db: D1Database,
  o: { userId: string; accountId: string | null; action: Action },
): D1PreparedStatement {
  return o.accountId === null
    ? db
        .prepare("DELETE FROM policies WHERE user_id = ? AND account_id IS NULL AND action = ?")
        .bind(o.userId, o.action)
    : db
        .prepare("DELETE FROM policies WHERE user_id = ? AND account_id = ? AND action = ?")
        .bind(o.userId, o.accountId, o.action);
}

export async function clearPolicy(
  db: D1Database,
  o: { userId: string; accountId: string | null; action: Action },
): Promise<void> {
  await clearPolicyStatement(db, o).run();
}

/**
 * A policy edit is one transaction: every row change, the audit row that says it happened, and the
 * revocation of every other session, together or not at all. Ownership of account_id rows is the
 * composite foreign key's job; the caller has already validated the shape.
 */
export async function applyPolicyEdit(
  db: D1Database,
  o: { userId: string; sessionIdHash: string; changes: PolicyChange[]; audit: AuditBase },
): Promise<void> {
  const stmts = o.changes.map((c) =>
    c.level === "inherit"
      ? clearPolicyStatement(db, { userId: o.userId, accountId: c.accountId, action: c.action })
      : setPolicyStatement(db, { userId: o.userId, accountId: c.accountId, action: c.action, level: c.level }),
  );
  stmts.push(auditStatement(db, "intent", o.audit));
  stmts.push(revokeOtherSessionsStatement(db, o.userId, o.sessionIdHash));
  await db.batch(stmts);
}
