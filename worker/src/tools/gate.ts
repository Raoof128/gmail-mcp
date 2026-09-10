import { inputRequired, type ServerContext, type RequestStateCodec } from "@modelcontextprotocol/server";
import type { Action, Modifier } from "@gmail-mcp/shared/actions";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Env } from "../env";
import type { Deps } from "../deps";
import type { Principal } from "../auth/principal";
import { auditIntent, auditStatement, type AuditBase, type AuditFacts } from "../audit/log";
import { claimPending, handlesFromPayload } from "../approval/claim";
import {
  cancelPending,
  createPendingStatement,
  getPending,
  PENDING_TTL_MS,
  type PendingRow,
} from "../approval/pending";
import { APPROVAL_STATE_VERSION, type ApprovalState } from "../approval/state";
import { canonicalize, hashCanonical } from "../crypto/canonical";
import { randomId } from "../crypto/random";
import { GmailApiError } from "../google/gmail";
import { insertOperationStatement } from "../operations/journal";
import { decide } from "../policy/engine";
import { LIMITS } from "../policy/limits";
import { extendExpiryStatement, reserveStatements } from "../staging/store";
import { accountById, type AccountRef } from "./accounts";
import { bindIdempotencyStatements, lookupIdempotency, replayFor } from "./idempotency";
import { approvalUrl, pendingApprovalResult, text, type ToolResult } from "./results";
import { settleExecuted, settleFailedSafe, settleUnknown } from "./settle";

const HOLD_MARGIN_MS = 5 * 60_000;

export type Round = {
  requestState(): ApprovalState | undefined;
  answer(): "accept" | "decline" | "cancel" | "missing";
  mint(s: ApprovalState): Promise<string>;
};

export function roundOf(ctx: ServerContext, codec: RequestStateCodec<ApprovalState>): Round {
  return {
    requestState: () => ctx.mcpReq.requestState<ApprovalState>(),
    answer: () => {
      const r = ctx.mcpReq.inputResponses?.approval as { action?: unknown } | undefined;
      return r?.action === "accept" || r?.action === "decline" || r?.action === "cancel" ? r.action : "missing";
    },
    mint: (s) => codec.mint(s, ctx),
  };
}

export type ToolContext = { env: Env; deps: Deps; principal: Principal; urlElicitation: boolean; round: Round };

export type ExecRun = {
  userId: string;
  account: AccountRef;
  payload: Record<string, unknown>;
  operationId: string | null;
  pendingId: string | null;
};
export type Executor = (env: Env, deps: Deps, run: ExecRun) => Promise<Record<string, unknown>>;

const executors = new Map<string, { fn: Executor; version: number }>();
/** Keyed by tool name and versioned: a pending row names both, and executes only under the version it was approved for. */
export function registerExecutor(tool: string, version: number, fn: Executor): void {
  executors.set(tool, { fn, version });
}
export function executorFor(tool: string): { fn: Executor; version: number } {
  const e = executors.get(tool);
  if (!e) throw new GmailMcpError("internal", `no executor for ${tool}`);
  return e;
}

export type GateInput = {
  tool: string;
  version: number;
  action: Action;
  journal: boolean;
  account: AccountRef;
  intentHash: string;
  idempotencyKey?: string | undefined;
  modifiers: Modifier[];
  summary: string;
  facts: AuditFacts;
  /** Runs after the decision and after any replay: stages inline bytes, validates handles, returns the execution payload. */
  build: () => Promise<{ payload: Record<string, unknown>; handles: string[] }>;
};

/** Spec 3.10: reads write one intent row only. read.attachment creates staging state, so it keeps its outcome. */
const INTENT_ONLY: ReadonlySet<Action> = new Set<Action>([
  "read.search",
  "read.message",
  "account.read",
  "policy.read",
]);

/** Everything an audit row needs except the decision, which each call site supplies as it writes. */
type AuditDraft = Omit<AuditBase, "decision">;

const base = (
  t: ToolContext,
  i: { tool: string; action: Action; account: AccountRef; modifiers: Modifier[]; facts: AuditFacts },
): AuditDraft => ({
  userId: t.principal.userId,
  accountId: i.account.id,
  tool: i.tool,
  action: i.action,
  modifiers: i.modifiers,
  facts: i.facts,
});

