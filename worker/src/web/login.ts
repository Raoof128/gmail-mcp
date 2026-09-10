import type { Env } from "../env";
import { ownerEmails, ownerSubs } from "../env";
import { randomId } from "../crypto/random";
import { LOGIN_SCOPES, buildAuthUrl, exchangeCode, verifyIdToken } from "../google/oidc";
import { escapeHtml, htmlResponse, isInternalPath, redirect } from "./html";
import { type Ctx, type Route, guardPost, page, readForm, requireSession, returnPath } from "./router";
import { clearCookie, createSession, markReauthenticated, readSession, revokeSession } from "./session";
import { consumeState, putState } from "./state";
import { clearApprovedCookie } from "../auth/approved";

export const OIDC_TTL_MS = 600_000;
export type OidcState = {
  nonce: string;
  returnTo: string;
  sessionIdHash?: string;
  userId?: string;
  alias?: string;
};

export function loginRedirectUri(env: Env): string {
  return `https://${env.WORKER_HOSTNAME}/oidc/callback`;
}

export async function startLogin(
  env: Env,
  o: { returnTo: string; purpose: "login" | "reauth"; sessionIdHash?: string },
): Promise<Response> {
  const state = randomId("st");
  const nonce = randomId("nc");
  const rec: OidcState = { nonce, returnTo: o.returnTo };
  if (o.sessionIdHash) rec.sessionIdHash = o.sessionIdHash;
  await putState(env.DB, o.purpose, state, rec, OIDC_TTL_MS);
  const url = buildAuthUrl(env, {
    redirectUri: loginRedirectUri(env),
    scope: LOGIN_SCOPES,
    state,
    nonce,
    offline: false,
  });
  // Not redirect(): this one leaves the origin on purpose, to Google, from a URL we built ourselves.
  return new Response(null, { status: 303, headers: { location: url, "cache-control": "no-store" } });
}

async function oidcCallback(ctx: Ctx): Promise<Response> {
  const { env, deps, url, request } = ctx;
  // The kind is part of the consume, so a connect state cannot be replayed here and vice versa. The
  // purpose is recovered from which kind matched.
  const stateId = url.searchParams.get("state");
  let purpose: "login" | "reauth" = "login";
  let st = await consumeState<OidcState>(env.DB, "login", stateId);
  if (!st) {
    st = await consumeState<OidcState>(env.DB, "reauth", stateId);
    purpose = "reauth";
  }
  if (!st)
    return htmlResponse("Login failed", "<p>Login state is missing or was already used. Start again.</p>", null, 400);
  if (url.searchParams.get("error"))
    return htmlResponse(
      "Login failed",
      `<p>Google refused: ${escapeHtml(url.searchParams.get("error")!)}</p>`,
      null,
      400,
    );
  const code = url.searchParams.get("code");
  if (!code) return htmlResponse("Login failed", "<p>No code.</p>", null, 400);

  const tokens = await exchangeCode(env, deps, { code, redirectUri: loginRedirectUri(env) });
  const id = await verifyIdToken(env, deps, tokens.id_token, { nonce: st.nonce });

  const subs = ownerSubs(env);
  if (subs.length === 0) {
    if (ownerEmails(env).includes(id.email)) {
      return htmlResponse(
        "Set up the owner",
        `<p>No owner is configured yet. Confirm this is the Google account you intend to trust, then set the
Worker secret <code>OWNER_GOOGLE_SUBS</code> to this value and log in again:</p>
<pre>${escapeHtml(id.sub)}</pre>
<p class="muted">Signed in as ${escapeHtml(id.email)}. Nothing was stored. For an address that is not a Gmail or
Workspace mailbox, Google verifies that the address was confirmed once, not that it is still under your control.</p>`,
        null,
      );
    }
    return htmlResponse(
      "Not the owner",
      "<p>This deployment has no owner yet and your address is not in the bootstrap list.</p>",
      null,
      403,
    );
  }
  if (!subs.includes(id.sub))
    return htmlResponse("Not the owner", "<p>This deployment belongs to someone else.</p>", null, 403);

  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO users (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email",
  )
    .bind(id.sub, id.email, now)
    .run();

  if (purpose === "reauth") {
    const current = await readSession(env.DB, request);
    if (!current || current.idHash !== st.sessionIdHash || current.userId !== id.sub) {
      return htmlResponse(
        "Reauthentication failed",
        "<p>The session changed or a different Google account was used.</p>",
        null,
        403,
      );
    }
    await markReauthenticated(env.DB, current.idHash);
    return redirect(st.returnTo);
  }

  // Rotation: whatever cookie arrived is revoked (if it was ours) and replaced. A value an attacker
  // planted before login never becomes an authenticated session.
  const previous = await readSession(env.DB, request);
  if (previous) await revokeSession(env.DB, previous.idHash);
  const fresh = await createSession(env.DB, id.sub);
  const res = redirect(st.returnTo);
  res.headers.append("set-cookie", fresh.cookie);
  // Remembered consent belongs to one owner. A different owner on this browser starts with none.
  if (!previous || previous.userId !== id.sub) res.headers.append("set-cookie", clearApprovedCookie());
  return res;
}

export const loginRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/$/,
    handler: async ({ env, request }) => {
      const s = await readSession(env.DB, request);
      if (s)
        return page(
          env,
          s,
          "gmail-mcp",
          `<p><a href="/accounts">Accounts</a> · <a href="/policy">Policy</a> · <a href="/audit">Audit</a></p>`,
        );
      return htmlResponse("gmail-mcp", `<p><a href="/login">Log in with Google</a></p>`, null);
    },
  },
  {
    method: "GET",
    pattern: /^\/login$/,
    handler: ({ env, url }) => startLogin(env, { returnTo: returnPath(url), purpose: "login" }),
  },
  { method: "GET", pattern: /^\/oidc\/callback$/, handler: oidcCallback },
  {
    method: "POST",
    pattern: /^\/reauth$/,
    handler: async ({ env, request }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const form = await readForm(request);
      const refused = await guardPost(env, request, s, form, "/reauth", "");
      if (refused) return refused;
      const back = form.get("return") ?? "";
      return startLogin(env, {
        returnTo: isInternalPath(back) ? back : "/accounts",
        purpose: "reauth",
        sessionIdHash: s.idHash,
      });
    },
  },
  {
    method: "POST",
    pattern: /^\/logout$/,
    handler: async ({ env, request }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const form = await readForm(request);
      const refused = await guardPost(env, request, s, form, "/logout", "");
      if (refused) return refused;
      await revokeSession(env.DB, s.idHash);
      const res = redirect("/");
      res.headers.append("set-cookie", clearCookie());
      return res;
    },
  },
];
