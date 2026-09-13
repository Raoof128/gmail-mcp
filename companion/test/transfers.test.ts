import { it, expect } from "vitest";
import { Companion } from "../src/transfers.ts";
import { Authority } from "../src/http.ts";
import type { NativePort } from "../src/native.ts";
it("recovers a lost first response without reopening a changed source, and binds explicit keys", async () => {
  const rows = new Map<string, any>();
  let snapshots = 0,
    uploads = 0,
    intents = 0;
  let remote: any;
  const native: NativePort = {
    close() {},
    // eslint-disable-next-line @typescript-eslint/require-await -- This test double implements an async interface.
    async call(c, body) {
      const key = String(c.scope) + String(c.key);
      if (c.op === "journal.get") return { meta: rows.get(key) ?? {}, body: new Uint8Array() };
      if (c.op === "journal.put") {
        rows.set(key, { requestHash: c.requestHash, payload: c.payload });
        return { meta: { ok: true }, body: new Uint8Array() };
      }
      if (c.op === "snapshot.prepare") {
        snapshots++;
        return {
          meta: {
            state: "ready",
            transfer_id: c.transfer_id,
            root: c.root,
            path: c.path,
            mime: c.mime,
            created_at: Date.now() / 1000,
            file: {
              path: "/private/not-for-model",
              size: 0,
              sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            },
          },
          body: new Uint8Array(),
        };
      }
      return { meta: { ok: true }, body: body ? new Uint8Array(body) : new Uint8Array() };
    },
  };
  // eslint-disable-next-line @typescript-eslint/require-await -- This test double implements an async interface.
  const api = new Authority("https://worker.example.test", async (url, init) => {
    if ((url instanceof URL ? url.href : typeof url === "string" ? url : url.url).endsWith("/intent")) {
      intents++;
      const input = JSON.parse(init?.body as string);
      remote ??= {
        transfer_id: input.transfer_id,
        account: "work",
        account_id: "a",
        intent_hash: "hash",
        state: "issued",
        generation: 1,
        ticket_id: "ut_" + "a".repeat(43),
      };
      if (intents === 1) throw new Error("lost response");
      return Response.json(remote);
    }
    uploads++;
    remote = { ...remote, state: "completed", handle: "sh_" + "h".repeat(43) };
    return Response.json(remote);
  });
  const service = new Companion(native, api, "test-only", { user_id: "owner", client_id: "client" });
  const input = { account: "work", root: "read", path: "a.txt", mime: "text/plain", idempotency_key: "one" };
  await expect(service.stage(input)).rejects.toThrow("lost response");
  const result = await service.stage(input);
  expect(result.handle).toMatch(/^sh_/);
  expect(JSON.stringify(result)).not.toContain("/private");
  expect(snapshots).toBe(1);
  expect(uploads).toBe(1);
  await expect(service.stage({ ...input, path: "b.txt" })).rejects.toThrow("idempotency_conflict");
  expect((await service.stage(input)).handle).toBe(result.handle);
  expect(uploads).toBe(1);
});
it("rejects control characters in explicit request keys", async () => {
  const { StageInput } = await import("../src/transfers.ts");
  expect(
    StageInput.safeParse({
      account: "work",
      root: "read",
      path: "a.txt",
      mime: "text/plain",
      idempotency_key: "a\u0000b",
    }).success,
  ).toBe(false);
});
