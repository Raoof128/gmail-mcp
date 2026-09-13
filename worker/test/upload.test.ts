import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { seedUserAndAccount } from "./fixtures";
import { setPolicy } from "../src/policy/engine";
import { ensureTransfer } from "../src/staging/transfers";
import { recoverUploads } from "../src/staging/recovery";
import { acceptUpload } from "../src/staging/upload";
import { sha256Hex } from "../src/crypto/canonical";
const p = { userId: "upload-owner", email: "test@example.test", scope: "staging" as const };
const bytes = new TextEncoder().encode("verified attachment");
beforeAll(async () => {
  await seedUserAndAccount(env.DB, { userId: p.userId, accountId: "upload-account", alias: "work" });
  await setPolicy(env.DB, {
    userId: p.userId,
    accountId: "upload-account",
    action: "attachment.stage_upload",
    level: "allow",
  });
});
async function ready(ch: string) {
  const i = {
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
  return { i, r: await ensureTransfer(env, p, i) };
}
const request = (body: Uint8Array = bytes) =>
  new Request("https://example.test/upload", {
    method: "PUT",
    headers: { "content-length": String(bytes.length), "content-type": "text/plain" },
    body,
  });
describe("upload publication", () => {
  it("lets an admitted live lease settle after the intent stops accepting new work", async () => {
    const { i, r } = await ready("S");
    const result = await acceptUpload(env, p, r.ticket_id!, request(), {
      afterStored: async () => {
        await env.DB.prepare("UPDATE upload_transfers SET authority_until=1 WHERE id=?").bind(i.transfer_id).run();
        await recoverUploads(env, Date.now());
        expect((await ensureTransfer(env, p, i)).state).toBe("stored");
      },
    });
    expect(result.state).toBe("completed");
  });
  it("admits only one active upload across different transfers", async () => {
    const first = await ready("Q"),
      second = await ready("R");
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const running = acceptUpload(
      env,
      p,
      first.r.ticket_id!,
      new Request("https://example.test/upload", {
        method: "PUT",
        headers: { "content-length": String(bytes.length), "content-type": "text/plain" },
        body: stream,
      }),
    );
    await vi.waitFor(async () =>
      expect(
        await env.DB.prepare("SELECT state FROM upload_generations WHERE ticket_id=?").bind(first.r.ticket_id).first(),
      ).toEqual({ state: "uploading" }),
    );
    try {
      await expect(acceptUpload(env, p, second.r.ticket_id!, request())).rejects.toThrow(/handle_invalid/);
    } finally {
      controller.enqueue(bytes);
      controller.close();
    }
    expect((await running).state).toBe("completed");
  });
  it("keeps ambiguous R2 writes charged without claiming writer termination", async () => {
    const { r } = await ready("h");
    const put = vi.spyOn(env.STAGING, "put").mockRejectedValueOnce(new Error("response lost"));
    try {
      await expect(acceptUpload(env, p, r.ticket_id!, request())).rejects.toThrow();
    } finally {
      put.mockRestore();
    }
    expect(
      await env.DB.prepare("SELECT state,cleanup_state,writer_stopped FROM upload_generations WHERE ticket_id=?")
        .bind(r.ticket_id)
        .first(),
    ).toEqual({ state: "abandoned", cleanup_state: "debt", writer_stopped: 0 });
  });
  it("allows an explicit retry after an interrupted body and replays its retry receipt", async () => {
    const { i, r } = await ready("i");
    const body = new ReadableStream({
      start(c) {
        c.error(new Error("connection interrupted"));
      },
    });
    const broken = new Request("https://example.test/upload", {
      method: "PUT",
      headers: { "content-length": String(bytes.length), "content-type": "text/plain" },
      body,
    });
    await expect(acceptUpload(env, p, r.ticket_id!, broken)).rejects.toThrow();
    const retry = { ...i, mode: "retry" as const, expected_generation: 1, retry_request_id: `rr_${"j".repeat(43)}` };
    const next = await ensureTransfer(env, p, retry);
    expect(next.generation).toBe(2);
    expect((await ensureTransfer(env, p, retry)).ticket_id).toBe(next.ticket_id);
  });
  it("publishes exactly one handle and replays the recorded result after response loss", async () => {
    const { i, r } = await ready("d");
    const out = await acceptUpload(env, p, r.ticket_id!, request());
    expect(out.handle).toMatch(/^sh_/);
    expect((await ensureTransfer(env, p, { ...i, mode: "status" })).handle).toBe(out.handle);
    await expect(acceptUpload(env, p, r.ticket_id!, request())).rejects.toThrow(/handle_invalid/);
    const row = await env.DB.prepare("SELECT * FROM staging_objects WHERE handle=?").bind(out.handle).first<any>();
    expect(await (await env.STAGING.get(row.r2_key))!.text()).toBe("verified attachment");
  });
  it("rejects hash mismatch and leaves no usable handle", async () => {
    const { i, r } = await ready("e");
    await expect(acceptUpload(env, p, r.ticket_id!, request(new Uint8Array(bytes.length)))).rejects.toThrow(
      /handle_invalid/,
    );
    expect((await ensureTransfer(env, p, { ...i, mode: "status" })).handle).toBeUndefined();
  });
  it("fences account revoke/reconnect between stored bytes and publication", async () => {
    const { i, r } = await ready("f");
    await expect(
      acceptUpload(env, p, r.ticket_id!, request(), {
        afterStored: async () => {
          await env.DB.prepare(
            "UPDATE accounts SET credential_version=credential_version+2 WHERE id='upload-account'",
          ).run();
        },
      }),
    ).rejects.toThrow();
    expect((await ensureTransfer(env, p, { ...i, mode: "status" })).handle).toBeUndefined();
  });
  it("fences a writer after its lease expires", async () => {
    const { i, r } = await ready("g");
    await expect(
      acceptUpload(env, p, r.ticket_id!, request(), {
        afterStored: async () => {
          await env.DB.prepare("UPDATE upload_generations SET lease_until=1 WHERE ticket_id=?").bind(r.ticket_id).run();
        },
      }),
    ).rejects.toThrow();
    expect((await ensureTransfer(env, p, { ...i, mode: "status" })).handle).toBeUndefined();
  });
});
