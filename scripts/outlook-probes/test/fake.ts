/** A tiny programmable Graph for tests. It records every request and answers from a route table. */
export interface Seen {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | null;
}

export type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
export type Route = (req: Seen) => Reply | undefined;

export function fakeFetch(routes: Route[]): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    let body: string | null = null;
    if (typeof init?.body === "string") body = init.body;
    else if (init?.body instanceof Uint8Array) body = `<${init.body.length} bytes>`;
    const req: Seen = { method: init?.method ?? "GET", url, headers, body };
    seen.push(req);
    for (const r of routes) {
      const reply = r(req);
      if (reply) {
        const text = reply.body === undefined ? "" : JSON.stringify(reply.body);
        return Promise.resolve(
          new Response(reply.status === 204 ? null : text, { status: reply.status, headers: reply.headers ?? {} }),
        );
      }
    }
    return Promise.resolve(
      new Response(JSON.stringify({ error: { code: "NotRouted", message: url.pathname } }), { status: 404 }),
    );
  };
  return { fetch: impl, seen };
}

export const on =
  (method: string, path: string | RegExp, reply: Reply | ((req: Seen) => Reply)): Route =>
  (req) => {
    if (req.method !== method) return undefined;
    const p = decodeURIComponent(req.url.pathname);
    const hit = typeof path === "string" ? p === path : path.test(p);
    if (!hit) return undefined;
    return typeof reply === "function" ? reply(req) : reply;
  };
