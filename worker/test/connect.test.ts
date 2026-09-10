import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index";
import { Browser, mintToken } from "./browser";
import { FakeGoogle } from "./fake-google";
import { testEnv, testDeps } from "./test-env";
import { Keyring } from "../src/crypto/keyring";
import { connectElicitationId } from "../src/google/connect";
import { rpc } from "./mcp-client";

let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker(testDeps(g));
});

async function connect(
  b: Browser,
  alias: string,
  o: { sub: string; email: string; e?: string; withRefresh?: boolean },
) {
  const start = await b.get(`/connect?alias=${alias}${o.e ? `&e=${o.e}` : ""}`);
  if (start.status !== 303) return start;
  const google = new URL(start.headers.get("location")!);
  expect(google.searchParams.get("access_type")).toBe("offline");
  expect(google.searchParams.get("scope")).toContain("gmail.modify");
  const code = g.grantCode({
    sub: o.sub,
    email: o.email,
    nonce: google.searchParams.get("nonce")!,
    scope: "https://www.googleapis.com/auth/gmail.modify openid email",
  });
  if (o.withRefresh === false) g.codes.get(code)!.refresh = "";
  return b.get(`/connect/callback?state=${google.searchParams.get("state")}&code=${code}`);
}

describe("connect an account", () => {
  it("stores encrypted tokens under the right AAD, verified send-as only, and makes the first account default", async () => {
    const e = testEnv();
    const b = new Browser(worker, e);
    await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
    const done = await connect(b, "personal", { sub: "gsub-1", email: "me@gmail.test" });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/accounts");
    const row = await env.DB.prepare(
      "SELECT * FROM accounts WHERE user_id = 'owner-sub' AND google_sub = 'gsub-1'",
    ).first<any>();
    expect(row.alias).toBe("personal");
    expect(row.is_default).toBe(1);
    expect(row.status).toBe("active");
    expect(row.credential_version).toBe(0);
    expect(JSON.parse(row.send_as)).toEqual(["owner@example.test", "alias@example.test"]);
    expect(row.scopes).toContain("gmail.modify");
    const ring = Keyring.fromEnv(e);
    const rt = await ring.decrypt(new Uint8Array(row.refresh_token_enc), row.refresh_token_key_id, {
      userId: "owner-sub",
      accountId: row.id,
      field: "refresh_token",
    });
    expect(rt).toMatch(/^rt-/);
    await expect(
      ring.decrypt(new Uint8Array(row.refresh_token_enc), row.refresh_token_key_id, {
        userId: "owner-sub",
        accountId: "other",
        field: "refresh_token",
      }),
    ).rejects.toThrow();
    const audit = await env.DB.prepare(
      "SELECT action, decision FROM audit_log WHERE user_id = 'owner-sub' AND action = 'account.connect' ORDER BY id DESC LIMIT 1",
    ).first<any>();
    expect(audit.decision).toBe("connected");
  });

  it("reconnecting the same Google account keeps its alias and id and replaces the tokens", async () => {
    const e = testEnv();
    const b = new Browser(worker, e);
    await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
    await connect(b, "first", { sub: "gsub-2", email: "two@gmail.test" });
    const before = await env.DB.prepare(
      "SELECT id, refresh_token_enc FROM accounts WHERE google_sub = 'gsub-2'",
    ).first<any>();
    await env.DB.prepare("UPDATE accounts SET status = 'needs_reconnect' WHERE google_sub = 'gsub-2'").run();
    expect((await connect(b, "renamed", { sub: "gsub-2", email: "two@gmail.test" })).status).toBe(303);
    const after = await env.DB.prepare(
      "SELECT id, alias, status, credential_version, refresh_token_enc FROM accounts WHERE google_sub = 'gsub-2'",
    ).first<any>();
    expect(after.id).toBe(before.id);
    expect(after.alias).toBe("first");
    expect(after.status).toBe("active");
    expect(after.credential_version).toBe(1);
    expect(new Uint8Array(after.refresh_token_enc)).not.toEqual(new Uint8Array(before.refresh_token_enc));
  });

  it("a failed persist revokes the freshly issued refresh token, and a grant without gmail.modify is refused", async () => {
    const e = testEnv();
    const b = new Browser(worker, e);
    await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
    await connect(b, "taken2", { sub: "gsub-30", email: "thirty@gmail.test" });
    const start = await b.get("/connect?alias=taken2");
    const google = new URL(start.headers.get("location")!);
    const code = g.grantCode({
      sub: "gsub-31",
      email: "thirtyone@gmail.test",
      nonce: google.searchParams.get("nonce")!,
      scope: "https://www.googleapis.com/auth/gmail.modify openid email",
    });
    const refresh = g.codes.get(code)!.refresh;
    const res = await b.get(`/connect/callback?state=${google.searchParams.get("state")}&code=${code}`);
    expect(res.status).toBe(409);
    expect(g.revoked.has(refresh)).toBe(true);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM accounts WHERE google_sub = 'gsub-31'").first<{ n: number }>(),
    ).toEqual({ n: 0 });

    const start2 = new URL((await b.get("/connect?alias=narrow")).headers.get("location")!);
    const narrow = g.grantCode({
      sub: "gsub-32",
      email: "n@gmail.test",
      nonce: start2.searchParams.get("nonce")!,
      scope: "openid email",
    });
    const refresh2 = g.codes.get(narrow)!.refresh;
    const res2 = await b.get(`/connect/callback?state=${start2.searchParams.get("state")}&code=${narrow}`);
    expect(res2.status).toBe(400);
    expect(await res2.text()).toContain("gmail.modify");
    expect(g.revoked.has(refresh2)).toBe(true);
  });

  it("two first connections racing create one default; two reconnects of one sub keep one row", async () => {
    const e = testEnv({ OWNER_GOOGLE_SUBS: "owner-sub,racer" });
    const b1 = new Browser(worker, e);
    const b2 = new Browser(worker, e);
    await b1.login(g, { sub: "racer", email: "racer@example.test" });
    await b2.login(g, { sub: "racer", email: "racer@example.test" });
    const s1 = new URL((await b1.get("/connect?alias=one")).headers.get("location")!);
    const s2 = new URL((await b2.get("/connect?alias=two")).headers.get("location")!);
    const c1 = g.grantCode({
      sub: "gsub-40",
      email: "a@gmail.test",
      nonce: s1.searchParams.get("nonce")!,
      scope: "https://www.googleapis.com/auth/gmail.modify openid email",
    });
    const c2 = g.grantCode({
      sub: "gsub-41",
      email: "b@gmail.test",
      nonce: s2.searchParams.get("nonce")!,
      scope: "https://www.googleapis.com/auth/gmail.modify openid email",
    });
    const [r1, r2] = await Promise.all([
      b1.get(`/connect/callback?state=${s1.searchParams.get("state")}&code=${c1}`),
      b2.get(`/connect/callback?state=${s2.searchParams.get("state")}&code=${c2}`),
    ]);
    expect([r1.status, r2.status]).toEqual([303, 303]);
    const defaults = await env.DB.prepare(
      "SELECT count(*) AS n FROM accounts WHERE user_id = 'racer' AND is_default = 1",
    ).first<{ n: number }>();
    expect(defaults).toEqual({ n: 1 });

    const s3 = new URL((await b1.get("/connect?alias=one")).headers.get("location")!);
    const s4 = new URL((await b2.get("/connect?alias=one")).headers.get("location")!);
    const c3 = g.grantCode({
      sub: "gsub-40",
      email: "a@gmail.test",
      nonce: s3.searchParams.get("nonce")!,
      scope: "https://www.googleapis.com/auth/gmail.modify openid email",
    });
    const c4 = g.grantCode({
      sub: "gsub-40",
      email: "a@gmail.test",
      nonce: s4.searchParams.get("nonce")!,
      scope: "https://www.googleapis.com/auth/gmail.modify openid email",
    });
    const [r3, r4] = await Promise.all([
      b1.get(`/connect/callback?state=${s3.searchParams.get("state")}&code=${c3}`),
      b2.get(`/connect/callback?state=${s4.searchParams.get("state")}&code=${c4}`),
    ]);
    expect([r3.status, r4.status]).toEqual([303, 303]);
    const rows = await env.DB.prepare("SELECT credential_version FROM accounts WHERE google_sub = 'gsub-40'").all<{
      credential_version: number;
    }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.credential_version).toBe(2);
  });

  it("refuses an alias in use, a bad alias, a missing refresh token, a state from another session, and a foreign elicitation id", async () => {
    const e = testEnv();
    const b = new Browser(worker, e);
    await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
    await connect(b, "taken", { sub: "gsub-3", email: "three@gmail.test" });
    expect((await connect(b, "taken", { sub: "gsub-4", email: "four@gmail.test" })).status).toBe(409);
    expect((await b.get("/connect?alias=Not%20Valid")).status).toBe(400);
    const noRefresh = await connect(b, "five", { sub: "gsub-5", email: "five@gmail.test", withRefresh: false });
    expect(noRefresh.status).toBe(400);
    expect(await noRefresh.text()).toContain("refresh token");
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM accounts WHERE google_sub = 'gsub-5'").first<{ n: number }>(),
    ).toEqual({ n: 0 });

    const start = await b.get("/connect?alias=six");
    const google = new URL(start.headers.get("location")!);
    const code = g.grantCode({ sub: "gsub-6", email: "six@gmail.test", nonce: google.searchParams.get("nonce")! });
    const other = new Browser(worker, e);
    await other.login(g, { sub: "owner-sub", email: "owner@example.test" });
    expect((await other.get(`/connect/callback?state=${google.searchParams.get("state")}&code=${code}`)).status).toBe(
      403,
    );

    const foreign = await connectElicitationId(e, "someone-else", "seven");
    expect((await b.get(`/connect?alias=seven&e=${foreign}`)).status).toBe(403);
    const mine = await connectElicitationId(e, "owner-sub", "seven");
    expect((await b.get(`/connect?alias=seven&e=${mine}`)).status).toBe(303);
  });

  it("connect_account and open_policy_editor return page URLs and audit an intent", async () => {
    const e = testEnv();
    const t = await mintToken(worker, e, g, { scope: "mcp" });
    const call = await rpc(
      worker,
      e,
      t.accessToken,
      "tools/call",
      { name: "connect_account", arguments: { alias: "work" } },
      5,
    );
    const parsed = JSON.parse(call.json.result.content[0].text);
    expect(parsed.status).toBe("connect_required");
    expect(parsed.url).toMatch(
      /^https:\/\/gmail-mcp\.example\.workers\.dev\/connect\?alias=work&e=\d+\.[A-Za-z0-9_-]{43}$/,
    );
    const pol = await rpc(worker, e, t.accessToken, "tools/call", { name: "open_policy_editor", arguments: {} }, 6);
    expect(JSON.parse(pol.json.result.content[0].text).url).toBe("https://gmail-mcp.example.workers.dev/policy");
    const rows = await env.DB.prepare(
      "SELECT tool, action, decision FROM audit_log WHERE user_id = 'owner-sub' AND tool IN ('connect_account','open_policy_editor')",
    ).all<any>();
    expect(rows.results.map((r) => `${r.tool}:${r.action}:${r.decision}`).sort()).toEqual([
      "connect_account:account.connect:browser",
      "open_policy_editor:policy.read:browser",
    ]);
  });
});
