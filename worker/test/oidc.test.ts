import { describe, it, expect, beforeAll } from "vitest";
import { FakeGoogle } from "./fake-google";
import { testEnv, testDeps } from "./test-env";
import {
  CONNECT_SCOPES,
  LOGIN_SCOPES,
  buildAuthUrl,
  exchangeCode,
  fetchSendAs,
  refreshAccessToken,
  revokeToken,
  verifyIdToken,
} from "../src/google/oidc";

const env = testEnv();
let g: FakeGoogle;
beforeAll(async () => {
  g = await FakeGoogle.create();
});
const deps = () => testDeps(g);

describe("oidc client", () => {
  it("builds the login and connect URLs with the right parameters", () => {
    const login = new URL(
      buildAuthUrl(env, {
        redirectUri: "https://h/oidc/callback",
        scope: LOGIN_SCOPES,
        state: "s",
        nonce: "n",
        offline: false,
      }),
    );
    expect(login.origin + login.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(login.searchParams.get("client_id")).toBe(env.GOOGLE_CLIENT_ID);
    expect(login.searchParams.get("response_type")).toBe("code");
    expect(login.searchParams.get("scope")).toBe("openid email profile");
    expect(login.searchParams.get("access_type")).toBeNull();
    const connect = new URL(
      buildAuthUrl(env, {
        redirectUri: "https://h/connect/callback",
        scope: CONNECT_SCOPES,
        state: "s",
        nonce: "n",
        offline: true,
      }),
    );
    expect(connect.searchParams.get("access_type")).toBe("offline");
    expect(connect.searchParams.get("prompt")).toBe("consent");
    expect(connect.searchParams.get("scope")).not.toContain("mail.google.com");
    expect(connect.searchParams.get("scope")).toContain("gmail.modify");
  });

  it("verifies a good id_token and rejects each bad claim", async () => {
    const ok = await g.issue({ sub: "s1", email: "a@x.test", nonce: "n1" });
    expect(await verifyIdToken(env, deps(), ok, { nonce: "n1" })).toEqual({ sub: "s1", email: "a@x.test" });
    const alt = await g.issue({ sub: "s1", email: "a@x.test", nonce: "n1", iss: "accounts.google.com" });
    expect((await verifyIdToken(env, deps(), alt, { nonce: "n1" })).sub).toBe("s1");
    const cases = [
      ["wrong nonce", ok, "n2"],
      ["wrong issuer", await g.issue({ sub: "s1", email: "a@x.test", nonce: "n1", iss: "https://evil.test" }), "n1"],
      ["wrong audience", await g.issue({ sub: "s1", email: "a@x.test", nonce: "n1", aud: "other" }), "n1"],
      ["expired", await g.issue({ sub: "s1", email: "a@x.test", nonce: "n1", expSeconds: -120 }), "n1"],
      [
        "stale iat",
        await g.issue({ sub: "s1", email: "a@x.test", nonce: "n1", iatOffsetSeconds: -900, expSeconds: 300 }),
        "n1",
      ],
      ["future iat", await g.issue({ sub: "s1", email: "a@x.test", nonce: "n1", iatOffsetSeconds: 300 }), "n1"],
      ["unverified email", await g.issue({ sub: "s1", email: "a@x.test", nonce: "n1", emailVerified: false }), "n1"],
      ["garbage", "a.b.c", "n1"],
    ] as const;
    for (const [name, tok, nonce] of cases) {
      await expect(verifyIdToken(env, deps(), tok, { nonce }), name).rejects.toMatchObject({ code: "unauthorized" });
    }
  });

  it("exchanges a code once, refreshes, detects invalid_grant, lists verified send-as, revokes", async () => {
    const code = g.grantCode({ sub: "s1", email: "a@x.test", nonce: "n1" });
    const t = await exchangeCode(env, deps(), { code, redirectUri: "https://h/cb" });
    expect(t.refresh_token).toMatch(/^rt-/);
    g.malformedNext = true;
    const bad = g.grantCode({ sub: "s1", email: "a@x.test", nonce: "n1" });
    await expect(exchangeCode(env, deps(), { code: bad, redirectUri: "https://h/cb" })).rejects.toMatchObject({
      code: "internal",
    });
    await expect(exchangeCode(env, deps(), { code, redirectUri: "https://h/cb" })).rejects.toMatchObject({
      code: "internal",
    });
    expect(await refreshAccessToken(env, deps(), t.refresh_token!)).toMatchObject({ expires_in: 3599 });
    g.refreshTokens.set(t.refresh_token!, "invalid_grant");
    expect(await refreshAccessToken(env, deps(), t.refresh_token!)).toBe("invalid_grant");
    expect(await fetchSendAs(deps(), t.access_token)).toEqual(["owner@example.test", "alias@example.test"]);
    await revokeToken(deps(), t.refresh_token!);
    expect(g.revoked.has(t.refresh_token!)).toBe(true);
  });
});
