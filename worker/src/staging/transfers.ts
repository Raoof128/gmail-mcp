import { recoveryBudget } from "./budgets";
import { TransferIntent, type TransferResult, STAGING_LIMITS as L } from "@gmail-mcp/shared/staging";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Env } from "../env";
import type { Principal } from "../auth/principal";
import { canonicalize, hashCanonical } from "../crypto/canonical";
import { randomHandle, randomId } from "../crypto/random";
import { decide } from "../policy/engine";
import { assertNotBlocked } from "../policy/limits";
import { resolveAccount } from "../tools/accounts";
import { createPendingStatement, getPending } from "../approval/pending";
import { auditStatement } from "../audit/log";

export type TransferRow = {
  user_id: string;
  id: string;
  account_id: string;
  account_alias: string;
  metadata_json: string;
  intent_hash: string;
  payload_version: number;
  state: string;
  pending_id: string | null;
  operation_id: string | null;
  active_generation: number;
  handle: string | null;
  handle_expires_at: number | null;
  error: string | null;
  created_at: number;
  authority_until: number;
  retain_until: number;
};
export type GenerationRow = {
  user_id: string;
  transfer_id: string;
  account_id: string;
  generation: number;
  ticket_id: string;
  state: string;
  issued_until: number;
  admitted_at: number | null;
  lease_until: number | null;
  credential_version: number | null;
  r2_key: string;
  reserved_bytes: number;
  cleanup_state: string;
  writer_stopped: number;
  created_at: number;
};
export const readTransfer = (db: D1Database, user: string, id: string) =>
  db.prepare("SELECT * FROM upload_transfers WHERE user_id=? AND id=?").bind(user, id).first<TransferRow>();
