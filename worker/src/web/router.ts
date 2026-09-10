import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Deps } from "../deps";
import type { Env } from "../env";
import { checkOrigin, csrfToken, verifyCsrf } from "./csrf";
import { type Chrome, escapeHtml, htmlResponse, isInternalPath, redirect } from "./html";
import { isRecentlyAuthenticated, readSession, type Session } from "./session";
import { staticHandler } from "./static";

export type Ctx = { request: Request; env: Env; deps: Deps; url: URL; params: string[] };
export type Route = { method: "GET" | "POST"; pattern: RegExp; handler: (ctx: Ctx) => Promise<Response> };

const FORM_CAP = 64 * 1024;

export async function readForm(request: Request): Promise<URLSearchParams> {
  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > FORM_CAP) throw new GmailMcpError("limit_exceeded", "form too large");
  // Decoded from bytes rather than request.text(): the runtime warns that text() on a urlencoded
  // body may corrupt it, and the byte count is what the cap is about anyway.
  const text = new TextDecoder().decode(await request.arrayBuffer());
  if (text.length > FORM_CAP) throw new GmailMcpError("limit_exceeded", "form too large");
  return new URLSearchParams(text);
}

export async function requireSession(env: Env, request: Request): Promise<Session | Response> {
  const s = await readSession(env.DB, request);
  if (s) return s;
  const url = new URL(request.url);
  return redirect(`/login?return=${encodeURIComponent(url.pathname + url.search)}`);
}

async function chrome(env: Env, session: Session): Promise<NonNullable<Chrome>> {
  return {
    logoutCsrf: await csrfToken(env, session, "POST", "/logout", ""),
    reauthCsrf: await csrfToken(env, session, "POST", "/reauth", ""),
  };
}

export async function page(
  env: Env,
  session: Session,
  title: string,
  body: string,
  status = 200,
  extraFormActions: string[] = [],
): Promise<Response> {
  return htmlResponse(title, body, await chrome(env, session), status, extraFormActions);
}

/** Spec 4.6: a fresh Google login, not activity, unlocks policy edits and revocations. */
export async function requireRecent(env: Env, session: Session, request: Request): Promise<Response | null> {
  if (isRecentlyAuthenticated(session)) return null;
  const url = new URL(request.url);
  const c = await chrome(env, session);
  return page(
    env,
    session,
    "Recent login required",
    `<p>This change needs a login within the last 15 minutes.</p>
<form method="post" action="/reauth"><input type="hidden" name="csrf" value="${escapeHtml(c.reauthCsrf)}"><input type="hidden" name="return" value="${escapeHtml(url.pathname)}"><button>Re-authenticate with Google</button></form>`,
    403,
  );
}

/** Every state-changing POST: same-origin, then the per-form token. Order matters only for the message. */
export async function guardPost(
  env: Env,
  request: Request,
  session: Session,
  form: URLSearchParams,
  route: string,
  objectId: string,
): Promise<Response | null> {
  if (!checkOrigin(request, env)) return page(env, session, "Refused", "<p>Cross-origin form post refused.</p>", 403);
  if (!(await verifyCsrf(env, session, "POST", route, objectId, form.get("csrf") ?? ""))) {
    return page(env, session, "Refused", "<p>The form token is missing, expired or for a different object.</p>", 403);
  }
  return null;
}

export function returnPath(url: URL, fallback = "/accounts"): string {
  const r = url.searchParams.get("return");
  return r && isInternalPath(r) ? r : fallback;
}

const STATUS: Partial<Record<string, number>> = {
  unauthorized: 401,
  forbidden: 403,
  account_not_found: 404,
  limit_exceeded: 413,
  invalid_address: 400,
  invalid_header: 400,
};

/**
 * Explicitly a plain Request, so our own callers and the tests can hand it one. The OAuth provider
 * accepts this shape for both its defaultHandler and its apiHandlers.
 */
export type FetchHandler = { fetch: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response> };

export function webHandler(deps: Deps, routes: Route[]): FetchHandler {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const asset = staticHandler(request);
      if (asset) return asset;
      for (const r of routes) {
        if (r.method !== request.method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        try {
          return await r.handler({ request, env, deps, url, params: m.slice(1) });
        } catch (e) {
          if (e instanceof GmailMcpError) {
            return htmlResponse("Error", `<p>${e.code}</p>`, null, STATUS[e.code] ?? 400);
          }
          console.error("web handler failure", (e as Error).message);
          return htmlResponse("Error", "<p>Something went wrong.</p>", null, 500);
        }
      }
      return htmlResponse("Not found", "<p>No such page.</p>", null, 404);
    },
  };
}
