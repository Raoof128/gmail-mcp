import { env, createExecutionContext } from "cloudflare:test";
import { it, expect } from "vitest";
import { createWorker } from "../src/index";
import { FakeGoogle } from "./fake-google";
import { Browser, mintToken } from "./browser";
import { testEnv, testDeps, HOST } from "./test-env";
import { registerCompanionClient } from "../src/auth/companion";
import { seedUserAndAccount } from "./fixtures";
import { setPolicy } from "../src/policy/engine";
it("authenticates identity and uploads through the real staging OAuth route", async () => {
  const g = await FakeGoogle.create();
  const w = createWorker(testDeps(g));
  const e = testEnv();
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "api-account", alias: "work" });
  await setPolicy(env.DB, {
    userId: "owner-sub",
    accountId: "api-account",
    action: "attachment.stage_upload",
    level: "allow",
  });
  const browser = new Browser(w, e);
  await browser.login(g, { sub: "owner-sub", email: "owner@example.test" });
  const clientId = await registerCompanionClient({ ...e, OAUTH_PROVIDER: undefined as never }, w);
  const token = (
    await mintToken(w, e, g, { scope: "staging", clientId, redirectUri: "http://127.0.0.1:61234/callback", browser })
  ).accessToken;
  const call = (path: string, init: RequestInit = {}) =>
    w.fetch(
      new Request(HOST + path, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } }),
      { ...e },
      createExecutionContext(),
    );
  expect(await (await call("/staging/identity")).json()).toMatchObject({ user_id: "owner-sub" });
  const response = await call("/staging/intent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "ensure",
      transfer_id: `tr_${"z".repeat(43)}`,
      account: "work",
      metadata: {
        filename: "empty.txt",
        size: 0,
        mime: "text/plain",
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
    }),
  });
  expect(response.status).toBe(200);
  const ticket = (await response.json()) as any;
  const result = await call(`/staging/${ticket.ticket_id}`, {
    method: "PUT",
    headers: { "content-length": "0", "content-type": "text/plain" },
    body: "",
  });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ state: "completed" });
});
