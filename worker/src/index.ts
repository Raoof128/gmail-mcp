import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "./env";
import { runCron } from "./cron";
import { defaultDeps, type Deps } from "./deps";
import { authenticateDev } from "./mcp/auth-dev";
import { buildServer } from "./mcp/server";
import { loginRoutes } from "./web/login";
import { webHandler } from "./web/router";

/**
 * Interim wiring. The web routes are live; /mcp still sits behind the development bearer from plan 1.
 * The task that mounts the OAuth provider replaces this whole file and deletes mcp/auth-dev.ts, and
 * keeping the old branch until then means no commit in between ships a broken /mcp.
 */
/**
 * The handler shape callers and tests use: fetch is required and takes a plain Request, which is what
 * `new Request(...)` produces. The default export below is checked against ExportedHandler, so this
 * staying a valid Worker entrypoint is proved by the compiler rather than assumed.
 */
export type WorkerHandler = {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
  scheduled: (controller: ScheduledController, env: Env, ctx: ExecutionContext) => void;
};

export function createWorker(deps: Deps = defaultDeps): WorkerHandler {
  const web = webHandler(deps, [...loginRoutes]);
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname === "/mcp") {
        const principal = authenticateDev(request, env);
        if (!principal || principal.scope !== "mcp") {
          return new Response("unauthorized", {
            status: 401,
            headers: {
              "www-authenticate": `Bearer resource_metadata="https://${env.WORKER_HOSTNAME}/.well-known/oauth-protected-resource"`,
            },
          });
        }
        return createMcpHandler(() => buildServer(env, principal))(request, env, ctx);
      }
      return web.fetch(request, env, ctx);
    },
    scheduled(_controller, env, ctx) {
      ctx.waitUntil(runCron(env, Date.now()));
    },
  };
}

export default createWorker() satisfies ExportedHandler<Env>;
