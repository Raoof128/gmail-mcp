import { expect, it } from "vitest";
import { testEnv } from "./test-env";
import { seedRecovery } from "./recovery-fixtures";
import { insertOperation } from "./fixtures";
import { ingest, purgeExpired } from "../src/staging/store";
import { beginRecoverableOperation, settleDirect } from "../src/operations/recovery-state";
it("cleans published consumed storage under a permit without erasing delivery truth", async () => {
  const e = testEnv();
  const b = await seedRecovery(e, "cleanup-owner");
  const file = await ingest(e, {
    userId: b.userId,
    accountId: b.accountId,
    direction: "upload",
    filename: "test.txt",
    mime: "text/plain",
    length: 1,
    body: new Response("x").body!,
  });
  const op = "cleanup-send";
  await insertOperation(e.DB, op, b.userId, b.accountId, "claimed");
  await e.DB.prepare("UPDATE staging_objects SET reserved_by_operation_id=? WHERE handle=?")
    .bind(op, file.handle)
    .run();
  await beginRecoverableOperation(
    e,
    { ...b, operationId: op, generatedMessageId: `<${op}@${e.WORKER_HOSTNAME}>`, startedAt: Date.now() },
    null,
  );
  await settleDirect(e, op, { gmail_result_id: "m1", message: { id: "m1", thread_id: "t1", label_ids: ["SENT"] } });
  expect((await purgeExpired(e, Date.now())).deleted).toBe(1);
  expect(await e.DB.prepare("SELECT state FROM operations WHERE id=?").bind(op).first("state")).toBe("executed");
  expect(await e.DB.prepare("SELECT count(*) AS n FROM settlement_permits").first("n")).toBe(0);
});
it("retains stopped producer proof until its published object is removed", async () => {
  const { seedUserAndAccount } = await import("./fixtures");
  const { setPolicy } = await import("../src/policy/engine");
  const { ensureTransfer } = await import("../src/staging/transfers");
  const { acceptUpload } = await import("../src/staging/upload");
  const { recoverUploads } = await import("../src/staging/recovery");
  const { producerStopped } = await import("../src/staging/settlement");
  const e = testEnv();
  const id = "retained-producer";
  await seedUserAndAccount(e.DB, { userId: id, accountId: id, alias: "work" });
  await setPolicy(e.DB, { userId: id, accountId: id, action: "attachment.stage_upload", level: "allow" });
  const p = { userId: id, email: "fixture@example.test", scope: "staging" as const };
  const t = await ensureTransfer(e, p, {
    mode: "ensure",
    transfer_id: "tr_" + "X".repeat(43),
    account: "work",
    metadata: {
      filename: "empty.txt",
      mime: "text/plain",
      size: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
  });
  const result = await acceptUpload(
    e,
    p,
    t.ticket_id!,
    new Request("https://fixture.test/upload", {
      method: "PUT",
      headers: { "content-length": "0", "content-type": "text/plain" },
      body: "",
    }),
  );
  const key = (await e.DB.prepare("SELECT r2_key FROM staging_objects WHERE handle=?")
    .bind(result.handle)
    .first<string>("r2_key"))!;
  await e.DB.prepare("UPDATE upload_transfers SET retain_until=1 WHERE user_id=?").bind(id).run();
  await recoverUploads(e, Date.now());
  expect(await producerStopped(e.DB, key)).toBe(true);
});