async function canonicalPayload(payload: Record<string, unknown>): Promise<{ canonical: string; hash: string }> {
  const canonical = canonicalize(payload);
  if (new TextEncoder().encode(canonical).length > LIMITS.canonicalPayloadBytes) {
    throw new GmailMcpError("limit_exceeded", "limit_exceeded: canonical payload > 1 MB");
  }
  return { canonical, hash: await hashCanonical(canonical) };
}

/**
 * The one decision point, in this order: replay a known key, decide policy, build the payload, then
 * store-and-ask or journal-and-run. Nothing before `build` writes staging state, so a denied or replayed
 * call leaves no trace but its audit row. Nothing here touches Gmail; executors do, after the journal row.
 */
/**
 * The answer a known key already has, or null when this call is fresh. `defineTool` asks before it
 * plans, because planning reads the staged handles and a replayed send's handles are already consumed:
 * a replay must touch nothing at all (spec 3.5 step 1).
 */
export async function replayIfKnown(
  t: ToolContext,
  o: { tool: string; account: AccountRef; intentHash: string; idempotencyKey: string | undefined },
): Promise<ToolResult | null> {
  if (!o.idempotencyKey) return null;
  const userId = t.principal.userId;
  const known = await lookupIdempotency(t.env.DB, {
    userId,
    accountId: o.account.id,
    key: o.idempotencyKey,
  });
  if (!known) return null;
  const replay = await replayFor(t.env, known, {
    tool: o.tool,
    intentHash: o.intentHash,
    alias: o.account.alias,
    userId,
  });
  return replay === "fresh" ? null : text(replay);
}

export async function runGated(t: ToolContext, input: GateInput): Promise<ToolResult> {
  const db = t.env.DB;
  const userId = t.principal.userId;
  const replayed = await replayIfKnown(t, {
    tool: input.tool,
    account: input.account,
    intentHash: input.intentHash,
    idempotencyKey: input.idempotencyKey,
  });
  if (replayed) return replayed;
  const decision = await decide(db, {
    userId,
    accountId: input.account.id,
    action: input.action,
    modifiers: input.modifiers,
  });
  if (decision.level === "deny") {
    await auditIntent(db, { ...base(t, input), decision: "deny" });
    throw new GmailMcpError("policy_denied", `policy_denied: ${input.action}`, { modifiers: input.modifiers });
  }
  const built = await input.build();
  const payload: Record<string, unknown> = { ...built.payload, tool: input.tool, v: input.version };
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
  const { canonical, hash } = await canonicalPayload(payload);
  const now = Date.now();

  if (decision.level === "ask") {
    const id = randomId("pa");
    const stmts: D1PreparedStatement[] = [
      createPendingStatement(db, {
        id,
        userId,
        accountId: input.account.id,
        action: input.action,
        modifiers: input.modifiers,
        canonical,
        hash,
        intentHash: input.intentHash,
        idempotencyKey: input.idempotencyKey ?? null,
        summary: input.summary,
        now,
      }),
    ];
    // Spec 3.7: a handle staged 29 minutes ago must not expire between approval and execution.
    const hold = extendExpiryStatement(
      db,
      built.handles,
      userId,
      input.account.id,
      now + PENDING_TTL_MS + HOLD_MARGIN_MS,
    );
    if (hold) stmts.push(hold);
    if (input.idempotencyKey)
      stmts.push(
        ...bindIdempotencyStatements(db, {
          userId,
          accountId: input.account.id,
          key: input.idempotencyKey,
          tool: input.tool,
          intentHash: input.intentHash,
          pendingId: id,
          operationId: null,
          now,
        }),
      );
    stmts.push(auditStatement(db, "intent", { ...base(t, input), decision: "ask", pendingId: id }));
    try {
      await db.batch(stmts);
    } catch (e) {
      return lostRace(t, input, e);
    }
    const row = (await getPending(db, id, userId))!;
    return ask(t, input, row);
  }

  const operationId = input.journal || built.handles.length > 0 ? randomId("op") : null;
  const stmts: D1PreparedStatement[] = [];
  if (operationId)
    stmts.push(
      insertOperationStatement(db, {
        id: operationId,
        userId,
        accountId: input.account.id,
        action: input.action,
        payloadHash: hash,
        now,
      }),
    );
  if (input.idempotencyKey)
    stmts.push(
      ...bindIdempotencyStatements(db, {
        userId,
        accountId: input.account.id,
        key: input.idempotencyKey,
        tool: input.tool,
        intentHash: input.intentHash,
        pendingId: null,
        operationId,
        now,
      }),
    );
  if (operationId)
    stmts.push(
      ...reserveStatements(db, { operationId, handles: built.handles, userId, accountId: input.account.id, now }),
    );
  stmts.push(
    auditStatement(db, "intent", { ...base(t, input), decision: "allow", ...(operationId ? { operationId } : {}) }),
  );
  try {
    await db.batch(stmts);
  } catch (e) {
    if (built.handles.length > 0 && operationId) {
      // Distinguish a lost idempotency race from an unavailable handle by re-reading the key.
      const replay = await lostRace(t, input, e, true);
      if (replay) return replay;
      throw new GmailMcpError("handle_reserved", "handle_reserved: one or more attachments are unavailable", {
        handles: built.handles,
      });
    }
    return lostRace(t, input, e);
  }
  return text(await runExecutor(t, { ...input, payload, handles: built.handles, operationId, pendingId: null }));
}

