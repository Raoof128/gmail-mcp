import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { Env } from "../src/env";
import type { WorkerHandler } from "../src/index";
import type { FakeGoogle } from "./fake-google";
import { HOST } from "./test-env";
import { b64url } from "../src/crypto/random";

type Worker = WorkerHandler;

/** A browser with a cookie jar and nothing else. It never follows redirects; tests assert on them. */
export class Browser {
  readonly cookies = new Map<string, string>();
  constructor(
    private readonly worker: Worker,
    private readonly env: Env,
  ) {}

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    if (init.method === "POST" && !headers.has("origin")) headers.set("origin", HOST);
    const ctx = createExecutionContext();
    // A fresh spread per request: the provider assigns env.OAUTH_PROVIDER, and the shared env must not carry it between tests.
    const res = await this.worker.fetch(new Request(HOST + path, { ...init, headers }), { ...this.env }, ctx);
    await waitOnExecutionContext(ctx);
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (attrs.some((a) => a.trim().toLowerCase() === "max-age=0") || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }
  get(path: string, headers: Record<string, string> = {}): Promise<Response> {
    return this.fetch(path, { headers });
  }
  post(path: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
    return this.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(form).toString(),
    });
  }

  /** Drives /login through the fake Google and ends with a session cookie. */
  async login(g: FakeGoogle, o: { sub: string; email: string; returnTo?: string }): Promise<Response> {
    const start = await this.get(`/login${o.returnTo ? `?return=${encodeURIComponent(o.returnTo)}` : ""}`);
    if (start.status !== 303) throw new Error(`login start ${start.status}`);
    const google = new URL(start.headers.get("location")!);
    const state = google.searchParams.get("state")!;
    const nonce = google.searchParams.get("nonce")!;
    const code = g.grantCode({ sub: o.sub, email: o.email, nonce });
    return this.get(`/oidc/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`);
  }
}

export function csrfFrom(html: string, formAction?: string): string {
  const scope = formAction ? (html.split(`action="${formAction}"`)[1] ?? "") : html;
  const m = /name="csrf" value="([^"]+)"/.exec(scope);
  if (!m) throw new Error("no csrf token in page");
  return m[1]!;
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const verifier = b64url(raw);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}

export async function registerClient(worker: Worker, env: Env, redirectUri: string): Promise<string> {
  const b = new Browser(worker, env);
  const res = await b.fetch("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "test client",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (res.status !== 201) throw new Error(`register ${res.status} ${await res.text()}`);
  return (await res.json<{ client_id: string }>()).client_id;
}

/**
 * The whole Flow A as a client would run it: DCR (unless a client id is given), owner login, consent,
 * code exchange with PKCE. Returns the token and the browser that holds the owner's session.
 */
export async function mintToken(
  worker: Worker,
  env: Env,
  g: FakeGoogle,
  o: {
    scope: string;
    clientId?: string;
    redirectUri?: string;
    resource?: string | null;
    browser?: Browser;
    sub?: string;
    email?: string;
    decision?: "approve" | "deny";
  },
): Promise<{
  accessToken: string;
  refreshToken?: string | undefined;
  clientId: string;
  browser: Browser;
  authorizeStatus: number;
  location: string | null;
}> {
  const redirectUri = o.redirectUri ?? "http://localhost:5555/callback";
  const clientId = o.clientId ?? (await registerClient(worker, env, redirectUri));
  const b = o.browser ?? new Browser(worker, env);
  if (!o.browser) await b.login(g, { sub: o.sub ?? "owner-sub", email: o.email ?? "owner@example.test" });
  const { verifier, challenge } = await pkce();
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: o.scope,
    state: "client-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (o.resource !== null) q.set("resource", o.resource ?? `${HOST}/${o.scope === "staging" ? "staging" : "mcp"}`);
  let res = await b.get(`/authorize?${q.toString()}`);
  const authorizeStatus = res.status;
  let location = res.headers.get("location");
  if (res.status === 303 && location?.startsWith("/authorize/")) {
    const consentPath = location;
    res = await b.get(consentPath);
    location = res.headers.get("location");
    if (res.status === 200) {
      // A remembered client answers the GET with a redirect instead; only a rendered page has a form.
      const csrf = csrfFrom(await res.text(), consentPath);
      res = await b.post(consentPath, { decision: o.decision ?? "approve", csrf });
      location = res.headers.get("location");
    }
  }
  if (!location || !location.startsWith(redirectUri)) {
    return { accessToken: "", clientId, browser: b, authorizeStatus, location };
  }
  const code = new URL(location).searchParams.get("code");
  if (!code) return { accessToken: "", clientId, browser: b, authorizeStatus, location };
  const tok = await b.fetch("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }).toString(),
  });
  if (tok.status !== 200) throw new Error(`token ${tok.status} ${await tok.text()}`);
  const body = await tok.json<{ access_token: string; refresh_token?: string }>();
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    clientId,
    browser: b,
    authorizeStatus,
    location,
  };
}
