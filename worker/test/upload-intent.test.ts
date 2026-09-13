import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedUserAndAccount } from "./fixtures";
import { ensureTransfer } from "../src/staging/transfers";
import { setPolicy } from "../src/policy/engine";
import { approvePending } from "../src/approval/pending";
import type { TransferIntent } from "@gmail-mcp/shared/staging";
const user = "intent-owner";
const p = { userId: user, email: "test@example.test", scope: "staging" as const };
const input = (letter: string): TransferIntent => ({
  mode: "ensure",
  transfer_id: `tr_${letter.repeat(43)}`,
  account: "work",
  metadata: {
    filename: "a.txt",
    mime: "text/plain",
    size: 0,
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
});
beforeAll(async () => {
  await seedUserAndAccount(env.DB, { userId: user, accountId: "intent-account", alias: "work" });
});
describe("upload intent authority", () => {
  it("recovers a lost first response and issues just one ticket concurrently", async () => {
    await setPolicy(env.DB, {
      userId: user,
      accountId: "intent-account",
      action: "attachment.stage_upload",
      level: "allow",
    });
    const [a, b] = await Promise.all([ensureTransfer(env, p, input("a")), ensureTransfer(env, p, input("a"))]);
    expect(a.ticket_id).toBe(b.ticket_id);
    expect(a.generation).toBe(1);
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM upload_generations WHERE transfer_id=?")
          .bind(a.transfer_id)
          .first<any>()
      ).n,
    ).toBe(1);
    await expect(
      ensureTransfer(env, p, { ...input("a"), metadata: { ...input("a").metadata, filename: "other.txt" } }),
    ).rejects.toThrow(/idempotency_conflict/);
  });
  it("asks without issuing bytes capability, then consumes browser approval once", async () => {
    await setPolicy(env.DB, {
      userId: user,
      accountId: "intent-account",
      action: "attachment.stage_upload",
      level: "ask",
    });
    const a = await ensureTransfer(env, p, input("b"));
    expect(a.pending_id).toBeDefined();
    expect(a.ticket_id).toBeUndefined();
    await approvePending(env.DB, { id: a.pending_id!, userId: user, via: "browser" });
    const b = await ensureTransfer(env, p, input("b"));
    expect(b.ticket_id).toBeDefined();
    expect((await ensureTransfer(env, p, input("b"))).ticket_id).toBe(b.ticket_id);
  });
  it("does not resurrect an issued transfer after a deny decision", async () => {
    await setPolicy(env.DB, {
      userId: user,
      accountId: "intent-account",
      action: "attachment.stage_upload",
      level: "allow",
    });
    await ensureTransfer(env, p, input("k"));
    await setPolicy(env.DB, {
      userId: user,
      accountId: "intent-account",
      action: "attachment.stage_upload",
      level: "deny",
    });
    await expect(ensureTransfer(env, p, input("k"))).rejects.toThrow(/policy_denied/);
    await setPolicy(env.DB, {
      userId: user,
      accountId: "intent-account",
      action: "attachment.stage_upload",
      level: "allow",
    });
    expect((await ensureTransfer(env, p, input("k"))).state).toBe("denied");
  });
  it("binds a competing retry only if its own receipt commits", async () => {
    await setPolicy(env.DB, {
      userId: user,
      accountId: "intent-account",
      action: "attachment.stage_upload",
      level: "allow",
    });
    const initial = await ensureTransfer(env, p, input("l"));
    await env.DB.prepare("UPDATE upload_generations SET issued_until=1 WHERE ticket_id=?")
      .bind(initial.ticket_id)
      .run();
    const retry = { ...input("l"), mode: "retry" as const, expected_generation: 1 };
    const outcomes = await Promise.allSettled([
      ensureTransfer(env, p, { ...retry, retry_request_id: `rr_${"m".repeat(43)}` }),
      ensureTransfer(env, p, { ...retry, retry_request_id: `rr_${"n".repeat(43)}` }),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
  it("returns approval without a ticket when allow tightens to ask", async () => {
    await setPolicy(env.DB, {
      userId: user,
      accountId: "intent-account",
      action: "attachment.stage_upload",
      level: "allow",
    });
    const before = await ensureTransfer(env, p, input("o"));
    await setPolicy(env.DB, {
      userId: user,
      accountId: "intent-account",
      action: "attachment.stage_upload",
      level: "ask",
    });
    const after = await ensureTransfer(env, p, input("o"));
    expect(after.state).toBe("awaiting_approval");
    expect(after.pending_id).toBeDefined();
    expect(after.ticket_id).toBeUndefined();
    expect(
      await env.DB.prepare("SELECT state FROM upload_generations WHERE ticket_id=?").bind(before.ticket_id).first(),
    ).toEqual({ state: "expired" });
    await approvePending(env.DB, { id: after.pending_id!, userId: user, via: "browser" });
    expect((await ensureTransfer(env, p, input("o"))).generation).toBe(2);
  });
  it("refuses a Gmail action substituted into a staging approval before claim", async () => {
    await setPolicy(env.DB, {
      userId: user,
      accountId: "intent-account",
      action: "attachment.stage_upload",
      level: "ask",
    });
    const result = await ensureTransfer(env, p, input("p"));
    await env.DB.prepare("UPDATE pending_actions SET action='send.message',state='approved' WHERE id=?")
      .bind(result.pending_id)
      .run();
    await expect(ensureTransfer(env, p, input("p"))).rejects.toThrow(/payload_mismatch/);
    expect(
      await env.DB.prepare("SELECT state,operation_id FROM pending_actions WHERE id=?").bind(result.pending_id).first(),
    ).toEqual({ state: "approved", operation_id: null });
  });
  it("refuses deny and a foreign owner cannot inspect an existing transfer", async () => {
    await setPolicy(env.DB, {
      userId: user,
      accountId: "intent-account",
      action: "attachment.stage_upload",
      level: "deny",
    });
    await expect(ensureTransfer(env, p, input("c"))).rejects.toThrow(/policy_denied/);
    await expect(ensureTransfer(env, { ...p, userId: "stranger" }, { ...input("a"), mode: "status" })).rejects.toThrow(
      /handle_invalid/,
    );
  });
});
