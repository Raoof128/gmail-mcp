import { it, expect } from "vitest";
import { Companion } from "../src/transfers.ts";
import { Authority } from "../src/http.ts";
import type { NativePort } from "../src/native.ts";
it("returns durable local success when ACK fails and never downloads again for its replay", async () => {
  let state = "prepared",
    gets = 0,
    acks = 0,
    publishes = 0;
  const native: NativePort = {
    close() {},
    call(command) {
      if (command.op === "save.publish") {
        state = "published";
        publishes++;
      }
      if (command.op === "save.ack") state = "acknowledged";
      return Promise.resolve({
        meta: {
          state,
          root: "attachments",
          relative: "a.txt",
          file: { size: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
        },
        body: new Uint8Array(),
      });
    },
  };
  const api = new Authority("https://worker.example.test", (url) => {
    if ((url as URL).pathname.endsWith("/ack")) {
      acks++;
      return acks === 1
        ? Promise.reject(new Error("lost ack"))
        : Promise.resolve(Response.json({ acknowledged: true, replayed: true }));
    }
    gets++;
    return Promise.resolve(
      new Response(new Uint8Array(), {
        headers: {
          "content-length": "0",
          "x-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
      }),
    );
  });
  const service = new Companion(native, api, "test-only", { user_id: "owner", client_id: "client" });
  const input = { handle: "sh_" + "a".repeat(43), root: "attachments", path: "a.txt" };
  expect(await service.save(input)).toMatchObject({ state: "published", acknowledged: false });
  expect(await service.save(input)).toMatchObject({ state: "published", acknowledged: true });
  expect(gets).toBe(1);
  expect(publishes).toBe(1);
});
