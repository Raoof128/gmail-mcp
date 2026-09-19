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

// Cloudflare drops content-length when the Worker streams the R2 body, so the real download arrives
// without it and this check refused every save in production with "download_metadata". Every test
// here built its own Response and set the header, which is why the suite never saw it. The Worker
// now also sends the size as x-size, which the edge leaves alone, and the length is read from
// whichever header is present.
it("saves when the edge dropped content-length and the size arrives as x-size", async () => {
  const bytes = new TextEncoder().encode("hello");
  const sha = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
  let state = "prepared";
  const native: NativePort = {
    close() {},
    call(command) {
      if (command.op === "save.publish") state = "published";
      if (command.op === "save.ack") state = "acknowledged";
      return Promise.resolve({
        meta: { state, root: "attachments", relative: "a.txt", file: { size: bytes.length, sha256: sha } },
        body: new Uint8Array(),
      });
    },
  };
  const api = new Authority("https://worker.example.test", (url) =>
    (url as URL).pathname.endsWith("/ack")
      ? Promise.resolve(Response.json({ acknowledged: true, replayed: true }))
      : // no content-length, exactly as the deployed Worker answers
        Promise.resolve(new Response(bytes, { headers: { "x-size": String(bytes.length), "x-sha256": sha } })),
  );
  const service = new Companion(native, api, "test-only", { user_id: "owner", client_id: "client" });
  const out = await service.save({ handle: "sh_" + "b".repeat(43), root: "attachments", path: "a.txt" });
  expect(out).toMatchObject({ state: "published", acknowledged: true });
});
