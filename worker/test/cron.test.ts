import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedUserAndAccount, insertOperation } from "./fixtures";
import { runCron, recoverClaimed } from "../src/cron";
import { auditIntent, auditOutcome } from "../src/audit/log";

beforeAll(async () => {
  await seedUserAndAccount(env.DB, { userId: "ku", accountId: "ka", alias: "main" });
});

describe("audit", () => {
  it("writes intent and outcome rows and renders the summary itself", async () => {
    const id = await auditIntent(env.DB, {
      userId: "ku",
      accountId: "ka",
      tool: "send_message",
      action: "send.message",
      modifiers: ["+external"],
      decision: "ask",
      facts: { recipients: 2, attachments: 1 },
    });
    expect(id).toBeGreaterThan(0);
    await auditOutcome(env.DB, {
      userId: "ku",
      accountId: "ka",
      tool: "send_message",
      action: "send.message",
      modifiers: [],
      decision: "executed",
      gmailResultId: "m9",
      facts: { ids: ["m9"] },
    });
    const rows = await env.DB.prepare("SELECT phase, summary FROM audit_log WHERE user_id = 'ku' ORDER BY id").all<{
      phase: string;
      summary: string;
    }>();
    expect(rows.results).toEqual([
      { phase: "intent", summary: "recipients=2 attachments=1" },
      { phase: "outcome", summary: "ids=m9" },
    ]);
  });
});

describe("cron", () => {
  it("expires pending, promotes stale executing, fails stale claimed transactionally, purges old audit", async () => {
    const old = Date.now() - 10 * 60_000;
    await env.DB.prepare(
      `INSERT INTO pending_actions (id, user_id, account_id, action, modifiers, payload_json, payload_hash, summary, state, created_at, expires_at)
      VALUES ('pa_old', 'ku', 'ka', 'send.message', '[]', '{"x":1}', 'h', 'To: secret', 'pending', ?, ?)`,
    )
      .bind(old, old + 1)
      .run();
    await insertOperation(env.DB, "op_exec", "ku", "ka", "executing", old);
    await insertOperation(env.DB, "op_claim", "ku", "ka", "claimed", old);
    await insertOperation(env.DB, "op_fresh", "ku", "ka", "executing");
    await env.DB.prepare(
      `INSERT INTO pending_actions (id, user_id, account_id, action, modifiers, payload_json, payload_hash, summary, state, operation_id, created_at, expires_at)
      VALUES ('pa_claim', 'ku', 'ka', 'send.message', '[]', '{"x":2}', 'h', 'To: secret', 'executing', 'op_claim', ?, ?)`,
    )
      .bind(old, old + 900_000)
      .run();
    await env.DB.prepare(
      `INSERT INTO staging_objects (handle, user_id, account_id, direction, r2_key, filename, mime, size, sha256, reserved_by_operation_id, created_at, expires_at)
      VALUES ('sh_res', 'ku', 'ka', 'upload', 'k', 'f', 'm', 1, 'h', 'op_claim', ?, ?)`,
    )
      .bind(old, old + 900_000)
      .run();
    await env.DB.prepare(`INSERT INTO audit_log (ts, phase, summary) VALUES (?, 'intent', 'ancient')`)
      .bind(Date.now() - 91 * 86_400_000)
      .run();

    const report = await runCron(env, Date.now());
    expect(report.expiredPending).toBeGreaterThanOrEqual(1);
    expect(report.promotedUnknown).toBeGreaterThanOrEqual(1);
    expect(report.failedSafe).toBeGreaterThanOrEqual(1);
    expect(report.purgedAudit).toBeGreaterThanOrEqual(1);

    expect(
      await env.DB.prepare("SELECT state, payload_json, summary FROM pending_actions WHERE id = 'pa_old'").first(),
    ).toEqual({ state: "expired", payload_json: null, summary: "redacted" });
    const byId = Object.fromEntries(
      (
        await env.DB.prepare("SELECT id, state FROM operations WHERE id IN ('op_exec','op_claim','op_fresh')").all<{
          id: string;
          state: string;
        }>()
      ).results.map((r) => [r.id, r.state]),
    );
    expect(byId).toEqual({ op_exec: "delivery_unknown", op_claim: "failed_safe", op_fresh: "executing" });
    expect(
      await env.DB.prepare("SELECT state, payload_json, error FROM pending_actions WHERE id = 'pa_claim'").first(),
    ).toEqual({ state: "failed", payload_json: null, error: "failed_safe" });
    expect(
      (
        await env.DB.prepare(
          "SELECT reserved_by_operation_id AS r FROM staging_objects WHERE handle = 'sh_res'",
        ).first<{ r: string | null }>()
      )?.r,
    ).toBeNull();
  });
  it("does not touch a claimed operation that progressed between select and recovery", async () => {
    const old = Date.now() - 10 * 60_000;
    await insertOperation(env.DB, "op_race", "ku", "ka", "claimed", old);
    await env.DB.prepare(
      `INSERT INTO staging_objects (handle, user_id, account_id, direction, r2_key, filename, mime, size, sha256, reserved_by_operation_id, created_at, expires_at)
      VALUES ('sh_race', 'ku', 'ka', 'upload', 'k', 'f', 'm', 1, 'h', 'op_race', ?, ?)`,
    )
      .bind(old, old + 900_000)
      .run();
    await env.DB.prepare("UPDATE operations SET state = 'executing', updated_at = ? WHERE id = 'op_race'")
      .bind(Date.now())
      .run();
    await expect(recoverClaimed(env.DB, "op_race", Date.now())).resolves.toBe(false);
    expect(
      (
        await env.DB.prepare(
          "SELECT reserved_by_operation_id AS r FROM staging_objects WHERE handle = 'sh_race'",
        ).first<{ r: string | null }>()
      )?.r,
    ).toBe("op_race");
  });
});
