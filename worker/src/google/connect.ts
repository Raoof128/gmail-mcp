import { GmailMcpError } from "@gmail-mcp/shared/errors";
import { AccountAlias } from "@gmail-mcp/shared/schemas";
import type { Env } from "../env";
import { auditIntent, auditOutcome } from "../audit/log";
import { signToken, verifyToken } from "../crypto/hmac";
import { Keyring } from "../crypto/keyring";
import { randomId } from "../crypto/random";
import { escapeHtml, htmlResponse, redirect } from "../web/html";
import { OIDC_TTL_MS, type OidcState } from "../web/login";
import { type Route, requireSession } from "../web/router";
import { consumeState, putState } from "../web/state";
import { CONNECT_SCOPES, buildAuthUrl, exchangeCode, fetchSendAs, revokeToken, verifyIdToken } from "./oidc";

const E_PURPOSE = "gmail-mcp:connect:v1";
const E_TTL_MS = 15 * 60_000;

export function connectRedirectUri(env: Env): string {
  return `https://${env.WORKER_HOSTNAME}/connect/callback`;
}

/** Ties a connect link handed to the model to the owner and alias it was minted for. */
export function connectElicitationId(env: Env, userId: string, alias: string): Promise<string> {
  return signToken(env.STATE_HMAC_KEY, E_PURPOSE, [userId, alias], Date.now() + E_TTL_MS);
}

export async function connectUrl(env: Env, userId: string, alias: string): Promise<string> {
  const e = await connectElicitationId(env, userId, alias);
  return `https://${env.WORKER_HOSTNAME}/connect?alias=${encodeURIComponent(alias)}&e=${e}`;
}

export async function upsertAccount(
  env: Env,
  o: {
    userId: string;
    alias: string;
    googleSub: string;
    email: string;
    sendAs: string[];
    scopes: string;
    refreshToken: string;
    accessToken: string;
    accessExpiresAt: number;
  },
): Promise<{ id: string; created: boolean }> {
  const ring = Keyring.fromEnv(env);
  const now = Date.now();
  // Reconnect path. credential_version moves so a refresh that read the old tokens cannot write back.
  const existing = await env.DB.prepare("SELECT id FROM accounts WHERE user_id = ? AND google_sub = ?")
    .bind(o.userId, o.googleSub)
    .first<{ id: string }>();
  if (existing) {
    const rt = await ring.encrypt(o.refreshToken, { userId: o.userId, accountId: existing.id, field: "refresh_token" });
    const at = await ring.encrypt(o.accessToken, { userId: o.userId, accountId: existing.id, field: "access_token" });
    await env.DB.prepare(
      `UPDATE accounts SET google_email = ?, send_as = ?, scopes = ?, status = 'active', credential_version = credential_version + 1,
         refresh_token_enc = ?, refresh_token_key_id = ?, access_token_enc = ?, access_token_key_id = ?, access_expires_at = ?, last_refresh_at = ?
       WHERE id = ? AND user_id = ?`,
    )
      .bind(
        o.email,
        JSON.stringify(o.sendAs),
        o.scopes,
        rt.ciphertext,
        rt.keyId,
        at.ciphertext,
        at.keyId,
        o.accessExpiresAt,
        now,
        existing.id,
        o.userId,
      )
      .run();
    return { id: existing.id, created: false };
  }
  // New account. The id is part of the AAD, so it is chosen before anything is encrypted. The default
  // flag is decided inside the INSERT: two first connections both evaluate the subquery, and the
  // partial unique index on (user_id) WHERE is_default = 1 makes the second one lose rather than tie.
  const id = randomId("acc");
  const rt = await ring.encrypt(o.refreshToken, { userId: o.userId, accountId: id, field: "refresh_token" });
  const at = await ring.encrypt(o.accessToken, { userId: o.userId, accountId: id, field: "access_token" });
  try {
    await env.DB.prepare(
      `INSERT INTO accounts (id, user_id, alias, google_sub, google_email, send_as, scopes, status, is_default,
         refresh_token_enc, refresh_token_key_id, access_token_enc, access_token_key_id, access_expires_at, created_at, last_refresh_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active',
         (SELECT CASE WHEN EXISTS (SELECT 1 FROM accounts WHERE user_id = ? AND is_default = 1) THEN 0 ELSE 1 END),
         ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        o.userId,
        o.alias,
        o.googleSub,
        o.email,
        JSON.stringify(o.sendAs),
        o.scopes,
        o.userId,
        rt.ciphertext,
        rt.keyId,
        at.ciphertext,
        at.keyId,
        o.accessExpiresAt,
        now,
        now,
      )
      .run();
    return { id, created: true };
  } catch (e) {
    const msg = String((e as Error).message);
    if (/accounts\.user_id, accounts\.alias/.test(msg))
      throw new GmailMcpError("invalid_address", `alias in use: ${o.alias}`);
    // Lost a race with a concurrent connect of the same Google account or the same default slot:
    // the row now exists, so this becomes a reconnect; a lost default slot becomes a non-default insert.
    if (/accounts\.user_id, accounts\.google_sub/.test(msg)) return upsertAccount(env, o);
    if (/accounts_one_default/.test(msg)) {
      await env.DB.prepare(
        `INSERT INTO accounts (id, user_id, alias, google_sub, google_email, send_as, scopes, status, is_default,
           refresh_token_enc, refresh_token_key_id, access_token_enc, access_token_key_id, access_expires_at, created_at, last_refresh_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          o.userId,
          o.alias,
          o.googleSub,
          o.email,
          JSON.stringify(o.sendAs),
          o.scopes,
          rt.ciphertext,
          rt.keyId,
          at.ciphertext,
          at.keyId,
          o.accessExpiresAt,
          now,
          now,
        )
        .run();
      return { id, created: true };
    }
    throw e;
  }
}

