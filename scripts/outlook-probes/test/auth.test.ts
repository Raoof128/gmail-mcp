import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authorizeUrl,
  checkAuthority,
  idTokenShape,
  pkcePair,
  refresh,
  TokenRequestFailed,
  type AuthConfig,
} from "../auth.ts";
import { CONSUMER_TID } from "../redact.ts";
import { fakeFetch, on } from "./fake.ts";

const cfg: AuthConfig = { authority: "consumers", clientId: "client-123", port: 8400 };

describe("authority", () => {
  it("accepts consumers and tenant ids only", () => {
    expect(checkAuthority("consumers")).toBe("consumers");
    expect(checkAuthority("72f988bf-86f1-41af-91ab-2d7cd011db47")).toBe("72f988bf-86f1-41af-91ab-2d7cd011db47");
    for (const bad of ["common", "organizations", "evil.example/x", ""]) expect(() => checkAuthority(bad)).toThrow();
  });
});

describe("PKCE and the authorize URL", () => {
  it("derives the S256 challenge from the verifier", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("asks for the spec's scopes against a loopback redirect", () => {
    const u = new URL(authorizeUrl(cfg, "chal", "st", "no"));
    expect(u.origin + u.pathname).toBe("https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8400/callback");
    expect(u.searchParams.get("scope")?.split(" ")).toEqual(
      expect.arrayContaining(["profile", "offline_access", "Mail.ReadWrite", "Mail.Send", "MailboxSettings.ReadWrite"]),
    );
  });
});

describe("token endpoint", () => {
  it("returns the rotated refresh token", async () => {
    const { fetch, seen } = fakeFetch([
      on("POST", "/consumers/oauth2/v2.0/token", {
        status: 200,
        body: { access_token: "a2", refresh_token: "r2", expires_in: 3600, scope: "Mail.ReadWrite" },
      }),
    ]);
    const t = await refresh(cfg, "r1", fetch);
    expect(t.refreshToken).toBe("r2");
    expect(seen[0]?.body).toContain("grant_type=refresh_token");
    expect(seen[0]?.body).not.toContain("client_secret");
  });

  it("surfaces the OAuth error and the AADSTS codes P6 needs", async () => {
    const { fetch } = fakeFetch([
      on("POST", "/consumers/oauth2/v2.0/token", {
        status: 400,
        body: { error: "invalid_grant", error_codes: [700082], error_description: "AADSTS700082 ..." },
      }),
    ]);
    const err = await refresh(cfg, "r1", fetch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenRequestFailed);
    expect((err as TokenRequestFailed).detail).toEqual({ status: 400, error: "invalid_grant", errorCodes: [700082] });
  });
});

describe("idTokenShape", () => {
  const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

  it("describes the claims without returning their values", () => {
    const shape = idTokenShape(
      jwt({
        tid: CONSUMER_TID,
        iss: `https://login.microsoftonline.com/${CONSUMER_TID}/v2.0`,
        oid: "00000000-0000-0000-0000-0000000000aa",
        preferred_username: "owner@outlook.com",
        nonce: "n",
      }),
    );
    expect(shape).toEqual({
      present: true,
      parsed: true,
      tidKind: "consumer",
      issMatchesTid: true,
      hasOid: true,
      hasEmail: false,
      hasPreferredUsername: true,
      hasNonce: true,
    });
    expect(JSON.stringify(shape)).not.toContain("owner@outlook.com");
  });

  it("flags an issuer that does not match the tenant", () => {
    const shape = idTokenShape(
      jwt({ tid: "72f988bf-86f1-41af-91ab-2d7cd011db47", iss: "https://login.microsoftonline.com/other/v2.0" }),
    );
    expect(shape.tidKind).toBe("tenant");
    expect(shape.issMatchesTid).toBe(false);
  });
});
