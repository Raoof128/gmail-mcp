import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index";
import { Browser, csrfFrom, mintToken, registerClient } from "./browser";
import { FakeGoogle } from "./fake-google";
import { rpc } from "./mcp-client";
import { HOST, testEnv } from "./test-env";
import { registerCompanionClient } from "../src/auth/companion";
import { requireScope } from "../src/auth/principal";
import { seedUserAndAccount } from "./fixtures";

const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } };
let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker({ googleFetch: g.fetch });
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "oa", alias: "personal", isDefault: true });
});

describe("discovery", () => {
  it("serves AS metadata with S256 only and CIMD on, and PRM for /mcp", async () => {
    const b = new Browser(worker, testEnv());
    const as = (await (await b.get("/.well-known/oauth-authorization-server")).json()) as any;
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.registration_endpoint).toBe(`${HOST}/register`);
    const prm = (await (await b.get("/.well-known/oauth-protected-resource/mcp")).json()) as any;
    expect(prm.resource).toBe(`${HOST}/mcp`);
    expect(prm.authorization_servers).toEqual([HOST]);
    expect(prm.scopes_supported).toEqual(["mcp", "staging"]);
    const staging = (await (await b.get("/.well-known/oauth-protected-resource/staging")).json()) as any;
    expect(staging.resource).toBe(`${HOST}/staging`);
    expect(staging.authorization_servers).toEqual([HOST]);
  });
});

describe("scope policy at /authorize", () => {
  it("a DCR client gets mcp, and is refused staging or both", async () => {
    const ok = await mintToken(worker, testEnv(), g, { scope: "mcp" });
    expect(ok.accessToken).not.toBe("");
    const staging = await mintToken(worker, testEnv(), g, { scope: "staging", resource: `${HOST}/staging` });
    expect(staging.accessToken).toBe("");
    expect(staging.location).toContain("error=invalid_scope");
    const both = await mintToken(worker, testEnv(), g, { scope: "mcp staging" });
    expect(both.location).toContain("error=invalid_scope");
  });
  it("the companion client gets staging only", async () => {
    const e = testEnv();
    const b = new Browser(worker, e);
    await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
    const companionId = await registerCompanionClient({ ...e, OAUTH_PROVIDER: undefined as never }, worker);
    const st = await mintToken(worker, e, g, {
      scope: "staging",
      clientId: companionId,
      redirectUri: "http://127.0.0.1:61234/callback",
      browser: b,
    });
    expect(st.accessToken).not.toBe("");
    const mcp = await mintToken(worker, e, g, {
      scope: "mcp",
      clientId: companionId,
      redirectUri: "http://127.0.0.1:9/callback",
      browser: b,
    });
    expect(mcp.location).toContain("error=invalid_scope");
  });
  it("an empty scope request receives the client's one allowed scope", async () => {
    const t = await mintToken(worker, testEnv(), g, { scope: "" });
    expect(t.accessToken).not.toBe("");
    expect((await rpc(worker, testEnv(), t.accessToken, "initialize", INIT)).status).toBe(200);
  });
  it("a resource that is not the audience for the scope is invalid_target", async () => {
    const t = await mintToken(worker, testEnv(), g, { scope: "mcp", resource: `${HOST}/staging` });
    expect(t.location).toContain("error=invalid_target");
  });
});

describe("tokens at the routes", () => {
  it("an mcp token cannot reach /staging and a staging token cannot reach /mcp", async () => {
    const e = testEnv();
    const b = new Browser(worker, e);
    await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
    const companionId = await registerCompanionClient({ ...e, OAUTH_PROVIDER: undefined as never }, worker);
    const mcp = await mintToken(worker, e, g, { scope: "mcp", browser: b });
    const st = await mintToken(worker, e, g, {
      scope: "staging",
      clientId: companionId,
      redirectUri: "http://127.0.0.1:5/callback",
      browser: b,
    });
    const cross1 = await b.fetch("/staging/sh_x", { headers: { authorization: `Bearer ${mcp.accessToken}` } });
    expect(cross1.status).toBe(401);
    const cross2 = await rpc(worker, e, st.accessToken, "initialize", INIT);
    expect(cross2.status).toBe(401);
    const own = await b.fetch("/staging/sh_nope", { headers: { authorization: `Bearer ${st.accessToken}` } });
    expect(own.status).toBe(404);
  });
  it("requireScope refuses a token whose scope does not include the route's, and whose props disagree with the token owner", async () => {
    const stub = (scope: string[], sub: string) =>
      ({
        OAUTH_PROVIDER: {
          unwrapToken: () =>
            Promise.resolve({
              userId: "owner-sub",
              scope,
              audience: `${HOST}/mcp`,
              grant: { clientId: "c", props: { sub, email: "o@x" } },
            }),
        },
        WORKER_HOSTNAME: "gmail-mcp.example.workers.dev",
      }) as never;
    const req = new Request(`${HOST}/mcp`, { headers: { authorization: "Bearer a:b:c" } });
    const bad = await requireScope(req, stub(["staging"], "owner-sub"), "mcp");
    expect(bad instanceof Response && bad.status).toBe(403);
    const tampered = await requireScope(req, stub(["mcp"], "someone-else"), "mcp");
    expect(tampered instanceof Response && tampered.status).toBe(401);
    const good = await requireScope(req, stub(["mcp"], "owner-sub"), "mcp");
    expect(good).toMatchObject({ userId: "owner-sub", scope: "mcp" });
  });
});

