import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedUserAndAccount } from "./fixtures";
import { setPolicy } from "../src/policy/engine";
import { ensureTransfer } from "../src/staging/transfers";
import { recoverUploads } from "../src/staging/recovery";
import { acceptUpload } from "../src/staging/upload";
import { sha256Hex } from "../src/crypto/canonical";
import type { Env } from "../src/env";

const p = { userId: "race-owner", email: "test@example.test", scope: "staging" as const };
const bytes = new TextEncoder().encode("race attachment payload");

beforeAll(async () => {
  await seedUserAndAccount(env.DB, { userId: p.userId, accountId: "race-account", alias: "work" });
  await setPolicy(env.DB, {
    userId: p.userId,
    accountId: "race-account",
    action: "attachment.stage_upload",
    level: "allow",
  });
});

async function intent(ch: string) {
  return {
    mode: "ensure" as const,
    transfer_id: `tr_${ch.repeat(43)}`,
    account: "work",
    metadata: {
      filename: "f.txt",
      mime: "text/plain",
      size: bytes.length,
      sha256: await sha256Hex(new Uint8Array(bytes)),
    },
  };
}
const request = (body: Uint8Array | ReadableStream<Uint8Array> = bytes, declared = bytes.length) =>
  new Request("https://example.test/upload", {
    method: "PUT",
    headers: { "content-length": String(declared), "content-type": "text/plain" },
    body,
  });

type Generation = {
  generation: number;
  ticket_id: string;
  state: string;
  cleanup_state: string;
  writer_stopped: number;
  r2_key: string;
};

/** The upload tuple: R2, both database sides, and what a caller could reach. */
async function evidence(transferId: string) {
  const transfer = await env.DB.prepare(
    "SELECT state,handle,active_generation,account_id FROM upload_transfers WHERE id=?",
  )
    .bind(transferId)
    .first<{ state: string; handle: string | null; active_generation: number; account_id: string }>();
  const generations = (
    await env.DB.prepare(
      "SELECT generation,ticket_id,state,cleanup_state,writer_stopped,r2_key FROM upload_generations WHERE transfer_id=? ORDER BY generation",
    )
      .bind(transferId)
      .all<Generation>()
  ).results;
  const objects = (
    await env.DB.prepare(
      "SELECT handle,r2_key,size,sha256,consumed_at,user_id,account_id FROM staging_objects WHERE r2_key IN (SELECT r2_key FROM upload_generations WHERE transfer_id=?)",
    )
      .bind(transferId)
      .all<{ handle: string; r2_key: string; size: number; sha256: string; consumed_at: number | null }>()
  ).results;
  const stored = await Promise.all(
    generations.map(async (g) => {
      const head = await env.STAGING.head(g.r2_key);
      return { r2_key: g.r2_key, exists: head !== null, size: head?.size ?? null };
    }),
  );
  return { transfer, generations, objects, stored };
}
const auditCount = (transferId: string) =>
  env.DB.prepare(
    "SELECT count(*) n FROM audit_log WHERE operation_id=(SELECT operation_id FROM upload_transfers WHERE id=?)",
  )
    .bind(transferId)
    .first<number>("n");

/** Replaces only the R2 binding, on a spread copy, so the shared test env is never mutated. */
function withStaging(overrides: Partial<R2Bucket>): Env {
  return { ...env, STAGING: { ...env.STAGING, ...overrides } };
}

