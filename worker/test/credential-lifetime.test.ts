import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { createWorker } from "../src/index";
import { Browser } from "./browser";
import { testEnv } from "./test-env";
import { closeRegistration, openRegistration } from "./../src/auth/registration";

const worker = createWorker();

beforeEach(async () => {
  await closeRegistration(env.DB);
});

/**
 * Registration is closed by design, so every credential lifetime the library defaults to becomes a
 * wall the owner has to walk to the console to unlock. The library's defaults are 1 hour, 30 days and
 * 90 days: the client record is the shortest-lived thing that matters, and once it lapses the client
 * has no way back in except dynamic registration, which is exactly what is closed. The lifetimes are
 * therefore a deliberate decision here, not something left to the dependency.
 */
describe("credential lifetimes keep a lapsed client recoverable without a registration window", () => {
  const options = () => worker.oauthOptions(testEnv());

  it("states all three lifetimes rather than inheriting the library defaults", () => {
    const o = options();
    expect(typeof o.accessTokenTTL).toBe("number");
    expect(typeof o.refreshTokenTTL).toBe("number");
    expect(typeof o.clientRegistrationTTL).toBe("number");
  });

  // The ordering is the invariant. A client record that outlives its grant means an expired grant
  // costs one consent click; a client record that dies first costs a trip to /accounts to open a
  // ten-minute window, which is the failure the owner actually hit.
  it("keeps the client record alive longer than the grant it belongs to", () => {
    const o = options();
    expect(o.clientRegistrationTTL!).toBeGreaterThan(o.refreshTokenTTL!);
    expect(o.refreshTokenTTL!).toBeGreaterThan(o.accessTokenTTL!);
  });

  // 30 days was the default and is the regression to guard: it put a re-authorization in the owner's
  // path roughly monthly, against a registration endpoint that is shut.
  it("does not leave the grant on the library's 30-day default", () => {
    expect(options().refreshTokenTTL!).toBeGreaterThan(90 * 86_400);
  });

  it("registers a client whose lifetime the store accepts, and still resolves it afterwards", async () => {
    await openRegistration(env.DB, Date.now());
    const res = await new Browser(worker, testEnv()).fetch("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "lifetime probe",
        redirect_uris: ["https://client.test/cb"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    expect(res.status).toBe(201);
    const { client_id } = await res.json<{ client_id: string }>();

    // Resolving through /authorize proves the record was written and read back under the configured
    // lifetime. An unknown client renders that phrase, so its absence is the assertion.
    const html = await (
      await new Browser(worker, testEnv()).get(
        `/authorize?client_id=${encodeURIComponent(client_id)}&redirect_uri=${encodeURIComponent(
          "https://client.test/cb",
        )}&response_type=code&scope=mcp&state=x&code_challenge=${"a".repeat(43)}&code_challenge_method=S256`,
      )
    ).text();
    expect(html).not.toContain("Unknown client");
  });
});
