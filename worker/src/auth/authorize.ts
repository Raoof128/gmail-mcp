import { AuthorizationError, CimdFetchError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";
import { randomId } from "../crypto/random";
import { escapeHtml, escapeVisible, htmlResponse, redirect } from "../web/html";
import { type Route, guardPost, page, readForm, requireSession } from "../web/router";
import { csrfToken } from "../web/csrf";
import { approvedCookie, readApproved } from "./approved";
import { consumeState, putState } from "../web/state";
import { allowedScopeForClient, audienceFor, resolveGrantedScope, type Scope } from "./scopes";

const AUTHREQ_TTL_MS = 600_000;
type Stored = { request: AuthRequest; clientName: string; redirectUri: string; scope: Scope };

function clientError(
  req: AuthRequest | { redirectUri: string; state?: string | undefined; issuer?: string | undefined },
  code: string,
  description: string,
): Response {
  const u = new URL(req.redirectUri);
  u.searchParams.set("error", code);
  u.searchParams.set("error_description", description);
  if (req.state) u.searchParams.set("state", req.state);
  if (req.issuer) u.searchParams.set("iss", req.issuer);
  // An OAuth redirect back to a registered client URI. The provider validated that URI; this is the one
  // place a redirect may leave the origin, so it does not go through redirect().
  return new Response(null, { status: 302, headers: { location: u.toString(), "cache-control": "no-store" } });
}

/**
 * The consume comes first and is the only gate: whoever wins the UPDATE completes the grant, the other
 * caller sees 410. A failure after the consume leaves the client with an error and a fresh /authorize
 * is the recovery; nothing here may be retried against a consumed request.
 */
async function complete(env: Env, request: Request, userId: string, email: string, id: string): Promise<Response> {
  const s = await consumeState<Stored>(env.DB, "authreq", id);
  if (!s)
    return htmlResponse("Expired", "<p>This authorization request expired or was already decided.</p>", null, 410);
  const client = await env.OAUTH_PROVIDER.lookupClient(s.request.clientId);
  if (!client || (await allowedScopeForClient(env.DB, s.request.clientId, client.clientName)) !== s.scope)
    return htmlResponse("Authorization refused", "<p>Client registration changed.</p>", null, 400);
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: { ...s.request, resource: audienceFor(env, s.scope) },
    userId,
    metadata: { clientName: s.clientName },
    scope: [s.scope],
    props: { sub: userId, email },
  });
  const res = new Response(null, { status: 302, headers: { location: redirectTo, "cache-control": "no-store" } });
  const remembered = await readApproved(env, request, userId);
  if (!remembered.includes(s.request.clientId)) {
    res.headers.append("set-cookie", await approvedCookie(env, userId, [...remembered, s.request.clientId]));
  }
  return res;
}

async function readStored(env: Env, id: string): Promise<Stored | null> {
  const row = await env.DB.prepare(
    "SELECT payload FROM oauth_states WHERE id = ? AND kind = 'authreq' AND consumed_at IS NULL AND expires_at > ?",
  )
    .bind(id, Date.now())
    .first<{ payload: string }>();
  return row ? (JSON.parse(row.payload) as Stored) : null;
}

