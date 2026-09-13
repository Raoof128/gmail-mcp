import { GmailMcpError } from "@gmail-mcp/shared/errors";
import { TransferIntent } from "@gmail-mcp/shared/staging";
import { ZodError } from "zod";
import type { Deps } from "../deps";
import { requireScope } from "../auth/principal";
import type { FetchHandler } from "../web/router";
import { openForRead } from "./store";
import { acknowledgeDownload } from "./downloads";
import { ensureTransfer } from "./transfers";
import { acceptUpload } from "./upload";
const HANDLE = /^\/staging\/(sh_[A-Za-z0-9_-]{43})(\/ack)?$/;
const TICKET = /^\/staging\/(ut_[A-Za-z0-9_-]{43})$/;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
async function readIntent(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    throw new GmailMcpError("handle_invalid", "handle_invalid: JSON required");
  const reader = (request.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (!reader) throw new GmailMcpError("handle_invalid", "handle_invalid: missing intent");
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GmailMcpError("limit_exceeded", "limit_exceeded: intent timeout")), 30_000);
  });
  try {
    for (;;) {
      const p = await Promise.race([reader.read(), deadline]);
      if (p.done) break;
      size += p.value.length;
      if (size > 65536) throw new GmailMcpError("limit_exceeded", "limit_exceeded: intent body");
      chunks.push(p.value);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return TransferIntent.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)));
}
export function stagingApiHandler(_deps: Deps): FetchHandler {
  return {
    async fetch(request, env) {
      const principal = await requireScope(request, env, "staging");
      if (principal instanceof Response) return principal;
      const path = new URL(request.url).pathname;
      try {
        if (path === "/staging/identity" && request.method === "GET") return json({ user_id: principal.userId });
        if (path === "/staging/intent" && request.method === "POST")
          return json(await ensureTransfer(env, principal, await readIntent(request)));
        const ticket = TICKET.exec(path);
        if (ticket && request.method === "PUT") return json(await acceptUpload(env, principal, ticket[1]!, request));
        const m = HANDLE.exec(path);
        if (!m) return json({ error: "not_found" }, 404);
        if (m[2] && request.method === "POST") {
          const out = await acknowledgeDownload(env, principal.userId, m[1]!);
          return out ? json(out) : json({ error: "handle_invalid" }, 404);
        }
        if (!m[2] && request.method === "GET") {
          const { row, body } = await openForRead(env, { handle: m[1]!, userId: principal.userId });
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
        return json({ error: "method_not_allowed" }, 405);
      } catch (e) {
        if (e instanceof GmailMcpError) {
          const status =
            e.code === "policy_denied"
              ? 403
              : e.code === "handle_expired"
                ? 404
                : e.code === "idempotency_conflict"
                  ? 409
                  : 400;
          return json({ error: e.code }, status);
        }
        if (e instanceof ZodError || e instanceof SyntaxError || e instanceof TypeError)
          return json({ error: "invalid_request" }, 400);
        return json({ error: "internal" }, 500);
      }
    },
  };
}
