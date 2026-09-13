import { env } from "cloudflare:test";
import { it, expect } from "vitest";
import { seedUserAndAccount } from "./fixtures";
import { setPolicy } from "../src/policy/engine";
import { sha256Hex } from "../src/crypto/canonical";
import { ensureTransfer } from "../src/staging/transfers";
import { acceptUpload } from "../src/staging/upload";
it("publishes and verifies the inclusive 25 MiB boundary", async () => {
  const userId = "ceiling-owner";
  await seedUserAndAccount(env.DB, { userId, accountId: "ceiling-account", alias: "work" });
  await setPolicy(env.DB, { userId, accountId: "ceiling-account", action: "attachment.stage_upload", level: "allow" });
  const bytes = new Uint8Array(25 * 1024 * 1024);
  bytes[0] = 3;
  bytes[bytes.length - 1] = 9;
  const digest = await sha256Hex(bytes),
    p = { userId, email: "test@example.test", scope: "staging" as const };
  const ticket = await ensureTransfer(env, p, {
    mode: "ensure",
    transfer_id: "tr_" + "C".repeat(43),
    account: "work",
    metadata: { filename: "boundary.bin", mime: "application/octet-stream", size: bytes.length, sha256: digest },
  });
  const out = await acceptUpload(
    env,
    p,
    ticket.ticket_id!,
    new Request("https://example.test/upload", {
      method: "PUT",
      headers: { "content-length": String(bytes.length), "content-type": "application/octet-stream" },
      body: bytes,
    }),
  );
  const row = await env.DB.prepare("SELECT r2_key,size,sha256 FROM staging_objects WHERE handle=?")
    .bind(out.handle)
    .first<{ r2_key: string; size: number; sha256: string }>();
  expect(row).toMatchObject({ size: 25 * 1024 * 1024, sha256: digest });
  const stored = await env.STAGING.get(row!.r2_key);
  expect(stored!.size).toBe(bytes.length);
  expect(await sha256Hex(new Uint8Array(await stored!.arrayBuffer()))).toBe(digest);
});
