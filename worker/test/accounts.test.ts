import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index";
import { Browser, csrfFrom } from "./browser";
import { FakeGoogle } from "./fake-google";
import { testEnv, testDeps } from "./test-env";
import { seedUserAndAccount } from "./fixtures";
import { Keyring } from "../src/crypto/keyring";
import { SESSION_COOKIE } from "../src/web/session";

let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker(testDeps(g));
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "ac1", alias: "personal", isDefault: true });
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "ac2", alias: "work" });
  await seedUserAndAccount(env.DB, { userId: "other-owner", accountId: "ac3", alias: "personal", isDefault: true });
});

async function owner() {
  const b = new Browser(worker, testEnv());
  await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
  return b;
}
async function tokenFor(b: Browser, objectId: string) {
  const html = await (await b.get("/accounts")).text();
  const block = html.split(`data-account="${objectId}"`)[1] ?? "";
  return csrfFrom(block);
}

describe("accounts page", () => {
  it("needs a session and lists only the owner's accounts", async () => {
    const anon = new Browser(worker, testEnv());
    expect((await anon.get("/accounts")).headers.get("location")).toBe("/login?return=%2Faccounts");
    const b = await owner();
    const html = await (await b.get("/accounts")).text();
    expect(html).toContain("personal");
    expect(html).toContain("work");
    expect(html).not.toContain("ac3");
    expect(html).toContain('action="/connect"');
    expect(html).not.toMatch(/refresh_token|access_token/);
  });

  it("set default moves the single default", async () => {
    const b = await owner();
    const res = await b.post("/accounts", { op: "default", account: "ac2", csrf: await tokenFor(b, "ac2") });
    expect(res.status).toBe(303);
    const rows = await env.DB.prepare(
      "SELECT id, is_default FROM accounts WHERE user_id = 'owner-sub' ORDER BY id",
    ).all<any>();
    expect(rows.results).toEqual([
      { id: "ac1", is_default: 0 },
      { id: "ac2", is_default: 1 },
    ]);
    expect((await b.post("/accounts", { op: "default", account: "ac3", csrf: await tokenFor(b, "ac2") })).status).toBe(
      403,
    );
  });

  it("trust settings need recent auth, are canonicalised the way the trust rules read them, and are audited", async () => {
    const b = await owner();
    const t = await tokenFor(b, "ac1");
    await env.DB.prepare("UPDATE web_sessions SET authenticated_at = 1 WHERE user_id = 'owner-sub'").run();
    const stale = await b.post("/accounts", {
      op: "allowlist_add",
      account: "ac1",
      pattern: "prof@uni.edu.au",
      csrf: t,
    });
    expect(stale.status).toBe(403);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM contact_allowlist WHERE account_id = 'ac1'").first<{
        n: number;
      }>(),
    ).toEqual({ n: 0 });
    await env.DB.prepare("UPDATE web_sessions SET authenticated_at = ? WHERE user_id = 'owner-sub'")
      .bind(Date.now())
      .run();

    expect(
      (await b.post("/accounts", { op: "allowlist_add", account: "ac1", pattern: "Prof.Name@Uni.EDU.AU", csrf: t }))
        .status,
    ).toBe(303);
    expect(
      (await b.post("/accounts", { op: "allowlist_add", account: "ac1", pattern: "@Bücher.example", csrf: t })).status,
    ).toBe(303);
    expect(
      (await b.post("/accounts", { op: "allowlist_add", account: "ac1", pattern: "Some.One+tag@gmail.com", csrf: t }))
        .status,
    ).toBe(303);
    expect(
      (await b.post("/accounts", { op: "allowlist_add", account: "ac1", pattern: "not an address", csrf: t })).status,
    ).toBe(400);
    expect((await b.post("/accounts", { op: "allowlist_add", account: "ac1", pattern: "@..", csrf: t })).status).toBe(
      400,
    );
    let list = (
      await env.DB.prepare("SELECT pattern FROM contact_allowlist WHERE account_id = 'ac1' ORDER BY pattern").all<any>()
    ).results.map((r) => r.pattern);
    // Local-part case is kept for a non-Gmail domain, the domain is lower-cased and punycoded, and the Gmail address is folded.
    expect(list).toEqual(["@xn--bcher-kva.example", "Prof.Name@uni.edu.au", "some.one@gmail.com"]);
    expect(
      (
        await b.post("/accounts", {
          op: "allowlist_remove",
          account: "ac1",
          pattern: "@xn--bcher-kva.example",
          csrf: t,
        })
      ).status,
    ).toBe(303);
    list = (
      await env.DB.prepare("SELECT pattern FROM contact_allowlist WHERE account_id = 'ac1' ORDER BY pattern").all<any>()
    ).results.map((r) => r.pattern);
    expect(list).toEqual(["Prof.Name@uni.edu.au", "some.one@gmail.com"]);

    expect((await b.post("/accounts", { op: "send_limit", account: "ac1", bytes: "10485760", csrf: t })).status).toBe(
      303,
    );
    expect(
      (await b.post("/accounts", { op: "send_limit", account: "ac1", bytes: "99999999999", csrf: t })).status,
    ).toBe(400);
    expect((await b.post("/accounts", { op: "send_limit", account: "ac1", bytes: "0", csrf: t })).status).toBe(400);
    expect(
      (
        await b.post("/accounts", {
          op: "org_domains",
          account: "ac1",
          domains: "Uni.edu.au, staff.uni.edu.au, bücher.example",
          csrf: t,
        })
      ).status,
    ).toBe(303);
    expect(
      (await b.post("/accounts", { op: "org_domains", account: "ac1", domains: "bad domain", csrf: t })).status,
    ).toBe(400);
    expect(
      (await b.post("/accounts", { op: "org_domains", account: "ac1", domains: "foo..com", csrf: t })).status,
    ).toBe(400);
    expect(
      (await b.post("/accounts", { op: "org_domains", account: "ac1", domains: "-foo.com", csrf: t })).status,
    ).toBe(400);
    const row = await env.DB.prepare(
      "SELECT send_limit_bytes, org_domains FROM accounts WHERE id = 'ac1'",
    ).first<any>();
    expect(row.send_limit_bytes).toBe(10485760);
    expect(JSON.parse(row.org_domains)).toEqual(["uni.edu.au", "staff.uni.edu.au", "xn--bcher-kva.example"]);

    // A decrease needs no recent auth; an increase does.
    await env.DB.prepare("UPDATE web_sessions SET authenticated_at = 1 WHERE user_id = 'owner-sub'").run();
    expect((await b.post("/accounts", { op: "send_limit", account: "ac1", bytes: "1048576", csrf: t })).status).toBe(
      303,
    );
    expect((await b.post("/accounts", { op: "send_limit", account: "ac1", bytes: "2097152", csrf: t })).status).toBe(
      403,
    );
    await env.DB.prepare("UPDATE web_sessions SET authenticated_at = ? WHERE user_id = 'owner-sub'")
      .bind(Date.now())
      .run();
    expect((await b.post("/accounts", { op: "send_limit", account: "ac1", bytes: "2097152", csrf: t })).status).toBe(
      303,
    );

    const audits = (
      await env.DB.prepare(
        "SELECT summary FROM audit_log WHERE user_id = 'owner-sub' AND tool = 'accounts_page' AND action = 'policy.edit' ORDER BY id",
      ).all<any>()
    ).results.map((r) => r.summary);
    expect(audits).toContain("ids=allowlist_add");
    expect(audits).toContain("ids=org_domains");
    expect(audits).toContain("ids=send_limit");
  });

  it("revoke needs recent authentication, wipes tokens, tells Google, and logs out other sessions", async () => {
    const b = await owner();
    const other = await owner();
    const ring = Keyring.fromEnv(testEnv());
    const rt = await ring.encrypt("rt-to-revoke", { userId: "owner-sub", accountId: "ac2", field: "refresh_token" });
    await env.DB.prepare("UPDATE accounts SET refresh_token_enc = ?, refresh_token_key_id = ? WHERE id = 'ac2'")
      .bind(rt.ciphertext, rt.keyId)
      .run();
    await env.DB.prepare("UPDATE web_sessions SET authenticated_at = 1 WHERE user_id = 'owner-sub'").run();
    const stale = await b.post("/accounts", { op: "revoke", account: "ac2", csrf: await tokenFor(b, "ac2") });
    expect(stale.status).toBe(403);
    expect(await stale.text()).toContain('name="return" value="/accounts"');
    expect((await env.DB.prepare("SELECT status FROM accounts WHERE id = 'ac2'").first<any>()).status).toBe("active");
    await env.DB.prepare("UPDATE web_sessions SET authenticated_at = ? WHERE user_id = 'owner-sub'")
      .bind(Date.now())
      .run();
    const ok = await b.post("/accounts", { op: "revoke", account: "ac2", csrf: await tokenFor(b, "ac2") });
    expect(ok.status).toBe(303);
    expect(g.revoked.has("rt-to-revoke")).toBe(true);
    const row = await env.DB.prepare("SELECT status, refresh_token_enc FROM accounts WHERE id = 'ac2'").first<any>();
    expect(row).toEqual({ status: "revoked", refresh_token_enc: null });
    expect((await other.get("/accounts")).status).toBe(303);
    expect((await b.get("/accounts")).status).toBe(200);
    expect(b.cookies.has(SESSION_COOKIE)).toBe(true);
    const audit = await env.DB.prepare(
      "SELECT decision FROM audit_log WHERE account_id = 'ac2' AND action = 'account.connect' ORDER BY id DESC LIMIT 1",
    ).first<any>();
    expect(audit.decision).toBe("revoked");
  });

  it("registers the companion once and shows its client id", async () => {
    const b = await owner();
    const html = await (await b.get("/accounts")).text();
    const t = csrfFrom(html.split('data-account="companion"')[1]!);
    expect((await b.post("/accounts", { op: "register_companion", account: "companion", csrf: t })).status).toBe(303);
    const again = await (await b.get("/accounts")).text();
    const id = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'companion_client_id'").first<any>())
      .value;
    expect(again).toContain(id);
    expect(again).not.toContain('value="register_companion"');
  });
});
