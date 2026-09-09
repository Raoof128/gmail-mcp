export type AuditFacts = { recipients?: number; attachments?: number; ids?: string[] };

type Base = {
  userId: string;
  accountId: string | null;
  tool: string;
  action: string;
  modifiers: string[];
  decision: string;
  pendingId?: string;
  operationId?: string;
  facts: AuditFacts;
  clientHint?: string;
};

/** The only way a summary reaches the audit table. Counts and ids, never text from mail. */
function render(f: AuditFacts): string {
  const parts: string[] = [];
  if (f.recipients !== undefined) parts.push(`recipients=${f.recipients}`);
  if (f.attachments !== undefined) parts.push(`attachments=${f.attachments}`);
  if (f.ids && f.ids.length > 0)
    parts.push(
      `ids=${f.ids
        .slice(0, 10)
        .map((s) => s.replace(/[^A-Za-z0-9_.:-]/g, ""))
        .join(",")}`,
    );
  return parts.join(" ");
}

async function write(
  db: D1Database,
  phase: "intent" | "outcome",
  b: Base & { gmailResultId?: string },
): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO audit_log (ts, user_id, account_id, tool, action, modifiers, phase, decision, pending_id, operation_id, gmail_result_id, summary, client_hint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      Date.now(),
      b.userId,
      b.accountId,
      b.tool,
      b.action,
      JSON.stringify(b.modifiers),
      phase,
      b.decision,
      b.pendingId ?? null,
      b.operationId ?? null,
      b.gmailResultId ?? null,
      render(b.facts),
      b.clientHint ?? null,
    )
    .run();
  return Number(res.meta.last_row_id ?? 0);
}

export const auditIntent = (db: D1Database, b: Base) => write(db, "intent", b);
export const auditOutcome = (db: D1Database, b: Base & { gmailResultId?: string }) => write(db, "outcome", b);
