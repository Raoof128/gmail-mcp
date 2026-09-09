import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedUserAndAccount } from "./fixtures";
import { createPending, approvePending, cancelPending, denyPending, getPending } from "../src/approval/pending";
import { claimPending } from "../src/approval/claim";
import { acquire, transition } from "../src/operations/journal";

beforeAll(async () => {
  await seedUserAndAccount(env.DB, { userId: "cu", accountId: "ca", alias: "main" });
  await seedUserAndAccount(env.DB, { userId: "cu2", accountId: "cb", alias: "main" });
});

async function stageUpload(handle: string, accountId = "ca", userId = "cu") {
  await env.DB.prepare(
    `INSERT INTO staging_objects (handle, user_id, account_id, direction, r2_key, filename, mime, size, sha256, created_at, expires_at)
     VALUES (?, ?, ?, 'upload', ?, 'f.pdf', 'application/pdf', 1, 'h', ?, ?)`,
  ).bind(handle, userId, accountId, `stg/${handle}`, Date.now(), Date.now() + 60_000).run();
}
const H = (s: string) => "sh_" + s.padEnd(43, "A");
const mk = (payload: unknown, extra: Record<string, unknown> = {}) =>
  createPending(env.DB, { userId: "cu", accountId: "ca", action: "send.message", modifiers: [], payload, summary: "To: someone", ...extra });

describe("pending lifecycle", () => {
  it("stores canonical payload, hashes the stored string, 15 minute ttl, approves once", async () => {
    const p = await mk({ to: ["a@x.test"], attachments: [] });
    expect(p.payload_json).toBe('{"attachments":[],"to":["a@x.test"]}');
    expect(p.expires_at - p.created_at).toBe(15 * 60_000);
    expect(await approvePending(env.DB, { id: p.id, userId: "cu", via: "browser" })).toBe(true);
    expect(await approvePending(env.DB, { id: p.id, userId: "cu", via: "browser" })).toBe(false);
  });
  it("cannot be approved or read by another user", async () => {
    const p = await mk({ id: 1, attachments: [] });
    expect(await approvePending(env.DB, { id: p.id, userId: "cu2", via: "browser" })).toBe(false);
    expect(await getPending(env.DB, p.id, "cu2")).toBeNull();
  });
  it("cancel works from pending and approved, never from executing; deny and cancel redact", async () => {
    const p = await mk({ n: 1, attachments: [] });
    await approvePending(env.DB, { id: p.id, userId: "cu", via: "browser" });
    expect(await cancelPending(env.DB, { id: p.id, userId: "cu" })).toBe(true);
    const after = await getPending(env.DB, p.id, "cu");
    expect(after).toMatchObject({ state: "cancelled", payload_json: null, summary: "redacted" });
    const q = await mk({ n: 2, attachments: [] });
    expect(await denyPending(env.DB, { id: q.id, userId: "cu" })).toBe(true);
    expect(await getPending(env.DB, q.id, "cu")).toMatchObject({ state: "denied", payload_json: null, summary: "redacted" });
    const r = await mk({ n: 3, attachments: [] });
    await approvePending(env.DB, { id: r.id, userId: "cu", via: "browser" });
    await claimPending(env.DB, { id: r.id, userId: "cu" });
    expect(await cancelPending(env.DB, { id: r.id, userId: "cu" })).toBe(false);
  });
});

