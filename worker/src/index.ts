import { BUILD_ID } from "./build-identity";
import { assertInstallation } from "./operations/installation";
import { recoverDeliveries } from "./operations/recovery-cron";
import { OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "./env";
import { runCron } from "./cron";
import { defaultDeps, type Deps } from "./deps";
import { isCompanionName } from "./auth/companion";
import { authorizeRoutes } from "./auth/authorize";
import { connectRoutes } from "./google/connect";
import { accountsRoutes } from "./web/pages/accounts";
import { approveRoutes } from "./web/pages/approve";
import { auditRoutes } from "./web/pages/audit";
import { policyRoutes } from "./web/pages/policy";
import { requireScope } from "./auth/principal";
import { buildServer } from "./mcp/server";
import { stagingApiHandler } from "./staging/routes";
import { loginRoutes } from "./web/login";
import { webHandler, type FetchHandler } from "./web/router";

function mcpApiHandler(deps: Deps): FetchHandler {
  return {
    async fetch(request, env, ctx) {
      // apiHandlers match by prefix, so /mcpanything would land here too.
      if (new URL(request.url).pathname !== "/mcp") return new Response("not found", { status: 404 });
      const principal = await requireScope(request, env, "mcp");
      if (principal instanceof Response) return principal;
      return createMcpHandler((mcpCtx) => buildServer(env, principal, deps, mcpCtx.era))(request, env, ctx);
    },
  };
}

function oauthOptions(env: Env, deps: Deps): OAuthProviderOptions<Env> {
  const origin = `https://${env.WORKER_HOSTNAME}`;
  return {
    apiHandlers: { "/mcp": mcpApiHandler(deps), "/staging/": stagingApiHandler(deps) },
    defaultHandler: webHandler(deps, [
      ...loginRoutes,
      ...authorizeRoutes,
      ...connectRoutes,
      ...approveRoutes,
      ...accountsRoutes,
      ...policyRoutes,
      ...auditRoutes,
    ]),
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    clientRegistrationCallback: ({ clientMetadata }) =>
      isCompanionName(clientMetadata.client_name) ? { description: "reserved companion client name" } : undefined,
    scopesSupported: ["mcp", "staging"],
    clientIdMetadataDocumentEnabled: true,
    allowPlainPKCE: false,
    // No `resource` here on purpose: one configured resource would bind every token to /mcp and the
    // provider would then refuse the same token at /staging. The authorize handler pins the resource
    // per scope instead, and requireScope checks the audience per route.
    // One metadata object serves both well-known paths; the library derives `resource` from the path
    // and publishes one scopes list, so both scopes are listed and the authorize handler decides which
    // one a given client may hold.
    resourceMetadata: {
      authorization_servers: [origin],
      scopes_supported: ["mcp", "staging"],
      bearer_methods_supported: ["header"],
      resource_name: "gmail-mcp",
    },
  };
}

type Entry = { provider: OAuthProvider<Env>; options: OAuthProviderOptions<Env> };
// One provider per (deps, hostname): the options close over both, and the hostname only arrives with env.
const providers = new WeakMap<Deps, Map<string, Entry>>();
function providerFor(env: Env, deps: Deps): Entry {
  let byHost = providers.get(deps);
  if (!byHost) {
    byHost = new Map();
    providers.set(deps, byHost);
  }
  let entry = byHost.get(env.WORKER_HOSTNAME);
  if (!entry) {
    const options = oauthOptions(env, deps);
    entry = { provider: new OAuthProvider<Env>(options), options };
    byHost.set(env.WORKER_HOSTNAME, entry);
  }
  return entry;
}

/**
 * The handler shape callers and tests use: fetch is required and takes a plain Request, which is what
 * `new Request(...)` produces. The default export below is checked against ExportedHandler, so this
 * staying a valid Worker entrypoint is proved by the compiler rather than assumed.
 */
export type WorkerHandler = {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
  scheduled: (controller: ScheduledController, env: Env, ctx: ExecutionContext) => void;
};
export type Worker = WorkerHandler & { oauthOptions: (env: Env) => OAuthProviderOptions<Env> };

export function createWorker(deps: Deps = defaultDeps): Worker {
  return {
    fetch: async (request, env, ctx) => {
      const stamp = (response: Response) => {
        const headers = new Headers(response.headers);
        headers.set("x-recovery-build", env.BUILD_ID);
        if (env.WORKER_VERSION?.id) headers.set("x-recovery-version", env.WORKER_VERSION.id);
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      };
      let ready = true;
      try {
        await assertInstallation(env);
      } catch {
        ready = false;
      }
      if (new URL(request.url).pathname === "/healthz" && request.method === "GET")
        return stamp(Response.json({ status: ready ? "ready" : "maintenance" }, { status: ready ? 200 : 503 }));
      if (!ready) return stamp(Response.json({ error: "maintenance" }, { status: 503 }));
      try {
        return stamp(await providerFor(env, deps).provider.fetch(request, env, ctx));
      } catch {
        return stamp(Response.json({ error: "internal" }, { status: 500 }));
      }
    },
    scheduled(controller, env, ctx) {
      ctx.waitUntil(
        (async () => {
          try {
            await assertInstallation(env);
          } catch {
            return;
          }
          const now = Date.now();
          await recoverDeliveries(env, deps, controller.scheduledTime, now);
          await runCron(env, Date.now());
          await providerFor(env, deps).provider.purgeExpiredData(env, { batchSize: 100 });
        })(),
      );
    },
    oauthOptions: (env) => providerFor(env, deps).options,
  };
}

const worker = createWorker();
// Production uses a bundled constant. A mutable binding cannot impersonate a qualified build.
export default {
  fetch: (request, env, ctx) => worker.fetch(request, { ...env, BUILD_ID }, ctx),
  scheduled: (controller, env, ctx) => worker.scheduled(controller, { ...env, BUILD_ID }, ctx),
} satisfies ExportedHandler<Env>;