export const authorizeRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/authorize$/,
    handler: async ({ env, request }) => {
      let req: AuthRequest;
      try {
        req = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      } catch (e) {
        if (e instanceof CimdFetchError)
          return htmlResponse(
            "Authorization refused",
            "<p>The client's metadata document could not be fetched.</p>",
            null,
            400,
          );
        if (!(e instanceof AuthorizationError)) throw e;
        // Without redirectUri the client or its redirect never validated: render here, never redirect.
        if (!e.redirectUri)
          return htmlResponse("Authorization refused", `<p>${escapeHtml(e.description)}</p>`, null, 400);
        return clientError({ redirectUri: e.redirectUri, state: e.state, issuer: e.issuer }, e.code, e.description);
      }
      const client = await env.OAUTH_PROVIDER.lookupClient(req.clientId);
      if (!client) return htmlResponse("Authorization refused", "<p>Unknown client.</p>", null, 400);
      const allowed = await allowedScopeForClient(env.DB, req.clientId, client.clientName);
      if (!allowed) return clientError(req, "unauthorized_client", "companion registration is quarantined");
      const scope = resolveGrantedScope(req.scope, allowed);
      if (!scope) return clientError(req, "invalid_scope", `this client may request only "${allowed}"`);
      const wanted = Array.isArray(req.resource) ? req.resource : req.resource ? [req.resource] : [];
      if (wanted.length > 0 && !(wanted.length === 1 && wanted[0] === audienceFor(env, scope))) {
        return clientError(req, "invalid_target", `resource must be ${audienceFor(env, scope)}`);
      }
      const id = randomId("ar");
      // A DCR client names itself. Cap it so the consent page cannot be flooded, and render it visibly.
      const stored: Stored = {
        request: req,
        clientName: (client.clientName ?? req.clientId).slice(0, 100),
        redirectUri: req.redirectUri,
        scope,
      };
      await putState(env.DB, "authreq", id, stored, AUTHREQ_TTL_MS);
      return redirect(`/authorize/${id}`);
    },
  },
  {
    method: "GET",
    pattern: /^\/authorize\/(ar_[A-Za-z0-9_-]{22})$/,
    handler: async ({ env, request, params }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const stored = await readStored(env, params[0]!);
      if (!stored)
        return htmlResponse(
          "Expired",
          "<p>This authorization request expired. Start again from the client.</p>",
          null,
          410,
        );
      const email =
        (await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(s.userId).first<{ email: string }>())
          ?.email ?? "";
      if ((await readApproved(env, request, s.userId)).includes(stored.request.clientId)) {
        return complete(env, request, s.userId, email, params[0]!);
      }
      const csrf = await csrfToken(env, s, "POST", "/authorize", params[0]!);
      // The approve POST answers with a redirect to the client. Browsers apply form-action to that
      // redirect, so the client's origin is added to this page's CSP and nowhere else.
      return page(
        env,
        s,
        "Allow this client?",
        `<p>Only continue if you started this from a Claude client or the companion yourself.</p>
<table>
<tr><th>Client</th><td>${escapeVisible(stored.clientName)}</td></tr>
<tr><th>Client id</th><td>${escapeVisible(stored.request.clientId)}</td></tr>
<tr><th>Will return to</th><td>${escapeVisible(stored.redirectUri)}</td></tr>
<tr><th>Access</th><td>${stored.scope === "mcp" ? "Use the Gmail tools as you, subject to your policy" : "Move attachment bytes to and from this machine"}</td></tr>
</table>
<form method="post" action="/authorize/${escapeHtml(params[0]!)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<button name="decision" value="approve" class="approve">Allow</button>
<button name="decision" value="deny" class="deny">Deny</button>
</form>`,
        200,
        [new URL(stored.redirectUri).origin],
      );
    },
  },
  {
    method: "POST",
    pattern: /^\/authorize\/(ar_[A-Za-z0-9_-]{22})$/,
    handler: async ({ env, request, params }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const form = await readForm(request);
      const refused = await guardPost(env, request, s, form, "/authorize", params[0]!);
      if (refused) return refused;
      if (form.get("decision") !== "approve") {
        const stored = await consumeState<Stored>(env.DB, "authreq", params[0]!);
        if (!stored)
          return htmlResponse(
            "Expired",
            "<p>This authorization request expired or was already decided.</p>",
            null,
            410,
          );
        return clientError(stored.request, "access_denied", "the owner declined");
      }
      const email =
        (await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(s.userId).first<{ email: string }>())
          ?.email ?? "";
      return complete(env, request, s.userId, email, params[0]!);
    },
  },
];