describe("claimPending", () => {
  it("claims an approved row exactly once under concurrency and records execution_started_at", async () => {
    const p = await mk({ n: 4, attachments: [] });
    await approvePending(env.DB, { id: p.id, userId: "cu", via: "elicitation" });
    const results = await Promise.allSettled([claimPending(env.DB, { id: p.id, userId: "cu" }), claimPending(env.DB, { id: p.id, userId: "cu" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const row = await getPending(env.DB, p.id, "cu");
    expect(row?.state).toBe("executing");
    expect(row?.execution_started_at).not.toBeNull();
    expect(row?.executed_at).toBeNull();
    const ops = await env.DB.prepare("SELECT count(*) AS c FROM operations WHERE idempotency_key = ?").bind(p.id).first<{ c: number }>();
    expect(ops?.c).toBe(1);
  });
  it("rejects unapproved, cancelled and expired rows without creating an operation", async () => {
    const before = (await env.DB.prepare("SELECT count(*) AS c FROM operations").first<{ c: number }>())!.c;
    const p1 = await mk({ n: 5, attachments: [] });
    await expect(claimPending(env.DB, { id: p1.id, userId: "cu" })).rejects.toThrow(/pending_not_approved/);
    await cancelPending(env.DB, { id: p1.id, userId: "cu" });
    await expect(claimPending(env.DB, { id: p1.id, userId: "cu" })).rejects.toThrow(/pending_not_approved/);
    const p2 = await mk({ n: 6, attachments: [] }, { ttlMs: -1 });
    await expect(claimPending(env.DB, { id: p2.id, userId: "cu" })).rejects.toThrow(/pending_expired|pending_not_approved/);
    expect((await env.DB.prepare("SELECT count(*) AS c FROM operations").first<{ c: number }>())!.c).toBe(before);
  });
  it("reserves exactly the handles in the approved payload and nothing the caller could add", async () => {
    await stageUpload(H("ok1"));
    await stageUpload(H("other"));
    const p = await mk({ attachments: [H("ok1")] }, { modifiers: ["+attachment"] });
    await approvePending(env.DB, { id: p.id, userId: "cu", via: "browser" });
    const r = await claimPending(env.DB, { id: p.id, userId: "cu" });
    expect(r.handles).toEqual([H("ok1")]);
    const rows = await env.DB.prepare("SELECT handle, reserved_by_operation_id AS r FROM staging_objects WHERE handle IN (?, ?)").bind(H("ok1"), H("other")).all<{ handle: string; r: string | null }>();
    const byHandle = Object.fromEntries(rows.results.map((x) => [x.handle, x.r]));
    expect(byHandle[H("ok1")]).toBe(r.operationId);
    expect(byHandle[H("other")]).toBeNull();
  });
  it("rolls back the whole claim when a payload handle is foreign, consumed or missing", async () => {
    await stageUpload(H("foreign"), "cb", "cu2");
    const p = await mk({ attachments: [H("foreign")] }, { modifiers: ["+attachment"] });
    await approvePending(env.DB, { id: p.id, userId: "cu", via: "browser" });
    const before = (await env.DB.prepare("SELECT count(*) AS c FROM operations").first<{ c: number }>())!.c;
    await expect(claimPending(env.DB, { id: p.id, userId: "cu" })).rejects.toThrow(/handle_reserved/);
    expect((await env.DB.prepare("SELECT count(*) AS c FROM operations").first<{ c: number }>())!.c).toBe(before);
    expect((await getPending(env.DB, p.id, "cu"))?.state).toBe("approved");
  });
});

describe("operations journal", () => {
  it("returns the existing row for a repeated key with the same action and hash", async () => {
    const a = await acquire(env.DB, { userId: "cu", accountId: "ca", action: "send.message", idempotencyKey: "k1", payloadHash: "h1" });
    expect(a.existing).toBeNull();
    await transition(env.DB, a.operationId, ["claimed"], "executed", { gmail_result_id: "m1" });
    const b = await acquire(env.DB, { userId: "cu", accountId: "ca", action: "send.message", idempotencyKey: "k1", payloadHash: "h1" });
    expect(b.operationId).toBe(a.operationId);
    expect(b.existing).toMatchObject({ state: "executed", gmail_result_id: "m1" });
  });
  it("refuses a reused key with a different action or hash", async () => {
    await acquire(env.DB, { userId: "cu", accountId: "ca", action: "send.message", idempotencyKey: "k2", payloadHash: "h2" });
    await expect(acquire(env.DB, { userId: "cu", accountId: "ca", action: "send.message", idempotencyKey: "k2", payloadHash: "OTHER" })).rejects.toThrow(/idempotency_conflict/);
    await expect(acquire(env.DB, { userId: "cu", accountId: "ca", action: "draft.write", idempotencyKey: "k2", payloadHash: "h2" })).rejects.toThrow(/idempotency_conflict/);
  });
  it("is atomic under concurrent acquisition of the same key", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      acquire(env.DB, { userId: "cu", accountId: "ca", action: "send.message", idempotencyKey: "k3", payloadHash: "h3" })));
    const ids = new Set(results.map((r) => r.operationId));
    expect(ids.size).toBe(1);
    const n = await env.DB.prepare("SELECT count(*) AS c FROM operations WHERE idempotency_key = 'k3'").first<{ c: number }>();
    expect(n?.c).toBe(1);
  });
  it("transition only from allowed states", async () => {
    const a = await acquire(env.DB, { userId: "cu", accountId: "ca", action: "send.message", payloadHash: "h4" });
    expect(await transition(env.DB, a.operationId, ["executing"], "executed")).toBe(false);
    expect(await transition(env.DB, a.operationId, ["claimed"], "executing")).toBe(true);
  });
});