export function assertion(db: D1Database, condition: string, values: unknown[] = []): D1PreparedStatement {
  return db.prepare(`INSERT INTO _assert(x) SELECT 1 WHERE NOT (${condition})`).bind(...values);
}
export function auditFor(t: TransferRow, decision: string) {
  return {
    userId: t.user_id,
    accountId: t.account_id,
    tool: "stage_file",
    action: "attachment.stage_upload",
    modifiers: [],
    decision,
    ...(t.pending_id ? { pendingId: t.pending_id } : {}),
    ...(t.operation_id ? { operationId: t.operation_id } : {}),
    facts: { attachments: 1 },
  };
}
export async function transferView(
  env: Env,
  t: TransferRow,
  generation = t.active_generation,
): Promise<TransferResult> {
  const out: TransferResult = {
    transfer_id: t.id,
    account: t.account_alias,
    account_id: t.account_id,
    intent_hash: t.intent_hash,
    state: t.state,
  };
  if (t.error) out.error = t.error;
  if (t.handle) {
    out.handle = t.handle;
    out.handle_expires_at = t.handle_expires_at!;
    if (t.handle_expires_at! <= Date.now()) out.state = "completed_handle_expired";
    return out;
  }
  if (t.pending_id && t.state === "awaiting_approval") {
    out.pending_id = t.pending_id;
    out.approval_url = `https://${env.WORKER_HOSTNAME}/approve/${t.pending_id}`;
  }
  if (["failed", "denied", "expired", "awaiting_approval"].includes(t.state)) return out;
  if (generation) {
    const g = await env.DB.prepare(
      "SELECT * FROM upload_generations WHERE user_id=? AND transfer_id=? AND generation=?",
    )
      .bind(t.user_id, t.id, generation)
      .first<GenerationRow>();
    if (g) {
      out.generation = g.generation;
      out.state = g.state;
      if (g.state === "issued" && g.issued_until > Date.now() && t.authority_until > Date.now()) {
        out.ticket_id = g.ticket_id;
        out.ticket_expires_at = g.issued_until;
      } else if (g.state === "issued") out.state = "expired";
    }
  }
  return out;
}
export async function policySnapshot(env: Env, user: string, account: string) {
  // Read the revision first; the later batch asserts it did not move around the decision read.
  const rev = (await env.DB.prepare("SELECT version FROM policy_revision WHERE id=1").first<{ version: number }>())!
    .version;
  const result = await decide(env.DB, {
    userId: user,
    accountId: account,
    action: "attachment.stage_upload",
    modifiers: [],
  });
  return { rev, level: result.level };
}
export function policyAssert(db: D1Database, rev: number) {
  return assertion(db, "(SELECT version FROM policy_revision WHERE id=1)=?", [rev]);
}
export function accountAssert(db: D1Database, user: string, id: string, version?: number) {
  return assertion(
    db,
    `EXISTS(SELECT 1 FROM accounts WHERE user_id=? AND id=? AND status='active'${version === undefined ? "" : " AND credential_version=?"})`,
    version === undefined ? [user, id] : [user, id, version],
  );
}
export function byteQuota(db: D1Database, user: string, size: number) {
  const used =
    "COALESCE((SELECT sum(size) FROM staging_objects),0)+COALESCE((SELECT sum(reserved_bytes) FROM upload_generations WHERE cleanup_state IN ('reserved','debt','deleting')),0)+COALESCE((SELECT sum(reserved_bytes) FROM staging_ingests WHERE state IN ('active','debt')),0)+COALESCE((SELECT sum(reserved_bytes) FROM staging_materializations),0)";
  const own =
    "COALESCE((SELECT sum(size) FROM staging_objects WHERE user_id=?),0)+COALESCE((SELECT sum(reserved_bytes) FROM upload_generations WHERE user_id=? AND cleanup_state IN ('reserved','debt','deleting')),0)+COALESCE((SELECT sum(reserved_bytes) FROM staging_ingests WHERE user_id=? AND state IN ('active','debt')),0)+COALESCE((SELECT sum(reserved_bytes) FROM staging_materializations WHERE user_id=?),0)";
  return [
    assertion(db, `${used}+?<=?`, [size, L.bytesGlobal]),
    assertion(db, `${own}+?<=?`, [user, user, user, user, size, L.bytesOwner]),
  ];
}
export async function ensureTransfer(env: Env, p: Principal, raw: TransferIntent): Promise<TransferResult> {
  const input = TransferIntent.parse(raw);
  const db = env.DB;
  const now = Date.now();
  let t = await readTransfer(db, p.userId, input.transfer_id);
  if (!t) {
    if (input.mode !== "ensure") throw new GmailMcpError("handle_invalid", "handle_invalid: unknown transfer");
    const account = await resolveAccount(env, p.userId, input.account);
    assertNotBlocked(input.metadata.filename);
    const policy = await policySnapshot(env, p.userId, account.id);
    if (policy.level === "deny") {
      await auditStatement(db, "intent", {
        userId: p.userId,
        accountId: account.id,
        tool: "stage_file",
        action: "attachment.stage_upload",
        modifiers: [],
        decision: "deny",
        facts: { attachments: 1 },
      }).run();
      throw new GmailMcpError("policy_denied", "policy_denied: upload");
    }
    const metadata = canonicalize(input.metadata);
    const hash = await hashCanonical(canonicalize({ account_id: account.id, metadata: input.metadata, v: 1 }));
    const pending = policy.level === "ask" ? randomId("pa") : null;
    const payload = canonicalize({ tool: "stage_file", v: 1, ...input.metadata });
    const stmts = [
      ...recoveryBudget(db, p.userId, "upload:" + input.transfer_id, 1, now + L.retentionMs),
      policyAssert(db, policy.rev),
      accountAssert(db, p.userId, account.id),
      assertion(db, "(SELECT count(*) FROM upload_transfers WHERE user_id=?)<?", [p.userId, L.recordsOwner]),
      assertion(db, "(SELECT count(*) FROM upload_transfers)<?", [L.recordsGlobal]),
      assertion(
        db,
        "(SELECT count(*) FROM upload_transfers WHERE user_id=? AND state IN ('authorized','awaiting_approval','in_progress'))<?",
        [p.userId, L.pendingOwner],
      ),
      assertion(
        db,
        "(SELECT count(*) FROM upload_transfers WHERE state IN ('authorized','awaiting_approval','in_progress'))<?",
        [L.pendingGlobal],
      ),
    ];
    if (pending)
      stmts.push(
        createPendingStatement(db, {
          id: pending,
          userId: p.userId,
          accountId: account.id,
          action: "attachment.stage_upload",
          modifiers: [],
          canonical: payload,
          hash: await hashCanonical(payload),
          intentHash: hash,
          idempotencyKey: input.transfer_id,
          summary: `Stage ${input.metadata.filename}`,
          now,
        }),
      );
    stmts.push(
      db
        .prepare(
          "INSERT INTO upload_transfers(user_id,id,account_id,account_alias,metadata_json,intent_hash,state,pending_id,created_at,authority_until,retain_until) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          p.userId,
          input.transfer_id,
          account.id,
          input.account,
          metadata,
          hash,
          pending ? "awaiting_approval" : "authorized",
          pending,
          now,
          now + L.authorityMs,
          now + L.retentionMs,
        ),
    );
    stmts.push(
      auditStatement(db, "intent", {
        userId: p.userId,
        accountId: account.id,
        tool: "stage_file",
        action: "attachment.stage_upload",
        modifiers: [],
        decision: policy.level,
        ...(pending ? { pendingId: pending } : {}),
        facts: { attachments: 1 },
      }),
    );
    try {
      await db.batch(stmts);
    } catch (e) {
      if (!(await readTransfer(db, p.userId, input.transfer_id)))
        throw new GmailMcpError("limit_exceeded", "limit_exceeded: intent admission failed", { cause: String(e) });
    }
    t = (await readTransfer(db, p.userId, input.transfer_id))!;
  }
  if (t.account_alias !== input.account || t.metadata_json !== canonicalize(input.metadata))
    throw new GmailMcpError("idempotency_conflict", "idempotency_conflict: transfer is bound to another intent");
  if (input.mode === "status" || t.handle || ["failed", "denied", "expired"].includes(t.state))
    return transferView(env, t);
  if (t.authority_until <= now) {
    // Authority expiry closes admission; an already admitted lease may still settle.
    await db
      .prepare(
        "UPDATE upload_transfers SET state='expired',error='pending_expired' WHERE user_id=? AND id=? AND state!='completed' AND NOT EXISTS(SELECT 1 FROM upload_generations g WHERE g.user_id=upload_transfers.user_id AND g.transfer_id=upload_transfers.id AND g.generation=upload_transfers.active_generation AND g.state IN ('uploading','stored') AND g.lease_until>?)",
      )
      .bind(t.user_id, t.id, now)
      .run();
    return transferView(env, (await readTransfer(db, t.user_id, t.id))!);
  }
  if (input.mode === "retry") {
    const previous = await db
      .prepare(
        "SELECT expected_generation,result_generation FROM upload_retry_requests WHERE user_id=? AND transfer_id=? AND retry_id=?",
      )
      .bind(t.user_id, t.id, input.retry_request_id)
      .first<{ expected_generation: number; result_generation: number }>();
    if (previous) {
      if (previous.expected_generation !== input.expected_generation)
        throw new GmailMcpError("idempotency_conflict", "idempotency_conflict: retry identity");
      return transferView(env, t, previous.result_generation);
    }
  }
  const policy = await policySnapshot(env, t.user_id, t.account_id);
  if (policy.level === "deny") {
    await terminalBeforeAdmission(env, t, "denied", "policy_denied");
    throw new GmailMcpError("policy_denied", "policy_denied: upload policy tightened");
  }
  const pending = t.pending_id ? await getPending(db, t.pending_id, t.user_id) : null;
  if (t.active_generation && t.state !== "awaiting_approval") {
    if (policy.level === "ask" && (!pending || !["approved", "executing"].includes(pending.state))) {
      const generation = await db
        .prepare("SELECT state FROM upload_generations WHERE user_id=? AND transfer_id=? AND generation=?")
        .bind(t.user_id, t.id, t.active_generation)
        .first<{ state: string }>();
      if (generation && ["uploading", "stored", "completed"].includes(generation.state)) return transferView(env, t);
      await db.batch([
        policyAssert(db, policy.rev),
        assertion(
          db,
          "EXISTS(SELECT 1 FROM upload_transfers WHERE user_id=? AND id=? AND active_generation=? AND state='in_progress')",
          [t.user_id, t.id, t.active_generation],
        ),
        assertion(
          db,
          "EXISTS(SELECT 1 FROM upload_generations WHERE user_id=? AND transfer_id=? AND generation=? AND state IN ('issued','expired','abandoned'))",
          [t.user_id, t.id, t.active_generation],
        ),
        db
          .prepare(
            "UPDATE upload_generations SET state='expired',cleanup_state='released',writer_stopped=1 WHERE user_id=? AND transfer_id=? AND generation=? AND state='issued'",
          )
          .bind(t.user_id, t.id, t.active_generation),
        db
          .prepare("UPDATE upload_transfers SET state='awaiting_approval' WHERE user_id=? AND id=?")
          .bind(t.user_id, t.id),
      ]);
      t = (await readTransfer(db, t.user_id, t.id))!;
    } else if (input.mode !== "retry") return transferView(env, t);
  }
  if (pending && ["denied", "cancelled", "expired", "failed"].includes(pending.state)) {
    await db
      .prepare("UPDATE upload_transfers SET state='failed',error=? WHERE user_id=? AND id=?")
      .bind(pending.state, t.user_id, t.id)
      .run();
    return transferView(env, (await readTransfer(db, t.user_id, t.id))!);
  }
  if (policy.level === "ask" && (!pending || !["approved", "executing"].includes(pending.state))) {
    if (!pending) {
      const id = randomId("pa");
      const payload = canonicalize({ tool: "stage_file", v: 1, ...input.metadata });
      try {
        await db.batch([
          policyAssert(db, policy.rev),
          assertion(db, "EXISTS(SELECT 1 FROM upload_transfers WHERE user_id=? AND id=? AND pending_id IS NULL)", [
            t.user_id,
            t.id,
          ]),
          createPendingStatement(db, {
            id,
            userId: t.user_id,
            accountId: t.account_id,
            action: "attachment.stage_upload",
            modifiers: [],
            canonical: payload,
            hash: await hashCanonical(payload),
            intentHash: t.intent_hash,
            idempotencyKey: t.id,
            summary: `Stage ${input.metadata.filename}`,
            now,
            ttlMs: t.authority_until - now,
          }),
          db
            .prepare("UPDATE upload_transfers SET pending_id=?,state='awaiting_approval' WHERE user_id=? AND id=?")
            .bind(id, t.user_id, t.id),
        ]);
      } catch {
        const latest = await readTransfer(db, t.user_id, t.id);
        if (!latest?.pending_id)
          throw new GmailMcpError("pending_not_approved", "pending_not_approved: admission changed");
      }
    }
    return transferView(env, (await readTransfer(db, t.user_id, t.id))!, 0);
  }
  if (pending) {
    const expected = canonicalize({ tool: "stage_file", v: 1, ...input.metadata });
    if (
      pending.action !== "attachment.stage_upload" ||
      pending.account_id !== t.account_id ||
      pending.payload_json !== expected ||
      pending.payload_hash !== (await hashCanonical(expected)) ||
      pending.expires_at <= now
    )
      throw new GmailMcpError("payload_mismatch", "payload_mismatch: staging approval");
    if (!["approved", "executing"].includes(pending.state)) return transferView(env, t, 0);
  }
  const old = t.active_generation;
  const next = old + 1;
  if (next > L.generations || (input.mode === "retry" && input.expected_generation !== old))
    throw new GmailMcpError("idempotency_conflict", "idempotency_conflict: stale generation");
  const ticket = randomHandle().replace(/^sh_/, "ut_");
  const op = t.operation_id ?? randomId("op");
  const stmts = [
    policyAssert(db, policy.rev),
    accountAssert(db, t.user_id, t.account_id),
    assertion(
      db,
      "EXISTS(SELECT 1 FROM upload_transfers WHERE user_id=? AND id=? AND active_generation=? AND state NOT IN ('completed','failed','expired','denied'))",
      [t.user_id, t.id, old],
    ),
  ];
  if (old) {
    stmts.push(
      db
        .prepare(
          "UPDATE upload_generations SET state='expired',cleanup_state='released',writer_stopped=1 WHERE user_id=? AND transfer_id=? AND generation=? AND state='issued' AND issued_until<=?",
        )
        .bind(t.user_id, t.id, old, now),
    );
    stmts.push(
      assertion(
        db,
        "EXISTS(SELECT 1 FROM upload_generations WHERE user_id=? AND transfer_id=? AND generation=? AND state IN ('expired','abandoned'))",
        [t.user_id, t.id, old],
      ),
    );
  }
  stmts.push(
    ...byteQuota(db, t.user_id, input.metadata.size),
    assertion(db, "(SELECT count(*) FROM upload_generations WHERE state='issued' AND issued_until>?)<?", [
      now,
      L.ticketsGlobal,
    ]),
    assertion(db, "(SELECT count(*) FROM upload_generations WHERE user_id=? AND state='issued' AND issued_until>?)<?", [
      t.user_id,
      now,
      L.ticketsOwner,
    ]),
  );
  if (!t.operation_id)
    stmts.push(
      db
        .prepare(
          "INSERT INTO operations(id,user_id,account_id,action,idempotency_key,state,payload_hash,created_at,updated_at) VALUES(?,?,?,'attachment.stage_upload',?,'claimed',?,?,?)",
        )
        .bind(op, t.user_id, t.account_id, t.id, t.intent_hash, now, now),
    );
  if (pending?.state === "approved") {
    stmts.push(
      db
        .prepare(
          "UPDATE pending_actions SET state='executing',operation_id=?,execution_started_at=? WHERE id=? AND user_id=? AND state='approved' AND expires_at>?",
        )
        .bind(op, now, pending.id, t.user_id, now),
    );
    stmts.push(
      assertion(db, "EXISTS(SELECT 1 FROM pending_actions WHERE id=? AND state='executing' AND operation_id=?)", [
        pending.id,
        op,
      ]),
    );
  }
  stmts.push(
    db
      .prepare(
        "INSERT INTO upload_generations(user_id,transfer_id,account_id,generation,ticket_id,state,issued_until,r2_key,reserved_bytes,created_at) VALUES(?,?,?,?,?,'issued',?,?,?,?)",
      )
      .bind(
        t.user_id,
        t.id,
        t.account_id,
        next,
        ticket,
        Math.min(now + L.ticketMs, t.authority_until),
        `stg/upload/${encodeURIComponent(t.user_id)}/${t.id}/${next}`,
        input.metadata.size,
        now,
      ),
  );
  stmts.push(
    db
      .prepare(
        "UPDATE upload_transfers SET state='in_progress',operation_id=?,active_generation=? WHERE user_id=? AND id=?",
      )
      .bind(op, next, t.user_id, t.id),
  );
  if (input.mode === "retry")
    stmts.push(
      db
        .prepare("INSERT INTO upload_retry_requests VALUES(?,?,?,?,?)")
        .bind(t.user_id, t.id, input.retry_request_id, input.expected_generation, next),
    );
  try {
    await db.batch(stmts);
  } catch (e) {
    const latest = (await readTransfer(db, t.user_id, t.id))!;
    if (input.mode === "retry") {
      const receipt = await db
        .prepare(
          "SELECT result_generation FROM upload_retry_requests WHERE user_id=? AND transfer_id=? AND retry_id=? AND expected_generation=?",
        )
        .bind(t.user_id, t.id, input.retry_request_id, input.expected_generation)
        .first<{ result_generation: number }>();
      if (receipt) return transferView(env, latest, receipt.result_generation);
      if (latest.active_generation !== old)
        throw new GmailMcpError("idempotency_conflict", "idempotency_conflict: competing retry");
    } else if (latest.active_generation === next) return transferView(env, latest);
    throw new GmailMcpError("limit_exceeded", "limit_exceeded: ticket admission failed", { cause: String(e) });
  }
  return transferView(env, (await readTransfer(db, t.user_id, t.id))!);
}

