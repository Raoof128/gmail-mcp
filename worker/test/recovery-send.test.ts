import { expect, it } from "vitest";
import { sendMime } from "../src/operations/send";
import { testEnv } from "./test-env";
import { insertOperation, seedAccessToken, seedUserAndAccount } from "./fixtures";
import { defaultDeps } from "../src/deps";
it("never binds a grant-N resumable session to N+1 after reconnect", async () => {
  const e = testEnv();
  const id = "session-grant";
  await seedUserAndAccount(e.DB, { userId: id, accountId: id, alias: "session" });
  await seedAccessToken(e, { userId: id, accountId: id });
  await insertOperation(e.DB, id, id, id, "claimed");
  let puts = 0;
  const deps = {
    ...defaultDeps,
    googleFetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        puts++;
        return Response.json({ id: "m1", threadId: "t1" });
      }
      await e.DB.prepare("UPDATE accounts SET credential_version=1 WHERE id=?").bind(id).run();
      return new Response(null, {
        headers: {
          location:
            "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=resumable&upload_id=session",
        },
      });
    },
  };
  await expect(
    sendMime(e, deps, {
      userId: id,
      accountId: id,
      operationId: id,
      body: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      length: 5242881,
      threadId: null,
      rfc822MessageId: `<${id}@${e.WORKER_HOSTNAME}>`,
      recoveryContext: {
        executor: "send_message",
        pendingId: null,
        audit: { action: "send.message", modifiers: [], recipients: 1, attachments: 1 },
      },
    }),
  ).rejects.toThrow();
  expect(puts).toBe(0);
  expect(await e.DB.prepare("SELECT state FROM operations WHERE id=?").bind(id).first("state")).toBe("claimed");
});
it("refuses MIME PUT when maintenance starts during OAuth refresh", async () => {
  const { putResumable } = await import("../src/google/gmail");
  const e = testEnv();
  const id = "freeze-refresh";
  await seedUserAndAccount(e.DB, { userId: id, accountId: id, alias: "freeze" });
  await seedAccessToken(e, { userId: id, accountId: id, refresh: "rt-freeze", expiresInMs: -1 });
  let puts = 0;
  const deps = {
    ...defaultDeps,
    googleFetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        puts++;
        return Response.json({ id: "m", threadId: "t" });
      }
      await e.DB.prepare("UPDATE recovery_installation SET mutation_state='frozen'").run();
      return Response.json({ access_token: "fresh", expires_in: 3600, token_type: "Bearer" });
    },
  };
  await expect(
    putResumable(
      e,
      deps,
      { userId: id, accountId: id },
      "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=resumable&upload_id=test",
      {
        endpoint: { kind: "send" },
        contentType: "message/rfc822",
        length: 1,
        body: new Response("x").body!,
        expectedCredentialVersion: 0,
      },
    ),
  ).rejects.toThrow();
  expect(puts).toBe(0);
});
