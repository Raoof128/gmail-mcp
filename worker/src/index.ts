import type { Env } from "./env";

export default {
  async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    return new Response("not found", { status: 404 });
  },
  async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext): Promise<void> {},
} satisfies ExportedHandler<Env>;