export const connectRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/connect$/,
    handler: async ({ env, request, url }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const alias = AccountAlias.safeParse(url.searchParams.get("alias"));
      if (!alias.success)
        return htmlResponse("Bad alias", "<p>An alias is 1 to 32 characters of a-z, 0-9, _ or -.</p>", null, 400);
      const e = url.searchParams.get("e");
      if (e !== null && !(await verifyToken(env.STATE_HMAC_KEY, E_PURPOSE, [s.userId, alias.data], e))) {
        return htmlResponse(
          "Refused",
          "<p>This connect link was made for a different owner or has expired.</p>",
          null,
          403,
        );
      }
      const state = randomId("st");
      const nonce = randomId("nc");
      const rec: OidcState = {
        nonce,
        returnTo: "/accounts",
        alias: alias.data,
        userId: s.userId,
        sessionIdHash: s.idHash,
      };
      await putState(env.DB, "connect", state, rec, OIDC_TTL_MS);
      const target = buildAuthUrl(env, {
        redirectUri: connectRedirectUri(env),
        scope: CONNECT_SCOPES,
        state,
        nonce,
        offline: true,
      });
      return new Response(null, { status: 303, headers: { location: target, "cache-control": "no-store" } });
    },
  },
  {
    method: "GET",
    pattern: /^\/connect\/callback$/,
    handler: async ({ env, deps, request, url }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const st = await consumeState<OidcState>(env.DB, "connect", url.searchParams.get("state"));
      if (!st) return htmlResponse("Connect failed", "<p>State missing or already used.</p>", null, 400);
      if (st.sessionIdHash !== s.idHash || st.userId !== s.userId) {
        return htmlResponse(
          "Refused",
          "<p>This connection was started from a different browser session.</p>",
          null,
          403,
        );
      }
      if (url.searchParams.get("error"))
        return htmlResponse(
          "Connect failed",
          `<p>Google refused: ${escapeHtml(url.searchParams.get("error")!)}</p>`,
          null,
          400,
        );
      const code = url.searchParams.get("code");
      if (!code) return htmlResponse("Connect failed", "<p>No code.</p>", null, 400);
      const tokens = await exchangeCode(env, deps, { code, redirectUri: connectRedirectUri(env) });
      if (!tokens.refresh_token) {
        return htmlResponse(
          "No refresh token",
          `<p>Google did not return a refresh token, so this account cannot be kept connected. Remove gmail-mcp under
<a href="https://myaccount.google.com/permissions">Google account permissions</a> and connect again.</p>`,
          null,
          400,
        );
      }
      // From here on a refresh token exists at Google. Any failure before it is stored revokes it, so a
      // failed connect leaves no live grant behind.
      const fail = async (title: string, body: string, status: number): Promise<Response> => {
        await revokeToken(deps, tokens.refresh_token!);
        return htmlResponse(title, body, null, status);
      };
      try {
        const id = await verifyIdToken(env, deps, tokens.id_token, { nonce: st.nonce });
        if (!tokens.scope.split(" ").includes("https://www.googleapis.com/auth/gmail.modify")) {
          return fail(
            "Scope refused",
            "<p>Google did not grant gmail.modify, so this account cannot be used. Connect again and accept the Gmail permission.</p>",
            400,
          );
        }
        const sendAs = await fetchSendAs(deps, tokens.access_token);
        await auditIntent(env.DB, {
          userId: s.userId,
          accountId: null,
          tool: "connect_page",
          action: "account.connect",
          modifiers: [],
          decision: "browser",
          facts: {},
        });
        let result: { id: string; created: boolean };
        try {
          result = await upsertAccount(env, {
            userId: s.userId,
            alias: st.alias!,
            googleSub: id.sub,
            email: id.email,
            sendAs,
            scopes: tokens.scope,
            refreshToken: tokens.refresh_token,
            accessToken: tokens.access_token,
            accessExpiresAt: Date.now() + tokens.expires_in * 1000 - 60_000,
          });
        } catch (e) {
          if (e instanceof GmailMcpError && e.message.startsWith("alias in use")) {
            return fail(
              "Alias in use",
              `<p>The alias <code>${escapeHtml(st.alias!)}</code> already names a different Google account. Pick another.</p>`,
              409,
            );
          }
          throw e;
        }
        await auditOutcome(env.DB, {
          userId: s.userId,
          accountId: result.id,
          tool: "connect_page",
          action: "account.connect",
          modifiers: [],
          decision: "connected",
          facts: { ids: [result.id] },
        });
        return redirect("/accounts");
      } catch (e) {
        await revokeToken(deps, tokens.refresh_token);
        throw e;
      }
    },
  },
];
