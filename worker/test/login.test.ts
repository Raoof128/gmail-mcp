import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index";
import { FakeGoogle } from "./fake-google";
import { Browser, csrfFrom } from "./browser";
import { testEnv, testDeps } from "./test-env";
import { SESSION_COOKIE } from "../src/web/session";

let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker(testDeps(g));
});
const E = () => testEnv();

describe("owner login", () => {
  it("landing redirects to /login without a session and to /accounts with one", async () => {
    const b = new Browser(worker, E());
    expect((await b.get("/")).status).toBe(200);
    expect(await (await b.get("/")).text()).toContain('href="/login"');
    await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
    const home = await b.get("/");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('action="/logout"');
  });

  it("logs the owner in, rotates the session, and returns to an internal path only", async () => {
    const b = new Browser(worker, E());
    b.cookies.set(SESSION_COOKIE, "fixated-value-that-is-43-chars-long-xxxxxxxx");
    const done = await b.login(g, { sub: "owner-sub", email: "owner@example.test", returnTo: "/policy" });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/policy");
    expect(b.cookies.get(SESSION_COOKIE)).not.toBe("fixated-value-that-is-43-chars-long-xxxxxxxx");
    const user = await env.DB.prepare("SELECT email FROM users WHERE id = 'owner-sub'").first<{ email: string }>();
    expect(user?.email).toBe("owner@example.test");

    const evil = new Browser(worker, E());
    const start = await evil.get("/login?return=https://evil.test/");
    const google = new URL(start.headers.get("location")!);
    const code = g.grantCode({
      sub: "owner-sub",
      email: "owner@example.test",
      nonce: google.searchParams.get("nonce")!,
    });
    const cb = await evil.get(`/oidc/callback?state=${google.searchParams.get("state")}&code=${code}`);
    expect(cb.headers.get("location")).toBe("/accounts");
  });

  it("two callbacks racing on one state yield exactly one session", async () => {
    const b1 = new Browser(worker, E());
    const start = await b1.get("/login");
    const google = new URL(start.headers.get("location")!);
    const state = google.searchParams.get("state")!;
    const nonce = google.searchParams.get("nonce")!;
    const b2 = new Browser(worker, E());
    const c1 = g.grantCode({ sub: "owner-sub", email: "owner@example.test", nonce });
    const c2 = g.grantCode({ sub: "owner-sub", email: "owner@example.test", nonce });
    const [r1, r2] = await Promise.all([
      b1.get(`/oidc/callback?state=${state}&code=${c1}`),
      b2.get(`/oidc/callback?state=${state}&code=${c2}`),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([303, 400]);
    expect([b1.cookies.has(SESSION_COOKIE), b2.cookies.has(SESSION_COOKIE)].filter(Boolean)).toHaveLength(1);
  });

  it("rejects state replay, a foreign state, and a nonce that does not match", async () => {
    const b = new Browser(worker, E());
    const start = await b.get("/login");
    const google = new URL(start.headers.get("location")!);
    const state = google.searchParams.get("state")!;
    const nonce = google.searchParams.get("nonce")!;
    const code = g.grantCode({ sub: "owner-sub", email: "owner@example.test", nonce });
    expect((await b.get(`/oidc/callback?state=${state}&code=${code}`)).status).toBe(303);
    const replay = g.grantCode({ sub: "owner-sub", email: "owner@example.test", nonce });
    expect((await b.get(`/oidc/callback?state=${state}&code=${replay}`)).status).toBe(400);
    expect((await b.get(`/oidc/callback?state=made-up&code=${replay}`)).status).toBe(400);

    const c = new Browser(worker, E());
    const s2 = new URL((await c.get("/login")).headers.get("location")!);
    const wrongNonce = g.grantCode({ sub: "owner-sub", email: "owner@example.test", nonce: "not-the-nonce" });
    const res = await c.get(`/oidc/callback?state=${s2.searchParams.get("state")}&code=${wrongNonce}`);
    expect(res.status).toBe(401);
    expect(c.cookies.has(SESSION_COOKIE)).toBe(false);
  });

  it("refuses a Google identity that is not the owner, and never creates a session for it", async () => {
    const b = new Browser(worker, E());
    const res = await b.login(g, { sub: "stranger", email: "stranger@example.test" });
    expect(res.status).toBe(403);
    expect(b.cookies.has(SESSION_COOKIE)).toBe(false);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM users WHERE id = 'stranger'").first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  it("bootstrap: with OWNER_GOOGLE_SUBS empty, an OWNER_EMAILS address sees its sub and gets no session", async () => {
    const b = new Browser(worker, testEnv({ OWNER_GOOGLE_SUBS: "" }));
    const res = await b.login(g, { sub: "new-owner-sub", email: "owner@example.test" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("new-owner-sub");
    expect(html).toContain("Confirm this is the Google account you intend to trust");
    expect(b.cookies.has(SESSION_COOKIE)).toBe(false);
    const other = new Browser(worker, testEnv({ OWNER_GOOGLE_SUBS: "" }));
    expect((await other.login(g, { sub: "x", email: "someone@else.test" })).status).toBe(403);
  });

  it("reauth refreshes authenticated_at on the same session; logout revokes and needs CSRF", async () => {
    const b = new Browser(worker, E());
    await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
    const sid = b.cookies.get(SESSION_COOKIE)!;
    await env.DB.prepare("UPDATE web_sessions SET authenticated_at = 1").run();
    const reauthCsrf = csrfFrom(await (await b.get("/")).text(), "/reauth");
    expect((await b.post("/reauth", { csrf: "nope", return: "/policy" })).status).toBe(403);
    const start = await b.post("/reauth", { csrf: reauthCsrf, return: "/policy" });
    expect(start.status).toBe(303);
    const google = new URL(start.headers.get("location")!);
    const code = g.grantCode({
      sub: "owner-sub",
      email: "owner@example.test",
      nonce: google.searchParams.get("nonce")!,
    });
    const cb = await b.get(`/oidc/callback?state=${google.searchParams.get("state")}&code=${code}`);
    expect(cb.headers.get("location")).toBe("/policy");
    expect(b.cookies.get(SESSION_COOKIE)).toBe(sid);
    const row = await env.DB.prepare(
      "SELECT authenticated_at FROM web_sessions WHERE revoked_at IS NULL ORDER BY authenticated_at DESC LIMIT 1",
    ).first<{ authenticated_at: number }>();
    expect(row!.authenticated_at).toBeGreaterThan(Date.now() - 10_000);

    // reauth as a different Google identity must not upgrade this session
    const start2 = new URL(
      (await b.post("/reauth", { csrf: reauthCsrf, return: "https://evil.test/" })).headers.get("location")!,
    );
    const wrong = g.grantCode({ sub: "stranger", email: "s@example.test", nonce: start2.searchParams.get("nonce")! });
    expect((await b.get(`/oidc/callback?state=${start2.searchParams.get("state")}&code=${wrong}`)).status).toBe(403);

    const csrf = csrfFrom(await (await b.get("/")).text(), "/logout");
    expect((await b.post("/logout", { csrf: "nope" })).status).toBe(403);
    const out = await b.post("/logout", { csrf });
    expect(out.status).toBe(303);
    expect(b.cookies.has(SESSION_COOKIE)).toBe(false);
    // /accounts does not exist until task 11; what this task can prove is that the session is gone,
    // so the landing page renders the logged-out view instead of the header forms.
    const afterLogout = await b.get("/");
    expect(afterLogout.status).toBe(200);
    expect(await afterLogout.text()).toContain('href="/login"');
  });
});
