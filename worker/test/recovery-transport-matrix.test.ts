import { expect, it } from "vitest";
import { createWorker } from "../src/index";
import { FakeGoogle } from "./fake-google";
import { mintToken } from "./browser";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import { callTool } from "./mcp-client";
import { testDeps, testEnv } from "./test-env";
import { ingest } from "../src/staging/store";
import { approvePending } from "../src/approval/pending";
import { settleDirect } from "../src/operations/recovery-state";
import { RecoveryBarriers } from "./recovery-barriers";

const transports = ["media", "multipart", "resumable", "draft"] as const;
const faults = ["receipt", "lost-body", "partial-json", "malformed-success", "400", "401", "503"] as const;
for (const transport of transports)
  for (const fault of faults) {
    it(`${transport}: ${fault} preserves one operation, key, pending action and winner`, async () => {
      const e = testEnv();
      const account = `mx-${transport}-${fault}`;
      const g = await FakeGoogle.create();
      const barriers = new RecoveryBarriers();
      let armed = false,
        mutationRequests = 0;
      const googleFetch: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const mutation =
          armed &&
          url.hostname === "gmail.googleapis.com" &&
          (url.pathname.endsWith("/drafts/send") ||
            (url.pathname.includes("/upload/") &&
              (request.method === "PUT" || url.searchParams.get("uploadType") !== "resumable")));
        if (!mutation) return g.fetch(request);
        mutationRequests++;
        await barriers.barrier("headers");
        if (["400", "401", "503"].includes(fault)) return new Response("refused", { status: Number(fault) });
        const response = await g.fetch(request);
        await barriers.barrier("provider-commit");
        if (fault === "lost-body")
          return new Response(
            new ReadableStream({
              start(c) {
                c.error(new Error("lost body"));
              },
            }),
          );
        if (fault === "partial-json") return new Response('{"id":"partial"');
        if (fault === "malformed-success") return Response.json({ id: null, threadId: [] });
        return response;
      };
      const worker = createWorker(testDeps(g, { googleFetch }));
      await seedUserAndAccount(e.DB, { userId: "owner-sub", accountId: account, alias: account });
      await seedAccessToken(e, { userId: "owner-sub", accountId: account });
      const token = (await mintToken(worker, e, g, { scope: "mcp" })).accessToken;
      let tool = "send_message";
      const args: Record<string, unknown> = { account: account, idempotency_key: "matrix-key" };
      let handle: string | null = null;
      if (transport === "draft") {
        tool = "send_draft";
        args.draft_id = g.gmail.seedDraft({
          from: `${account}@example.test`,
          to: ["recipient@example.test"],
          subject: "matrix",
          text: "body",
        }).id;
      } else if (transport === "multipart") {
        tool = "reply";
        args.message_id = g.gmail.seedMessage({
          from: "recipient@example.test",
          to: [`${account}@example.test`],
          subject: "matrix",
          text: "body",
        }).id;
        args.body = "reply";
      } else {
        Object.assign(args, { to: ["recipient@example.test"], subject: "matrix", body: "body" });
        if (transport === "resumable") {
          const bytes = new Uint8Array(4 * 1024 * 1024);
          handle = (
            await ingest(e, {
              userId: "owner-sub",
              accountId: account,
              direction: "upload",
              filename: "matrix.bin",
              mime: "application/octet-stream",
              length: bytes.length,
              body: new Response(bytes).body!,
            })
          ).handle;
          args.attachments = [handle];
        }
      }
      const call = (name: string, input: Record<string, unknown>) => callTool(worker, e, token, name, input);
      const pending = await call(tool, args);
      expect(pending.result.status).toBe("pending_approval");
      const pendingId: string = pending.result.action_id;
      await approvePending(e.DB, { id: pendingId, userId: "owner-sub", via: "browser" });
      const pauseAt = ["400", "401", "503"].includes(fault) ? "headers" : "provider-commit";
      barriers.hold(pauseAt);
      armed = true;
      const executing = call("execute_pending", { action_id: pendingId });
      await barriers.reached(pauseAt);
      try {
        const active = await e.DB.prepare("SELECT operation_id,state FROM pending_actions WHERE id=?")
          .bind(pendingId)
          .first<{ operation_id: string; state: string }>();
        expect(active!.state).toBe("executing");
        const operationId = active!.operation_id;
        expect(await e.DB.prepare("SELECT state FROM operations WHERE id=?").bind(operationId).first("state")).toBe(
          "executing",
        );
        expect(
          await e.DB.prepare(
            "SELECT COALESCE(k.operation_id,p.operation_id) operation_id FROM idempotency_keys k LEFT JOIN pending_actions p ON p.id=k.pending_id WHERE k.key='matrix-key' AND k.account_id=?",
          )
            .bind(account)
            .first("operation_id"),
        ).toBe(operationId);
        if (handle)
          expect(
            await e.DB.prepare("SELECT consumed_at FROM staging_objects WHERE handle=?")
              .bind(handle)
              .first("consumed_at"),
          ).toBeNull();
      } finally {
        barriers.release(pauseAt);
      }
      const result = await executing;
      const row = await e.DB.prepare("SELECT operation_id,state FROM pending_actions WHERE id=?")
        .bind(pendingId)
        .first<{ operation_id: string; state: string }>();
      const id = row!.operation_id;
      if (fault === "receipt") expect(result.result.status).toBe("executed");
      else expect(result.result.error).toBe("delivery_unknown");
      expect(mutationRequests).toBe(1);
      expect(g.gmail.sent.length).toBe(["400", "401", "503"].includes(fault) ? 0 : 1);
      const replay = await call(tool, args);
      expect(replay.result.operation_id).toBe(id);
      expect(mutationRequests).toBe(1);
      const sent = g.gmail.sent[0];
      if (sent) {
        const message = g.gmail.messages.get(sent.id)!;
        const receipt = {
          gmail_result_id: message.id,
          message: { id: message.id, thread_id: message.threadId, label_ids: message.labelIds },
        };
        const winners = await Promise.all([settleDirect(e, id, receipt), settleDirect(e, id, receipt)]);
        expect(winners.filter((w) => w === "settled").length).toBe(fault === "receipt" ? 0 : 1);
        expect(await e.DB.prepare("SELECT state FROM pending_actions WHERE id=?").bind(pendingId).first("state")).toBe(
          "executed",
        );
        expect(
          await e.DB.prepare("SELECT count(*) n FROM audit_log WHERE operation_id=? AND decision='executed'")
            .bind(id)
            .first("n"),
        ).toBe(1);
        if (handle)
          expect(
            await e.DB.prepare("SELECT consumed_at FROM staging_objects WHERE handle=?")
              .bind(handle)
              .first("consumed_at"),
          ).not.toBeNull();
      } else {
        expect(await e.DB.prepare("SELECT state FROM operations WHERE id=?").bind(id).first("state")).toBe(
          "delivery_unknown",
        );
        expect(
          await e.DB.prepare("SELECT count(*) n FROM audit_log WHERE operation_id=? AND decision='executed'")
            .bind(id)
            .first("n"),
        ).toBe(0);
      }
    });
  }