describe("authorization endpoint hardening", () => {
  it("redirect_uri substitution is rendered locally, never redirected", async () => {
    const clientId = await registerClient(worker, testEnv(), "http://localhost:5555/callback");
    const b = new Browser(worker, testEnv());
    await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
    const res = await b.get(
      `/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent("https://evil.test/cb")}&scope=mcp&state=s&code_challenge=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&code_challenge_method=S256`,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });
  it("an authorization code is single use", async () => {
    const e = testEnv();
    const t = await mintToken(worker, e, g, { scope: "mcp" });
    const code = new URL(t.location!).searchParams.get("code")!;
    const replay = await t.browser.fetch("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:5555/callback",
        client_id: t.clientId,
        code_verifier: "x".repeat(43),
      }).toString(),
    });
    expect(replay.status).toBe(400);
  });
  it("consent requires a session, the right CSRF token, and denial returns access_denied to the client", async () => {
    const e = testEnv();
    const clientId = await registerClient(worker, e, "http://localhost:5555/callback");
    const anon = new Browser(worker, e);
    const q = `response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent("http://localhost:5555/callback")}&scope=mcp&state=s&code_challenge=${"a".repeat(43)}&code_challenge_method=S256&resource=${encodeURIComponent(HOST + "/mcp")}`;
    const start = await anon.get(`/authorize?${q}`);
    expect(start.status).toBe(303);
    const consentPath = start.headers.get("location")!;
    expect((await anon.get(consentPath)).headers.get("location")).toContain("/login?return=");

    await anon.login(g, { sub: "owner-sub", email: "owner@example.test" });
    const consent = await anon.get(consentPath);
    expect(consent.status).toBe(200);
    expect(consent.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://accounts.google.com http://localhost:5555",
    );
    const html = await consent.text();
    expect(html).toContain("test client");
    expect((await anon.post(consentPath, { decision: "approve", csrf: "wrong" })).status).toBe(403);
    expect(
      (await anon.post(consentPath, { decision: "approve", csrf: "wrong" }, { origin: "https://evil.test" })).status,
    ).toBe(403);
    const denied = await mintToken(worker, e, g, { scope: "mcp", clientId, browser: anon, decision: "deny" });
    expect(denied.location).toContain("error=access_denied");
    expect(denied.location).toContain("state=client-state");
    expect(denied.location).toContain("iss=");
  });
  it("a remembered client skips consent for the same owner only", async () => {
    const e = testEnv({ OWNER_GOOGLE_SUBS: "owner-sub,owner-two" });
    const first = await mintToken(worker, e, g, { scope: "mcp" });
    const again = await mintToken(worker, e, g, { scope: "mcp", clientId: first.clientId, browser: first.browser });
    expect(again.accessToken).not.toBe("");
    expect(first.browser.cookies.has("__Host-approved")).toBe(true);
    // Same browser, different owner: the cookie names owner-sub, so owner-two must see the consent page.
    await first.browser.login(g, { sub: "owner-two", email: "two@example.test" });
    expect(first.browser.cookies.has("__Host-approved")).toBe(false);
    const q = new URLSearchParams({
      response_type: "code",
      client_id: first.clientId,
      redirect_uri: "http://localhost:5555/callback",
      scope: "mcp",
      state: "s",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
    });
    const start = await first.browser.get(`/authorize?${q.toString()}`);
    const consent = await first.browser.get(start.headers.get("location")!);
    expect(consent.status).toBe(200);
    expect(await consent.text()).toContain('name="decision" value="approve"');
  });

  it("two consent decisions racing on one request produce one grant", async () => {
    const e = testEnv();
    const clientId = await registerClient(worker, e, "http://localhost:5555/callback");
    const b = new Browser(worker, e);
    await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "http://localhost:5555/callback",
      scope: "mcp",
      state: "s",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
    });
    const consentPath = (await b.get(`/authorize?${q.toString()}`)).headers.get("location")!;
    const csrf = csrfFrom(await (await b.get(consentPath)).text(), consentPath);
    const [r1, r2] = await Promise.all([
      b.post(consentPath, { decision: "approve", csrf }),
      b.post(consentPath, { decision: "approve", csrf }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([302, 410]);
  });

  it("companion registration under concurrency creates one client", async () => {
    const e = testEnv();
    await env.DB.prepare("DELETE FROM settings WHERE key = 'companion_client_id'").run();
    const ids = await Promise.all([
      registerCompanionClient({ ...e, OAUTH_PROVIDER: undefined as never }, worker),
      registerCompanionClient({ ...e, OAUTH_PROVIDER: undefined as never }, worker),
    ]);
    expect(ids[0]).toBe(ids[1]);
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'companion_client_id'").first<{
      value: string;
    }>();
    expect(row?.value).toBe(ids[0]);
  });
});