/**
 * A batch that failed because the idempotency assertion refused it means another call with the same key
 * won the race a moment ago: answer with that call's state. Any other failure is rethrown.
 */
async function lostRace(t: ToolContext, input: GateInput, e: unknown, quiet = false): Promise<ToolResult> {
  if (input.idempotencyKey) {
    const known = await lookupIdempotency(t.env.DB, {
      userId: t.principal.userId,
      accountId: input.account.id,
      key: input.idempotencyKey,
    });
    if (known) {
      const replay = await replayFor(t.env, known, {
        tool: input.tool,
        intentHash: input.intentHash,
        alias: input.account.alias,
        userId: t.principal.userId,
      });
      if (replay !== "fresh") return text(replay);
    }
  }
  if (quiet) return undefined as never;
  throw new GmailMcpError("internal", `gate batch failed: ${String((e as Error).message ?? e)}`);
}

async function ask(t: ToolContext, input: GateInput, row: PendingRow): Promise<ToolResult> {
  const url = approvalUrl(t.env, row.id);
  if (!t.urlElicitation) return text(pendingApprovalResult(t.env, row, input.account.alias));
  const requestState = await t.round.mint({
    v: APPROVAL_STATE_VERSION,
    tool: input.tool,
    pending_id: row.id,
    account_id: input.account.id,
    intent_hash: input.intentHash,
  });
  return inputRequired({
    inputRequests: {
      approval: inputRequired.elicitUrl({
        message: `Approve ${input.action} on ${input.account.alias}: ${input.summary}`,
        url,
      }),
    },
    requestState,
  });
}

/**
 * Spec 1.4 and 3.4 on the retried call. The state must be ours, for this tool and this account; the
 * retried arguments must hash to the intent the pending row was created from; then poll until approved,
 * declined or the deadline. The retried call never rebuilds the payload: what executes is the row.
 */