/** Refuse unadmitted authority permanently; ordinary policy edits do not cancel an admitted writer. */
export async function terminalBeforeAdmission(
  env: Env,
  t: TransferRow,
  state: "denied" | "failed",
  error: string,
): Promise<void> {
  const db = env.DB;
  await db.batch([
    assertion(
      db,
      "NOT EXISTS(SELECT 1 FROM upload_generations WHERE user_id=? AND transfer_id=? AND state IN ('uploading','stored','completed'))",
      [t.user_id, t.id],
    ),
    db
      .prepare(
        "UPDATE upload_generations SET state='failed',writer_stopped=1,cleanup_state='released' WHERE user_id=? AND transfer_id=? AND state='issued'",
      )
      .bind(t.user_id, t.id),
    db
      .prepare("UPDATE upload_transfers SET state=?,error=? WHERE user_id=? AND id=? AND state!='completed'")
      .bind(state, error, t.user_id, t.id),
    db
      .prepare(
        "UPDATE operations SET state='failed_safe',updated_at=? WHERE id=? AND action='attachment.stage_upload' AND state='claimed'",
      )
      .bind(Date.now(), t.operation_id),
    db
      .prepare(
        "UPDATE pending_actions SET state=?,error=?,payload_json=NULL,summary='redacted' WHERE id=? AND action='attachment.stage_upload' AND state IN ('pending','approved','executing')",
      )
      .bind(state, error, t.pending_id),
    auditStatement(db, "outcome", auditFor(t, state)),
  ]);
}
