import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { z } from "zod";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Deps } from "../deps";
import type { Env } from "../env";

export const GOOGLE = {
  issuer: "https://accounts.google.com",
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
  sendAsUrl: "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs",
} as const;

export const LOGIN_SCOPES = "openid email profile";
/** gmail.modify cannot permanently delete. mail.google.com can, and is never requested. */
export const CONNECT_SCOPES = "https://www.googleapis.com/auth/gmail.modify openid email";

export function buildAuthUrl(
  env: Env,
  o: { redirectUri: string; scope: string; state: string; nonce: string; offline: boolean; loginHint?: string },
): string {
  const u = new URL(GOOGLE.authUrl);
  u.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", o.scope);
  u.searchParams.set("state", o.state);
  u.searchParams.set("nonce", o.nonce);
  if (o.offline) {
    u.searchParams.set("access_type", "offline");
    // Google returns a refresh token only on a consent screen; a silent re-auth would leave us
    // with an account row that cannot refresh.
    u.searchParams.set("prompt", "consent");
  }
  if (o.loginHint) u.searchParams.set("login_hint", o.loginHint);
  return u.toString();
}

/** What Google's token endpoint must return before anything is stored. A 200 with a wrong shape is a failure. */
const TokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine((t) => t.toLowerCase() === "bearer"),
  expires_in: z.number().int().min(1).max(86_400),
  id_token: z.string().min(1),
  scope: z.string(),
  refresh_token: z.string().min(1).optional(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;
const RefreshResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().min(1).max(86_400),
});

async function tokenPost(env: Env, deps: Deps, form: Record<string, string>): Promise<Response> {
  return deps.googleFetch(GOOGLE.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...form }),
  });
}

export async function exchangeCode(
  env: Env,
  deps: Deps,
  o: { code: string; redirectUri: string },
): Promise<TokenResponse> {
  const res = await tokenPost(env, deps, {
    grant_type: "authorization_code",
    code: o.code,
    redirect_uri: o.redirectUri,
  });
  if (!res.ok) throw new GmailMcpError("internal", `google token endpoint ${res.status}`);
  const parsed = TokenResponse.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new GmailMcpError("internal", "google token endpoint returned an unexpected body");
  return parsed.data;
}

export async function refreshAccessToken(
  env: Env,
  deps: Deps,
  refreshToken: string,
): Promise<{ access_token: string; expires_in: number } | "invalid_grant"> {
  const res = await tokenPost(env, deps, { grant_type: "refresh_token", refresh_token: refreshToken });
  if (res.ok) {
    const parsed = RefreshResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new GmailMcpError("internal", "google refresh returned an unexpected body");
    return parsed.data;
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 400 && body.error === "invalid_grant") return "invalid_grant";
  throw new GmailMcpError("internal", `google refresh ${res.status}`);
}

async function jwks(deps: Deps): Promise<ReturnType<typeof createLocalJWKSet>> {
  // Fetched per verification rather than cached in the isolate: logins are rare, and a stale cache
  // across a key rotation is a worse failure than one extra request.
  const res = await deps.googleFetch(GOOGLE.jwksUrl);
  if (!res.ok) throw new GmailMcpError("internal", `google jwks ${res.status}`);
  return createLocalJWKSet(await res.json<JSONWebKeySet>());
}

export async function verifyIdToken(
  env: Env,
  deps: Deps,
  idToken: string,
  o: { nonce: string },
): Promise<{ sub: string; email: string }> {
  try {
    const { payload } = await jwtVerify(idToken, await jwks(deps), {
      issuer: [GOOGLE.issuer, "accounts.google.com"],
      audience: env.GOOGLE_CLIENT_ID,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "email", "iat", "exp", "nonce"],
      // iat is checked, not just required: a token older than the login flow itself is replayed.
      maxTokenAge: "10 minutes",
      clockTolerance: 60,
    });
    if (payload.nonce !== o.nonce) throw new Error("nonce");
    if (payload.email_verified !== true) throw new Error("email_verified");
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") throw new Error("claims");
    return { sub: payload.sub, email: payload.email.toLowerCase() };
  } catch (e) {
    throw new GmailMcpError("unauthorized", `id_token rejected: ${(e as Error).message}`);
  }
}

export async function fetchSendAs(deps: Deps, accessToken: string): Promise<string[]> {
  const res = await deps.googleFetch(GOOGLE.sendAsUrl, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new GmailMcpError("internal", `sendAs ${res.status}`);
  const body = await res.json<{ sendAs?: { sendAsEmail: string; verificationStatus?: string }[] }>();
  return (body.sendAs ?? [])
    .filter((s) => s.verificationStatus === "accepted" || s.verificationStatus === undefined)
    .map((s) => s.sendAsEmail.toLowerCase());
}

/** Best effort. The local wipe that follows is what actually removes our access. */
export async function revokeToken(deps: Deps, token: string): Promise<void> {
  await deps
    .googleFetch(GOOGLE.revokeUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    })
    .catch(() => undefined);
}
