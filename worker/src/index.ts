import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "./env";
import { runCron } from "./cron";
import { authenticateDev } from "./mcp/auth-dev";
import { buildServer } from "./mcp/server";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      const principal = authenticateDev(request, env);
      if (!principal || principal.scope !== "mcp") {
        return new Response("unauthorized", {
          status: 401,
          headers: { "www-authenticate": `Bearer resource_metadata="https://${env.WORKER_HOSTNAME}/.well-known/oauth-protected-resource"` },
        });
      }
      return createMcpHandler(() => buildServer(env, principal))(request, env, ctx);
    }
    return new Response("not found", { status: 404 });
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env, Date.now()));
  },
} satisfies ExportedHandler<Env>;
