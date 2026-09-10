import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";
import { FakeGmail } from "./fake-gmail";

type CodeRecord = { sub: string; email: string; nonce: string; refresh: string; scope: string };

/** FormData.get() is string | File; every field this fake reads is a string or absent. */
const field = (f: FormData, k: string): string => {
  const v = f.get(k);
  return typeof v === "string" ? v : "";
};

/**
 * A Google that lives in memory: real RS256 keys, a real JWKS document, and a token endpoint that
 * hands out id_tokens signed with them. Every Worker path that talks to Google runs against this
 * through Deps.googleFetch, so the tests exercise the actual verification code.
 */
export class FakeGoogle {
  private priv!: CryptoKey;
  private jwks!: { keys: unknown[] };
  readonly codes = new Map<string, CodeRecord>();
  readonly refreshTokens = new Map<string, "ok" | "invalid_grant">();
  readonly revoked = new Set<string>();
  sendAs: string[] = ["owner@example.test", "alias@example.test"];
  readonly gmail = new FakeGmail();
  tokenCalls = 0;
  accessCounter = 0;
  /** When set, the next authorization_code exchange answers 200 with a body missing access_token. */
  malformedNext = false;

  static async create(): Promise<FakeGoogle> {
    const g = new FakeGoogle();
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    g.priv = privateKey;
    const jwk = await exportJWK(publicKey);
    g.jwks = { keys: [{ ...jwk, kid: "k-test", alg: "RS256", use: "sig" }] };
    return g;
  }

  issue(o: {
    sub: string;
    email: string;
    nonce: string;
    aud?: string;
    iss?: string;
    expSeconds?: number;
    iatOffsetSeconds?: number;
    emailVerified?: boolean;
  }): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ email: o.email, email_verified: o.emailVerified ?? true, nonce: o.nonce })
      .setProtectedHeader({ alg: "RS256", kid: "k-test" })
      .setIssuer(o.iss ?? "https://accounts.google.com")
      .setAudience(o.aud ?? "gid.apps.googleusercontent.com")
      .setSubject(o.sub)
      .setIssuedAt(now + (o.iatOffsetSeconds ?? 0))
      .setExpirationTime(now + (o.expSeconds ?? 300))
      .sign(this.priv);
  }

  /** Test hook: runs before a refresh_token grant is answered, so a test can interleave a revoke. */
  beforeRefresh: (() => Promise<void>) | null = null;

  grantCode(o: { sub: string; email: string; nonce: string; scope?: string }): string {
    const code = `code-${this.codes.size + 1}-${o.sub}`;
    const refresh = `rt-${code}`;
    this.refreshTokens.set(refresh, "ok");
    this.codes.set(code, { ...o, refresh, scope: o.scope ?? "openid email" });
    return code;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.href === "https://www.googleapis.com/oauth2/v3/certs") return Response.json(this.jwks);
    if (url.href === "https://oauth2.googleapis.com/token") {
      this.tokenCalls++;
      // formData(), not text(): workerd warns that .text() on a urlencoded body may corrupt it.
      const form = await req.formData();
      if (field(form, "grant_type") === "authorization_code") {
        const rec = this.codes.get(field(form, "code"));
        if (!rec) return Response.json({ error: "invalid_grant" }, { status: 400 });
        this.codes.delete(field(form, "code")); // Google codes are single use
        if (this.malformedNext) {
          this.malformedNext = false;
          return Response.json({ token_type: "Bearer", expires_in: 3599 });
        }
        return Response.json({
          access_token: `at-${++this.accessCounter}`,
          // Google omits the field entirely when it issues no refresh token; it never sends "".
          ...(rec.refresh ? { refresh_token: rec.refresh } : {}),
          expires_in: 3599,
          scope: rec.scope,
          token_type: "Bearer",
          id_token: await this.issue({ sub: rec.sub, email: rec.email, nonce: rec.nonce }),
        });
      }
      if (field(form, "grant_type") === "refresh_token") {
        if (this.beforeRefresh) await this.beforeRefresh();
        const state = this.refreshTokens.get(field(form, "refresh_token"));
        if (state !== "ok") return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({ access_token: `at-${++this.accessCounter}`, expires_in: 3599, token_type: "Bearer" });
      }
      return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    }
    if (url.href === "https://oauth2.googleapis.com/revoke") {
      this.revoked.add(field(await req.formData(), "token"));
      return new Response(null, { status: 200 });
    }
    if (url.hostname === "gmail.googleapis.com") {
      if (url.href === "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs") {
        if (!req.headers.get("authorization")?.startsWith("Bearer at-")) return new Response("", { status: 401 });
        return Response.json({
          sendAs: [
            ...this.sendAs.map((e) => ({ sendAsEmail: e, verificationStatus: "accepted" })),
            { sendAsEmail: "pending@example.test", verificationStatus: "pending" },
          ],
        });
      }
      return this.gmail.fetch(req);
    }
    return new Response("fake google: unknown url " + url.href, { status: 404 });
  };
}
