import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { createWorker } from "../src/index";
import { Browser, csrfFrom } from "./browser";
import { FakeGoogle } from "./fake-google";
import { testEnv, testDeps } from "./test-env";
import { seedUserAndAccount } from "./fixtures";
import { registerCompanionClient } from "../src/auth/companion";
import {
  REGISTRATION_WINDOW_MS,
  closeRegistration,
  isRegistrationOpen,
  openRegistration,
} from "../src/auth/registration";

const worker = createWorker();

function body(name = "probe") {
  return JSON.stringify({
    client_name: name,
    redirect_uris: ["https://client.test/cb"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  });
}
const post = (e: ReturnType<typeof testEnv>, name?: string) =>
  new Browser(worker, e).fetch("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body(name),
  });

beforeEach(async () => {
  await closeRegistration(env.DB);
});

describe("dynamic client registration is closed unless the owner opens it", () => {
  // Open DCR lets anyone mint a client with their own redirect_uri and phish the owner's consent
  // page on the genuine origin. The endpoint must default to closed.
  it("refuses an unauthenticated registration while the window is closed", async () => {
    expect(await isRegistrationOpen(env.DB, Date.now())).toBe(false);
    expect((await post(testEnv())).status).not.toBe(201);
  });

  it("accepts registration only inside an owner-opened window", async () => {
    await openRegistration(env.DB, Date.now());
    expect((await post(testEnv(), "inside window")).status).toBe(201);
  });

  it("refuses again once the window has elapsed", async () => {
    await openRegistration(env.DB, Date.now() - REGISTRATION_WINDOW_MS - 1000);
    expect(await isRegistrationOpen(env.DB, Date.now())).toBe(false);
    expect((await post(testEnv(), "after window")).status).not.toBe(201);
  });

  // The companion never uses the public endpoint, so closing it must not break owner setup.
  it("still lets the companion register through the internal API while closed", async () => {
    const e = testEnv();
    await env.DB.prepare("DELETE FROM settings WHERE key='companion_client_id'").run();
    const id = await registerCompanionClient(e, { oauthOptions: (x) => worker.oauthOptions(x) });
    expect(id).toMatch(/.+/);
    expect(await isRegistrationOpen(env.DB, Date.now())).toBe(false);
  });
});

describe("only the owner can open the window", () => {
  it("opens from the accounts page and refuses an anonymous post", async () => {
    const g = await FakeGoogle.create();
    const w = createWorker(testDeps(g));
    await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "rw1", alias: "personal", isDefault: true });

    const anon = new Browser(w, testEnv());
    expect((await anon.post("/accounts", { op: "open_registration", account: "registration", csrf: "x" })).status).toBe(
      303,
    );
    expect(await isRegistrationOpen(env.DB, Date.now())).toBe(false);

    const b = new Browser(w, testEnv());
    await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
    const html = await (await b.get("/accounts")).text();
    const block = html.split('data-account="registration"')[1] ?? "";
    const csrf = csrfFrom(block);
    const res = await b.post("/accounts", { op: "open_registration", account: "registration", csrf });
    expect(res.status).toBe(303);
    expect(await isRegistrationOpen(env.DB, Date.now())).toBe(true);
  });
});

describe("a client id metadata document is not a second way in", () => {
  // CIMD lets a client identify by URL with no registration at all, so leaving it on defeats the
  // registration window entirely: anyone who can host one HTTPS JSON file gets a usable client_id.
  // MCP's 2026 security guidance reserves "accept any HTTPS client_id" for open servers; this
  // deployment has one owner. Refusing before the fetch also removes the server-side request the
  // same guidance flags against authorization servers.
  it("does not advertise CIMD support", async () => {
    const meta = await (
      await new Browser(worker, testEnv()).get("/.well-known/oauth-authorization-server")
    ).json<{ client_id_metadata_document_supported?: boolean }>();
    expect(meta.client_id_metadata_document_supported ?? false).toBe(false);
  });

  it("refuses a URL client_id without fetching it", async () => {
    const res = await new Browser(worker, testEnv()).get(
      "/authorize?client_id=" +
        encodeURIComponent("https://evil.test/client.json") +
        "&redirect_uri=" +
        encodeURIComponent("https://evil.test/cb") +
        "&response_type=code&scope=mcp&state=x",
    );
    const html = await res.text();
    expect(res.status).toBe(400);
    expect(html).not.toContain("metadata document");
  });
});
