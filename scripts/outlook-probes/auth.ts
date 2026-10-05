import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

export const LOGIN_ORIGIN = "https://login.microsoftonline.com";

/** The scopes spec v2 section 5.2 requests, so the probes see exactly what the Worker will. */
export const PROBE_SCOPES = [
  "openid",
  "profile",
  "offline_access",
  "User.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "MailboxSettings.ReadWrite",
];

export interface AuthConfig {
  /** `consumers` for the personal registration, or the tenant id for the single-tenant one. */
  authority: string;
  clientId: string;
  port: number;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn: number;
  scope: string;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function checkAuthority(authority: string): string {
  if (authority === "consumers" || GUID.test(authority)) return authority;
  throw new Error("authority must be `consumers` or a tenant id");
}

export function redirectUri(port: number): string {
  return `http://127.0.0.1:${port}/callback`;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function authorizeUrl(cfg: AuthConfig, challenge: string, state: string, nonce: string): string {
  const u = new URL(`${LOGIN_ORIGIN}/${checkAuthority(cfg.authority)}/oauth2/v2.0/authorize`);
  u.search = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: redirectUri(cfg.port),
    response_mode: "query",
    scope: PROBE_SCOPES.join(" "),
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return u.toString();
}

export function tokenUrl(authority: string): string {
  return `${LOGIN_ORIGIN}/${checkAuthority(authority)}/oauth2/v2.0/token`;
}

export interface TokenError {
  status: number;
  error: string;
  /** AADSTS codes, which P6 needs to map against the OAuth `error` value. */
  errorCodes: number[];
}

export class TokenRequestFailed extends Error {
  constructor(readonly detail: TokenError) {
    super(`token endpoint returned ${detail.status} ${detail.error}`);
    this.name = "TokenRequestFailed";
  }
}

async function tokenPost(cfg: AuthConfig, form: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenSet> {
  const res = await fetchImpl(tokenUrl(cfg.authority), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, ...form }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const codes = Array.isArray(body.error_codes) ? body.error_codes.filter((c) => typeof c === "number") : [];
    throw new TokenRequestFailed({
      status: res.status,
      error: typeof body.error === "string" ? body.error : "unknown",
      errorCodes: codes,
    });
  }
  if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
    throw new Error("token endpoint returned an unexpected body");
  }
  const out: TokenSet = {
    accessToken: body.access_token,
    expiresIn: body.expires_in,
    scope: typeof body.scope === "string" ? body.scope : "",
  };
  if (typeof body.refresh_token === "string") out.refreshToken = body.refresh_token;
  if (typeof body.id_token === "string") out.idToken = body.id_token;
  return out;
}

export function redeem(cfg: AuthConfig, code: string, verifier: string, fetchImpl: typeof fetch = fetch) {
  return tokenPost(
    cfg,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(cfg.port),
      code_verifier: verifier,
      scope: PROBE_SCOPES.join(" "),
    },
    fetchImpl,
  );
}

export function refresh(cfg: AuthConfig, refreshToken: string, fetchImpl: typeof fetch = fetch) {
  return tokenPost(
    cfg,
    { grant_type: "refresh_token", refresh_token: refreshToken, scope: PROBE_SCOPES.join(" ") },
    fetchImpl,
  );
}

/** Claims names and shapes only. The values identify the person, so none is returned. */
export function idTokenShape(idToken: string | undefined): Record<string, string | boolean> {
  if (idToken == null) return { present: false };
  const payload = idToken.split(".")[1];
  if (payload == null) return { present: true, parsed: false };
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  const tid = typeof claims.tid === "string" ? claims.tid : "";
  const iss = typeof claims.iss === "string" ? claims.iss : "";
  return {
    present: true,
    parsed: true,
    tidKind: tid === "9188040d-6c67-4c5b-b112-36a304b66dad" ? "consumer" : GUID.test(tid) ? "tenant" : "missing",
    issMatchesTid: iss === `${LOGIN_ORIGIN}/${tid}/v2.0`,
    hasOid: typeof claims.oid === "string",
    hasEmail: typeof claims.email === "string",
    hasPreferredUsername: typeof claims.preferred_username === "string",
    hasNonce: typeof claims.nonce === "string",
  };
}

/**
 * Runs the authorization code flow with PKCE against a loopback redirect. The owner opens the printed
 * URL; the code comes back to 127.0.0.1 and is redeemed at once. Nothing is written to disk.
 */
export async function interactiveLogin(
  cfg: AuthConfig,
  print: (line: string) => void,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 300_000,
): Promise<TokenSet> {
  const { verifier, challenge } = pkcePair();
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(24));
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", redirectUri(cfg.port));
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const done = (status: number, text: string) => {
        res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(text);
        clearTimeout(timer);
        server.close();
      };
      if (u.searchParams.get("state") !== state) {
        done(400, "State mismatch. Close this tab and start again.");
        reject(new Error("state mismatch on the loopback callback"));
        return;
      }
      const err = u.searchParams.get("error");
      const c = u.searchParams.get("code");
      if (err != null || c == null) {
        done(400, "Sign-in failed. The terminal has the error code.");
        reject(new Error(`authorize returned ${err ?? "no code"}`));
        return;
      }
      done(200, "Signed in. You can close this tab and return to the terminal.");
      resolve(c);
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("timed out waiting for sign-in"));
    }, timeoutMs);
    server.on("error", reject);
    server.listen(cfg.port, "127.0.0.1", () => {
      print(
        `Open this URL in a browser and sign in with the probe account:\n${authorizeUrl(cfg, challenge, state, nonce)}\n`,
      );
    });
  });
  return redeem(cfg, code, verifier, fetchImpl);
}