export async function resumeGated(
  t: ToolContext,
  o: { tool: string; account: AccountRef; intentHash: string; state: ApprovalState },
): Promise<ToolResult> {
  const db = t.env.DB;
  const userId = t.principal.userId;
  const auditBase: AuditDraft = {
    userId,
    accountId: o.account.id,
    tool: o.tool,
    action: "send.message",
    modifiers: [],
    facts: {},
  };
  const mismatch = async (why: string, row?: PendingRow): Promise<never> => {
    await auditIntent(db, {
      ...auditBase,
      ...(row ? { action: row.action, modifiers: JSON.parse(row.modifiers) as Modifier[], pendingId: row.id } : {}),
      decision: "payload_mismatch",
    });
    throw new GmailMcpError("payload_mismatch", `payload_mismatch: ${why}`);
  };
  const s = o.state;
  if (s.v !== APPROVAL_STATE_VERSION || s.tool !== o.tool || s.account_id !== o.account.id)
    return mismatch("state does not belong to this call");
  const row = await getPending(db, s.pending_id, userId);
  if (!row) throw new GmailMcpError("pending_not_approved", "pending_not_approved: unknown");
  if (row.intent_hash !== o.intentHash || s.intent_hash !== row.intent_hash) return mismatch("arguments changed", row);

  const answer = t.round.answer();
  if (answer === "decline" || answer === "cancel") {
    await cancelPending(db, { id: row.id, userId });
    throw new GmailMcpError("pending_not_approved", `pending_not_approved: ${answer}d in the client`);
  }
  const deadline = Date.now() + t.deps.approvalWait.deadlineMs;
  for (;;) {
    const cur = await getPending(db, row.id, userId);
    if (!cur) throw new GmailMcpError("pending_not_approved", "pending_not_approved: unknown");
    if (cur.expires_at <= Date.now() && (cur.state === "pending" || cur.state === "approved"))
      throw new GmailMcpError("pending_expired", "pending_expired");
    switch (cur.state) {
      case "approved":
        return text(await executePending(t, cur.id));
      case "pending":
        if (Date.now() >= deadline) return text(pendingApprovalResult(t.env, cur, o.account.alias));
        await t.deps.sleep(t.deps.approvalWait.intervalMs);
        continue;
      case "executing":
      case "executed":
        throw new GmailMcpError("pending_replayed", `pending_replayed: ${cur.state}`);
      case "expired":
        throw new GmailMcpError("pending_expired", "pending_expired");
      default:
        throw new GmailMcpError("pending_not_approved", `pending_not_approved: ${cur.state}`);
    }
  }
}

export type ExecutorRun = {
  tool: string;
  action: Action;
  account: AccountRef;
  payload: Record<string, unknown>;
  modifiers: Modifier[];
  facts: AuditFacts;
  handles: string[];
  operationId: string | null;
  pendingId: string | null;
};

/**
 * Runs the executor and settles every local consequence in one batch. After a failure the operation's
 * state says what happened: `claimed` means no request was opened (failed_safe); `executing` with a
 * Gmail 4xx means Gmail said no, definitively (failed_safe); `executing` with anything else means Gmail
 * may have it (delivery_unknown, the row stays for the cron). A settlement failure after a Gmail success
 * is reported on the result and logged, never turned into a failure the model might retry (spec 3.9).
 */
export async function runExecutor(t: ToolContext, run: ExecutorRun): Promise<Record<string, unknown>> {
  const db = t.env.DB;
  const audit = INTENT_ONLY.has(run.action)
    ? null
    : {
        ...base(t, run),
        ...(run.pendingId ? { pendingId: run.pendingId } : {}),
        ...(run.operationId ? { operationId: run.operationId } : {}),
      };
  let out: Record<string, unknown>;
  try {
    out = await executorFor(run.tool).fn(t.env, t.deps, {
      userId: t.principal.userId,
      account: run.account,
      payload: run.payload,
      operationId: run.operationId,
      pendingId: run.pendingId,
    });
  } catch (e) {
    const state = run.operationId
      ? (await db.prepare("SELECT state FROM operations WHERE id = ?").bind(run.operationId).first<{ state: string }>())
          ?.state
      : null;
    const err =
      e instanceof GmailMcpError
        ? e
        : new GmailMcpError("internal", "internal: the executor failed", {
            cause: e instanceof Error ? e.message : String(e),
          });
    if (
      !run.operationId ||
      state === "claimed" ||
      (state === "executing" && e instanceof GmailApiError && e.status >= 400 && e.status < 500)
    ) {
      await settleFailedSafe(db, { operationId: run.operationId, pendingId: run.pendingId, audit, error: err.code });
      throw err;
    }
    if (state === "executing") {
      await settleUnknown(db, { operationId: run.operationId, pendingId: run.pendingId, audit });
      throw new GmailMcpError(
        "delivery_unknown",
        "delivery_unknown: The Gmail request may have succeeded. Do not retry automatically.",
        { operation_id: run.operationId, cause: err.message },
      );
    }
    await settleFailedSafe(db, { operationId: run.operationId, pendingId: run.pendingId, audit, error: err.code });
    throw err;
  }
  const gmailResultId = typeof out.gmail_result_id === "string" ? out.gmail_result_id : null;
  const result: Record<string, unknown> = {
    status: "executed",
    account: run.account.alias,
    ...(run.operationId ? { operation_id: run.operationId } : {}),
    ...(run.pendingId ? { action_id: run.pendingId } : {}),
    ...out,
  };
  try {
    await settleExecuted(db, {
      operationId: run.operationId,
      pendingId: run.pendingId,
      audit: audit && gmailResultId ? { ...audit, gmailResultId } : audit,
      gmailResultId,
      result: out,
    });
  } catch (e) {
    const state = run.operationId
      ? (await db.prepare("SELECT state FROM operations WHERE id = ?").bind(run.operationId).first<{ state: string }>())
          ?.state
      : null;
    if (state === "claimed") {
      // The executor returned success without ever opening its operation: a programming error, made loud.
      await settleFailedSafe(db, { operationId: run.operationId, pendingId: run.pendingId, audit, error: "internal" });
      throw new GmailMcpError("internal", `internal: ${run.tool} returned without opening its operation`);
    }
    console.error("settlement failed after Gmail success", run.operationId, (e as Error).message);
    result.local_settlement_failed = true;
  }
  return result;
}

