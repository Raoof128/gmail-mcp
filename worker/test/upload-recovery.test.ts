import { env } from "cloudflare:test";
import { it, expect } from "vitest";
import { seedUserAndAccount } from "./fixtures";
import { setPolicy } from "../src/policy/engine";
import { ensureTransfer } from "../src/staging/transfers";
import { recoverUploads } from "../src/staging/recovery";
it("fences expired writers while retaining unknown cleanup debt, then expires authority", async () => {
  const userId = "recovery-owner";
  await seedUserAndAccount(env.DB, { userId, accountId: "recovery-account", alias: "work" });
  await setPolicy(env.DB, { userId, accountId: "recovery-account", action: "attachment.stage_upload", level: "allow" });
  const p = { userId, email: "r@example.test", scope: "staging" as const };
  const input = {
    mode: "ensure" as const,
    transfer_id: `tr_${"r".repeat(43)}`,
    account: "work",
    metadata: {
      filename: "f.txt",
      mime: "text/plain",
      size: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
  };
  const r = await ensureTransfer(env, p, input);
  await env.DB.prepare("UPDATE upload_generations SET state='uploading',lease_until=1 WHERE ticket_id=?")
    .bind(r.ticket_id)
    .run();
  await env.STAGING.put(`stg/upload/${userId}/${input.transfer_id}/1`, "late");
  await recoverUploads(env, Date.now());
  expect(
    await env.DB.prepare("SELECT state,cleanup_state,writer_stopped FROM upload_generations WHERE ticket_id=?")
      .bind(r.ticket_id)
      .first(),
  ).toEqual({ state: "abandoned", cleanup_state: "debt", writer_stopped: 0 });
  await env.DB.prepare("UPDATE upload_transfers SET authority_until=1 WHERE id=?").bind(input.transfer_id).run();
  await recoverUploads(env, Date.now());
  expect((await ensureTransfer(env, p, { ...input, mode: "status" })).state).toBe("expired");
  expect(
    await env.DB.prepare("SELECT cleanup_state FROM upload_generations WHERE ticket_id=?").bind(r.ticket_id).first(),
  ).toEqual({ cleanup_state: "debt" });
});
