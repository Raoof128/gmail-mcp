import type { Env } from "./env";
import { runCron } from "./cron";

export default {
  async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    return new Response("not found", { status: 404 });
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env, Date.now()));
  },
} satisfies ExportedHandler<Env>;