/**
 * Spec 3.4 from the approved side: claim atomically, re-evaluate policy (a tighter policy saved after
 * approval wins), check the executor version, run, settle. The account is checked before the claim so a
 * needs_reconnect account leaves the approval intact for later.
 */
export async function executePending(t: ToolContext, pendingId: string): Promise<Record<string, unknown>> {
  const db = t.env.DB;
  const userId = t.principal.userId;
  const before = await getPending(db, pendingId, userId);
  if (!before) throw new GmailMcpError("pending_not_approved", "pending_not_approved: unknown");
  const account = await accountById(t.env, userId, before.account_id);

  const { operationId, pending } = await claimPending(db, { id: pendingId, userId });
  const payload = JSON.parse(pending.payload_json ?? "null") as Record<string, unknown> | null;
  const action = pending.action;
  const modifiers = JSON.parse(pending.modifiers) as Modifier[];
  const tool = typeof payload?.tool === "string" ? payload.tool : "unknown";
  const audit: AuditDraft = {
    userId,
    accountId: account.id,
    tool,
    action,
    modifiers,
    pendingId,
    operationId,
    facts: factsOf(payload ?? {}),
  };

  const refuse = async (code: "payload_mismatch" | "policy_denied", why: string, decision: string): Promise<never> => {
    await settleFailedSafe(db, { operationId, pendingId, audit, error: code, decision });
    throw new GmailMcpError(code, `${code}: ${why}`);
  };
  if (!payload || tool === "unknown") return refuse("payload_mismatch", "no tool in payload", "failed");
  const executor = executorFor(tool);
  if (payload.v !== executor.version)
    return refuse(
      "payload_mismatch",
      `payload was approved for ${tool} v${String(payload.v)}, executor is v${executor.version}`,
      "failed",
    );
  const decision = await decide(db, { userId, accountId: account.id, action, modifiers });
  if (decision.level === "deny") return refuse("policy_denied", `${action} was tightened after approval`, "denied");

  return runExecutor(t, {
    tool,
    action,
    account,
    payload,
    modifiers,
    facts: audit.facts,
    handles: handlesFromPayload(pending.payload_json),
    operationId,
    pendingId,
  });
}

/** Counts and ids from a payload, so audit rows never see content. */
export function factsOf(p: Record<string, unknown>): AuditFacts {
  const arr = (k: string) => (Array.isArray(p[k]) ? (p[k] as unknown[]).length : 0);
  const ids = ["message_id", "thread_id", "draft_id", "label_id"]
    .map((k) => p[k])
    .filter((v): v is string => typeof v === "string");
  const facts: AuditFacts = {};
  const recipients = arr("to") + arr("cc") + arr("bcc");
  if (recipients > 0 || "to" in p) facts.recipients = recipients;
  if ("attachments" in p) facts.attachments = arr("attachments");
  if (ids.length > 0) facts.ids = ids;
  return facts;
}
