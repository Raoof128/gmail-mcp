import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Deps } from "../deps";
import { requireScope } from "../auth/principal";
import type { FetchHandler } from "../web/router";
import { ack, openForRead } from "./store";

const HANDLE = /^\/staging\/(sh_[A-Za-z0-9_-]{43})(\/ack)?$/;

/** Plan 4 adds /staging/intent and PUT /staging/<ticket>. This is the download side only. */
export function stagingApiHandler(_deps: Deps): FetchHandler {
  return {
    async fetch(request, env) {
      const principal = await requireScope(request, env, "staging");
      if (principal instanceof Response) return principal;
      const url = new URL(request.url);
      const m = HANDLE.exec(url.pathname);
      if (!m) return new Response("not found", { status: 404 });
      const handle = m[1]!;
      try {
        if (m[2] && request.method === "POST") {
          const ok = await ack(env, { handle, userId: principal.userId });
          return new Response(null, { status: ok ? 204 : 404 });
        }
        if (!m[2] && request.method === "GET") {
          const { row, body } = await openForRead(env, { handle, userId: principal.userId });
          return new Response(body, {
            headers: {
              "content-type": row.mime,
              "content-length": String(row.size),
              "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
              "x-sha256": row.sha256,
              "cache-control": "no-store",
            },
          });
        }
        return new Response("method not allowed", { status: 405 });
      } catch (e) {
        if (e instanceof GmailMcpError && (e.code === "handle_invalid" || e.code === "handle_expired")) {
          return new Response(e.code, { status: 404 });
        }
        throw e;
      }
    },
  };
}
