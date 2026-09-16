import { expect, it, vi } from "vitest";
import { sendMime } from "../src/operations/send";
import { testEnv } from "./test-env";
import { insertOperation, seedAccessToken, seedUserAndAccount } from "./fixtures";
import { defaultDeps } from "../src/deps";
it("bounds a stalled send receipt through EOF without retrying the mutation", async () => {
  const e = testEnv();
  const id = "stalled-send-receipt";
  await seedUserAndAccount(e.DB, { userId: id, accountId: id, alias: "stalled" });
  await seedAccessToken(e, { userId: id, accountId: id });
  await insertOperation(e.DB, id, id, id, "claimed");
  let received!: () => void;
  const headers = new Promise<void>((r) => {
    received = r;
  });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let calls = 0;
  let state = "pending";
  const result = sendMime(
    e,
    {
      ...defaultDeps,
      googleFetch: () => {
        calls++;
        vi.useFakeTimers();
        received();
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                controller = c;
                c.enqueue(new TextEncoder().encode('{"id":'));
              },
            }),
          ),
        );
      },
    },
    {
      userId: id,
      accountId: id,
      operationId: id,
      body: new Response("x").body!,
      length: 1,
      threadId: null,
      rfc822MessageId: `<${id}@${e.WORKER_HOSTNAME}>`,
      recoveryContext: {
        executor: "send_message",
        pendingId: null,
        audit: { action: "send.message", modifiers: [], recipients: 1, attachments: 0 },
      },
    },
  ).then(
    () => {
      state = "success";
    },
    () => {
      state = "failed";
    },
  );
  await headers;
  try {
    await vi.advanceTimersByTimeAsync(15001);
    expect(state).toBe("failed");
    expect(calls).toBe(1);
  } finally {
    vi.useRealTimers();
    try {
      controller.error(new Error("test cleanup"));
    } catch {
      /* Already cancelled by deadline. */
    }
    await result;
  }
  expect(await e.DB.prepare("SELECT state FROM operations WHERE id=?").bind(id).first("state")).toBe("executing");
});
it("rejects oversized and malformed UTF-8 receipt bodies without exposing their content", async () => {
  const { readMutationReceipt } = await import("../src/google/mutation-receipt");
  for (const response of [
    new Response(new Uint8Array(65537)),
    new Response(new Uint8Array([0xff])),
    new Response("private-session-shaped-invalid-json"),
  ]) {
    await expect(readMutationReceipt(response)).rejects.toMatchObject({ message: "mutation receipt unavailable" });
  }
  await expect(readMutationReceipt(Response.json({ id: "m", threadId: "t" }))).resolves.toEqual({
    id: "m",
    threadId: "t",
  });
});