describe("upload races across D1, R2 and the caller's response", () => {
  it("publishes one authoritative object and one handle when nothing races", async () => {
    const i = await intent("A");
    const r = await ensureTransfer(env, p, i);
    const result = await acceptUpload(env, p, r.ticket_id!, request());
    expect(result.state).toBe("completed");
    const ev = await evidence(i.transfer_id);
    expect(ev.objects.length).toBe(1);
    expect(ev.objects[0]).toMatchObject({ size: bytes.length, consumed_at: null });
    expect(ev.stored.filter((s) => s.exists).length).toBe(1);
    expect(ev.generations).toMatchObject([{ state: "completed", cleanup_state: "published", writer_stopped: 1 }]);
  });

  it("removes the object when the publication transaction fails after the bytes landed", async () => {
    const i = await intent("B");
    const r = await ensureTransfer(env, p, i);
    const key = (await evidence(i.transfer_id)).generations[0]!.r2_key;
    await expect(
      acceptUpload(env, p, r.ticket_id!, request(), {
        afterStored: () => Promise.reject(new Error("publication transaction lost")),
      }),
    ).rejects.toThrow();

    // This invocation's own put returned, so it can prove its writer stopped and may delete.
    const ev = await evidence(i.transfer_id);
    expect(await env.STAGING.head(key)).toBeNull();
    expect(ev.objects).toEqual([]);
    expect(ev.transfer).toMatchObject({ state: "failed", handle: null });
    expect(ev.generations[0]).toMatchObject({ state: "failed", cleanup_state: "released", writer_stopped: 1 });
  });

  it("never lets a late write resurrect an abandoned object into a usable handle", async () => {
    const i = await intent("C");
    const r = await ensureTransfer(env, p, i);
    const key = (await evidence(i.transfer_id)).generations[0]!.r2_key;

    // The put is entered and never returns an answer: the remote outcome is unknown.
    const hostile = withStaging({ put: () => Promise.reject(new Error("put outcome unknown")) });
    await expect(acceptUpload(hostile, p, r.ticket_id!, request())).rejects.toThrow();

    const abandoned = await evidence(i.transfer_id);
    expect(abandoned.generations[0]).toMatchObject({
      state: "abandoned",
      cleanup_state: "debt",
      writer_stopped: 0,
    });
    // Nothing deleted it, because nothing has proved the writer stopped.
    expect(abandoned.objects).toEqual([]);

    // The sweep deletes the bytes but keeps the debt charged.
    await recoverUploads(env, Date.now());
    expect((await evidence(i.transfer_id)).generations[0]).toMatchObject({
      cleanup_state: "debt",
      writer_stopped: 0,
    });

    // Now the delayed writer finally lands. This is the race the whole cleanup story turns on.
    await env.STAGING.put(key, bytes, { httpMetadata: { contentType: "text/plain" } });
    expect(await env.STAGING.head(key)).not.toBeNull();

    // The next sweep removes it again, and the debt stays charged, so this repeats for as long as the
    // writer might be alive.
    await recoverUploads(env, Date.now());
    expect(await env.STAGING.head(key)).toBeNull();
    const after = await evidence(i.transfer_id);
    expect(after.generations[0]).toMatchObject({ cleanup_state: "debt", writer_stopped: 0 });

    // The load-bearing part: no handle ever referenced those bytes, so even while they existed they
    // were unreachable. Resurrection is not the danger; a reference to resurrected bytes would be.
    expect(after.objects).toEqual([]);
    expect(after.transfer?.handle).toBeNull();
  });

  it("gives a retry its own key so an abandoned object can never become the authoritative one", async () => {
    const i = await intent("D");
    const r = await ensureTransfer(env, p, i);
    const first = (await evidence(i.transfer_id)).generations[0]!;
    const hostile = withStaging({ put: () => Promise.reject(new Error("put outcome unknown")) });
    await expect(acceptUpload(hostile, p, r.ticket_id!, request())).rejects.toThrow();

    const retry = await ensureTransfer(env, p, {
      mode: "retry",
      transfer_id: i.transfer_id,
      account: "work",
      metadata: i.metadata,
      expected_generation: first.generation,
      retry_request_id: "rr_" + "D".repeat(43),
    });
    expect(retry.ticket_id).not.toBe(first.ticket_id);
    const second = (await evidence(i.transfer_id)).generations.find((g) => g.generation !== first.generation)!;
    expect(second.r2_key).not.toBe(first.r2_key);

    const done = await acceptUpload(env, p, retry.ticket_id!, request());
    expect(done.state).toBe("completed");

    // Exactly one authoritative object, and it is the retry's, not the abandoned generation's.
    const ev = await evidence(i.transfer_id);
    expect(ev.objects.length).toBe(1);
    expect(ev.objects[0]!.r2_key).toBe(second.r2_key);
    expect(ev.generations.find((g) => g.generation === first.generation)).toMatchObject({
      state: "abandoned",
      writer_stopped: 0,
    });
  });

  it("refuses the superseded ticket once a retry has replaced it", async () => {
    const i = await intent("E");
    const r = await ensureTransfer(env, p, i);
    const first = (await evidence(i.transfer_id)).generations[0]!;
    await recoverUploads(env, Date.now() + 3_600_000);
    const retry = await ensureTransfer(env, p, {
      mode: "retry",
      transfer_id: i.transfer_id,
      account: "work",
      metadata: i.metadata,
      expected_generation: first.generation,
      retry_request_id: "rr_" + "E".repeat(43),
    });
    expect(retry.ticket_id).not.toBe(r.ticket_id);

    await expect(acceptUpload(env, p, r.ticket_id!, request())).rejects.toMatchObject({ code: "handle_invalid" });
    const ev = await evidence(i.transfer_id);
    expect(ev.objects).toEqual([]);
    expect(ev.stored.every((s) => !s.exists)).toBe(true);
  });

  it("admits one of two writers presenting the same ticket and publishes one object", async () => {
    const i = await intent("G");
    const r = await ensureTransfer(env, p, i);
    const key = (await evidence(i.transfer_id)).generations[0]!.r2_key;
    const outcomes = await Promise.allSettled([
      acceptUpload(env, p, r.ticket_id!, request()),
      acceptUpload(env, p, r.ticket_id!, request()),
    ]);
    const won = outcomes.filter((o) => o.status === "fulfilled");
    // Both may be answered, because the loser can legitimately read back the completed transfer, but
    // the durable side must show one admission and one object.
    expect(won.length).toBeGreaterThanOrEqual(1);
    const ev = await evidence(i.transfer_id);
    expect(ev.objects.length).toBe(1);
    expect(ev.objects[0]!.r2_key).toBe(key);
    expect(ev.generations.length).toBe(1);
    expect(ev.transfer).toMatchObject({ state: "completed" });
    expect(
      await env.DB.prepare(
        "SELECT count(*) n FROM audit_log WHERE operation_id=(SELECT operation_id FROM upload_transfers WHERE id=?) AND decision='executed'",
      )
        .bind(i.transfer_id)
        .first<number>("n"),
    ).toBe(1);
  });

  it("refuses a body longer than the declared length and leaves nothing behind", async () => {
    const i = await intent("F");
    const r = await ensureTransfer(env, p, i);
    const key = (await evidence(i.transfer_id)).generations[0]!.r2_key;
    const oversize = new Uint8Array(bytes.length + 16);
    oversize.set(bytes);
    await expect(acceptUpload(env, p, r.ticket_id!, request(oversize))).rejects.toMatchObject({
      code: "handle_invalid",
    });
    expect(await env.STAGING.head(key)).toBeNull();
    const ev = await evidence(i.transfer_id);
    expect(ev.objects).toEqual([]);
    expect(ev.transfer).toMatchObject({ state: "failed", handle: null });
    expect(await auditCount(i.transfer_id)).toBeGreaterThan(0);
  });
});
