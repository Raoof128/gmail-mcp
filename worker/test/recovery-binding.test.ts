import { expect, it } from "vitest";
import { seedUserAndAccount, insertOperation } from "./fixtures";
import { testEnv } from "./test-env";
import { beginRecoverableOperation, recordFailure, settleDirect } from "../src/operations/recovery-state";
import type { Binding } from "../src/operations/recovery-types";

const e = testEnv();
async function binding(id: string): Promise<Binding> {
  await seedUserAndAccount(e.DB, { userId: id, accountId: id, alias: "recovery" });
  await insertOperation(e.DB, id, id, id, "claimed");
  return {
    operationId: id,
    userId: id,
    accountId: id,
    credentialVersion: 0,
    executor: "send_message",
    resultVersion: "send-v1",
    generatedMessageId: `<${id}@${e.WORKER_HOSTNAME}>`,
    threadId: null,
    pendingId: null,
    startedAt: Date.now(),
    mimeLength: 100,
    buildId: "test-build",
    origin: `https://${e.WORKER_HOSTNAME}`,
    audit: { action: "send.message", modifiers: [], recipients: 1, attachments: 0 },
  };
}
it("binds before bytes and preserves unknown on every admitted failure", async () => {
  const b = await binding("bound");
  await beginRecoverableOperation(e, b, null);
  expect(await recordFailure(e, b.operationId)).toBe("delivery_unknown");
  expect(await recordFailure(e, b.operationId)).toBe("delivery_unknown");
  expect(
    await e.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE operation_id=?").bind(b.operationId).first("n"),
  ).toBe(1);
});
it("rejects forged generated Message-ID and replacement grant before binding", async () => {
  const b = await binding("forged");
  await expect(
    beginRecoverableOperation(e, { ...b, generatedMessageId: "<other@example.test>" }, null),
  ).rejects.toThrow();
  await expect(beginRecoverableOperation(e, { ...b, credentialVersion: 1 }, null)).rejects.toThrow();
  expect(await e.DB.prepare("SELECT state FROM operations WHERE id=?").bind(b.operationId).first("state")).toBe(
    "claimed",
  );
});
it("one positive winner survives changed labels, late errors and metadata retention", async () => {
  const b = await binding("positive");
  await beginRecoverableOperation(e, b, null);
  await recordFailure(e, b.operationId);
  await e.DB.prepare("DELETE FROM operation_recovery WHERE operation_id=?").bind(b.operationId).run();
  const result = { gmail_result_id: "m1", message: { id: "m1", thread_id: "t1", label_ids: ["SENT"] } };
  expect(await settleDirect(e, b.operationId, result)).toBe("settled");
  expect(await settleDirect(e, b.operationId, { ...result, message: { ...result.message, label_ids: [] } })).toBe(
    "replayed",
  );
  expect(
    await settleDirect(e, b.operationId, {
      ...result,
      message: { ...result.message, id: "other" },
      gmail_result_id: "other",
    }),
  ).toBe("conflict");
  expect(await recordFailure(e, b.operationId)).toBe("executed");
  expect(
    await e.DB.prepare("SELECT result_json FROM operations WHERE id=?").bind(b.operationId).first("result_json"),
  ).toBe(JSON.stringify(result));
  expect(
    await e.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE operation_id=? AND decision='executed'")
      .bind(b.operationId)
      .first("n"),
  ).toBe(1);
});
