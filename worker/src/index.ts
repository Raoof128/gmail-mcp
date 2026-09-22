import { BUILD_ID } from "./build-identity";
import { assertInstallation } from "./operations/installation";
import { recoverDeliveries } from "./operations/recovery-cron";
import { OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "./env";
import { runCron } from "./cron";
import { defaultDeps, type Deps } from "./deps";
import { isCompanionName } from "./auth/companion";
import { isRegistrationOpen } from "./auth/registration";
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
    // Closed by default: see auth/registration.ts. The check reads the database, so nothing a
    // registration request carries can open it.
    clientRegistrationCallback: async ({ clientMetadata }) => {
      if (isCompanionName(clientMetadata.client_name)) return { description: "reserved companion client name" };
      if (!(await isRegistrationOpen(env.DB, Date.now())))
        return { description: "client registration is closed; the owner must open a registration window" };
      return undefined;
    },
    // Only "mcp". A client reads this list and asks for what it finds, and /authorize refuses any
    // client that asks for more than the single scope it may hold, so listing "staging" here told
    // every discovering client to request a combination that could not be granted: consent died on
    // invalid_scope right after the owner opened a registration window. "staging" is real but
    // unreachable this way, because the only client that holds it is the companion, which createClient
    // mints out of band and which never reads discovery. A list that names a scope its reader cannot
    // hold is a trap, not documentation.
    scopesSupported: ["mcp"],
    // Stated here rather than inherited, because registration being closed changes what an expiry
    // costs. The library defaults are 1 hour, 30 days and 90 days, and the client record is the
    // shortest-lived of the three: when it lapses, the client's only way back is dynamic registration,
    // which is shut, so the owner must open a ten-minute window at /accounts before a session can work
    // at all. The client record therefore outlives the grant by a wide margin. An expired grant then
    // costs one consent click, which the owner can give from the client that asked for it.
    //
    // A year sets the re-consent cadence. It is not a security boundary: revocation is an owner action
    // at /accounts, which kills the grant at once rather than waiting for a timeout. Neither value is
    // load-bearing for safety, because every mailbox mutation still passes the policy engine and a
    // token only ever buys what the policy already allows.
    accessTokenTTL: 3600,
    refreshTokenTTL: 365 * 86_400,
    clientRegistrationTTL: 10 * 365 * 86_400,
    // Off deliberately. A CIMD client identifies by URL and never registers, so leaving this on is a
    // second door around the registration window above: any HTTPS host becomes a client id. MCP's
    // 2026 security guidance reserves "accept any HTTPS client_id" for open servers, and this
    // deployment has exactly one owner. It also stops the authorization server fetching a URL an
    // unauthenticated caller chose.
    clientIdMetadataDocumentEnabled: false,
    allowPlainPKCE: false,
    // No `resource` here on purpose: one configured resource would bind every token to /mcp and the
    // provider would then refuse the same token at /staging. The authorize handler pins the resource
    // per scope instead, and requireScope checks the audience per route.
    // One metadata object serves both well-known paths: the library derives `resource` from the path
    // but publishes a single shared scopes list, so any list here is wrong for one of the two
    // resources — /mcp refuses a staging token and /staging refuses an mcp one. It therefore claims
    // no scopes at all, which RFC 9728 permits, and a client that needs to know reads the
    // authorization server metadata above.
    resourceMetadata: {
      authorization_servers: [origin],
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
