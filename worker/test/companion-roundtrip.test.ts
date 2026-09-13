import { env, createExecutionContext } from "cloudflare:test";
import { it, expect } from "vitest";
import { Companion } from "../../companion/src/transfers.ts";
import { Authority } from "../../companion/src/http.ts";
import type { NativePort } from "../../companion/src/protocol.ts";
import { createWorker } from "../src/index";
import { FakeGoogle } from "./fake-google";
import { Browser, mintToken } from "./browser";
import { testEnv, testDeps, HOST } from "./test-env";
import { registerCompanionClient } from "../src/auth/companion";
import { seedUserAndAccount } from "./fixtures";
import { setPolicy } from "../src/policy/engine";
it("runs companion orchestration through real Worker OAuth and staging publication", async () => {
  const google = await FakeGoogle.create(),
    worker = createWorker(testDeps(google)),
    e = testEnv();
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "roundtrip-account", alias: "work" });
  await setPolicy(env.DB, {
    userId: "owner-sub",
    accountId: "roundtrip-account",
    action: "attachment.stage_upload",
    level: "allow",
  });
  const browser = new Browser(worker, e);
  await browser.login(google, { sub: "owner-sub", email: "owner@example.test" });
  const client_id = await registerCompanionClient({ ...e, OAUTH_PROVIDER: undefined as never }, worker);
  const { accessToken } = await mintToken(worker, e, google, {
    scope: "staging",
    clientId: client_id,
    redirectUri: "http://127.0.0.1:61234/callback",
    browser,
  });
  const api = new Authority(HOST, async (url, init) => {
    expect(init?.redirect).toBe("error");
    // workerd Request lacks Node's redirect:error mode. This adapter never follows a redirect.
    const response = await worker.fetch(
      new Request(url, { ...init, redirect: "manual" }),
      { ...e },
      createExecutionContext(),
    );
    if (response.status >= 300 && response.status < 400) throw new Error("redirect_refused");
    return response;
  });
  await api.discover();
  const owner = (await api.json("/staging/identity", accessToken)) as { user_id: string };
  const rows = new Map<string, { requestHash: unknown; payload: unknown }>();
  const digest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const native: NativePort = {
    close() {},
    call(c) {
      const key = String(c.scope) + String(c.key);
      if (c.op === "journal.get") return Promise.resolve({ meta: rows.get(key) ?? {}, body: new Uint8Array() });
      if (c.op === "journal.put") rows.set(key, { requestHash: c.requestHash, payload: c.payload });
      return Promise.resolve({
        meta: c.op === "snapshot.prepare" ? { state: "ready", file: { size: 0, sha256: digest } } : { ok: true },
        body: new Uint8Array(),
      });
    },
  };
  const companion = new Companion(native, api, accessToken, { ...owner, client_id });
  const input = { account: "work", root: "source", path: "empty.txt", mime: "text/plain" };
  const result = await companion.stage(input);
  expect(result.state).toBe("completed");
  expect((await companion.stage(input)).handle).toBe(result.handle);
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM staging_objects WHERE user_id=?").bind(owner.user_id).first(),
  ).toEqual({ n: 1 });
});
