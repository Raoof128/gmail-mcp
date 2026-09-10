import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { Env } from "../src/env";
import type { WorkerHandler } from "../src/index";
import type { FakeGoogle } from "./fake-google";
import { HOST } from "./test-env";

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
