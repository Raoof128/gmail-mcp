# Gmail MCP Plan 2: OAuth, Identity and the Web Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the Worker behind real identity: `@cloudflare/workers-oauth-provider` in front of `/mcp` and `/staging/*` (Flow A and the server side of Flow C), Google OIDC login for the owner, per-account Google authorisation with encrypted refresh tokens (Flow B), browser sessions with CSRF, and the six server-rendered pages. The development bearer is deleted, not disabled.

**Architecture:** The default export becomes an `OAuthProvider` whose `apiHandlers` protect `/mcp` and `/staging/`, and whose `defaultHandler` is a small hand-written router for `/authorize`, the Google callbacks and the pages. The provider validates bearer tokens and audience; our gate in `auth/principal.ts` then checks the token's scope against the route, and everything downstream keeps receiving the same `Principal` shape Plan 1 defined. Google is reached through one injectable `fetch` so every OAuth path is tested inside workerd against an in-memory fake Google that mints real RS256 `id_token`s. Pages are HTML strings built by `web/html.ts`; there is no template engine, no client JavaScript and no inline style, because the CSP forbids both.

**Tech Stack:** Everything from Plan 1, plus `@cloudflare/workers-oauth-provider` 0.10.3 and `jose` 6.2.12 (RS256 verification and, in tests, key generation and signing).

**Spec:** `docs/superpowers/specs/2026-09-09-gmail-mcp-design.md` (revision 3). Sections implemented here: 1.3 (alias grammar at connect), 3.1, 3.3 (encrypt, cache, refresh, lazy re-encrypt, `needs_reconnect`), 3.7 (the two companion-facing staging routes only), 4.1, 4.2, 4.3, 4.5 (server side), 4.6, and the OAuth and web rows of 4.7. Section 4.4 is a Google Cloud console procedure and is written up as a runbook in the last task.

**Plan series:** Plan 1 worker foundations (done). Plan 2 this plan. Plan 3 Gmail tools and the send pipeline, including the URL-mode elicitation wait loop of spec 1.4, `execute_pending`, and the `needs_reconnect` elicitation on tool calls. Plan 4 companion, plus the `/staging/intent` and `PUT /staging/<ticket>` server routes of spec 3.6 it needs. Plan 5 protected suite and fault injection.

## Global Constraints

- `user_id` is the `sub` of the owner's Google identity as carried in the Worker's own OAuth token props, and is never read from a tool argument or a query string (spec 3.1).
- Token scopes are exactly `mcp` and `staging`. The pre-registered companion client may be granted only `staging`; CIMD and DCR clients may be granted only `mcp`; any other request is rejected before consent (spec 4.1).
- Every API route checks the token's scope and RFC 8707 audience; the audience for `/mcp` is `https://<WORKER_HOSTNAME>/mcp` and for `/staging/*` it is `https://<WORKER_HOSTNAME>/staging` (spec 4.1).
- `OAuthProvider` runs with `clientIdMetadataDocumentEnabled: true`, `allowPlainPKCE: false`, DCR enabled as deprecated compatibility, and the `global_fetch_strictly_public` compatibility flag already set in `wrangler.jsonc` (spec 4.2).
- Owner login uses Google OIDC with scopes `openid email profile` only; `sub` must be in `OWNER_GOOGLE_SUBS`; `email_verified` must be `true`; `iss`, `aud`, `exp` are verified, `iat` must be within the last 10 minutes with 60 s of clock tolerance, and the `nonce` must match the one-use state record (spec 4.2).
- Account connection requests `https://www.googleapis.com/auth/gmail.modify openid email` with `access_type=offline` and `prompt=consent`; `https://mail.google.com/` is never requested (spec 4.3).
- OAuth `state`, OIDC `nonce` and pending consent requests live in the D1 table `oauth_states` with a 600 s expiry and are consumed by one atomic `UPDATE ... RETURNING`; zero rows means unknown, expired or replayed. Workers KV is eventually consistent and a `get` followed by a `delete` is not a one-use consume, so KV holds only the provider's own state (spec 3.2 amended in Task 14).
- Remembered consent (`__Host-approved`) is bound to the owner's `sub` as well as the client id; a different owner on the same browser always sees the consent page (spec 4.2).
- Every write that stores or refreshes Google credentials is guarded by `status = 'active' AND credential_version = <version read>` and must change exactly one row; revocation is local-first and atomic, and Google's revoke endpoint is best-effort cleanup afterwards (spec 3.3).
- A policy edit, its audit row and the revocation of other sessions are one D1 batch; the same holds for an approval decision and its audit row (spec 4.6, 3.10).
- Trust-boundary settings on the Accounts page (recipient allowlist, organisation domains, a send-limit increase, companion registration, revocation) require recent authentication and are audited (spec 4.6).
- Session cookie `__Host-session`, 256 random bits, sha256 stored; HttpOnly, Secure, SameSite=Lax; rotated at login; 12 h absolute, 2 h idle; recent authentication is `authenticated_at` within 15 minutes and `last_seen_at` never counts (spec 4.6).
- CSRF token = HMAC(`CSRF_HMAC_KEY`) over `session_id || method || route || object_id || expiry`, never stored (spec 4.6).
- Every page response carries `Cache-Control: no-store`, `Pragma: no-cache`, `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none'; style-src 'self'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'`, `X-Content-Type-Options: nosniff` (spec 4.6, with one amendment: `form-action` names Google because browsers apply it to the redirect that follows a form post, and the consent page additionally names the client's redirect origin; Task 14 records the amendment in the spec).
- Pages are server-rendered forms with no client JavaScript and no third-party assets (spec 4.6).
- Policy edits and account revocations require recent authentication and revoke all other sessions; policy edits are audited as `policy.edit` (spec 4.6).
- Approval page POST is the atomic `pending → approved` transition from Plan 1's `approvePending`; execution happens only through the claim (spec 4.6, 3.4).
- Attacker-influenced text on pages renders bidi and control characters as visible escapes (spec 3.8).
- Tokens never appear in tool results, audit rows, pages or logs (spec 3.3).
- Dependencies pinned exactly. If `npm install` reports a conflict, stop and decide; never repin to whatever is current.
- Run `npm run format` before every commit; the code blocks in this plan are not guaranteed to be Prettier-clean and `npm run verify` checks formatting.
- Every task is RED then GREEN. Commit after every green step with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Run the `stop-slop` skill on every document this plan writes or edits.

**Measured on 2026-09-09 from the unpacked packages:** `@cloudflare/workers-oauth-provider` 0.10.3 (published 2026-08-10) exports `OAuthProvider`, `AuthorizationError`, `getOAuthApi`, types `OAuthHelpers`, `AuthRequest`, `ClientInfo`, `TokenSummary`. Verified behaviours that this plan leans on: `apiHandlers` accepts plain `ExportedHandler` objects and matches routes by `url.pathname.startsWith(route)`; before calling an API handler it validates the bearer, expiry and audience and sets `ctx.props` to the grant's decrypted props; it injects `env.OAUTH_PROVIDER` for both API and default handlers; `createClient()` always generates the client id (a caller cannot choose `companion`); `completeAuthorization()` stores `request.resource` as the grant's resource when no `resourceMetadata.resource` is configured, and tokens inherit it; loopback redirect URIs (`127.0.0.0/8`, `::1`, `localhost`) match on any port; `unwrapToken(token)` returns `{ scope, audience, userId, grant: { clientId, props } }`. `jose` 6.2.12 is already present in the workspace `node_modules` as a transitive dependency, exports `jwtVerify`, `createLocalJWKSet`, `SignJWT`, `generateKeyPair` (with an `extractable` option), `exportJWK`, the `CryptoKey` and `JSONWebKeySet` types, accepts `requiredClaims` in `jwtVerify`, and runs on WebCrypto; pinning it in `worker/package.json` makes the direct import legitimate without adding a package. Two provider behaviours matter for the pages: `audienceMatches` is origin plus path-boundary prefix, so an audience of `https://host/staging` covers `/staging/<handle>`; `parseAuthRequest` turns an absent or empty `scope` into `[]`; the DCR endpoint answers 201.

Also read from the source: `handleProtectedResourceMetadata` derives the resource from the well-known path (`/.well-known/oauth-protected-resource/mcp` gives `origin + /mcp`, and `/staging` likewise) whenever `resourceMetadata.resource` is unset, so the two audiences are served without any fallback. The library's own authorization codes, grants and tokens live in KV; single use of an authorization code is the library's guarantee under KV semantics and this plan does not strengthen it, which the self-review records as a bound.

**One fact the first run must confirm:** that `jose` loads inside workerd (Task 5). Every other runtime behaviour this plan leans on was read from the unpacked source.

---

## File structure

```
worker/
  migrations/0002_identity.sql        settings; oauth_states (one-use state); accounts.credential_version
  src/web/state.ts                    putState / consumeState over oauth_states
  src/env.ts                          + GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OWNER_GOOGLE_SUBS, OWNER_EMAILS, OAUTH_PROVIDER
                                      - DEV_STATIC_TOKEN, DEV_STATIC_USER
  src/deps.ts                         Deps { googleFetch } with the production default
  src/index.ts                        createWorker(deps): OAuthProvider wiring, scheduled purge
  src/auth/principal.ts               Principal; requireScope() gate over unwrapToken
  src/auth/scopes.ts                  which client may hold which scope; audience for a scope
  src/auth/authorize.ts               /authorize: parse, login, consent, complete
  src/auth/companion.ts               register the companion client once; read its id from settings
  src/crypto/hmac.ts                  purpose-framed HMAC-SHA256 sign and verify
  src/google/oidc.ts                  endpoints, auth URL, code exchange, id_token verify, sendAs, revoke
  src/google/connect.ts               /connect, /connect/callback, upsertAccount, connect elicitation id
  src/google/tokens.ts                getAccessToken: cache, refresh, lazy re-encrypt, needs_reconnect
  src/web/html.ts                     escape, escapeVisible, layout, PAGE_HEADERS, htmlResponse, redirect
  src/web/session.ts                  sessions and the cookie
  src/web/csrf.ts                     per-form tokens
  src/web/router.ts                   defaultHandler: dispatch table and session loading
  src/web/login.ts                    /login, /oidc/callback, /reauth, /logout, bootstrap page
  src/web/pages/approve.ts            /approve/<id>
  src/web/pages/accounts.ts           /accounts and its POST actions
  src/web/pages/policy.ts             /policy and its POST actions
  src/web/pages/audit.ts              /audit
  src/web/static.ts                   /static/app.css
  src/staging/routes.ts               GET /staging/<handle>, POST /staging/<handle>/ack
  src/mcp/server.ts                   + connect_account, open_policy_editor; Principal import moves
  src/mcp/auth-dev.ts                 deleted
  test/test-env.ts                    testEnv(): every secret set, plain object
  test/fake-google.ts                 in-memory Google: JWKS, token, sendAs, revoke
  test/browser.ts                     cookie jar, form posting, login helper, mintToken helper
  test/*.test.ts                      one file per task
```

---

### Task 1: Dependencies, settings migration, environment and the test env helper

**Files:**

- Modify: `worker/package.json`, `worker/src/env.ts`, `worker/.dev.vars.example`, `worker/wrangler.jsonc`
- Create: `worker/migrations/0002_identity.sql`, `worker/src/deps.ts`, `worker/test/test-env.ts`, `worker/test/settings.test.ts`

**Interfaces:**

- Produces: `Env` gains `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OWNER_GOOGLE_SUBS`, `OWNER_EMAILS` (strings, comma separated lists for the last two) and `OAUTH_PROVIDER: OAuthHelpers` (injected by the provider at request time). `Deps = { googleFetch: typeof fetch }` and `defaultDeps`. `testEnv(overrides?)` returns a plain object with every secret set to a fixed test value and `OWNER_GOOGLE_SUBS = "owner-sub"`, `OWNER_EMAILS = "owner@example.test"`, `GOOGLE_CLIENT_ID = "gid.apps.googleusercontent.com"`, `GOOGLE_CLIENT_SECRET = "gsecret"`.
- Table `settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`; table `oauth_states (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER)`; column `accounts.credential_version INTEGER NOT NULL DEFAULT 0`.

- [ ] **Step 1 (RED): write the test**

`worker/test/settings.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { testEnv } from "./test-env";

describe("plan 2 scaffold", () => {
  it("has the settings and oauth_states tables and the credential_version column", async () => {
    await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('k', 'v', 1)").run();
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'k'").first<{ value: string }>();
    expect(row?.value).toBe("v");
    await env.DB.prepare(
      "INSERT INTO oauth_states (id, kind, payload, created_at, expires_at) VALUES ('st_x', 'login', '{}', 1, 2)",
    ).run();
    const consumed = await env.DB.prepare(
      "UPDATE oauth_states SET consumed_at = 3 WHERE id = 'st_x' AND consumed_at IS NULL AND expires_at > 1 RETURNING payload",
    ).first<{ payload: string }>();
    expect(consumed?.payload).toBe("{}");
    const cols = (await env.DB.prepare("PRAGMA table_info(accounts)").all<{ name: string }>()).results.map(
      (c) => c.name,
    );
    expect(cols).toContain("credential_version");
  });

  it("testEnv is a plain object with every secret and no dev bearer", () => {
    const e = testEnv();
    expect(Object.getPrototypeOf(e)).toBe(Object.prototype);
    for (const k of [
      "TOKEN_KEKS",
      "TOKEN_KEK_CURRENT",
      "STATE_HMAC_KEY",
      "CSRF_HMAC_KEY",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "OWNER_GOOGLE_SUBS",
      "OWNER_EMAILS",
      "WORKER_HOSTNAME",
    ])
      expect(typeof (e as Record<string, unknown>)[k]).toBe("string");
    expect("DEV_STATIC_TOKEN" in e).toBe(false);
    expect(e.DB).toBe(env.DB);
  });
});
```

- [ ] **Step 2: run, expect failure**

Run: `cd worker && npx vitest run test/settings.test.ts`
Expected: FAIL, `no such table: settings` and `Cannot find module './test-env'`.

- [ ] **Step 3 (GREEN): dependencies**

In `worker/package.json` add to `dependencies`, keeping the alphabetical order:

```json
"@cloudflare/workers-oauth-provider": "0.10.3",
"jose": "6.2.12",
```

Run `npm install` from the repository root and read the output. A peer conflict stops the task; record it in the commit body and decide.

- [ ] **Step 4 (GREEN): migration**

`worker/migrations/0002_identity.sql`:

```sql
-- Owner-level key/value state that is not per account. First use: the client id the OAuth provider
-- generated for the pre-registered companion client, because createClient() does not accept a chosen id.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One-use OAuth state: OIDC login and connect state (with the nonce), and pending consent requests.
-- Consumed by a single UPDATE ... RETURNING, so two callbacks carrying the same state can never both
-- succeed. KV was rejected for this because it is eventually consistent and get-then-delete races.
CREATE TABLE oauth_states (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('login','reauth','connect','authreq')),
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX oauth_states_expires ON oauth_states(expires_at);

-- Incremented by every reconnect and revocation. A refresh that started before the bump cannot write
-- its result back, which is what stops a stale refresh from repopulating a revoked account.
ALTER TABLE accounts ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 5 (GREEN): env and deps**

`worker/src/env.ts` becomes:

```ts
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

declare global {
  // A namespace is the shape `wrangler types` generates and the only way to merge secrets
  // into the generated Cloudflare.Env, so the ES-module preference does not apply here.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    interface Env {
      TOKEN_KEKS: string; // JSON { key_id: base64 32 bytes }
      TOKEN_KEK_CURRENT: string; // key_id
      STATE_HMAC_KEY: string; // base64 32 bytes
      CSRF_HMAC_KEY: string; // base64 32 bytes
      GOOGLE_CLIENT_ID: string;
      GOOGLE_CLIENT_SECRET: string;
      OWNER_GOOGLE_SUBS: string; // comma separated Google subs allowed to log in; empty enables bootstrap
      OWNER_EMAILS: string; // comma separated; consulted only while OWNER_GOOGLE_SUBS is empty, to decide who may see their sub
      OAUTH_PROVIDER: OAuthHelpers; // injected by workers-oauth-provider on every handled request
    }
  }
}
export type Env = Cloudflare.Env;

export function ownerSubs(env: Env): string[] {
  return env.OWNER_GOOGLE_SUBS.split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}
export function ownerEmails(env: Env): string[] {
  return env.OWNER_EMAILS.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
}
```

`worker/src/deps.ts`:

```ts
/**
 * Everything that reaches outside the Worker goes through here so a test can stand in for Google
 * without a network. Production uses the platform fetch unchanged.
 */
export type Deps = { googleFetch: typeof fetch };

export const defaultDeps: Deps = { googleFetch: (input, init) => fetch(input, init) };
```

`worker/.dev.vars.example`: delete the two `DEV_STATIC_*` lines and their comment, and append:

```
# Google OAuth client for the Worker (Flow A identity login and Flow B account connection).
# Create it in the gmail-mcp-personal project per docs/runbooks/google-cloud.md. Redirect URIs:
#   https://<WORKER_HOSTNAME>/oidc/callback  and  https://<WORKER_HOSTNAME>/connect/callback
GOOGLE_CLIENT_ID=placeholder.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=placeholder

# Google subs allowed to log in, comma separated. Leave empty on first deploy: the login page then shows
# the sub of anyone whose email is in OWNER_EMAILS so you can paste it here.
OWNER_GOOGLE_SUBS=
OWNER_EMAILS=you@example.test
```

In `worker/wrangler.jsonc`, `vars` stays as it is; no new var is public.

- [ ] **Step 6 (GREEN): test env helper**

`worker/test/test-env.ts`:

```ts
import { env } from "cloudflare:test";
import type { Env } from "../src/env";

const K = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="; // 32 bytes of 0x01, base64

/**
 * Every test builds its env from here. A plain spread copy, never Object.create(env): the test env
 * is a Proxy and writes to a child delegate up the chain. Every secret is set explicitly, so a
 * developer's .dev.vars cannot change what a test sees, and the dev bearer keys are removed if present.
 */
export function testEnv(overrides: Partial<Record<keyof Env, unknown>> = {}): Env {
  const copy: Record<string, unknown> = { ...env };
  delete copy.DEV_STATIC_TOKEN;
  delete copy.DEV_STATIC_USER;
  return {
    ...copy,
    TOKEN_KEKS: JSON.stringify({ k1: K }),
    TOKEN_KEK_CURRENT: "k1",
    STATE_HMAC_KEY: K,
    CSRF_HMAC_KEY: K,
    GOOGLE_CLIENT_ID: "gid.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "gsecret",
    OWNER_GOOGLE_SUBS: "owner-sub",
    OWNER_EMAILS: "owner@example.test",
    WORKER_HOSTNAME: "gmail-mcp.example.workers.dev",
    ...overrides,
  } as Env;
}

export const HOST = "https://gmail-mcp.example.workers.dev";
```

- [ ] **Step 7: run, expect PASS**

Run: `cd worker && npm run types && npx vitest run test/settings.test.ts`
Expected: PASS (2 tests). `wrangler types` regenerates `worker-configuration.d.ts`; if its `ProcessEnv` line still lists `DEV_STATIC_TOKEN` that only reflects a local `.dev.vars` and is harmless.

- [ ] **Step 8: commit**

```bash
git add package-lock.json worker/package.json worker/migrations/0002_identity.sql worker/src/env.ts worker/src/deps.ts worker/.dev.vars.example worker/test/test-env.ts worker/test/settings.test.ts worker/worker-configuration.d.ts
git commit -m "build(worker): pin workers-oauth-provider and jose; settings, one-use oauth_states, credential_version

The settings table exists because the OAuth provider generates client ids and the
companion's id has to live somewhere the authorize handler can read on every request.
oauth_states is in D1 rather than KV because one-use needs an atomic consume.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: HTML primitives and page headers

**Files:**

- Create: `worker/src/web/html.ts`, `worker/src/web/static.ts`, `worker/test/html.test.ts`

**Interfaces:**

- Produces: `escapeHtml(s): string` (HTML entity escaping for `& < > " '`); `escapeVisible(s): string` (escapeHtml, then render control and bidi characters as `\u{XXXX}` text so they are seen rather than obeyed); `PAGE_HEADERS: Record<string,string>`; `htmlResponse(title, body, status?): Response`; `redirect(location): Response` (303, page headers, internal paths only); `layout(title, body): string`; `CSS: string` served at `/static/app.css` by `staticHandler(request): Response | null`.

- [ ] **Step 1 (RED): tests**

`worker/test/html.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { escapeHtml, escapeVisible, htmlResponse, redirect, PAGE_HEADERS } from "../src/web/html";
import { staticHandler } from "../src/web/static";

describe("html primitives", () => {
  it("escapes the five entities", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });
  it("renders bidi and control characters as visible escapes", () => {
    expect(escapeVisible("thesis\u202Efdp.exe")).toBe("thesis\\u{202E}fdp.exe");
    expect(escapeVisible("a\u0000b\u2066c")).toBe("a\\u{0}b\\u{2066}c");
    expect(escapeVisible("<b>")).toBe("&lt;b&gt;");
  });
  it("page responses carry the security headers and no-store", async () => {
    const res = htmlResponse("T", "<p>x</p>");
    const withClient = htmlResponse("T", "<p>x</p>", 200, ["http://localhost:5555"]);
    expect(withClient.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://accounts.google.com http://localhost:5555",
    );
    expect(res.status).toBe(200);
    for (const [k, v] of Object.entries(PAGE_HEADERS)) expect(res.headers.get(k)).toBe(v);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await res.text();
    expect(body).toContain('<link rel="stylesheet" href="/static/app.css">');
    expect(body).not.toMatch(/<script/i);
    expect(body).not.toMatch(/ style=/i);
  });
  it("redirect only accepts internal paths", () => {
    expect(redirect("/accounts").headers.get("location")).toBe("/accounts");
    expect(redirect("/accounts").status).toBe(303);
    expect(() => redirect("https://evil.test/")).toThrow();
    expect(() => redirect("//evil.test/")).toThrow();
    expect(() => redirect("/\\evil.test")).toThrow();
  });
  it("serves the stylesheet with nosniff and no-store", () => {
    const res = staticHandler(new Request("https://x.test/static/app.css"));
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(res?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(staticHandler(new Request("https://x.test/static/other.css"))).toBeNull();
  });
});
```

- [ ] **Step 2: run, expect failure**

Run: `cd worker && npx vitest run test/html.test.ts`
Expected: FAIL, cannot find module `../src/web/html`.

- [ ] **Step 3 (GREEN): html.ts**

`worker/src/web/html.ts`:

```ts
export const PAGE_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
  // form-action also governs where a form submission may be *redirected* (Chrome enforces this),
  // so the identity provider is listed: /reauth and /connect answer a form post with a 303 to Google.
  "content-security-policy":
    "default-src 'none'; style-src 'self'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
};

/** Page headers with additional form-action origins, for the consent page's redirect back to the client. */
export function pageHeaders(extraFormActions: string[] = []): Record<string, string> {
  if (extraFormActions.length === 0) return PAGE_HEADERS;
  const csp = PAGE_HEADERS["content-security-policy"]!.replace(
    "form-action 'self' https://accounts.google.com",
    `form-action 'self' https://accounts.google.com ${extraFormActions.join(" ")}`,
  );
  return { ...PAGE_HEADERS, "content-security-policy": csp };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// The same class limits.ts uses: control characters and the bidi overrides and isolates. Matching
// them is the point, so the lint rule is off for this one line.
// eslint-disable-next-line no-control-regex
const VISIBLE = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** For anything an email could have written. Escapes HTML, then shows control and bidi code points as text. */
export function escapeVisible(s: string): string {
  return escapeHtml(s).replace(VISIBLE, (c) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase()}}`);
}

export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · gmail-mcp</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<header><a href="/accounts">Accounts</a> <a href="/policy">Policy</a> <a href="/audit">Audit</a>
<form method="post" action="/logout" class="inline"><button>Log out</button></form></header>
<main>
<h1>${escapeHtml(title)}</h1>
${body}
</main>
</body>
</html>
`;
}

export function htmlResponse(title: string, body: string, status = 200, extraFormActions: string[] = []): Response {
  return new Response(layout(title, body), {
    status,
    headers: { ...pageHeaders(extraFormActions), "content-type": "text/html; charset=utf-8" },
  });
}

/** Redirects stay on this origin. Anything that could leave it is a programming error, not a request error. */
export function redirect(location: string): Response {
  if (!/^\/(?![/\\])/.test(location)) throw new Error(`refusing external redirect: ${location}`);
  return new Response(null, { status: 303, headers: { ...PAGE_HEADERS, location } });
}

export function isInternalPath(p: string): boolean {
  return /^\/(?![/\\])/.test(p);
}
```

The logout form in the header has no CSRF token here; Task 4 changes `layout` to take the token, and this test keeps passing because it only inspects headers and the absence of scripts and inline styles.

- [ ] **Step 4 (GREEN): static.ts**

`worker/src/web/static.ts`:

```ts
import { PAGE_HEADERS } from "./html";

/** One stylesheet, served from this origin because the CSP allows nothing else. */
export const CSS = `
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; max-width: 60rem; padding: 1rem; }
header { display: flex; gap: 1rem; align-items: center; border-bottom: 1px solid #8884; padding-bottom: .5rem; }
header form.inline { margin-left: auto; }
main h1 { font-size: 1.4rem; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #8884; padding: .3rem .5rem; text-align: left; vertical-align: top; }
.untrusted { border: 3px dashed #c33; padding: .5rem; margin: 1rem 0; white-space: pre-wrap; font-family: ui-monospace, monospace; }
.untrusted-label { color: #c33; font-weight: bold; }
.approve { background: #2a7; color: #fff; }
.deny { background: #c33; color: #fff; }
.danger { border: 2px solid #c33; }
.muted { opacity: .7; }
form.inline { display: inline; }
`;

export function staticHandler(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== "/static/app.css") return null;
  return new Response(CSS, {
    headers: { ...PAGE_HEADERS, "content-type": "text/css; charset=utf-8" },
  });
}
```

- [ ] **Step 5: run, expect PASS (5 tests), then commit**

```bash
git add worker/src/web/html.ts worker/src/web/static.ts worker/test/html.test.ts
git commit -m "feat(worker): HTML primitives with visible bidi escapes and the page security headers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Web sessions and the cookie

**Files:**

- Create: `worker/src/web/session.ts`, `worker/test/session.test.ts`

**Interfaces:**

- Produces: `SESSION_COOKIE = "__Host-session"`, `ABSOLUTE_MS = 12h`, `IDLE_MS = 2h`, `RECENT_AUTH_MS = 15min`. `createSession(db, userId): Promise<{ id: string; cookie: string }>`; `readSession(db, request): Promise<Session | null>` (parses the cookie, hashes, checks revoked, absolute and idle limits, touches `last_seen_at` at most once a minute); `Session = { id: string; idHash: string; userId: string; authenticatedAt: number; lastSeenAt: number }`; `isRecentlyAuthenticated(s, now?)`; `markReauthenticated(db, idHash)`; `revokeSession(db, idHash)`; `revokeOtherSessions(db, userId, keepIdHash)`; `clearCookie(): string`; `sha256Hex` is reused from `crypto/canonical.ts`.

- [ ] **Step 1 (RED): tests**

`worker/test/session.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import {
  ABSOLUTE_MS,
  IDLE_MS,
  RECENT_AUTH_MS,
  SESSION_COOKIE,
  createSession,
  isRecentlyAuthenticated,
  markReauthenticated,
  readSession,
  revokeOtherSessions,
  revokeSession,
} from "../src/web/session";
import { seedUserAndAccount } from "./fixtures";

const req = (cookie: string | null) => new Request("https://x.test/accounts", { headers: cookie ? { cookie } : {} });

beforeAll(async () => {
  await seedUserAndAccount(env.DB, { userId: "su", accountId: "sa", alias: "personal", isDefault: true });
});

describe("sessions", () => {
  it("creates a __Host- cookie with the required attributes and stores only a hash", async () => {
    const s = await createSession(env.DB, "su");
    expect(s.cookie).toMatch(
      new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; Secure; SameSite=Lax$`),
    );
    const row = await env.DB.prepare("SELECT id_hash FROM web_sessions WHERE user_id = 'su'").first<{
      id_hash: string;
    }>();
    expect(row?.id_hash).not.toBe(s.id);
    expect(row?.id_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reads back the session and rejects a tampered or missing cookie", async () => {
    const s = await createSession(env.DB, "su");
    expect((await readSession(env.DB, req(`${SESSION_COOKIE}=${s.id}`)))?.userId).toBe("su");
    expect(await readSession(env.DB, req(`${SESSION_COOKIE}=${s.id.slice(0, -1)}x`))).toBeNull();
    expect(await readSession(env.DB, req(null))).toBeNull();
  });

  it("enforces idle and absolute limits from stored timestamps", async () => {
    const idle = await createSession(env.DB, "su");
    await env.DB.prepare("UPDATE web_sessions SET last_seen_at = ? WHERE id_hash = ?")
      .bind(Date.now() - IDLE_MS - 1000, idle.idHash)
      .run();
    expect(await readSession(env.DB, req(`${SESSION_COOKIE}=${idle.id}`))).toBeNull();

    const old = await createSession(env.DB, "su");
    await env.DB.prepare("UPDATE web_sessions SET created_at = ?, expires_at = ? WHERE id_hash = ?")
      .bind(Date.now() - ABSOLUTE_MS - 1000, Date.now() - 1000, old.idHash)
      .run();
    expect(await readSession(env.DB, req(`${SESSION_COOKIE}=${old.id}`))).toBeNull();
  });

  it("recent authentication counts authenticated_at only, never last_seen_at", async () => {
    const s = await createSession(env.DB, "su");
    const live = (await readSession(env.DB, req(`${SESSION_COOKIE}=${s.id}`)))!;
    expect(isRecentlyAuthenticated(live)).toBe(true);
    await env.DB.prepare("UPDATE web_sessions SET authenticated_at = ?, last_seen_at = ? WHERE id_hash = ?")
      .bind(Date.now() - RECENT_AUTH_MS - 1000, Date.now(), s.idHash)
      .run();
    const stale = (await readSession(env.DB, req(`${SESSION_COOKIE}=${s.id}`)))!;
    expect(isRecentlyAuthenticated(stale)).toBe(false);
    await markReauthenticated(env.DB, s.idHash);
    expect(isRecentlyAuthenticated((await readSession(env.DB, req(`${SESSION_COOKIE}=${s.id}`)))!)).toBe(true);
  });

  it("revoke and revoke-others", async () => {
    const a = await createSession(env.DB, "su");
    const b = await createSession(env.DB, "su");
    await revokeOtherSessions(env.DB, "su", a.idHash);
    expect(await readSession(env.DB, req(`${SESSION_COOKIE}=${b.id}`))).toBeNull();
    expect((await readSession(env.DB, req(`${SESSION_COOKIE}=${a.id}`)))?.userId).toBe("su");
    await revokeSession(env.DB, a.idHash);
    expect(await readSession(env.DB, req(`${SESSION_COOKIE}=${a.id}`))).toBeNull();
  });
});
```

- [ ] **Step 2: run, expect failure**

Run: `cd worker && npx vitest run test/session.test.ts`
Expected: FAIL, cannot find module `../src/web/session`.

- [ ] **Step 3 (GREEN): session.ts**

`worker/src/web/session.ts`:

```ts
import { sha256Hex } from "../crypto/canonical";
import { b64url } from "../crypto/random";

export const SESSION_COOKIE = "__Host-session";
export const ABSOLUTE_MS = 12 * 3_600_000;
export const IDLE_MS = 2 * 3_600_000;
export const RECENT_AUTH_MS = 15 * 60_000;
const TOUCH_EVERY_MS = 60_000;

export type Session = {
  id: string;
  idHash: string;
  userId: string;
  authenticatedAt: number;
  lastSeenAt: number;
};

function hashId(id: string): Promise<string> {
  return sha256Hex(new Uint8Array(new TextEncoder().encode(id)));
}

function cookieFor(id: string): string {
  // __Host- means the browser only sends it on this exact host over https with Path=/, which is
  // the whole reason the prefix is used: a cookie a subdomain could set would not pass this check.
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function createSession(
  db: D1Database,
  userId: string,
): Promise<{ id: string; idHash: string; cookie: string }> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const id = b64url(raw);
  const idHash = await hashId(id);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO web_sessions (id_hash, user_id, created_at, authenticated_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(idHash, userId, now, now, now, now + ABSOLUTE_MS)
    .run();
  return { id, idHash, cookie: cookieFor(id) };
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export async function readSession(db: D1Database, request: Request): Promise<Session | null> {
  const id = cookieValue(request, SESSION_COOKIE);
  if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
  const idHash = await hashId(id);
  const now = Date.now();
  const row = await db
    .prepare(
      `SELECT user_id, authenticated_at, last_seen_at FROM web_sessions
       WHERE id_hash = ? AND revoked_at IS NULL AND expires_at > ? AND last_seen_at > ?`,
    )
    .bind(idHash, now, now - IDLE_MS)
    .first<{ user_id: string; authenticated_at: number; last_seen_at: number }>();
  if (!row) return null;
  if (now - row.last_seen_at >= TOUCH_EVERY_MS) {
    await db.prepare("UPDATE web_sessions SET last_seen_at = ? WHERE id_hash = ?").bind(now, idHash).run();
  }
  return { id, idHash, userId: row.user_id, authenticatedAt: row.authenticated_at, lastSeenAt: row.last_seen_at };
}

/** Spec 4.6: only a fresh Google login counts. Activity never extends it. */
export function isRecentlyAuthenticated(s: Session, now = Date.now()): boolean {
  return now - s.authenticatedAt < RECENT_AUTH_MS;
}

export async function markReauthenticated(db: D1Database, idHash: string): Promise<void> {
  await db.prepare("UPDATE web_sessions SET authenticated_at = ? WHERE id_hash = ?").bind(Date.now(), idHash).run();
}

export async function revokeSession(db: D1Database, idHash: string): Promise<void> {
  await db
    .prepare("UPDATE web_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL")
    .bind(Date.now(), idHash)
    .run();
}

export async function revokeOtherSessions(db: D1Database, userId: string, keepIdHash: string): Promise<void> {
  await db
    .prepare("UPDATE web_sessions SET revoked_at = ? WHERE user_id = ? AND id_hash != ? AND revoked_at IS NULL")
    .bind(Date.now(), userId, keepIdHash)
    .run();
}
```

- [ ] **Step 4: run, expect PASS (5 tests), then commit**

```bash
git add worker/src/web/session.ts worker/test/session.test.ts
git commit -m "feat(worker): browser sessions with hashed ids, idle and absolute limits, recent-auth from login only

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Purpose-framed HMAC tokens and CSRF

**Files:**

- Create: `worker/src/crypto/hmac.ts`, `worker/src/web/csrf.ts`, `worker/test/csrf.test.ts`
- Modify: `worker/src/web/html.ts` (layout takes the logout CSRF token)

**Interfaces:**

- Produces: `signToken(keyB64, purpose, fields: string[], expiresAt): Promise<string>` returning `<expiresAt>.<base64url sig>` where the MAC input is the length-prefixed concatenation `len(purpose):purpose|len(f1):f1|…|len(exp):exp`, so no field value can shift a boundary; `verifyToken(keyB64, purpose, fields, token, now?): Promise<boolean>` (constant-time compare, expiry check). `csrfToken(env, session, method, route, objectId): Promise<string>` (purpose `gmail-mcp:csrf:v1`, fields `[session.id, method, route, objectId]`, 1 h expiry); `verifyCsrf(env, session, method, route, objectId, token): Promise<boolean>`; `checkOrigin(request, env): boolean` (an `Origin` header, when present, must equal `https://<WORKER_HOSTNAME>`; a missing `Origin` on a POST is refused). `layout(title, body, logoutCsrf)`; `htmlResponse(title, body, logoutCsrf, status?)`. Later tasks call `page(env, session, title, body)` from `router.ts`, which computes the header tokens itself.

- [ ] **Step 1 (RED): tests**

`worker/test/csrf.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { signToken, verifyToken } from "../src/crypto/hmac";
import { checkOrigin, csrfToken, verifyCsrf } from "../src/web/csrf";
import { testEnv } from "./test-env";
import type { Session } from "../src/web/session";

const env = testEnv();
const session: Session = { id: "sid-A", idHash: "h", userId: "u", authenticatedAt: 0, lastSeenAt: 0 };
const other: Session = { ...session, id: "sid-B" };

describe("hmac tokens", () => {
  it("round-trips and binds every field and the purpose", async () => {
    const exp = Date.now() + 60_000;
    const t = await signToken(env.STATE_HMAC_KEY, "p", ["a", "b"], exp);
    expect(await verifyToken(env.STATE_HMAC_KEY, "p", ["a", "b"], t)).toBe(true);
    expect(await verifyToken(env.STATE_HMAC_KEY, "q", ["a", "b"], t)).toBe(false);
    expect(await verifyToken(env.STATE_HMAC_KEY, "p", ["a", "c"], t)).toBe(false);
    expect(await verifyToken(env.STATE_HMAC_KEY, "p", ["ab", ""], t)).toBe(false);
    const nul = await signToken(env.STATE_HMAC_KEY, "p", ["a\0b", "c"], exp);
    expect(await verifyToken(env.STATE_HMAC_KEY, "p", ["a", "b\0c"], nul)).toBe(false);
    expect(await verifyToken(env.STATE_HMAC_KEY, "p", ["a\0b", "c"], nul)).toBe(true);
    expect(await verifyToken("AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=", "p", ["a", "b"], t)).toBe(false);
  });
  it("rejects expired and malformed tokens", async () => {
    const t = await signToken(env.STATE_HMAC_KEY, "p", ["a"], Date.now() - 1);
    expect(await verifyToken(env.STATE_HMAC_KEY, "p", ["a"], t)).toBe(false);
    expect(await verifyToken(env.STATE_HMAC_KEY, "p", ["a"], "garbage")).toBe(false);
    expect(await verifyToken(env.STATE_HMAC_KEY, "p", ["a"], "123.")).toBe(false);
  });
});

describe("csrf", () => {
  it("a token for /approve/A cannot approve /approve/B, another session, or another method", async () => {
    const t = await csrfToken(env, session, "POST", "/approve", "pa_A");
    expect(await verifyCsrf(env, session, "POST", "/approve", "pa_A", t)).toBe(true);
    expect(await verifyCsrf(env, session, "POST", "/approve", "pa_B", t)).toBe(false);
    expect(await verifyCsrf(env, other, "POST", "/approve", "pa_A", t)).toBe(false);
    expect(await verifyCsrf(env, session, "POST", "/policy", "pa_A", t)).toBe(false);
    expect(await verifyCsrf(env, session, "POST", "/approve", "pa_A", "")).toBe(false);
  });
  it("origin must match the worker hostname when present and is required on POST", () => {
    const mk = (origin?: string, method = "POST") =>
      new Request("https://gmail-mcp.example.workers.dev/approve/x", {
        method,
        headers: origin ? { origin } : {},
      });
    expect(checkOrigin(mk("https://gmail-mcp.example.workers.dev"), env)).toBe(true);
    expect(checkOrigin(mk("https://evil.test"), env)).toBe(false);
    expect(checkOrigin(mk("null"), env)).toBe(false);
    expect(checkOrigin(mk(undefined), env)).toBe(false);
    expect(checkOrigin(mk(undefined, "GET"), env)).toBe(true);
  });
});
```

- [ ] **Step 2: run, expect failure**

Run: `cd worker && npx vitest run test/csrf.test.ts`
Expected: FAIL, cannot find module `../src/crypto/hmac`.

- [ ] **Step 3 (GREEN): hmac.ts**

`worker/src/crypto/hmac.ts`:

```ts
import { b64url, fromB64url } from "./random";

function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function mac(
  keyB64: string,
  purpose: string,
  fields: string[],
  expiresAt: number,
): Promise<Uint8Array<ArrayBuffer>> {
  // Length-prefixed framing: every value is preceded by its byte length, so no content, NUL included,
  // can move a boundary. The purpose comes first so a token minted for one use cannot be replayed as another.
  const enc = new TextEncoder();
  const parts = [purpose, ...fields, String(expiresAt)].map((v) => {
    const bytes = enc.encode(v);
    return `${bytes.length}:${v}|`;
  });
  const input = parts.join("");
  const key = await crypto.subtle.importKey("raw", keyBytes(keyB64), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new Uint8Array(new TextEncoder().encode(input))));
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export async function signToken(keyB64: string, purpose: string, fields: string[], expiresAt: number): Promise<string> {
  return `${expiresAt}.${b64url(await mac(keyB64, purpose, fields, expiresAt))}`;
}

export async function verifyToken(
  keyB64: string,
  purpose: string,
  fields: string[],
  token: string,
  now = Date.now(),
): Promise<boolean> {
  const m = /^(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return false;
  const expiresAt = Number(m[1]);
  if (!(expiresAt > now)) return false;
  let given: Uint8Array;
  try {
    given = fromB64url(m[2]!);
  } catch {
    return false;
  }
  return equal(given, await mac(keyB64, purpose, fields, expiresAt));
}
```

- [ ] **Step 4 (GREEN): csrf.ts**

`worker/src/web/csrf.ts`:

```ts
import type { Env } from "../env";
import { signToken, verifyToken } from "../crypto/hmac";
import type { Session } from "./session";

const PURPOSE = "gmail-mcp:csrf:v1";
const TTL_MS = 60 * 60_000;

/** Spec 4.6: HMAC over session_id, method, route and object id, with an expiry. Nothing is stored. */
export function csrfToken(env: Env, s: Session, method: string, route: string, objectId: string): Promise<string> {
  return signToken(env.CSRF_HMAC_KEY, PURPOSE, [s.id, method, route, objectId], Date.now() + TTL_MS);
}

export function verifyCsrf(
  env: Env,
  s: Session,
  method: string,
  route: string,
  objectId: string,
  token: string,
): Promise<boolean> {
  return verifyToken(env.CSRF_HMAC_KEY, PURPOSE, [s.id, method, route, objectId], token);
}

/** A cross-site form post carries the attacker's Origin, or "null". A same-site one carries ours. */
export function checkOrigin(request: Request, env: Env): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true;
  const origin = request.headers.get("origin");
  return origin === `https://${env.WORKER_HOSTNAME}`;
}
```

- [ ] **Step 5 (GREEN): thread the header form tokens through `layout`**

In `worker/src/web/html.ts` add a type and change the signatures. `Chrome` carries the two tokens the header forms need; `null` renders the header without forms, for pages shown to a visitor without a session.

```ts
export type Chrome = { logoutCsrf: string; reauthCsrf: string } | null;

export function layout(title: string, body: string, chrome: Chrome): string {
```

The header becomes:

```html
<header>
  <a href="/accounts">Accounts</a> <a href="/policy">Policy</a> <a href="/audit">Audit</a> ${ chrome ? `
  <form method="post" action="/reauth" class="inline">
    <input type="hidden" name="csrf" value="${escapeHtml(chrome.reauthCsrf)}" /><button>Re-authenticate</button>
  </form>
  <form method="post" action="/logout" class="inline">
    <input type="hidden" name="csrf" value="${escapeHtml(chrome.logoutCsrf)}" /><button>Log out</button>
  </form>
  ` : "" }
</header>
```

and:

```ts
export function htmlResponse(
  title: string,
  body: string,
  chrome: Chrome,
  status = 200,
  extraFormActions: string[] = [],
): Response {
  return new Response(layout(title, body, chrome), {
    status,
    headers: { ...pageHeaders(extraFormActions), "content-type": "text/html; charset=utf-8" },
  });
}
```

Update `test/html.test.ts` to call `htmlResponse("T", "<p>x</p>", { logoutCsrf: "tok", reauthCsrf: "tok2" })` and `htmlResponse("T", "<p>x</p>", null, 200, ["http://localhost:5555"])`, and add `expect(body).toContain('action="/reauth"')` for the first.

- [ ] **Step 6: run both files, expect PASS, then commit**

Run: `cd worker && npx vitest run test/csrf.test.ts test/html.test.ts`

```bash
git add worker/src/crypto/hmac.ts worker/src/web/csrf.ts worker/src/web/html.ts worker/test/csrf.test.ts worker/test/html.test.ts
git commit -m "feat(worker): purpose-framed HMAC tokens, stateless per-form CSRF, Origin check

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Google OIDC client with an in-memory fake Google

**Files:**

- Create: `worker/src/google/oidc.ts`, `worker/test/fake-google.ts`, `worker/test/oidc.test.ts`

**Interfaces:**

- Produces: `GOOGLE = { issuer: "https://accounts.google.com", authUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token", jwksUrl: "https://www.googleapis.com/oauth2/v3/certs", revokeUrl: "https://oauth2.googleapis.com/revoke", sendAsUrl: "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs" }`. `LOGIN_SCOPES = "openid email profile"`, `CONNECT_SCOPES = "https://www.googleapis.com/auth/gmail.modify openid email"`.
  `buildAuthUrl(env, o: { redirectUri; scope; state; nonce; offline: boolean; loginHint?: string }): string`.
  `exchangeCode(env, deps, o: { code; redirectUri }): Promise<TokenResponse>` where `TokenResponse` is validated with zod (`access_token` non-empty, `token_type` `Bearer` case-insensitively, `expires_in` an integer in `1..86400`, `id_token` non-empty, `scope` a string, `refresh_token` an optional non-empty string); a 2xx body that fails validation throws `GmailMcpError("internal")` like a non-2xx.
  `refreshAccessToken(env, deps, refreshToken): Promise<{ access_token: string; expires_in: number } | "invalid_grant">`.
  `verifyIdToken(env, deps, idToken, o: { nonce: string }): Promise<{ sub: string; email: string }>` (jose `jwtVerify` with a JWKS from `deps.googleFetch`, issuer accepts both `https://accounts.google.com` and `accounts.google.com`, audience `GOOGLE_CLIENT_ID`, `maxTokenAge` 10 minutes and `clockTolerance` 60 s so `iat` is checked and not just present, `nonce` equal, `email_verified === true`; throws `GmailMcpError("unauthorized")` otherwise).
  `fetchSendAs(deps, accessToken): Promise<string[]>` (verified addresses only, lower-cased).
  `revokeToken(deps, token): Promise<void>` (best effort, ignores non-2xx).
  Test fake: `class FakeGoogle { fetch: typeof fetch; issue(o: { sub; email; nonce; aud?; iss?; exp?; emailVerified? }): Promise<string>; codes: Map<code, { sub; email; nonce; refresh: string; scope }>; grantCode(o): string; revoked: Set<string>; refreshTokens: Map<string, "ok" | "invalid_grant">; sendAs: string[]; tokenCalls: number }`.

- [ ] **Step 1 (RED): fake Google and tests**

`worker/test/fake-google.ts`:

```ts
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";

type CodeRecord = { sub: string; email: string; nonce: string; refresh: string; scope: string };

/** FormData.get() is string | File; every field this fake reads is a string or absent. */
const field = (f: FormData, k: string): string => {
  const v = f.get(k);
  return typeof v === "string" ? v : "";
};

/**
 * A Google that lives in memory: real RS256 keys, a real JWKS document, and a token endpoint that
 * hands out id_tokens signed with them. Every Worker path that talks to Google runs against this
 * through Deps.googleFetch, so the tests exercise the actual verification code.
 */
export class FakeGoogle {
  private priv!: CryptoKey;
  private jwks!: { keys: unknown[] };
  readonly codes = new Map<string, CodeRecord>();
  readonly refreshTokens = new Map<string, "ok" | "invalid_grant">();
  readonly revoked = new Set<string>();
  sendAs: string[] = ["owner@example.test", "alias@example.test"];
  tokenCalls = 0;
  accessCounter = 0;
  /** When set, the next authorization_code exchange answers 200 with a body missing access_token. */
  malformedNext = false;

  static async create(): Promise<FakeGoogle> {
    const g = new FakeGoogle();
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    g.priv = privateKey;
    const jwk = await exportJWK(publicKey);
    g.jwks = { keys: [{ ...jwk, kid: "k-test", alg: "RS256", use: "sig" }] };
    return g;
  }

  issue(o: {
    sub: string;
    email: string;
    nonce: string;
    aud?: string;
    iss?: string;
    expSeconds?: number;
    iatOffsetSeconds?: number;
    emailVerified?: boolean;
  }): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ email: o.email, email_verified: o.emailVerified ?? true, nonce: o.nonce })
      .setProtectedHeader({ alg: "RS256", kid: "k-test" })
      .setIssuer(o.iss ?? "https://accounts.google.com")
      .setAudience(o.aud ?? "gid.apps.googleusercontent.com")
      .setSubject(o.sub)
      .setIssuedAt(now + (o.iatOffsetSeconds ?? 0))
      .setExpirationTime(now + (o.expSeconds ?? 300))
      .sign(this.priv);
  }

  /** Test hook: runs before a refresh_token grant is answered, so a test can interleave a revoke. */
  beforeRefresh: (() => Promise<void>) | null = null;

  grantCode(o: { sub: string; email: string; nonce: string; scope?: string }): string {
    const code = `code-${this.codes.size + 1}-${o.sub}`;
    const refresh = `rt-${code}`;
    this.refreshTokens.set(refresh, "ok");
    this.codes.set(code, { ...o, refresh, scope: o.scope ?? "openid email" });
    return code;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.href === "https://www.googleapis.com/oauth2/v3/certs") return Response.json(this.jwks);
    if (url.href === "https://oauth2.googleapis.com/token") {
      this.tokenCalls++;
      // formData(), not text(): workerd warns that .text() on a urlencoded body may corrupt it.
      const form = await req.formData();
      if (field(form, "grant_type") === "authorization_code") {
        const rec = this.codes.get(field(form, "code"));
        if (!rec) return Response.json({ error: "invalid_grant" }, { status: 400 });
        this.codes.delete(field(form, "code")); // Google codes are single use
        if (this.malformedNext) {
          this.malformedNext = false;
          return Response.json({ token_type: "Bearer", expires_in: 3599 });
        }
        return Response.json({
          access_token: `at-${++this.accessCounter}`,
          refresh_token: rec.refresh,
          expires_in: 3599,
          scope: rec.scope,
          token_type: "Bearer",
          id_token: await this.issue({ sub: rec.sub, email: rec.email, nonce: rec.nonce }),
        });
      }
      if (field(form, "grant_type") === "refresh_token") {
        if (this.beforeRefresh) await this.beforeRefresh();
        const state = this.refreshTokens.get(field(form, "refresh_token"));
        if (state !== "ok") return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({ access_token: `at-${++this.accessCounter}`, expires_in: 3599, token_type: "Bearer" });
      }
      return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    }
    if (url.href === "https://oauth2.googleapis.com/revoke") {
      this.revoked.add(field(await req.formData(), "token"));
      return new Response(null, { status: 200 });
    }
    if (url.href === "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs") {
      if (!req.headers.get("authorization")?.startsWith("Bearer at-")) return new Response("", { status: 401 });
      return Response.json({
        sendAs: [
          ...this.sendAs.map((e) => ({ sendAsEmail: e, verificationStatus: "accepted" })),
          { sendAsEmail: "pending@example.test", verificationStatus: "pending" },
        ],
      });
    }
    return new Response("fake google: unknown url " + url.href, { status: 404 });
  };
}
```

`worker/test/oidc.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { FakeGoogle } from "./fake-google";
import { testEnv } from "./test-env";
import {
  CONNECT_SCOPES,
  LOGIN_SCOPES,
  buildAuthUrl,
  exchangeCode,
  fetchSendAs,
  refreshAccessToken,
  revokeToken,
  verifyIdToken,
} from "../src/google/oidc";

const env = testEnv();
let g: FakeGoogle;
beforeAll(async () => {
  g = await FakeGoogle.create();
});
const deps = () => ({ googleFetch: g.fetch });

describe("oidc client", () => {
  it("builds the login and connect URLs with the right parameters", () => {
    const login = new URL(
      buildAuthUrl(env, {
        redirectUri: "https://h/oidc/callback",
        scope: LOGIN_SCOPES,
        state: "s",
        nonce: "n",
        offline: false,
      }),
    );
    expect(login.origin + login.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(login.searchParams.get("client_id")).toBe(env.GOOGLE_CLIENT_ID);
    expect(login.searchParams.get("response_type")).toBe("code");
    expect(login.searchParams.get("scope")).toBe("openid email profile");
    expect(login.searchParams.get("access_type")).toBeNull();
    const connect = new URL(
      buildAuthUrl(env, {
        redirectUri: "https://h/connect/callback",
        scope: CONNECT_SCOPES,
        state: "s",
        nonce: "n",
        offline: true,
      }),
    );
    expect(connect.searchParams.get("access_type")).toBe("offline");
    expect(connect.searchParams.get("prompt")).toBe("consent");
    expect(connect.searchParams.get("scope")).not.toContain("mail.google.com");
    expect(connect.searchParams.get("scope")).toContain("gmail.modify");
  });

  it("verifies a good id_token and rejects each bad claim", async () => {
    const ok = await g.issue({ sub: "s1", email: "a@x.test", nonce: "n1" });
    expect(await verifyIdToken(env, deps(), ok, { nonce: "n1" })).toEqual({ sub: "s1", email: "a@x.test" });
    const alt = await g.issue({ sub: "s1", email: "a@x.test", nonce: "n1", iss: "accounts.google.com" });
    expect((await verifyIdToken(env, deps(), alt, { nonce: "n1" })).sub).toBe("s1");
    const cases = [
      ["wrong nonce", ok, "n2"],
      ["wrong issuer", await g.issue({ sub: "s1", email: "a@x.test", nonce: "n1", iss: "https://evil.test" }), "n1"],
      ["wrong audience", await g.issue({ sub: "s1", email: "a@x.test", nonce: "n1", aud: "other" }), "n1"],
      ["expired", await g.issue({ sub: "s1", email: "a@x.test", nonce: "n1", expSeconds: -120 }), "n1"],
      [
        "stale iat",
        await g.issue({ sub: "s1", email: "a@x.test", nonce: "n1", iatOffsetSeconds: -900, expSeconds: 300 }),
        "n1",
      ],
      ["future iat", await g.issue({ sub: "s1", email: "a@x.test", nonce: "n1", iatOffsetSeconds: 300 }), "n1"],
      ["unverified email", await g.issue({ sub: "s1", email: "a@x.test", nonce: "n1", emailVerified: false }), "n1"],
      ["garbage", "a.b.c", "n1"],
    ] as const;
    for (const [name, tok, nonce] of cases) {
      await expect(verifyIdToken(env, deps(), tok, { nonce }), name).rejects.toMatchObject({ code: "unauthorized" });
    }
  });

  it("exchanges a code once, refreshes, detects invalid_grant, lists verified send-as, revokes", async () => {
    const code = g.grantCode({ sub: "s1", email: "a@x.test", nonce: "n1" });
    const t = await exchangeCode(env, deps(), { code, redirectUri: "https://h/cb" });
    expect(t.refresh_token).toMatch(/^rt-/);
    g.malformedNext = true;
    const bad = g.grantCode({ sub: "s1", email: "a@x.test", nonce: "n1" });
    await expect(exchangeCode(env, deps(), { code: bad, redirectUri: "https://h/cb" })).rejects.toMatchObject({
      code: "internal",
    });
    await expect(exchangeCode(env, deps(), { code, redirectUri: "https://h/cb" })).rejects.toMatchObject({
      code: "internal",
    });
    expect(await refreshAccessToken(env, deps(), t.refresh_token!)).toMatchObject({ expires_in: 3599 });
    g.refreshTokens.set(t.refresh_token!, "invalid_grant");
    expect(await refreshAccessToken(env, deps(), t.refresh_token!)).toBe("invalid_grant");
    expect(await fetchSendAs(deps(), t.access_token)).toEqual(["owner@example.test", "alias@example.test"]);
    await revokeToken(deps(), t.refresh_token!);
    expect(g.revoked.has(t.refresh_token!)).toBe(true);
  });
});
```

- [ ] **Step 2: run, expect failure**

Run: `cd worker && npx vitest run test/oidc.test.ts`
Expected: FAIL, cannot find module `../src/google/oidc`. If `jose` itself fails to import inside workerd, stop: that is a dependency decision, not something to patch around.

- [ ] **Step 3 (GREEN): oidc.ts**

`worker/src/google/oidc.ts`:

```ts
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { z } from "zod";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Deps } from "../deps";
import type { Env } from "../env";

export const GOOGLE = {
  issuer: "https://accounts.google.com",
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
  sendAsUrl: "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs",
} as const;

export const LOGIN_SCOPES = "openid email profile";
/** gmail.modify cannot permanently delete. mail.google.com can, and is never requested. */
export const CONNECT_SCOPES = "https://www.googleapis.com/auth/gmail.modify openid email";

export function buildAuthUrl(
  env: Env,
  o: { redirectUri: string; scope: string; state: string; nonce: string; offline: boolean; loginHint?: string },
): string {
  const u = new URL(GOOGLE.authUrl);
  u.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", o.scope);
  u.searchParams.set("state", o.state);
  u.searchParams.set("nonce", o.nonce);
  if (o.offline) {
    u.searchParams.set("access_type", "offline");
    // Google returns a refresh token only on a consent screen; a silent re-auth would leave us
    // with an account row that cannot refresh.
    u.searchParams.set("prompt", "consent");
  }
  if (o.loginHint) u.searchParams.set("login_hint", o.loginHint);
  return u.toString();
}

/** What Google's token endpoint must return before anything is stored. A 200 with a wrong shape is a failure. */
const TokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine((t) => t.toLowerCase() === "bearer"),
  expires_in: z.number().int().min(1).max(86_400),
  id_token: z.string().min(1),
  scope: z.string(),
  refresh_token: z.string().min(1).optional(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;
const RefreshResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().min(1).max(86_400),
});

async function tokenPost(env: Env, deps: Deps, form: Record<string, string>): Promise<Response> {
  return deps.googleFetch(GOOGLE.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...form }),
  });
}

export async function exchangeCode(
  env: Env,
  deps: Deps,
  o: { code: string; redirectUri: string },
): Promise<TokenResponse> {
  const res = await tokenPost(env, deps, {
    grant_type: "authorization_code",
    code: o.code,
    redirect_uri: o.redirectUri,
  });
  if (!res.ok) throw new GmailMcpError("internal", `google token endpoint ${res.status}`);
  const parsed = TokenResponse.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new GmailMcpError("internal", "google token endpoint returned an unexpected body");
  return parsed.data;
}

export async function refreshAccessToken(
  env: Env,
  deps: Deps,
  refreshToken: string,
): Promise<{ access_token: string; expires_in: number } | "invalid_grant"> {
  const res = await tokenPost(env, deps, { grant_type: "refresh_token", refresh_token: refreshToken });
  if (res.ok) {
    const parsed = RefreshResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new GmailMcpError("internal", "google refresh returned an unexpected body");
    return parsed.data;
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 400 && body.error === "invalid_grant") return "invalid_grant";
  throw new GmailMcpError("internal", `google refresh ${res.status}`);
}

async function jwks(deps: Deps): Promise<ReturnType<typeof createLocalJWKSet>> {
  // Fetched per verification rather than cached in the isolate: logins are rare, and a stale cache
  // across a key rotation is a worse failure than one extra request.
  const res = await deps.googleFetch(GOOGLE.jwksUrl);
  if (!res.ok) throw new GmailMcpError("internal", `google jwks ${res.status}`);
  return createLocalJWKSet(await res.json<JSONWebKeySet>());
}

export async function verifyIdToken(
  env: Env,
  deps: Deps,
  idToken: string,
  o: { nonce: string },
): Promise<{ sub: string; email: string }> {
  try {
    const { payload } = await jwtVerify(idToken, await jwks(deps), {
      issuer: [GOOGLE.issuer, "accounts.google.com"],
      audience: env.GOOGLE_CLIENT_ID,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "email", "iat", "exp", "nonce"],
      // iat is checked, not just required: a token older than the login flow itself is replayed.
      maxTokenAge: "10 minutes",
      clockTolerance: 60,
    });
    if (payload.nonce !== o.nonce) throw new Error("nonce");
    if (payload.email_verified !== true) throw new Error("email_verified");
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") throw new Error("claims");
    return { sub: payload.sub, email: payload.email.toLowerCase() };
  } catch (e) {
    throw new GmailMcpError("unauthorized", `id_token rejected: ${(e as Error).message}`);
  }
}

export async function fetchSendAs(deps: Deps, accessToken: string): Promise<string[]> {
  const res = await deps.googleFetch(GOOGLE.sendAsUrl, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new GmailMcpError("internal", `sendAs ${res.status}`);
  const body = await res.json<{ sendAs?: { sendAsEmail: string; verificationStatus?: string }[] }>();
  return (body.sendAs ?? [])
    .filter((s) => s.verificationStatus === "accepted" || s.verificationStatus === undefined)
    .map((s) => s.sendAsEmail.toLowerCase());
}

/** Best effort. The local wipe that follows is what actually removes our access. */
export async function revokeToken(deps: Deps, token: string): Promise<void> {
  await deps
    .googleFetch(GOOGLE.revokeUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    })
    .catch(() => undefined);
}
```

Google's primary send-as entry omits `verificationStatus`, which is why `undefined` counts as verified.

- [ ] **Step 4: run, expect PASS (3 tests), then commit**

```bash
git add worker/src/google/oidc.ts worker/test/fake-google.ts worker/test/oidc.test.ts
git commit -m "feat(worker): Google OIDC client verified against an in-memory Google with real RS256 keys

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Owner login, session rotation, reauth, logout and the router

**Files:**

- Create: `worker/src/web/state.ts`, `worker/src/web/router.ts`, `worker/src/web/login.ts`, `worker/test/browser.ts`, `worker/test/login.test.ts`

**Interfaces:**

- Produces: `webHandler(deps): ExportedHandler<Env>` (the provider's `defaultHandler`). Router helpers used by every page task: `requireSession(env, request): Promise<Session | Response>` (a `Response` is the redirect to `/login?return=<path>`); `requireRecent(env, session, request): Promise<Response | null>` (a 403 page carrying a re-authentication form that returns to the current path, when the session is not recently authenticated); `page(env, session, title, body, status?, extraFormActions?): Promise<Response>` (computes the header's logout and reauth CSRF tokens); `readForm(request): Promise<URLSearchParams>` (urlencoded, 64 KB cap); `guardPost(env, request, session, form, route, objectId): Promise<Response | null>` (Origin check then CSRF over the parsed form; a `Response` is the 403). `routes` is a table of `{ method, pattern: RegExp, handler(ctx) }` where `ctx = { request, env, deps, url, params: string[] }`.
- `state.ts`: `putState(db, kind, id, payload: object, ttlMs): Promise<void>` and `consumeState<T>(db, kind, id): Promise<T | null>`, the latter one `UPDATE oauth_states SET consumed_at = ? WHERE id = ? AND kind = ? AND consumed_at IS NULL AND expires_at > ? RETURNING payload`. `login.ts`: `startLogin(env, o: { returnTo: string; purpose: "login" | "reauth"; sessionIdHash?: string }): Promise<Response>` (row `oauth_states` of that kind holding `{ nonce, returnTo, sessionIdHash }`, 600 s); routes `GET /`, `GET /login`, `GET /oidc/callback`, `POST /reauth` (session, CSRF route `/reauth` object id `""`, form field `return`), `POST /logout`. `/reauth` is a POST because spec 4.6 puts it behind CSRF, and its 303 to Google is what the `form-action` amendment in Task 2 exists for. The bootstrap page is rendered by `oidcCallback` when `OWNER_GOOGLE_SUBS` is empty and the email is in `OWNER_EMAILS`.
- Test helper `Browser` (cookie jar, `get`, `post`, `login(g, { sub, email })`) and `csrfFrom(html)`.

- [ ] **Step 1 (RED): browser helper and tests**

`worker/test/browser.ts`:

```ts
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { Env } from "../src/env";
import type { FakeGoogle } from "./fake-google";
import { HOST } from "./test-env";

type Worker = { fetch: (r: Request, e: Env, c: ExecutionContext) => Promise<Response> | Response };

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
```

`worker/test/login.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index";
import { FakeGoogle } from "./fake-google";
import { Browser, csrfFrom } from "./browser";
import { testEnv } from "./test-env";
import { SESSION_COOKIE } from "../src/web/session";

let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker({ googleFetch: g.fetch });
});
const E = () => testEnv();

describe("owner login", () => {
  it("landing redirects to /login without a session and to /accounts with one", async () => {
    const b = new Browser(worker, E());
    expect((await b.get("/")).status).toBe(200);
    expect(await (await b.get("/")).text()).toContain('href="/login"');
    await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
    const home = await b.get("/");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('action="/logout"');
  });

  it("logs the owner in, rotates the session, and returns to an internal path only", async () => {
    const b = new Browser(worker, E());
    b.cookies.set(SESSION_COOKIE, "fixated-value-that-is-43-chars-long-xxxxxxxx");
    const done = await b.login(g, { sub: "owner-sub", email: "owner@example.test", returnTo: "/policy" });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/policy");
    expect(b.cookies.get(SESSION_COOKIE)).not.toBe("fixated-value-that-is-43-chars-long-xxxxxxxx");
    const user = await env.DB.prepare("SELECT email FROM users WHERE id = 'owner-sub'").first<{ email: string }>();
    expect(user?.email).toBe("owner@example.test");

    const evil = new Browser(worker, E());
    const start = await evil.get("/login?return=https://evil.test/");
    const google = new URL(start.headers.get("location")!);
    const code = g.grantCode({
      sub: "owner-sub",
      email: "owner@example.test",
      nonce: google.searchParams.get("nonce")!,
    });
    const cb = await evil.get(`/oidc/callback?state=${google.searchParams.get("state")}&code=${code}`);
    expect(cb.headers.get("location")).toBe("/accounts");
  });

  it("two callbacks racing on one state yield exactly one session", async () => {
    const b1 = new Browser(worker, E());
    const start = await b1.get("/login");
    const google = new URL(start.headers.get("location")!);
    const state = google.searchParams.get("state")!;
    const nonce = google.searchParams.get("nonce")!;
    const b2 = new Browser(worker, E());
    const c1 = g.grantCode({ sub: "owner-sub", email: "owner@example.test", nonce });
    const c2 = g.grantCode({ sub: "owner-sub", email: "owner@example.test", nonce });
    const [r1, r2] = await Promise.all([
      b1.get(`/oidc/callback?state=${state}&code=${c1}`),
      b2.get(`/oidc/callback?state=${state}&code=${c2}`),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([303, 400]);
    expect([b1.cookies.has(SESSION_COOKIE), b2.cookies.has(SESSION_COOKIE)].filter(Boolean)).toHaveLength(1);
  });

  it("rejects state replay, a foreign state, and a nonce that does not match", async () => {
    const b = new Browser(worker, E());
    const start = await b.get("/login");
    const google = new URL(start.headers.get("location")!);
    const state = google.searchParams.get("state")!;
    const nonce = google.searchParams.get("nonce")!;
    const code = g.grantCode({ sub: "owner-sub", email: "owner@example.test", nonce });
    expect((await b.get(`/oidc/callback?state=${state}&code=${code}`)).status).toBe(303);
    const replay = g.grantCode({ sub: "owner-sub", email: "owner@example.test", nonce });
    expect((await b.get(`/oidc/callback?state=${state}&code=${replay}`)).status).toBe(400);
    expect((await b.get(`/oidc/callback?state=made-up&code=${replay}`)).status).toBe(400);

    const c = new Browser(worker, E());
    const s2 = new URL((await c.get("/login")).headers.get("location")!);
    const wrongNonce = g.grantCode({ sub: "owner-sub", email: "owner@example.test", nonce: "not-the-nonce" });
    const res = await c.get(`/oidc/callback?state=${s2.searchParams.get("state")}&code=${wrongNonce}`);
    expect(res.status).toBe(401);
    expect(c.cookies.has(SESSION_COOKIE)).toBe(false);
  });

  it("refuses a Google identity that is not the owner, and never creates a session for it", async () => {
    const b = new Browser(worker, E());
    const res = await b.login(g, { sub: "stranger", email: "stranger@example.test" });
    expect(res.status).toBe(403);
    expect(b.cookies.has(SESSION_COOKIE)).toBe(false);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM users WHERE id = 'stranger'").first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  it("bootstrap: with OWNER_GOOGLE_SUBS empty, an OWNER_EMAILS address sees its sub and gets no session", async () => {
    const b = new Browser(worker, testEnv({ OWNER_GOOGLE_SUBS: "" }));
    const res = await b.login(g, { sub: "new-owner-sub", email: "owner@example.test" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("new-owner-sub");
    expect(html).toContain("Confirm this is the Google account you intend to trust");
    expect(b.cookies.has(SESSION_COOKIE)).toBe(false);
    const other = new Browser(worker, testEnv({ OWNER_GOOGLE_SUBS: "" }));
    expect((await other.login(g, { sub: "x", email: "someone@else.test" })).status).toBe(403);
  });

  it("reauth refreshes authenticated_at on the same session; logout revokes and needs CSRF", async () => {
    const b = new Browser(worker, E());
    await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
    const sid = b.cookies.get(SESSION_COOKIE)!;
    await env.DB.prepare("UPDATE web_sessions SET authenticated_at = 1").run();
    const reauthCsrf = csrfFrom(await (await b.get("/")).text(), "/reauth");
    expect((await b.post("/reauth", { csrf: "nope", return: "/policy" })).status).toBe(403);
    const start = await b.post("/reauth", { csrf: reauthCsrf, return: "/policy" });
    expect(start.status).toBe(303);
    const google = new URL(start.headers.get("location")!);
    const code = g.grantCode({
      sub: "owner-sub",
      email: "owner@example.test",
      nonce: google.searchParams.get("nonce")!,
    });
    const cb = await b.get(`/oidc/callback?state=${google.searchParams.get("state")}&code=${code}`);
    expect(cb.headers.get("location")).toBe("/policy");
    expect(b.cookies.get(SESSION_COOKIE)).toBe(sid);
    const row = await env.DB.prepare(
      "SELECT authenticated_at FROM web_sessions WHERE revoked_at IS NULL ORDER BY authenticated_at DESC LIMIT 1",
    ).first<{ authenticated_at: number }>();
    expect(row!.authenticated_at).toBeGreaterThan(Date.now() - 10_000);

    // reauth as a different Google identity must not upgrade this session
    const start2 = new URL(
      (await b.post("/reauth", { csrf: reauthCsrf, return: "https://evil.test/" })).headers.get("location")!,
    );
    const wrong = g.grantCode({ sub: "stranger", email: "s@example.test", nonce: start2.searchParams.get("nonce")! });
    expect((await b.get(`/oidc/callback?state=${start2.searchParams.get("state")}&code=${wrong}`)).status).toBe(403);

    const csrf = csrfFrom(await (await b.get("/")).text(), "/logout");
    expect((await b.post("/logout", { csrf: "nope" })).status).toBe(403);
    const out = await b.post("/logout", { csrf });
    expect(out.status).toBe(303);
    expect(b.cookies.has(SESSION_COOKIE)).toBe(false);
    expect((await b.get("/accounts")).headers.get("location")).toBe("/login?return=%2Faccounts");
  });
});
```

This test imports `createWorker` from `../src/index`, which Task 7 finishes. Step 4 gives `index.ts` a temporary `createWorker` that mounts only the web router, and Task 7 replaces it with the provider. The logout and reauth tokens are read from the landing page `/`, which renders the header forms whenever a session exists; that stays true after Task 11, so nothing here is a stand-in.

- [ ] **Step 2: run, expect failure**

Run: `cd worker && npx vitest run test/login.test.ts`
Expected: FAIL, `createWorker` is not exported.

- [ ] **Step 3 (GREEN): state.ts and router.ts**

`worker/src/web/state.ts`:

```ts
export type StateKind = "login" | "reauth" | "connect" | "authreq";

export async function putState(
  db: D1Database,
  kind: StateKind,
  id: string,
  payload: object,
  ttlMs: number,
): Promise<void> {
  const now = Date.now();
  await db
    .prepare("INSERT INTO oauth_states (id, kind, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, kind, JSON.stringify(payload), now, now + ttlMs)
    .run();
}

/**
 * One statement, one winner. A second caller with the same id sees zero rows, whether the first
 * consumed it a millisecond ago or in another colo. This is the property KV could not give.
 */
export async function consumeState<T>(db: D1Database, kind: StateKind, id: string | null): Promise<T | null> {
  if (!id || !/^[a-z]{2}_[A-Za-z0-9_-]{22}$/.test(id)) return null;
  const now = Date.now();
  const row = await db
    .prepare(
      "UPDATE oauth_states SET consumed_at = ? WHERE id = ? AND kind = ? AND consumed_at IS NULL AND expires_at > ? RETURNING payload",
    )
    .bind(now, id, kind, now)
    .first<{ payload: string }>();
  return row ? (JSON.parse(row.payload) as T) : null;
}

export async function purgeStates(db: D1Database, now: number, limit = 200): Promise<number> {
  const res = await db
    .prepare("DELETE FROM oauth_states WHERE id IN (SELECT id FROM oauth_states WHERE expires_at <= ? LIMIT ?)")
    .bind(now - 3_600_000, limit)
    .run();
  return res.meta.changes ?? 0;
}
```

`purgeStates` is called from `runCron` (Task 13 wires it). Consumed rows stay for an hour past expiry so a replay after consumption is still a zero-row update rather than an unknown id; both answers are the same 400, so this is bookkeeping rather than security.

`worker/src/web/router.ts`:

```ts
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Deps } from "../deps";
import type { Env } from "../env";
import { checkOrigin, csrfToken, verifyCsrf } from "./csrf";
import { type Chrome, escapeHtml, htmlResponse, isInternalPath, redirect } from "./html";
import { isRecentlyAuthenticated, readSession, type Session } from "./session";
import { staticHandler } from "./static";

export type Ctx = { request: Request; env: Env; deps: Deps; url: URL; params: string[] };
export type Route = { method: "GET" | "POST"; pattern: RegExp; handler: (ctx: Ctx) => Promise<Response> };

const FORM_CAP = 64 * 1024;

export async function readForm(request: Request): Promise<URLSearchParams> {
  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > FORM_CAP) throw new GmailMcpError("limit_exceeded", "form too large");
  const text = await request.text();
  if (text.length > FORM_CAP) throw new GmailMcpError("limit_exceeded", "form too large");
  return new URLSearchParams(text);
}

export async function requireSession(env: Env, request: Request): Promise<Session | Response> {
  const s = await readSession(env.DB, request);
  if (s) return s;
  const url = new URL(request.url);
  return redirect(`/login?return=${encodeURIComponent(url.pathname + url.search)}`);
}

async function chrome(env: Env, session: Session): Promise<NonNullable<Chrome>> {
  return {
    logoutCsrf: await csrfToken(env, session, "POST", "/logout", ""),
    reauthCsrf: await csrfToken(env, session, "POST", "/reauth", ""),
  };
}

export async function page(
  env: Env,
  session: Session,
  title: string,
  body: string,
  status = 200,
  extraFormActions: string[] = [],
): Promise<Response> {
  return htmlResponse(title, body, await chrome(env, session), status, extraFormActions);
}

/** Spec 4.6: a fresh Google login, not activity, unlocks policy edits and revocations. */
export async function requireRecent(env: Env, session: Session, request: Request): Promise<Response | null> {
  if (isRecentlyAuthenticated(session)) return null;
  const url = new URL(request.url);
  const c = await chrome(env, session);
  return page(
    env,
    session,
    "Recent login required",
    `<p>This change needs a login within the last 15 minutes.</p>
<form method="post" action="/reauth"><input type="hidden" name="csrf" value="${escapeHtml(c.reauthCsrf)}"><input type="hidden" name="return" value="${escapeHtml(url.pathname)}"><button>Re-authenticate with Google</button></form>`,
    403,
  );
}

/** Every state-changing POST: same-origin, then the per-form token. Order matters only for the message. */
export async function guardPost(
  env: Env,
  request: Request,
  session: Session,
  form: URLSearchParams,
  route: string,
  objectId: string,
): Promise<Response | null> {
  if (!checkOrigin(request, env)) return page(env, session, "Refused", "<p>Cross-origin form post refused.</p>", 403);
  if (!(await verifyCsrf(env, session, "POST", route, objectId, form.get("csrf") ?? ""))) {
    return page(env, session, "Refused", "<p>The form token is missing, expired or for a different object.</p>", 403);
  }
  return null;
}

export function returnPath(url: URL, fallback = "/accounts"): string {
  const r = url.searchParams.get("return");
  return r && isInternalPath(r) ? r : fallback;
}

const STATUS: Partial<Record<string, number>> = {
  unauthorized: 401,
  forbidden: 403,
  account_not_found: 404,
  limit_exceeded: 413,
  invalid_address: 400,
  invalid_header: 400,
};

export function webHandler(deps: Deps, routes: Route[]): ExportedHandler<Env> {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const asset = staticHandler(request);
      if (asset) return asset;
      for (const r of routes) {
        if (r.method !== request.method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        try {
          return await r.handler({ request, env, deps, url, params: m.slice(1) });
        } catch (e) {
          if (e instanceof GmailMcpError) {
            return htmlResponse("Error", `<p>${e.code}</p>`, null, STATUS[e.code] ?? 400);
          }
          console.error("web handler failure", (e as Error).message);
          return htmlResponse("Error", "<p>Something went wrong.</p>", null, 500);
        }
      }
      return htmlResponse("Not found", "<p>No such page.</p>", null, 404);
    },
  };
}
```

The error page passes an empty logout token: a CSRF token that verifies for nothing is harmless, and the alternative is loading a session inside an error path.

- [ ] **Step 4 (GREEN): login.ts and a temporary createWorker**

`worker/src/web/login.ts`:

```ts
import type { Env } from "../env";
import { ownerEmails, ownerSubs } from "../env";
import { randomId } from "../crypto/random";
import { LOGIN_SCOPES, buildAuthUrl, exchangeCode, verifyIdToken } from "../google/oidc";
import { escapeHtml, htmlResponse, isInternalPath, redirect } from "./html";
import { type Ctx, type Route, guardPost, page, readForm, requireSession, returnPath } from "./router";
import { clearCookie, createSession, markReauthenticated, readSession, revokeSession } from "./session";
import { consumeState, putState } from "./state";
import { clearApprovedCookie } from "../auth/authorize";

export const OIDC_TTL_MS = 600_000;
export type OidcState = {
  nonce: string;
  returnTo: string;
  sessionIdHash?: string;
  userId?: string;
  alias?: string;
};

export function loginRedirectUri(env: Env): string {
  return `https://${env.WORKER_HOSTNAME}/oidc/callback`;
}

export async function startLogin(
  env: Env,
  o: { returnTo: string; purpose: "login" | "reauth"; sessionIdHash?: string },
): Promise<Response> {
  const state = randomId("st");
  const nonce = randomId("nc");
  const rec: OidcState = { nonce, returnTo: o.returnTo };
  if (o.sessionIdHash) rec.sessionIdHash = o.sessionIdHash;
  await putState(env.DB, o.purpose, state, rec, OIDC_TTL_MS);
  const url = buildAuthUrl(env, {
    redirectUri: loginRedirectUri(env),
    scope: LOGIN_SCOPES,
    state,
    nonce,
    offline: false,
  });
  // Not redirect(): this one leaves the origin on purpose, to Google, from a URL we built ourselves.
  return new Response(null, { status: 303, headers: { location: url, "cache-control": "no-store" } });
}

async function oidcCallback(ctx: Ctx): Promise<Response> {
  const { env, deps, url, request } = ctx;
  // The kind is part of the consume, so a connect state cannot be replayed here and vice versa. The
  // purpose is recovered from which kind matched.
  const stateId = url.searchParams.get("state");
  let purpose: "login" | "reauth" = "login";
  let st = await consumeState<OidcState>(env.DB, "login", stateId);
  if (!st) {
    st = await consumeState<OidcState>(env.DB, "reauth", stateId);
    purpose = "reauth";
  }
  if (!st)
    return htmlResponse("Login failed", "<p>Login state is missing or was already used. Start again.</p>", null, 400);
  if (url.searchParams.get("error"))
    return htmlResponse(
      "Login failed",
      `<p>Google refused: ${escapeHtml(url.searchParams.get("error")!)}</p>`,
      null,
      400,
    );
  const code = url.searchParams.get("code");
  if (!code) return htmlResponse("Login failed", "<p>No code.</p>", null, 400);

  const tokens = await exchangeCode(env, deps, { code, redirectUri: loginRedirectUri(env) });
  const id = await verifyIdToken(env, deps, tokens.id_token, { nonce: st.nonce });

  const subs = ownerSubs(env);
  if (subs.length === 0) {
    if (ownerEmails(env).includes(id.email)) {
      return htmlResponse(
        "Set up the owner",
        `<p>No owner is configured yet. Confirm this is the Google account you intend to trust, then set the
Worker secret <code>OWNER_GOOGLE_SUBS</code> to this value and log in again:</p>
<pre>${escapeHtml(id.sub)}</pre>
<p class="muted">Signed in as ${escapeHtml(id.email)}. Nothing was stored. For an address that is not a Gmail or
Workspace mailbox, Google verifies that the address was confirmed once, not that it is still under your control.</p>`,
        null,
      );
    }
    return htmlResponse(
      "Not the owner",
      "<p>This deployment has no owner yet and your address is not in the bootstrap list.</p>",
      null,
      403,
    );
  }
  if (!subs.includes(id.sub))
    return htmlResponse("Not the owner", "<p>This deployment belongs to someone else.</p>", null, 403);

  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO users (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email",
  )
    .bind(id.sub, id.email, now)
    .run();

  if (purpose === "reauth") {
    const current = await readSession(env.DB, request);
    if (!current || current.idHash !== st.sessionIdHash || current.userId !== id.sub) {
      return htmlResponse(
        "Reauthentication failed",
        "<p>The session changed or a different Google account was used.</p>",
        null,
        403,
      );
    }
    await markReauthenticated(env.DB, current.idHash);
    return redirect(st.returnTo);
  }

  // Rotation: whatever cookie arrived is revoked (if it was ours) and replaced. A value an attacker
  // planted before login never becomes an authenticated session.
  const previous = await readSession(env.DB, request);
  if (previous) await revokeSession(env.DB, previous.idHash);
  const fresh = await createSession(env.DB, id.sub);
  const res = redirect(st.returnTo);
  res.headers.append("set-cookie", fresh.cookie);
  // Remembered consent belongs to one owner. A different owner on this browser starts with none.
  if (!previous || previous.userId !== id.sub) res.headers.append("set-cookie", clearApprovedCookie());
  return res;
}

export const loginRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/$/,
    handler: async ({ env, request }) => {
      const s = await readSession(env.DB, request);
      if (s)
        return page(
          env,
          s,
          "gmail-mcp",
          `<p><a href="/accounts">Accounts</a> · <a href="/policy">Policy</a> · <a href="/audit">Audit</a></p>`,
        );
      return htmlResponse("gmail-mcp", `<p><a href="/login">Log in with Google</a></p>`, null);
    },
  },
  {
    method: "GET",
    pattern: /^\/login$/,
    handler: ({ env, url }) => startLogin(env, { returnTo: returnPath(url), purpose: "login" }),
  },
  { method: "GET", pattern: /^\/oidc\/callback$/, handler: oidcCallback },
  {
    method: "POST",
    pattern: /^\/reauth$/,
    handler: async ({ env, request }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const form = await readForm(request);
      const refused = await guardPost(env, request, s, form, "/reauth", "");
      if (refused) return refused;
      const back = form.get("return") ?? "";
      return startLogin(env, {
        returnTo: isInternalPath(back) ? back : "/accounts",
        purpose: "reauth",
        sessionIdHash: s.idHash,
      });
    },
  },
  {
    method: "POST",
    pattern: /^\/logout$/,
    handler: async ({ env, request }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const form = await readForm(request);
      const refused = await guardPost(env, request, s, form, "/logout", "");
      if (refused) return refused;
      await revokeSession(env.DB, s.idHash);
      const res = redirect("/");
      res.headers.append("set-cookie", clearCookie());
      return res;
    },
  },
];
```

Temporary `worker/src/index.ts` (Task 7 replaces this whole file):

```ts
import type { Env } from "./env";
import { runCron } from "./cron";
import { defaultDeps, type Deps } from "./deps";
import { loginRoutes } from "./web/login";
import { webHandler } from "./web/router";

export function createWorker(deps: Deps = defaultDeps): ExportedHandler<Env> {
  const web = webHandler(deps, [...loginRoutes]);
  return {
    fetch: (request, env, ctx) => web.fetch!(request, env, ctx),
    scheduled(_controller, env, ctx) {
      ctx.waitUntil(runCron(env, Date.now()));
    },
  };
}

export default createWorker();
```

This drops the dev bearer from `/mcp` for the space of one task; `test/mcp.test.ts` fails until Task 7, which is the task that gives `/mcp` its real gate. Run only `login.test.ts` here.

- [ ] **Step 5: run, expect PASS (6 tests), then commit**

Run: `cd worker && npx vitest run test/login.test.ts`

```bash
git add worker/src/web/state.ts worker/src/web/router.ts worker/src/web/login.ts worker/src/index.ts worker/test/browser.ts worker/test/login.test.ts
git commit -m "feat(worker): owner login through Google OIDC with atomically consumed state, owner gating, session rotation, reauth and logout

State lives in D1 and is consumed by one UPDATE ... RETURNING. KV get-then-delete is not
one-use: it races within a colo and is eventually consistent across them.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: OAuthProvider in front of /mcp and /staging, the consent page, scope policy, and the end of the dev bearer

**Files:**

- Create: `worker/src/auth/principal.ts`, `worker/src/auth/scopes.ts`, `worker/src/auth/companion.ts`, `worker/src/auth/authorize.ts`, `worker/src/staging/routes.ts`, `worker/test/oauth.test.ts`
- Modify: `worker/src/index.ts`, `worker/src/mcp/server.ts`, `worker/test/mcp-client.ts`, `worker/test/mcp.test.ts`, `worker/test/browser.ts`, `worker/test/smoke.test.ts`
- Delete: `worker/src/mcp/auth-dev.ts`

**Interfaces:**

- `Principal = { userId: string; email: string; scope: Scope }`, `Scope = "mcp" | "staging"`.
- `scopes.ts`: `SCOPES`, `audienceFor(env, scope): string` (`https://<host>/mcp` or `https://<host>/staging`), `allowedScopeForClient(db, clientId): Promise<Scope>`, `resolveGrantedScope(requested: string[], allowed: Scope): Scope | null`.
- `companion.ts`: `COMPANION_KEY = "companion_client_id"`, `getCompanionClientId(db): Promise<string | null>` (returns `null` while the value is the reservation marker `pending`), `registerCompanionClient(env, source): Promise<string>`; registration is serialised through a reservation row so two concurrent calls create one provider client, and a failed creation releases the reservation.
- `principal.ts`: `requireScope(request, env, scope): Promise<Principal | Response>`.
- `authorize.ts`: `authorizeRoutes: Route[]` for `GET /authorize`, `GET /authorize/:id`, `POST /authorize/:id`. An `oauth_states` row of kind `authreq` (600 s) holds `{ request: AuthRequest, clientName: string, redirectUri: string, scope: Scope }`; the consent GET reads it without consuming, and the decision (approve, deny, or the remembered-client shortcut) consumes it atomically before `completeAuthorization`, so one consent request yields at most one grant. Approved-clients cookie `__Host-approved` = `<b64url json {sub, clients}>.<hmac token>` signed with `STATE_HMAC_KEY`, purpose `gmail-mcp:approved-clients:v1`, 30 days; it is honoured only when `sub` equals the session's owner, and the login callback clears it whenever the owner changes.
- `staging/routes.ts`: `stagingApiHandler(deps): ExportedHandler<Env>` serving `GET /staging/<handle>` (streams the object with `content-type`, `content-length`, `content-disposition: attachment; filename*=UTF-8''<encoded>`, `x-sha256`) and `POST /staging/<handle>/ack` (204 or 404). Both call `requireScope(..., "staging")`. Anything else under `/staging/` is 404 after the gate. `/staging/intent` and `PUT /staging/<ticket>` are Plan 4.
- `index.ts`: `createWorker(deps): ExportedHandler<Env>` wrapping one cached `OAuthProvider` per hostname. `default` export is `createWorker()`.
- `server.ts`: `buildServer(env, principal, deps)`; `Principal` now comes from `../auth/principal`.
- Test helpers: `mintToken(worker, env, g, o): Promise<{ accessToken: string; refreshToken?: string; clientId: string; browser: Browser }>` in `browser.ts`; `rpc(worker, env, token, method, params, id)` in `mcp-client.ts` posting to `HOST + "/mcp"`.

- [ ] **Step 1 (RED): update helpers and write the tests**

Replace `worker/test/mcp-client.ts`:

```ts
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { Env } from "../src/env";
import { HOST } from "./test-env";

type Worker = { fetch: (r: Request, e: Env, c: ExecutionContext) => Promise<Response> | Response };

export async function rpc(
  worker: Worker,
  env: Env,
  token: string | null,
  method: string,
  params: unknown,
  id = 1,
  path = "/mcp",
): Promise<{ status: number; json: any; headers: Headers }> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await worker.fetch(
    new Request(HOST + path, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }),
    { ...env },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let json: any = null;
  if (text.trim().startsWith("{")) json = JSON.parse(text);
  else {
    const line = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("data:"))
      .pop();
    if (line) json = JSON.parse(line.slice(5));
  }
  return { status: res.status, json, headers: res.headers };
}
```

Append to `worker/test/browser.ts`:

```ts
import { b64url } from "../src/crypto/random";

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const verifier = b64url(raw);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}

export async function registerClient(worker: Worker, env: Env, redirectUri: string): Promise<string> {
  const b = new Browser(worker, env);
  const res = await b.fetch("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "test client",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (res.status !== 201) throw new Error(`register ${res.status} ${await res.text()}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

/**
 * The whole Flow A as a client would run it: DCR (unless a client id is given), owner login, consent,
 * code exchange with PKCE. Returns the token and the browser that holds the owner's session.
 */
export async function mintToken(
  worker: Worker,
  env: Env,
  g: FakeGoogle,
  o: {
    scope: "mcp" | "staging" | string;
    clientId?: string;
    redirectUri?: string;
    resource?: string | null;
    browser?: Browser;
    sub?: string;
    email?: string;
    decision?: "approve" | "deny";
  },
): Promise<{
  accessToken: string;
  refreshToken?: string;
  clientId: string;
  browser: Browser;
  authorizeStatus: number;
  location: string | null;
}> {
  const redirectUri = o.redirectUri ?? "http://localhost:5555/callback";
  const clientId = o.clientId ?? (await registerClient(worker, env, redirectUri));
  const b = o.browser ?? new Browser(worker, env);
  if (!o.browser) await b.login(g, { sub: o.sub ?? "owner-sub", email: o.email ?? "owner@example.test" });
  const { verifier, challenge } = await pkce();
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: o.scope,
    state: "client-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (o.resource !== null) q.set("resource", o.resource ?? `${HOST}/${o.scope === "staging" ? "staging" : "mcp"}`);
  let res = await b.get(`/authorize?${q.toString()}`);
  const authorizeStatus = res.status;
  let location = res.headers.get("location");
  if (res.status === 303 && location?.startsWith("/authorize/")) {
    const consentPath = location;
    res = await b.get(consentPath);
    location = res.headers.get("location");
    if (res.status === 200) {
      // A remembered client answers the GET with a redirect instead; only a rendered page has a form.
      const csrf = csrfFrom(await res.text(), consentPath);
      res = await b.post(consentPath, { decision: o.decision ?? "approve", csrf });
      location = res.headers.get("location");
    }
  }
  if (!location || !location.startsWith(redirectUri)) {
    return { accessToken: "", clientId, browser: b, authorizeStatus, location };
  }
  const code = new URL(location).searchParams.get("code");
  if (!code) return { accessToken: "", clientId, browser: b, authorizeStatus, location };
  const tok = await b.fetch("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }).toString(),
  });
  if (tok.status !== 200) throw new Error(`token ${tok.status} ${await tok.text()}`);
  const body = (await tok.json()) as { access_token: string; refresh_token?: string };
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    clientId,
    browser: b,
    authorizeStatus,
    location,
  };
}
```

`csrfFrom(html, consentPath)` scopes the token search to the consent form, whose action is exactly that path. When the approved-clients cookie skips consent, `GET /authorize/<id>` answers with a redirect straight to the client and the function falls through to the code exchange.

Replace `worker/test/mcp.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index";
import { seedUserAndAccount } from "./fixtures";
import { rpc } from "./mcp-client";
import { FakeGoogle } from "./fake-google";
import { mintToken } from "./browser";
import { testEnv } from "./test-env";

const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } };
let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
let token: string;

beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker({ googleFetch: g.fetch });
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "ma", alias: "personal", isDefault: true });
  token = (await mintToken(worker, testEnv(), g, { scope: "mcp" })).accessToken;
});

describe("/mcp auth gate", () => {
  it("401 with a resource_metadata challenge and no session leakage without a bearer", async () => {
    const res = await rpc(worker, testEnv(), null, "initialize", INIT);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource/mcp");
    expect((await rpc(worker, testEnv(), "not-a-token", "initialize", INIT)).status).toBe(401);
  });
});

describe("protocol", () => {
  it("initialize then tools/list returns the control tools", async () => {
    const init = await rpc(worker, testEnv(), token, "initialize", INIT, 1);
    expect(init.status).toBe(200);
    expect(init.json?.result?.serverInfo?.name).toBe("gmail-mcp");
    const list = await rpc(worker, testEnv(), token, "tools/list", {}, 2);
    const names = (list.json?.result?.tools ?? []).map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["cancel_pending", "get_policy", "list_accounts", "list_pending"]);
  });
  it("get_policy resolves the default account of the token's owner", async () => {
    const call = await rpc(worker, testEnv(), token, "tools/call", { name: "get_policy", arguments: {} }, 3);
    const parsed = JSON.parse(call.json?.result?.content?.[0]?.text as string);
    expect(parsed.account).toBe("personal");
    expect(parsed.policy["send.message"]).toBe("ask");
    expect(parsed.policy["policy.edit"]).toBe("browser");
  });
});
```

`worker/test/oauth.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index";
import { Browser, csrfFrom, mintToken, registerClient } from "./browser";
import { FakeGoogle } from "./fake-google";
import { rpc } from "./mcp-client";
import { HOST, testEnv } from "./test-env";
import { registerCompanionClient } from "../src/auth/companion";
import { requireScope } from "../src/auth/principal";
import { seedUserAndAccount } from "./fixtures";

const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } };
let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker({ googleFetch: g.fetch });
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "oa", alias: "personal", isDefault: true });
});

describe("discovery", () => {
  it("serves AS metadata with S256 only and CIMD on, and PRM for /mcp", async () => {
    const b = new Browser(worker, testEnv());
    const as = (await (await b.get("/.well-known/oauth-authorization-server")).json()) as any;
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.registration_endpoint).toBe(`${HOST}/register`);
    const prm = (await (await b.get("/.well-known/oauth-protected-resource/mcp")).json()) as any;
    expect(prm.resource).toBe(`${HOST}/mcp`);
    expect(prm.authorization_servers).toEqual([HOST]);
    expect(prm.scopes_supported).toEqual(["mcp", "staging"]);
    const staging = (await (await b.get("/.well-known/oauth-protected-resource/staging")).json()) as any;
    expect(staging.resource).toBe(`${HOST}/staging`);
    expect(staging.authorization_servers).toEqual([HOST]);
  });
});

describe("scope policy at /authorize", () => {
  it("a DCR client gets mcp, and is refused staging or both", async () => {
    const ok = await mintToken(worker, testEnv(), g, { scope: "mcp" });
    expect(ok.accessToken).not.toBe("");
    const staging = await mintToken(worker, testEnv(), g, { scope: "staging", resource: `${HOST}/staging` });
    expect(staging.accessToken).toBe("");
    expect(staging.location).toContain("error=invalid_scope");
    const both = await mintToken(worker, testEnv(), g, { scope: "mcp staging" });
    expect(both.location).toContain("error=invalid_scope");
  });
  it("the companion client gets staging only", async () => {
    const e = testEnv();
    const b = new Browser(worker, e);
    await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
    const companionId = await registerCompanionClient({ ...e, OAUTH_PROVIDER: undefined as never }, worker);
    const st = await mintToken(worker, e, g, {
      scope: "staging",
      clientId: companionId,
      redirectUri: "http://127.0.0.1:61234/callback",
      browser: b,
    });
    expect(st.accessToken).not.toBe("");
    const mcp = await mintToken(worker, e, g, {
      scope: "mcp",
      clientId: companionId,
      redirectUri: "http://127.0.0.1:9/callback",
      browser: b,
    });
    expect(mcp.location).toContain("error=invalid_scope");
  });
  it("an empty scope request receives the client's one allowed scope", async () => {
    const t = await mintToken(worker, testEnv(), g, { scope: "" });
    expect(t.accessToken).not.toBe("");
    expect((await rpc(worker, testEnv(), t.accessToken, "initialize", INIT)).status).toBe(200);
  });
  it("a resource that is not the audience for the scope is invalid_target", async () => {
    const t = await mintToken(worker, testEnv(), g, { scope: "mcp", resource: `${HOST}/staging` });
    expect(t.location).toContain("error=invalid_target");
  });
});

describe("tokens at the routes", () => {
  it("an mcp token cannot reach /staging and a staging token cannot reach /mcp", async () => {
    const e = testEnv();
    const b = new Browser(worker, e);
    await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
    const companionId = await registerCompanionClient({ ...e, OAUTH_PROVIDER: undefined as never }, worker);
    const mcp = await mintToken(worker, e, g, { scope: "mcp", browser: b });
    const st = await mintToken(worker, e, g, {
      scope: "staging",
      clientId: companionId,
      redirectUri: "http://127.0.0.1:5/callback",
      browser: b,
    });
    const cross1 = await b.fetch("/staging/sh_x", { headers: { authorization: `Bearer ${mcp.accessToken}` } });
    expect(cross1.status).toBe(401);
    const cross2 = await rpc(worker, e, st.accessToken, "initialize", INIT);
    expect(cross2.status).toBe(401);
    const own = await b.fetch("/staging/sh_nope", { headers: { authorization: `Bearer ${st.accessToken}` } });
    expect(own.status).toBe(404);
  });
  it("requireScope refuses a token whose scope does not include the route's, and whose props disagree with the token owner", async () => {
    const stub = (scope: string[], sub: string) =>
      ({
        OAUTH_PROVIDER: {
          unwrapToken: async () => ({
            userId: "owner-sub",
            scope,
            audience: `${HOST}/mcp`,
            grant: { clientId: "c", props: { sub, email: "o@x" } },
          }),
        },
        WORKER_HOSTNAME: "gmail-mcp.example.workers.dev",
      }) as never;
    const req = new Request(`${HOST}/mcp`, { headers: { authorization: "Bearer a:b:c" } });
    const bad = await requireScope(req, stub(["staging"], "owner-sub"), "mcp");
    expect(bad instanceof Response && bad.status).toBe(403);
    const tampered = await requireScope(req, stub(["mcp"], "someone-else"), "mcp");
    expect(tampered instanceof Response && tampered.status).toBe(401);
    const good = await requireScope(req, stub(["mcp"], "owner-sub"), "mcp");
    expect(good).toMatchObject({ userId: "owner-sub", scope: "mcp" });
  });
});

describe("authorization endpoint hardening", () => {
  it("redirect_uri substitution is rendered locally, never redirected", async () => {
    const clientId = await registerClient(worker, testEnv(), "http://localhost:5555/callback");
    const b = new Browser(worker, testEnv());
    await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
    const res = await b.get(
      `/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent("https://evil.test/cb")}&scope=mcp&state=s&code_challenge=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&code_challenge_method=S256`,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });
  it("an authorization code is single use", async () => {
    const e = testEnv();
    const t = await mintToken(worker, e, g, { scope: "mcp" });
    const code = new URL(t.location!).searchParams.get("code")!;
    const replay = await t.browser.fetch("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:5555/callback",
        client_id: t.clientId,
        code_verifier: "x".repeat(43),
      }).toString(),
    });
    expect(replay.status).toBe(400);
  });
  it("consent requires a session, the right CSRF token, and denial returns access_denied to the client", async () => {
    const e = testEnv();
    const clientId = await registerClient(worker, e, "http://localhost:5555/callback");
    const anon = new Browser(worker, e);
    const q = `response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent("http://localhost:5555/callback")}&scope=mcp&state=s&code_challenge=${"a".repeat(43)}&code_challenge_method=S256&resource=${encodeURIComponent(HOST + "/mcp")}`;
    const start = await anon.get(`/authorize?${q}`);
    expect(start.status).toBe(303);
    const consentPath = start.headers.get("location")!;
    expect((await anon.get(consentPath)).headers.get("location")).toContain("/login?return=");

    await anon.login(g, { sub: "owner-sub", email: "owner@example.test" });
    const consent = await anon.get(consentPath);
    expect(consent.status).toBe(200);
    expect(consent.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://accounts.google.com http://localhost:5555",
    );
    const html = await consent.text();
    expect(html).toContain("test client");
    expect((await anon.post(consentPath, { decision: "approve", csrf: "wrong" })).status).toBe(403);
    expect(
      (await anon.post(consentPath, { decision: "approve", csrf: "wrong" }, { origin: "https://evil.test" })).status,
    ).toBe(403);
    const denied = await mintToken(worker, e, g, { scope: "mcp", clientId, browser: anon, decision: "deny" });
    expect(denied.location).toContain("error=access_denied");
    expect(denied.location).toContain("state=client-state");
    expect(denied.location).toContain("iss=");
  });
  it("a remembered client skips consent for the same owner only", async () => {
    const e = testEnv({ OWNER_GOOGLE_SUBS: "owner-sub,owner-two" });
    const first = await mintToken(worker, e, g, { scope: "mcp" });
    const again = await mintToken(worker, e, g, { scope: "mcp", clientId: first.clientId, browser: first.browser });
    expect(again.accessToken).not.toBe("");
    expect(first.browser.cookies.has("__Host-approved")).toBe(true);
    // Same browser, different owner: the cookie names owner-sub, so owner-two must see the consent page.
    await first.browser.login(g, { sub: "owner-two", email: "two@example.test" });
    expect(first.browser.cookies.has("__Host-approved")).toBe(false);
    const q = new URLSearchParams({
      response_type: "code",
      client_id: first.clientId,
      redirect_uri: "http://localhost:5555/callback",
      scope: "mcp",
      state: "s",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
    });
    const start = await first.browser.get(`/authorize?${q.toString()}`);
    const consent = await first.browser.get(start.headers.get("location")!);
    expect(consent.status).toBe(200);
    expect(await consent.text()).toContain('name="decision" value="approve"');
  });

  it("two consent decisions racing on one request produce one grant", async () => {
    const e = testEnv();
    const clientId = await registerClient(worker, e, "http://localhost:5555/callback");
    const b = new Browser(worker, e);
    await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "http://localhost:5555/callback",
      scope: "mcp",
      state: "s",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
    });
    const consentPath = (await b.get(`/authorize?${q.toString()}`)).headers.get("location")!;
    const csrf = csrfFrom(await (await b.get(consentPath)).text(), consentPath);
    const [r1, r2] = await Promise.all([
      b.post(consentPath, { decision: "approve", csrf }),
      b.post(consentPath, { decision: "approve", csrf }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([302, 410]);
  });

  it("companion registration under concurrency creates one client", async () => {
    const e = testEnv();
    await env.DB.prepare("DELETE FROM settings WHERE key = 'companion_client_id'").run();
    const ids = await Promise.all([
      registerCompanionClient({ ...e, OAUTH_PROVIDER: undefined as never }, worker),
      registerCompanionClient({ ...e, OAUTH_PROVIDER: undefined as never }, worker),
    ]);
    expect(ids[0]).toBe(ids[1]);
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'companion_client_id'").first<{
      value: string;
    }>();
    expect(row?.value).toBe(ids[0]);
  });
});
```

`registerCompanionClient` in the test is called with `worker` as a second argument: the helper needs an `OAuthHelpers` and outside a request there is none, so `companion.ts` exports `registerCompanionClient(env, workerOrHelpers)`; see Step 3 for how it gets the helpers.

- [ ] **Step 2: run, expect failure**

Run: `cd worker && npx vitest run test/oauth.test.ts test/mcp.test.ts`
Expected: FAIL on the missing `auth/` modules.

- [ ] **Step 3 (GREEN): scopes, companion, principal**

`worker/src/auth/scopes.ts`:

```ts
import type { Env } from "../env";
import { getCompanionClientId } from "./companion";

export const SCOPES = ["mcp", "staging"] as const;
export type Scope = (typeof SCOPES)[number];

export function audienceFor(env: Env, scope: Scope): string {
  return `https://${env.WORKER_HOSTNAME}/${scope}`;
}

/** Spec 4.1: the companion may hold staging; everyone else may hold mcp. The library does not do this for us. */
export async function allowedScopeForClient(db: D1Database, clientId: string): Promise<Scope> {
  const companion = await getCompanionClientId(db);
  return companion !== null && clientId === companion ? "staging" : "mcp";
}

export function resolveGrantedScope(requested: string[], allowed: Scope): Scope | null {
  const set = new Set(requested.filter((s) => s !== ""));
  if (set.size === 0) return allowed;
  if (set.size === 1 && set.has(allowed)) return allowed;
  return null;
}
```

`worker/src/auth/companion.ts`:

```ts
import { getOAuthApi, type OAuthHelpers, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";

export const COMPANION_KEY = "companion_client_id";

const PENDING = "pending";

export async function getCompanionClientId(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind(COMPANION_KEY)
    .first<{ value: string }>();
  return row && row.value !== PENDING ? row.value : null;
}

/**
 * One public client, created once, id stored in settings. createClient() picks the id, so a
 * pre-agreed name like "companion" is not an option; the owner copies the id from the Accounts page.
 * Loopback redirect URIs match on any port, which is what the companion's ephemeral port needs.
 */
export type HelpersSource = OAuthHelpers | { oauthOptions: (env: Env) => OAuthProviderOptions<Env> };

export async function registerCompanionClient(env: Env, source: HelpersSource): Promise<string> {
  const existing = await getCompanionClientId(env.DB);
  if (existing) return existing;
  // Reserve first. The primary key makes exactly one caller the creator; everyone else waits on the
  // stored value, so the provider never ends up with an orphan client that would be classed as "mcp".
  const reserved = await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(COMPANION_KEY, PENDING, Date.now())
    .run();
  if ((reserved.meta.changes ?? 0) !== 1) {
    for (let i = 0; i < 20; i++) {
      const id = await getCompanionClientId(env.DB);
      if (id) return id;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("companion registration in progress; retry");
  }
  // Inside a request the provider has put OAuthHelpers on env; outside one (tests, a future CLI) the
  // worker's own options rebuild the same helpers over the same KV.
  const helpers: OAuthHelpers = "createClient" in source ? source : getOAuthApi(source.oauthOptions(env), env);
  try {
    const client = await helpers.createClient({
      clientName: "gmail-mcp-companion",
      redirectUris: ["http://127.0.0.1/callback", "http://localhost/callback"],
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
    });
    await env.DB.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ? AND value = ?")
      .bind(client.clientId, Date.now(), COMPANION_KEY, PENDING)
      .run();
    return client.clientId;
  } catch (e) {
    await env.DB.prepare("DELETE FROM settings WHERE key = ? AND value = ?").bind(COMPANION_KEY, PENDING).run();
    throw e;
  }
}
```

`createWorker` (Step 5) attaches `oauthOptions` to the returned handler so a test, or a future CLI, can call `registerCompanionClient(env, worker)` outside a request; inside a request the Accounts page passes `env.OAUTH_PROVIDER`. The test above passes `{ ...e, OAUTH_PROVIDER: undefined as never }` only to make explicit that no helpers are on that env.

`worker/src/auth/principal.ts`:

```ts
import type { Env } from "../env";
import { audienceFor, type Scope } from "./scopes";

export type Principal = { userId: string; email: string; scope: Scope };

function challenge(env: Env, scope: Scope, error?: string): string {
  const parts = [
    `Bearer realm="OAuth"`,
    `resource_metadata="https://${env.WORKER_HOSTNAME}/.well-known/oauth-protected-resource/${scope}"`,
  ];
  if (error) parts.push(`error="${error}"`, `scope="${scope}"`);
  return parts.join(", ");
}

/**
 * The provider has already checked signature, expiry and audience before this runs. This is the part
 * it leaves to the application: the token's scope must cover the route, and the props must belong to
 * the token's owner. user_id comes from here and nowhere else (spec 3.1).
 */
export async function requireScope(request: Request, env: Env, scope: Scope): Promise<Principal | Response> {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  const token = m ? await env.OAUTH_PROVIDER.unwrapToken<{ sub?: string; email?: string }>(m[1]!) : null;
  if (!token)
    return new Response(null, { status: 401, headers: { "www-authenticate": challenge(env, scope, "invalid_token") } });
  if (!token.scope.includes(scope)) {
    return new Response(null, {
      status: 403,
      headers: { "www-authenticate": challenge(env, scope, "insufficient_scope") },
    });
  }
  const aud = Array.isArray(token.audience) ? token.audience : token.audience ? [token.audience] : [];
  if (!aud.includes(audienceFor(env, scope))) {
    return new Response(null, { status: 401, headers: { "www-authenticate": challenge(env, scope, "invalid_token") } });
  }
  const props = token.grant.props;
  if (typeof props?.sub !== "string" || props.sub !== token.userId || typeof props.email !== "string") {
    return new Response(null, { status: 401, headers: { "www-authenticate": challenge(env, scope, "invalid_token") } });
  }
  return { userId: props.sub, email: props.email, scope };
}
```

- [ ] **Step 4 (GREEN): authorize.ts**

`worker/src/auth/authorize.ts`:

```ts
import { AuthorizationError, CimdFetchError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";
import { randomId } from "../crypto/random";
import { signToken, verifyToken } from "../crypto/hmac";
import { escapeHtml, escapeVisible, htmlResponse, redirect } from "../web/html";
import { type Route, guardPost, page, readForm, requireSession } from "../web/router";
import { csrfToken } from "../web/csrf";
import { consumeState, putState } from "../web/state";
import { allowedScopeForClient, audienceFor, resolveGrantedScope, type Scope } from "./scopes";

const AUTHREQ_TTL_MS = 600_000;
export const APPROVED_COOKIE = "__Host-approved";
const APPROVED_PURPOSE = "gmail-mcp:approved-clients:v1";
const APPROVED_TTL_MS = 30 * 86_400_000;

type Stored = { request: AuthRequest; clientName: string; redirectUri: string; scope: Scope };
type Remembered = { sub: string; clients: string[] };

function clientError(
  req: AuthRequest | { redirectUri: string; state?: string; issuer?: string },
  code: string,
  description: string,
): Response {
  const u = new URL(req.redirectUri);
  u.searchParams.set("error", code);
  u.searchParams.set("error_description", description);
  if (req.state) u.searchParams.set("state", req.state);
  if (req.issuer) u.searchParams.set("iss", req.issuer);
  // An OAuth redirect back to a registered client URI. The provider validated that URI; this is the one
  // place a redirect may leave the origin, so it does not go through redirect().
  return new Response(null, { status: 302, headers: { location: u.toString(), "cache-control": "no-store" } });
}

/** Remembered clients for this owner only. A cookie signed for another sub is treated as absent. */
async function readApproved(env: Env, request: Request, userId: string): Promise<string[]> {
  const raw = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${APPROVED_COOKIE}=`));
  if (!raw) return [];
  const [payload, exp, sig] = raw.slice(APPROVED_COOKIE.length + 1).split(".");
  if (!payload || !exp || !sig) return [];
  if (!(await verifyToken(env.STATE_HMAC_KEY, APPROVED_PURPOSE, [payload], `${exp}.${sig}`))) return [];
  try {
    const rec = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as Partial<Remembered>;
    if (rec.sub !== userId || !Array.isArray(rec.clients) || !rec.clients.every((x) => typeof x === "string"))
      return [];
    return rec.clients;
  } catch {
    return [];
  }
}

async function approvedCookie(env: Env, userId: string, ids: string[]): Promise<string> {
  const rec: Remembered = { sub: userId, clients: ids.slice(-20) };
  const payload = btoa(JSON.stringify(rec)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const token = await signToken(env.STATE_HMAC_KEY, APPROVED_PURPOSE, [payload], Date.now() + APPROVED_TTL_MS);
  return `${APPROVED_COOKIE}=${payload}.${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${APPROVED_TTL_MS / 1000}`;
}

export function clearApprovedCookie(): string {
  return `${APPROVED_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * The consume comes first and is the only gate: whoever wins the UPDATE completes the grant, the other
 * caller sees 410. A failure after the consume leaves the client with an error and a fresh /authorize
 * is the recovery; nothing here may be retried against a consumed request.
 */
async function complete(env: Env, request: Request, userId: string, email: string, id: string): Promise<Response> {
  const s = await consumeState<Stored>(env.DB, "authreq", id);
  if (!s)
    return htmlResponse("Expired", "<p>This authorization request expired or was already decided.</p>", null, 410);
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: { ...s.request, resource: audienceFor(env, s.scope) },
    userId,
    metadata: { clientName: s.clientName },
    scope: [s.scope],
    props: { sub: userId, email },
  });
  const res = new Response(null, { status: 302, headers: { location: redirectTo, "cache-control": "no-store" } });
  const remembered = await readApproved(env, request, userId);
  if (!remembered.includes(s.request.clientId)) {
    res.headers.append("set-cookie", await approvedCookie(env, userId, [...remembered, s.request.clientId]));
  }
  return res;
}

async function readStored(env: Env, id: string): Promise<Stored | null> {
  const row = await env.DB.prepare(
    "SELECT payload FROM oauth_states WHERE id = ? AND kind = 'authreq' AND consumed_at IS NULL AND expires_at > ?",
  )
    .bind(id, Date.now())
    .first<{ payload: string }>();
  return row ? (JSON.parse(row.payload) as Stored) : null;
}

export const authorizeRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/authorize$/,
    handler: async ({ env, request }) => {
      let req: AuthRequest;
      try {
        req = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      } catch (e) {
        if (e instanceof CimdFetchError)
          return htmlResponse(
            "Authorization refused",
            "<p>The client's metadata document could not be fetched.</p>",
            null,
            400,
          );
        if (!(e instanceof AuthorizationError)) throw e;
        // Without redirectUri the client or its redirect never validated: render here, never redirect.
        if (!e.redirectUri)
          return htmlResponse("Authorization refused", `<p>${escapeHtml(e.description)}</p>`, null, 400);
        return clientError({ redirectUri: e.redirectUri, state: e.state, issuer: e.issuer }, e.code, e.description);
      }
      const client = await env.OAUTH_PROVIDER.lookupClient(req.clientId);
      if (!client) return htmlResponse("Authorization refused", "<p>Unknown client.</p>", null, 400);
      const allowed = await allowedScopeForClient(env.DB, req.clientId);
      const scope = resolveGrantedScope(req.scope, allowed);
      if (!scope) return clientError(req, "invalid_scope", `this client may request only "${allowed}"`);
      const wanted = Array.isArray(req.resource) ? req.resource : req.resource ? [req.resource] : [];
      if (wanted.length > 0 && !(wanted.length === 1 && wanted[0] === audienceFor(env, scope))) {
        return clientError(req, "invalid_target", `resource must be ${audienceFor(env, scope)}`);
      }
      const id = randomId("ar");
      // A DCR client names itself. Cap it so the consent page cannot be flooded, and render it visibly.
      const stored: Stored = {
        request: req,
        clientName: (client.clientName ?? req.clientId).slice(0, 100),
        redirectUri: req.redirectUri,
        scope,
      };
      await putState(env.DB, "authreq", id, stored, AUTHREQ_TTL_MS);
      return redirect(`/authorize/${id}`);
    },
  },
  {
    method: "GET",
    pattern: /^\/authorize\/(ar_[A-Za-z0-9_-]{22})$/,
    handler: async ({ env, request, params }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const stored = await readStored(env, params[0]!);
      if (!stored)
        return htmlResponse(
          "Expired",
          "<p>This authorization request expired. Start again from the client.</p>",
          null,
          410,
        );
      const email =
        (await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(s.userId).first<{ email: string }>())
          ?.email ?? "";
      if ((await readApproved(env, request, s.userId)).includes(stored.request.clientId)) {
        return complete(env, request, s.userId, email, params[0]!);
      }
      const csrf = await csrfToken(env, s, "POST", "/authorize", params[0]!);
      // The approve POST answers with a redirect to the client. Browsers apply form-action to that
      // redirect, so the client's origin is added to this page's CSP and nowhere else.
      return page(
        env,
        s,
        "Allow this client?",
        `<p>Only continue if you started this from a Claude client or the companion yourself.</p>
<table>
<tr><th>Client</th><td>${escapeVisible(stored.clientName)}</td></tr>
<tr><th>Client id</th><td>${escapeVisible(stored.request.clientId)}</td></tr>
<tr><th>Will return to</th><td>${escapeVisible(stored.redirectUri)}</td></tr>
<tr><th>Access</th><td>${stored.scope === "mcp" ? "Use the Gmail tools as you, subject to your policy" : "Move attachment bytes to and from this machine"}</td></tr>
</table>
<form method="post" action="/authorize/${escapeHtml(params[0]!)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<button name="decision" value="approve" class="approve">Allow</button>
<button name="decision" value="deny" class="deny">Deny</button>
</form>`,
        200,
        [new URL(stored.redirectUri).origin],
      );
    },
  },
  {
    method: "POST",
    pattern: /^\/authorize\/(ar_[A-Za-z0-9_-]{22})$/,
    handler: async ({ env, request, params }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const form = await readForm(request);
      const refused = await guardPost(env, request, s, form, "/authorize", params[0]!);
      if (refused) return refused;
      if (form.get("decision") !== "approve") {
        const stored = await consumeState<Stored>(env.DB, "authreq", params[0]!);
        if (!stored)
          return htmlResponse(
            "Expired",
            "<p>This authorization request expired or was already decided.</p>",
            null,
            410,
          );
        return clientError(stored.request, "access_denied", "the owner declined");
      }
      const email =
        (await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(s.userId).first<{ email: string }>())
          ?.email ?? "";
      return complete(env, request, s.userId, email, params[0]!);
    },
  },
];
```

- [ ] **Step 5 (GREEN): staging routes, server.ts, index.ts, delete the dev bearer**

`worker/src/staging/routes.ts`:

```ts
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Deps } from "../deps";
import type { Env } from "../env";
import { requireScope } from "../auth/principal";
import { ack, openForRead } from "./store";

const HANDLE = /^\/staging\/(sh_[A-Za-z0-9_-]{43})(\/ack)?$/;

/** Plan 4 adds /staging/intent and PUT /staging/<ticket>. This is the download side only. */
export function stagingApiHandler(_deps: Deps): ExportedHandler<Env> {
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
```

In `worker/src/mcp/server.ts`: change the `Principal` import to `import type { Principal } from "../auth/principal";` and add a `deps: Deps` third parameter to `buildServer` (unused until Plan 3, so name it `_deps`). The tool set is unchanged in this task; Task 8 adds two tools and updates the `tools/list` expectation to six names.

`worker/test/smoke.test.ts` passes the raw Proxy `env` to `worker.fetch`; the provider assigns `env.OAUTH_PROVIDER` on whatever env it receives. Change the smoke test to pass `{ ...env }` so the shared Proxy is never written to.

Delete `worker/src/mcp/auth-dev.ts`:

```bash
git rm worker/src/mcp/auth-dev.ts
```

`worker/src/index.ts`:

```ts
import { OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "./env";
import { runCron } from "./cron";
import { defaultDeps, type Deps } from "./deps";
import { authorizeRoutes } from "./auth/authorize";
import { requireScope } from "./auth/principal";
import { buildServer } from "./mcp/server";
import { stagingApiHandler } from "./staging/routes";
import { loginRoutes } from "./web/login";
import { webHandler } from "./web/router";

function mcpApiHandler(deps: Deps): ExportedHandler<Env> {
  return {
    async fetch(request, env, ctx) {
      // apiHandlers match by prefix, so /mcpanything would land here too.
      if (new URL(request.url).pathname !== "/mcp") return new Response("not found", { status: 404 });
      const principal = await requireScope(request, env, "mcp");
      if (principal instanceof Response) return principal;
      return createMcpHandler(() => buildServer(env, principal, deps))(request, env, ctx);
    },
  };
}

function oauthOptions(env: Env, deps: Deps): OAuthProviderOptions<Env> {
  const origin = `https://${env.WORKER_HOSTNAME}`;
  return {
    apiHandlers: { "/mcp": mcpApiHandler(deps), "/staging/": stagingApiHandler(deps) },
    defaultHandler: webHandler(deps, [...loginRoutes, ...authorizeRoutes]),
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
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

export type Worker = ExportedHandler<Env> & { oauthOptions: (env: Env) => OAuthProviderOptions<Env> };

export function createWorker(deps: Deps = defaultDeps): Worker {
  return {
    fetch: (request, env, ctx) => providerFor(env, deps).provider.fetch(request, env, ctx),
    scheduled(_controller, env, ctx) {
      ctx.waitUntil(
        Promise.all([
          runCron(env, Date.now()),
          providerFor(env, deps).provider.purgeExpiredData(env, { batchSize: 100 }),
        ]),
      );
    },
    oauthOptions: (env) => providerFor(env, deps).options,
  };
}

export default createWorker();
```

The cache is keyed by `deps` first and hostname second, so two `createWorker` calls with different fake Googles never share a provider, and nothing depends on whether the test runner isolates module state per file.

- [ ] **Step 6: run, expect PASS**

Run: `cd worker && npm run types && npx vitest run test/oauth.test.ts test/mcp.test.ts test/login.test.ts`

One thing to read from the first run: if the AS metadata lacks `client_id_metadata_document_supported`, the compatibility flag is not being seen by the test runtime; check `wrangler.jsonc` still lists `global_fetch_strictly_public` and that the vitest plugin reads it. The path-specific protected-resource documents are served by the provider from the well-known path (read from its source, header of this plan). If either document is missing or wrong, stop: the audience split between `/mcp` and `/staging` is an invariant of spec 4.1, and no test is made green by weakening it.

- [ ] **Step 7: full verify, then commit**

```bash
npm run verify
git add -A worker/src worker/test
git commit -m "feat(worker): OAuth provider in front of /mcp and /staging with per-client scope policy; delete the dev bearer

The provider validates tokens and audience; requireScope adds the scope-to-route check and
binds the principal to the token owner. resourceMetadata.resource is left unset so one
deployment can issue tokens for two audiences; the authorize handler pins the resource per scope.
Consent requests are one-use rows in D1 and remembered consent is bound to the owner's sub.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Flow B: connecting a Google account, and the two MCP tools that point at pages

**Files:**

- Create: `worker/src/google/connect.ts`, `worker/test/connect.test.ts`
- Modify: `worker/src/mcp/server.ts`, `worker/src/index.ts` (mount `connectRoutes`), `worker/test/mcp.test.ts` (six tools)

**Interfaces:**

- `connectRedirectUri(env)` = `https://<host>/connect/callback`. `connectElicitationId(env, userId, alias): Promise<string>` (purpose `gmail-mcp:connect:v1`, fields `[userId, alias]`, 15 min). `connectUrl(env, userId, alias): Promise<string>` = `https://<host>/connect?alias=<alias>&e=<id>`.
- `upsertAccount(env, o: { userId; alias; googleSub; email; sendAs: string[]; scopes: string; refreshToken: string; accessToken: string; accessExpiresAt: number }): Promise<{ id: string; created: boolean }>`. The row is matched on `(user_id, google_sub)`; an existing row keeps its alias and id, takes the new tokens and bumps `credential_version`; a new row takes the alias and becomes default when the owner has no default, decided inside the INSERT by a subquery so two first connections cannot both claim it. A concurrent insert for the same `google_sub` loses on the unique index and retries as an update. Alias in use by a different `google_sub` throws `GmailMcpError("invalid_address", "alias in use")` (reusing the code family; the page renders it as a 409). The callback verifies the granted scope contains `gmail.modify` before persisting, and if anything after the code exchange fails on a brand-new grant, it revokes the new refresh token at Google before rendering the error.
- Routes: `GET /connect?alias=&e=` and `GET /connect/callback`. KV state record `OidcState` with `purpose: "connect"`, `alias`, `userId`, `sessionIdHash`.
- Tools: `connect_account({ alias })` returns `{ status: "connect_required", account: alias, url }`; `open_policy_editor({})` returns `{ url: "https://<host>/policy" }`. Both audit an `intent` row with decision `browser`.

- [ ] **Step 1 (RED): tests**

`worker/test/connect.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index";
import { Browser, mintToken } from "./browser";
import { FakeGoogle } from "./fake-google";
import { testEnv } from "./test-env";
import { Keyring } from "../src/crypto/keyring";
import { connectElicitationId } from "../src/google/connect";
import { rpc } from "./mcp-client";

let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker({ googleFetch: g.fetch });
});

async function connect(
  b: Browser,
  alias: string,
  o: { sub: string; email: string; e?: string; withRefresh?: boolean },
) {
  const start = await b.get(`/connect?alias=${alias}${o.e ? `&e=${o.e}` : ""}`);
  if (start.status !== 303) return start;
  const google = new URL(start.headers.get("location")!);
  expect(google.searchParams.get("access_type")).toBe("offline");
  expect(google.searchParams.get("scope")).toContain("gmail.modify");
  const code = g.grantCode({
    sub: o.sub,
    email: o.email,
    nonce: google.searchParams.get("nonce")!,
    scope: "https://www.googleapis.com/auth/gmail.modify openid email",
  });
  if (o.withRefresh === false) g.codes.get(code)!.refresh = "";
  return b.get(`/connect/callback?state=${google.searchParams.get("state")}&code=${code}`);
}

describe("connect an account", () => {
  it("stores encrypted tokens under the right AAD, verified send-as only, and makes the first account default", async () => {
    const e = testEnv();
    const b = new Browser(worker, e);
    await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
    const done = await connect(b, "personal", { sub: "gsub-1", email: "me@gmail.test" });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/accounts");
    const row = await env.DB.prepare(
      "SELECT * FROM accounts WHERE user_id = 'owner-sub' AND google_sub = 'gsub-1'",
    ).first<any>();
    expect(row.alias).toBe("personal");
    expect(row.is_default).toBe(1);
    expect(row.status).toBe("active");
    expect(row.credential_version).toBe(0);
    expect(JSON.parse(row.send_as)).toEqual(["owner@example.test", "alias@example.test"]);
    expect(row.scopes).toContain("gmail.modify");
    const ring = Keyring.fromEnv(e);
    const rt = await ring.decrypt(new Uint8Array(row.refresh_token_enc), row.refresh_token_key_id, {
      userId: "owner-sub",
      accountId: row.id,
      field: "refresh_token",
    });
    expect(rt).toMatch(/^rt-/);
    await expect(
      ring.decrypt(new Uint8Array(row.refresh_token_enc), row.refresh_token_key_id, {
        userId: "owner-sub",
        accountId: "other",
        field: "refresh_token",
      }),
    ).rejects.toThrow();
    const audit = await env.DB.prepare(
      "SELECT action, decision FROM audit_log WHERE user_id = 'owner-sub' AND action = 'account.connect' ORDER BY id DESC LIMIT 1",
    ).first<any>();
    expect(audit.decision).toBe("connected");
  });

  it("reconnecting the same Google account keeps its alias and id and replaces the tokens", async () => {
    const e = testEnv();
    const b = new Browser(worker, e);
    await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
    await connect(b, "first", { sub: "gsub-2", email: "two@gmail.test" });
    const before = await env.DB.prepare(
      "SELECT id, refresh_token_enc FROM accounts WHERE google_sub = 'gsub-2'",
    ).first<any>();
    await env.DB.prepare("UPDATE accounts SET status = 'needs_reconnect' WHERE google_sub = 'gsub-2'").run();
    expect((await connect(b, "renamed", { sub: "gsub-2", email: "two@gmail.test" })).status).toBe(303);
    const after = await env.DB.prepare(
      "SELECT id, alias, status, credential_version, refresh_token_enc FROM accounts WHERE google_sub = 'gsub-2'",
    ).first<any>();
    expect(after.id).toBe(before.id);
    expect(after.alias).toBe("first");
    expect(after.status).toBe("active");
    expect(after.credential_version).toBe(1);
    expect(new Uint8Array(after.refresh_token_enc)).not.toEqual(new Uint8Array(before.refresh_token_enc));
  });

  it("a failed persist revokes the freshly issued refresh token, and a grant without gmail.modify is refused", async () => {
    const e = testEnv();
    const b = new Browser(worker, e);
    await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
    await connect(b, "taken2", { sub: "gsub-30", email: "thirty@gmail.test" });
    const start = await b.get("/connect?alias=taken2");
    const google = new URL(start.headers.get("location")!);
    const code = g.grantCode({
      sub: "gsub-31",
      email: "thirtyone@gmail.test",
      nonce: google.searchParams.get("nonce")!,
      scope: "https://www.googleapis.com/auth/gmail.modify openid email",
    });
    const refresh = g.codes.get(code)!.refresh;
    const res = await b.get(`/connect/callback?state=${google.searchParams.get("state")}&code=${code}`);
    expect(res.status).toBe(409);
    expect(g.revoked.has(refresh)).toBe(true);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM accounts WHERE google_sub = 'gsub-31'").first<{ n: number }>(),
    ).toEqual({ n: 0 });

    const start2 = new URL((await b.get("/connect?alias=narrow")).headers.get("location")!);
    const narrow = g.grantCode({
      sub: "gsub-32",
      email: "n@gmail.test",
      nonce: start2.searchParams.get("nonce")!,
      scope: "openid email",
    });
    const refresh2 = g.codes.get(narrow)!.refresh;
    const res2 = await b.get(`/connect/callback?state=${start2.searchParams.get("state")}&code=${narrow}`);
    expect(res2.status).toBe(400);
    expect(await res2.text()).toContain("gmail.modify");
    expect(g.revoked.has(refresh2)).toBe(true);
  });

  it("two first connections racing create one default; two reconnects of one sub keep one row", async () => {
    const e = testEnv({ OWNER_GOOGLE_SUBS: "owner-sub,racer" });
    const b1 = new Browser(worker, e);
    const b2 = new Browser(worker, e);
    await b1.login(g, { sub: "racer", email: "racer@example.test" });
    await b2.login(g, { sub: "racer", email: "racer@example.test" });
    const s1 = new URL((await b1.get("/connect?alias=one")).headers.get("location")!);
    const s2 = new URL((await b2.get("/connect?alias=two")).headers.get("location")!);
    const c1 = g.grantCode({
      sub: "gsub-40",
      email: "a@gmail.test",
      nonce: s1.searchParams.get("nonce")!,
      scope: "https://www.googleapis.com/auth/gmail.modify openid email",
    });
    const c2 = g.grantCode({
      sub: "gsub-41",
      email: "b@gmail.test",
      nonce: s2.searchParams.get("nonce")!,
      scope: "https://www.googleapis.com/auth/gmail.modify openid email",
    });
    const [r1, r2] = await Promise.all([
      b1.get(`/connect/callback?state=${s1.searchParams.get("state")}&code=${c1}`),
      b2.get(`/connect/callback?state=${s2.searchParams.get("state")}&code=${c2}`),
    ]);
    expect([r1.status, r2.status]).toEqual([303, 303]);
    const defaults = await env.DB.prepare(
      "SELECT count(*) AS n FROM accounts WHERE user_id = 'racer' AND is_default = 1",
    ).first<{ n: number }>();
    expect(defaults).toEqual({ n: 1 });

    const s3 = new URL((await b1.get("/connect?alias=one")).headers.get("location")!);
    const s4 = new URL((await b2.get("/connect?alias=one")).headers.get("location")!);
    const c3 = g.grantCode({
      sub: "gsub-40",
      email: "a@gmail.test",
      nonce: s3.searchParams.get("nonce")!,
      scope: "https://www.googleapis.com/auth/gmail.modify openid email",
    });
    const c4 = g.grantCode({
      sub: "gsub-40",
      email: "a@gmail.test",
      nonce: s4.searchParams.get("nonce")!,
      scope: "https://www.googleapis.com/auth/gmail.modify openid email",
    });
    const [r3, r4] = await Promise.all([
      b1.get(`/connect/callback?state=${s3.searchParams.get("state")}&code=${c3}`),
      b2.get(`/connect/callback?state=${s4.searchParams.get("state")}&code=${c4}`),
    ]);
    expect([r3.status, r4.status]).toEqual([303, 303]);
    const rows = await env.DB.prepare("SELECT credential_version FROM accounts WHERE google_sub = 'gsub-40'").all<{
      credential_version: number;
    }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.credential_version).toBe(2);
  });

  it("refuses an alias in use, a bad alias, a missing refresh token, a state from another session, and a foreign elicitation id", async () => {
    const e = testEnv();
    const b = new Browser(worker, e);
    await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
    await connect(b, "taken", { sub: "gsub-3", email: "three@gmail.test" });
    expect((await connect(b, "taken", { sub: "gsub-4", email: "four@gmail.test" })).status).toBe(409);
    expect((await b.get("/connect?alias=Not%20Valid")).status).toBe(400);
    const noRefresh = await connect(b, "five", { sub: "gsub-5", email: "five@gmail.test", withRefresh: false });
    expect(noRefresh.status).toBe(400);
    expect(await noRefresh.text()).toContain("refresh token");
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM accounts WHERE google_sub = 'gsub-5'").first<{ n: number }>(),
    ).toEqual({ n: 0 });

    const start = await b.get("/connect?alias=six");
    const google = new URL(start.headers.get("location")!);
    const code = g.grantCode({ sub: "gsub-6", email: "six@gmail.test", nonce: google.searchParams.get("nonce")! });
    const other = new Browser(worker, e);
    await other.login(g, { sub: "owner-sub", email: "owner@example.test" });
    expect((await other.get(`/connect/callback?state=${google.searchParams.get("state")}&code=${code}`)).status).toBe(
      403,
    );

    const foreign = await connectElicitationId(e, "someone-else", "seven");
    expect((await b.get(`/connect?alias=seven&e=${foreign}`)).status).toBe(403);
    const mine = await connectElicitationId(e, "owner-sub", "seven");
    expect((await b.get(`/connect?alias=seven&e=${mine}`)).status).toBe(303);
  });

  it("connect_account and open_policy_editor return page URLs and audit an intent", async () => {
    const e = testEnv();
    const t = await mintToken(worker, e, g, { scope: "mcp" });
    const call = await rpc(
      worker,
      e,
      t.accessToken,
      "tools/call",
      { name: "connect_account", arguments: { alias: "work" } },
      5,
    );
    const parsed = JSON.parse(call.json.result.content[0].text);
    expect(parsed.status).toBe("connect_required");
    expect(parsed.url).toMatch(
      /^https:\/\/gmail-mcp\.example\.workers\.dev\/connect\?alias=work&e=\d+\.[A-Za-z0-9_-]{43}$/,
    );
    const pol = await rpc(worker, e, t.accessToken, "tools/call", { name: "open_policy_editor", arguments: {} }, 6);
    expect(JSON.parse(pol.json.result.content[0].text).url).toBe("https://gmail-mcp.example.workers.dev/policy");
    const rows = await env.DB.prepare(
      "SELECT tool, action, decision FROM audit_log WHERE user_id = 'owner-sub' AND tool IN ('connect_account','open_policy_editor')",
    ).all<any>();
    expect(rows.results.map((r) => `${r.tool}:${r.action}:${r.decision}`).sort()).toEqual([
      "connect_account:account.connect:browser",
      "open_policy_editor:policy.read:browser",
    ]);
  });
});
```

- [ ] **Step 2: run, expect failure**

Run: `cd worker && npx vitest run test/connect.test.ts`
Expected: FAIL, cannot find module `../src/google/connect`.

- [ ] **Step 3 (GREEN): connect.ts**

`worker/src/google/connect.ts`:

```ts
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import { AccountAlias } from "@gmail-mcp/shared/schemas";
import type { Env } from "../env";
import { auditIntent, auditOutcome } from "../audit/log";
import { signToken, verifyToken } from "../crypto/hmac";
import { Keyring } from "../crypto/keyring";
import { randomId } from "../crypto/random";
import { escapeHtml, htmlResponse, redirect } from "../web/html";
import { OIDC_TTL_MS, type OidcState } from "../web/login";
import { type Route, requireSession } from "../web/router";
import { consumeState, putState } from "../web/state";
import { CONNECT_SCOPES, buildAuthUrl, exchangeCode, fetchSendAs, revokeToken, verifyIdToken } from "./oidc";

const E_PURPOSE = "gmail-mcp:connect:v1";
const E_TTL_MS = 15 * 60_000;

export function connectRedirectUri(env: Env): string {
  return `https://${env.WORKER_HOSTNAME}/connect/callback`;
}

/** Ties a connect link handed to the model to the owner and alias it was minted for. */
export function connectElicitationId(env: Env, userId: string, alias: string): Promise<string> {
  return signToken(env.STATE_HMAC_KEY, E_PURPOSE, [userId, alias], Date.now() + E_TTL_MS);
}

export async function connectUrl(env: Env, userId: string, alias: string): Promise<string> {
  const e = await connectElicitationId(env, userId, alias);
  return `https://${env.WORKER_HOSTNAME}/connect?alias=${encodeURIComponent(alias)}&e=${e}`;
}

export async function upsertAccount(
  env: Env,
  o: {
    userId: string;
    alias: string;
    googleSub: string;
    email: string;
    sendAs: string[];
    scopes: string;
    refreshToken: string;
    accessToken: string;
    accessExpiresAt: number;
  },
): Promise<{ id: string; created: boolean }> {
  const ring = Keyring.fromEnv(env);
  const now = Date.now();
  // Reconnect path. credential_version moves so a refresh that read the old tokens cannot write back.
  const existing = await env.DB.prepare("SELECT id FROM accounts WHERE user_id = ? AND google_sub = ?")
    .bind(o.userId, o.googleSub)
    .first<{ id: string }>();
  if (existing) {
    const rt = await ring.encrypt(o.refreshToken, { userId: o.userId, accountId: existing.id, field: "refresh_token" });
    const at = await ring.encrypt(o.accessToken, { userId: o.userId, accountId: existing.id, field: "access_token" });
    await env.DB.prepare(
      `UPDATE accounts SET google_email = ?, send_as = ?, scopes = ?, status = 'active', credential_version = credential_version + 1,
         refresh_token_enc = ?, refresh_token_key_id = ?, access_token_enc = ?, access_token_key_id = ?, access_expires_at = ?, last_refresh_at = ?
       WHERE id = ? AND user_id = ?`,
    )
      .bind(
        o.email,
        JSON.stringify(o.sendAs),
        o.scopes,
        rt.ciphertext,
        rt.keyId,
        at.ciphertext,
        at.keyId,
        o.accessExpiresAt,
        now,
        existing.id,
        o.userId,
      )
      .run();
    return { id: existing.id, created: false };
  }
  // New account. The id is part of the AAD, so it is chosen before anything is encrypted. The default
  // flag is decided inside the INSERT: two first connections both evaluate the subquery, and the
  // partial unique index on (user_id) WHERE is_default = 1 makes the second one lose rather than tie.
  const id = randomId("acc");
  const rt = await ring.encrypt(o.refreshToken, { userId: o.userId, accountId: id, field: "refresh_token" });
  const at = await ring.encrypt(o.accessToken, { userId: o.userId, accountId: id, field: "access_token" });
  try {
    await env.DB.prepare(
      `INSERT INTO accounts (id, user_id, alias, google_sub, google_email, send_as, scopes, status, is_default,
         refresh_token_enc, refresh_token_key_id, access_token_enc, access_token_key_id, access_expires_at, created_at, last_refresh_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active',
         (SELECT CASE WHEN EXISTS (SELECT 1 FROM accounts WHERE user_id = ? AND is_default = 1) THEN 0 ELSE 1 END),
         ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        o.userId,
        o.alias,
        o.googleSub,
        o.email,
        JSON.stringify(o.sendAs),
        o.scopes,
        o.userId,
        rt.ciphertext,
        rt.keyId,
        at.ciphertext,
        at.keyId,
        o.accessExpiresAt,
        now,
        now,
      )
      .run();
    return { id, created: true };
  } catch (e) {
    const msg = String((e as Error).message);
    if (/accounts\.user_id, accounts\.alias/.test(msg))
      throw new GmailMcpError("invalid_address", `alias in use: ${o.alias}`);
    // Lost a race with a concurrent connect of the same Google account or the same default slot:
    // the row now exists, so this becomes a reconnect; a lost default slot becomes a non-default insert.
    if (/accounts\.user_id, accounts\.google_sub/.test(msg)) return upsertAccount(env, o);
    if (/accounts_one_default/.test(msg)) {
      await env.DB.prepare(
        `INSERT INTO accounts (id, user_id, alias, google_sub, google_email, send_as, scopes, status, is_default,
           refresh_token_enc, refresh_token_key_id, access_token_enc, access_token_key_id, access_expires_at, created_at, last_refresh_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          o.userId,
          o.alias,
          o.googleSub,
          o.email,
          JSON.stringify(o.sendAs),
          o.scopes,
          rt.ciphertext,
          rt.keyId,
          at.ciphertext,
          at.keyId,
          o.accessExpiresAt,
          now,
          now,
        )
        .run();
      return { id, created: true };
    }
    throw e;
  }
}

export const connectRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/connect$/,
    handler: async ({ env, request, url }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const alias = AccountAlias.safeParse(url.searchParams.get("alias"));
      if (!alias.success)
        return htmlResponse("Bad alias", "<p>An alias is 1 to 32 characters of a-z, 0-9, _ or -.</p>", null, 400);
      const e = url.searchParams.get("e");
      if (e !== null && !(await verifyToken(env.STATE_HMAC_KEY, E_PURPOSE, [s.userId, alias.data], e))) {
        return htmlResponse(
          "Refused",
          "<p>This connect link was made for a different owner or has expired.</p>",
          null,
          403,
        );
      }
      const state = randomId("st");
      const nonce = randomId("nc");
      const rec: OidcState = {
        nonce,
        returnTo: "/accounts",
        alias: alias.data,
        userId: s.userId,
        sessionIdHash: s.idHash,
      };
      await putState(env.DB, "connect", state, rec, OIDC_TTL_MS);
      const target = buildAuthUrl(env, {
        redirectUri: connectRedirectUri(env),
        scope: CONNECT_SCOPES,
        state,
        nonce,
        offline: true,
      });
      return new Response(null, { status: 303, headers: { location: target, "cache-control": "no-store" } });
    },
  },
  {
    method: "GET",
    pattern: /^\/connect\/callback$/,
    handler: async ({ env, deps, request, url }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const st = await consumeState<OidcState>(env.DB, "connect", url.searchParams.get("state"));
      if (!st) return htmlResponse("Connect failed", "<p>State missing or already used.</p>", null, 400);
      if (st.sessionIdHash !== s.idHash || st.userId !== s.userId) {
        return htmlResponse(
          "Refused",
          "<p>This connection was started from a different browser session.</p>",
          null,
          403,
        );
      }
      if (url.searchParams.get("error"))
        return htmlResponse(
          "Connect failed",
          `<p>Google refused: ${escapeHtml(url.searchParams.get("error")!)}</p>`,
          null,
          400,
        );
      const code = url.searchParams.get("code");
      if (!code) return htmlResponse("Connect failed", "<p>No code.</p>", null, 400);
      const tokens = await exchangeCode(env, deps, { code, redirectUri: connectRedirectUri(env) });
      if (!tokens.refresh_token) {
        return htmlResponse(
          "No refresh token",
          `<p>Google did not return a refresh token, so this account cannot be kept connected. Remove gmail-mcp under
<a href="https://myaccount.google.com/permissions">Google account permissions</a> and connect again.</p>`,
          null,
          400,
        );
      }
      // From here on a refresh token exists at Google. Any failure before it is stored revokes it, so a
      // failed connect leaves no live grant behind.
      const fail = async (title: string, body: string, status: number): Promise<Response> => {
        await revokeToken(deps, tokens.refresh_token!);
        return htmlResponse(title, body, null, status);
      };
      try {
        const id = await verifyIdToken(env, deps, tokens.id_token, { nonce: st.nonce });
        if (!tokens.scope.split(" ").includes("https://www.googleapis.com/auth/gmail.modify")) {
          return fail(
            "Scope refused",
            "<p>Google did not grant gmail.modify, so this account cannot be used. Connect again and accept the Gmail permission.</p>",
            400,
          );
        }
        const sendAs = await fetchSendAs(deps, tokens.access_token);
        await auditIntent(env.DB, {
          userId: s.userId,
          accountId: null,
          tool: "connect_page",
          action: "account.connect",
          modifiers: [],
          decision: "browser",
          facts: {},
        });
        let result: { id: string; created: boolean };
        try {
          result = await upsertAccount(env, {
            userId: s.userId,
            alias: st.alias!,
            googleSub: id.sub,
            email: id.email,
            sendAs,
            scopes: tokens.scope,
            refreshToken: tokens.refresh_token,
            accessToken: tokens.access_token,
            accessExpiresAt: Date.now() + tokens.expires_in * 1000 - 60_000,
          });
        } catch (e) {
          if (e instanceof GmailMcpError && e.message.startsWith("alias in use")) {
            return fail(
              "Alias in use",
              `<p>The alias <code>${escapeHtml(st.alias!)}</code> already names a different Google account. Pick another.</p>`,
              409,
            );
          }
          throw e;
        }
        await auditOutcome(env.DB, {
          userId: s.userId,
          accountId: result.id,
          tool: "connect_page",
          action: "account.connect",
          modifiers: [],
          decision: "connected",
          facts: { ids: [result.id] },
        });
        return redirect("/accounts");
      } catch (e) {
        await revokeToken(deps, tokens.refresh_token);
        throw e;
      }
    },
  },
];
```

The page CSP has `default-src 'none'`, which does not block a plain anchor to Google's permissions page; the link is navigation, not a fetched resource.

- [ ] **Step 4 (GREEN): the two tools and mounting**

In `worker/src/mcp/server.ts` add, before `return server;`:

```ts
server.registerTool(
  "connect_account",
  {
    description:
      "Connect or reconnect a Google account under an alias. Completes in the owner's browser; returns the page URL.",
    inputSchema: z.object({ alias: AccountAlias }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ alias }) => {
    await auditIntent(env.DB, {
      userId: principal.userId,
      accountId: null,
      tool: "connect_account",
      action: "account.connect",
      modifiers: [],
      decision: "browser",
      facts: {},
    });
    return text({ status: "connect_required", account: alias, url: await connectUrl(env, principal.userId, alias) });
  },
);

server.registerTool(
  "open_policy_editor",
  {
    description: "Policy is edited in the browser only. Returns the policy page URL.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  },
  async () => {
    await auditIntent(env.DB, {
      userId: principal.userId,
      accountId: null,
      tool: "open_policy_editor",
      action: "policy.read",
      modifiers: [],
      decision: "browser",
      facts: {},
    });
    return text({ url: `https://${env.WORKER_HOSTNAME}/policy` });
  },
);
```

with imports `import { auditIntent } from "../audit/log";` and `import { connectUrl } from "../google/connect";`. Plan 3 upgrades `connect_account` to URL-mode elicitation when the client advertises it; the text URL stays as the fallback.

In `worker/src/index.ts` add `import { connectRoutes } from "./google/connect";` and mount `[...loginRoutes, ...authorizeRoutes, ...connectRoutes]`. In `worker/test/mcp.test.ts` the `tools/list` expectation becomes `["cancel_pending", "connect_account", "get_policy", "list_accounts", "list_pending", "open_policy_editor"]`.

- [ ] **Step 5: run, expect PASS, then commit**

Run: `cd worker && npx vitest run test/connect.test.ts test/mcp.test.ts`

```bash
git add worker/src/google/connect.ts worker/src/mcp/server.ts worker/src/index.ts worker/test/connect.test.ts worker/test/mcp.test.ts
git commit -m "feat(worker): connect Google accounts with offline consent, session-bound state, encrypted tokens, and page-pointing tools

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Access tokens: cache, refresh, lazy re-encryption, needs_reconnect, revoke

**Files:**

- Create: `worker/src/google/tokens.ts`, `worker/test/tokens.test.ts`

**Interfaces:**

- `getAccessToken(env, deps, userId, accountId): Promise<string>`. Ownership is in the query. `status != 'active'` throws `GmailMcpError("account_needs_reconnect")`. A cached token with more than 60 s left is returned after a lazy re-encrypt if its key id is not current. Otherwise the refresh token is decrypted and used; `"invalid_grant"` flips the row to `needs_reconnect`, wipes the access token columns and throws `account_needs_reconnect`; success stores the new access token encrypted with the current key and refreshes `last_refresh_at`; a refresh token under an old key id is re-encrypted in the same update. Every write carries `WHERE id = ? AND user_id = ? AND status = 'active' AND credential_version = ?` with the version read at the start, and a write that changes zero rows means a revoke or reconnect happened meanwhile: the function then throws `account_needs_reconnect` and never returns the token it obtained.
- `revokeAccount(env, deps, userId, accountId): Promise<void>`: local first. One UPDATE sets `status = 'revoked'`, `is_default = 0`, bumps `credential_version` and nulls both ciphertexts, returning the old refresh ciphertext with `RETURNING`; only then is Google's revoke endpoint called, best effort. Google being unreachable cannot keep an account alive.

- [ ] **Step 1 (RED): tests**

`worker/test/tokens.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { FakeGoogle } from "./fake-google";
import { testEnv } from "./test-env";
import { Keyring } from "../src/crypto/keyring";
import { getAccessToken, revokeAccount } from "../src/google/tokens";
import { seedUserAndAccount } from "./fixtures";

const K1 = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
const K2 = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=";
let g: FakeGoogle;
beforeAll(async () => {
  g = await FakeGoogle.create();
  await seedUserAndAccount(env.DB, { userId: "tu", accountId: "ta", alias: "personal", isDefault: true });
  await seedUserAndAccount(env.DB, { userId: "tu", accountId: "tb", alias: "second" });
  await seedUserAndAccount(env.DB, { userId: "tv", accountId: "tc", alias: "personal", isDefault: true });
});

async function seedTokens(
  e: ReturnType<typeof testEnv>,
  accountId: string,
  o: { refresh: string; access?: string; expiresAt?: number },
) {
  const ring = Keyring.fromEnv(e);
  const rt = await ring.encrypt(o.refresh, { userId: "tu", accountId, field: "refresh_token" });
  const at = o.access ? await ring.encrypt(o.access, { userId: "tu", accountId, field: "access_token" }) : null;
  await env.DB.prepare(
    "UPDATE accounts SET status = 'active', is_default = is_default, refresh_token_enc = ?, refresh_token_key_id = ?, access_token_enc = ?, access_token_key_id = ?, access_expires_at = ? WHERE id = ?",
  )
    .bind(rt.ciphertext, rt.keyId, at?.ciphertext ?? null, at?.keyId ?? null, o.expiresAt ?? null, accountId)
    .run();
}

describe("access tokens", () => {
  it("returns a cached token without calling Google, refreshes when it is about to expire", async () => {
    const e = testEnv();
    g.refreshTokens.set("rt-a", "ok");
    await seedTokens(e, "ta", { refresh: "rt-a", access: "cached", expiresAt: Date.now() + 10 * 60_000 });
    const calls = g.tokenCalls;
    expect(await getAccessToken(e, { googleFetch: g.fetch }, "tu", "ta")).toBe("cached");
    expect(g.tokenCalls).toBe(calls);
    await seedTokens(e, "ta", { refresh: "rt-a", access: "stale", expiresAt: Date.now() + 30_000 });
    const fresh = await getAccessToken(e, { googleFetch: g.fetch }, "tu", "ta");
    expect(fresh).toMatch(/^at-/);
    expect(g.tokenCalls).toBe(calls + 1);
    const row = await env.DB.prepare(
      "SELECT access_expires_at, last_refresh_at FROM accounts WHERE id = 'ta'",
    ).first<any>();
    expect(row.access_expires_at).toBeGreaterThan(Date.now() + 3000 * 1000);
    expect(row.last_refresh_at).toBeGreaterThan(Date.now() - 5000);
  });

  it("invalid_grant flips the account to needs_reconnect and wipes the access token", async () => {
    const e = testEnv();
    g.refreshTokens.set("rt-dead", "invalid_grant");
    await seedTokens(e, "tb", { refresh: "rt-dead" });
    await expect(getAccessToken(e, { googleFetch: g.fetch }, "tu", "tb")).rejects.toMatchObject({
      code: "account_needs_reconnect",
    });
    const row = await env.DB.prepare("SELECT status, access_token_enc FROM accounts WHERE id = 'tb'").first<any>();
    expect(row.status).toBe("needs_reconnect");
    expect(row.access_token_enc).toBeNull();
    await expect(getAccessToken(e, { googleFetch: g.fetch }, "tu", "tb")).rejects.toMatchObject({
      code: "account_needs_reconnect",
    });
  });

  it("re-encrypts lazily under the current key after a rotation", async () => {
    const old = testEnv();
    g.refreshTokens.set("rt-rot", "ok");
    await seedTokens(old, "ta", { refresh: "rt-rot", access: "cached", expiresAt: Date.now() + 10 * 60_000 });
    const rotated = testEnv({ TOKEN_KEKS: JSON.stringify({ k1: K1, k2: K2 }), TOKEN_KEK_CURRENT: "k2" });
    expect(await getAccessToken(rotated, { googleFetch: g.fetch }, "tu", "ta")).toBe("cached");
    const row = await env.DB.prepare(
      "SELECT refresh_token_key_id, access_token_key_id FROM accounts WHERE id = 'ta'",
    ).first<any>();
    expect(row.refresh_token_key_id).toBe("k2");
    expect(row.access_token_key_id).toBe("k2");
    expect(
      await Keyring.fromEnv(rotated).decrypt(
        new Uint8Array(
          (await env.DB.prepare("SELECT refresh_token_enc AS c FROM accounts WHERE id = 'ta'").first<any>()).c,
        ),
        "k2",
        { userId: "tu", accountId: "ta", field: "refresh_token" },
      ),
    ).toBe("rt-rot");
  });

  it("a revoke that lands while a refresh is in flight wins: the refresh result is discarded", async () => {
    const e = testEnv();
    g.refreshTokens.set("rt-race", "ok");
    await seedTokens(e, "ta", { refresh: "rt-race", access: "old", expiresAt: Date.now() + 1000 });
    g.beforeRefresh = async () => {
      await revokeAccount(e, { googleFetch: g.fetch }, "tu", "ta");
    };
    try {
      await expect(getAccessToken(e, { googleFetch: g.fetch }, "tu", "ta")).rejects.toMatchObject({
        code: "account_needs_reconnect",
      });
    } finally {
      g.beforeRefresh = null;
    }
    const row = await env.DB.prepare(
      "SELECT status, access_token_enc, refresh_token_enc FROM accounts WHERE id = 'ta'",
    ).first<any>();
    expect(row).toEqual({ status: "revoked", access_token_enc: null, refresh_token_enc: null });
  });

  it("a lazy re-encrypt that races a revoke cannot resurrect ciphertexts", async () => {
    const old = testEnv();
    g.refreshTokens.set("rt-rot2", "ok");
    await env.DB.prepare("UPDATE accounts SET status = 'active', credential_version = 0 WHERE id = 'tb'").run();
    await seedTokens(old, "tb", { refresh: "rt-rot2", access: "cached", expiresAt: Date.now() + 10 * 60_000 });
    const rotated = testEnv({ TOKEN_KEKS: JSON.stringify({ k1: K1, k2: K2 }), TOKEN_KEK_CURRENT: "k2" });
    // Bump the version between the read and the write by revoking directly in D1, as a concurrent request would.
    await env.DB.prepare(
      "UPDATE accounts SET status = 'revoked', credential_version = credential_version + 1, refresh_token_enc = NULL, refresh_token_key_id = NULL, access_token_enc = NULL, access_token_key_id = NULL WHERE id = 'tb'",
    ).run();
    await expect(getAccessToken(rotated, { googleFetch: g.fetch }, "tu", "tb")).rejects.toMatchObject({
      code: "account_needs_reconnect",
    });
    const row = await env.DB.prepare(
      "SELECT refresh_token_enc, access_token_enc FROM accounts WHERE id = 'tb'",
    ).first<any>();
    expect(row).toEqual({ refresh_token_enc: null, access_token_enc: null });
  });

  it("ownership is in the query, and revoke wipes ciphertexts before telling Google", async () => {
    const e = testEnv();
    await expect(getAccessToken(e, { googleFetch: g.fetch }, "tv", "ta")).rejects.toMatchObject({
      code: "account_not_found",
    });
    g.refreshTokens.set("rt-rev", "ok");
    await seedTokens(e, "ta", { refresh: "rt-rev", access: "x", expiresAt: Date.now() + 600_000 });
    const before = (await env.DB.prepare("SELECT credential_version AS v FROM accounts WHERE id = 'ta'").first<any>())
      .v;
    await revokeAccount(e, { googleFetch: g.fetch }, "tu", "ta");
    expect(g.revoked.has("rt-rev")).toBe(true);
    const row = await env.DB.prepare(
      "SELECT status, is_default, credential_version, refresh_token_enc, access_token_enc, refresh_token_key_id FROM accounts WHERE id = 'ta'",
    ).first<any>();
    expect(row).toMatchObject({
      status: "revoked",
      is_default: 0,
      credential_version: before + 1,
      refresh_token_enc: null,
      access_token_enc: null,
      refresh_token_key_id: null,
    });
  });
});
```

- [ ] **Step 2: run, expect failure**

Run: `cd worker && npx vitest run test/tokens.test.ts`

- [ ] **Step 3 (GREEN): tokens.ts**

`worker/src/google/tokens.ts`:

```ts
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Deps } from "../deps";
import type { Env } from "../env";
import { Keyring } from "../crypto/keyring";
import { refreshAccessToken, revokeToken } from "./oidc";

const EXPIRY_MARGIN_MS = 60_000;

type TokenRow = {
  id: string;
  status: "active" | "needs_reconnect" | "revoked";
  credential_version: number;
  refresh_token_enc: ArrayBuffer | null;
  refresh_token_key_id: string | null;
  access_token_enc: ArrayBuffer | null;
  access_token_key_id: string | null;
  access_expires_at: number | null;
};

async function load(db: D1Database, userId: string, accountId: string): Promise<TokenRow> {
  const row = await db
    .prepare(
      `SELECT id, status, credential_version, refresh_token_enc, refresh_token_key_id, access_token_enc, access_token_key_id, access_expires_at
       FROM accounts WHERE id = ? AND user_id = ?`,
    )
    .bind(accountId, userId)
    .first<TokenRow>();
  if (!row) throw new GmailMcpError("account_not_found", "account_not_found");
  return row;
}

const reconnect = (why: string) => new GmailMcpError("account_needs_reconnect", `account_needs_reconnect: ${why}`);

/**
 * Every credential write is conditional on the version read at the start and on the row still being
 * active. A revoke or reconnect in between bumps the version, the write matches nothing, and the
 * caller gets needs_reconnect rather than a token the owner has just withdrawn.
 */
async function guardedWrite(env: Env, sql: string, binds: unknown[], row: TokenRow, userId: string): Promise<void> {
  const res = await env.DB.prepare(
    `${sql} WHERE id = ? AND user_id = ? AND status = 'active' AND credential_version = ?`,
  )
    .bind(...binds, row.id, userId, row.credential_version)
    .run();
  if ((res.meta.changes ?? 0) !== 1) throw reconnect("credentials changed during refresh");
}

/**
 * Spec 3.3. The cached access token is used while it has more than a minute left; otherwise the
 * refresh token buys a new one. Any ciphertext read under a key that is no longer current is
 * rewritten under the current one, which is how a rotation completes without a migration.
 */
export async function getAccessToken(env: Env, deps: Deps, userId: string, accountId: string): Promise<string> {
  const row = await load(env.DB, userId, accountId);
  if (row.status !== "active") throw reconnect(row.status);
  const ring = Keyring.fromEnv(env);
  const now = Date.now();

  if (
    row.access_token_enc &&
    row.access_token_key_id &&
    row.access_expires_at &&
    row.access_expires_at - now > EXPIRY_MARGIN_MS
  ) {
    const token = await ring.decrypt(new Uint8Array(row.access_token_enc), row.access_token_key_id, {
      userId,
      accountId,
      field: "access_token",
    });
    if (row.access_token_key_id !== ring.currentKeyId || row.refresh_token_key_id !== ring.currentKeyId) {
      const refresh =
        row.refresh_token_enc && row.refresh_token_key_id
          ? await ring.decrypt(new Uint8Array(row.refresh_token_enc), row.refresh_token_key_id, {
              userId,
              accountId,
              field: "refresh_token",
            })
          : null;
      const at = await ring.encrypt(token, { userId, accountId, field: "access_token" });
      const rt = refresh === null ? null : await ring.encrypt(refresh, { userId, accountId, field: "refresh_token" });
      await guardedWrite(
        env,
        `UPDATE accounts SET access_token_enc = ?, access_token_key_id = ?,
           refresh_token_enc = COALESCE(?, refresh_token_enc), refresh_token_key_id = COALESCE(?, refresh_token_key_id)`,
        [at.ciphertext, at.keyId, rt?.ciphertext ?? null, rt?.keyId ?? null],
        row,
        userId,
      );
    }
    return token;
  }

  if (!row.refresh_token_enc || !row.refresh_token_key_id) throw reconnect("no refresh token");
  const refresh = await ring.decrypt(new Uint8Array(row.refresh_token_enc), row.refresh_token_key_id, {
    userId,
    accountId,
    field: "refresh_token",
  });
  const result = await refreshAccessToken(env, deps, refresh);
  if (result === "invalid_grant") {
    // Same guard: if the account was revoked meanwhile, leave the revoked row exactly as it is.
    await env.DB.prepare(
      `UPDATE accounts SET status = 'needs_reconnect', access_token_enc = NULL, access_token_key_id = NULL, access_expires_at = NULL
       WHERE id = ? AND user_id = ? AND status = 'active' AND credential_version = ?`,
    )
      .bind(accountId, userId, row.credential_version)
      .run();
    throw reconnect("refresh token rejected");
  }
  const at = await ring.encrypt(result.access_token, { userId, accountId, field: "access_token" });
  const rt =
    row.refresh_token_key_id === ring.currentKeyId
      ? null
      : await ring.encrypt(refresh, { userId, accountId, field: "refresh_token" });
  await guardedWrite(
    env,
    `UPDATE accounts SET access_token_enc = ?, access_token_key_id = ?, access_expires_at = ?, last_refresh_at = ?,
       refresh_token_enc = COALESCE(?, refresh_token_enc), refresh_token_key_id = COALESCE(?, refresh_token_key_id)`,
    [at.ciphertext, at.keyId, now + result.expires_in * 1000, now, rt?.ciphertext ?? null, rt?.keyId ?? null],
    row,
    userId,
  );
  return result.access_token;
}

/**
 * Local first. Read the ciphertext, then revoke and wipe in one statement guarded on the version that
 * was read; only after the wipe has landed is Google's revoke endpoint told, best effort. A concurrent
 * reconnect that moved the version makes the guarded wipe match nothing, and the loop re-reads and
 * wipes that newer credential too, so the outcome is always "revoked" for the row the owner pointed at.
 * (RETURNING was measured to yield post-update values, so it cannot return the old ciphertext.)
 */
export async function revokeAccount(env: Env, deps: Deps, userId: string, accountId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await load(env.DB, userId, accountId);
    const res = await env.DB.prepare(
      `UPDATE accounts SET status = 'revoked', is_default = 0, credential_version = credential_version + 1,
         refresh_token_enc = NULL, refresh_token_key_id = NULL, access_token_enc = NULL, access_token_key_id = NULL, access_expires_at = NULL
       WHERE id = ? AND user_id = ? AND credential_version = ?`,
    )
      .bind(accountId, userId, row.credential_version)
      .run();
    if ((res.meta.changes ?? 0) !== 1) continue;
    if (row.refresh_token_enc && row.refresh_token_key_id) {
      const ring = Keyring.fromEnv(env);
      const refresh = await ring.decrypt(new Uint8Array(row.refresh_token_enc), row.refresh_token_key_id, {
        userId,
        accountId,
        field: "refresh_token",
      });
      await revokeToken(deps, refresh);
    }
    return;
  }
  throw new GmailMcpError("internal", "revoke lost three races with concurrent credential writes");
}
```

D1 returns BLOB columns as `ArrayBuffer`, which is why the row type says so and the code wraps in `Uint8Array`.

- [ ] **Step 4: run, expect PASS (4 tests), then commit**

```bash
git add worker/src/google/tokens.ts worker/test/tokens.test.ts
git commit -m "feat(worker): version-guarded token refresh and re-encryption; local-first revoke

Every credential write requires status active and the credential_version read at the start,
so a revoke that lands mid-refresh wins and the refreshed token is discarded.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The approval page

**Files:**

- Create: `worker/src/web/pages/approve.ts`, `worker/src/approval/view.ts`, `worker/test/approve.test.ts`
- Modify: `worker/src/index.ts` (mount `approveRoutes`), `worker/src/audit/log.ts` (expose `auditStatement`)

**Interfaces:**

- `approval/view.ts`: `approvalView(action, payload): ApprovalView`, a discriminated union the page renders field by field. `send` (`send.message`, `send.draft`, `send.forward`): `to`, `cc`, `bcc` kept apart, `subject`, `body`, `attachments`, plus `draft_id`, `message_id`, `include_original_attachments` when present. `targets` (`trash.move`, `trash.restore`, `spam.mark`, `spam.unmark`, `label.apply`): `message_ids`, `thread_ids`, `label_ids`, `add`, `remove`, with counts. `label` (`label.manage`): `op` (`create`, `update`, `delete`), `label_id`, `name`. `upload` (`attachment.stage_upload`): `filename`, `size`, `mime`. Any other action, or a payload missing the fields its action needs, yields `raw`, and the page prints the whole canonical payload as escaped text so the owner always sees what would run. This is the payload contract Plan 3's tools must honour; the page never guesses.
- `audit/log.ts` gains `auditStatement(db, phase, base): D1PreparedStatement`, the prepared form of the existing `write`, so callers can put an audit row inside a batch.
- `GET /approve/<pa_id>`: session; row looked up with `user_id` in the query; an unknown or foreign id is 404. A `pending` and unexpired row renders the structured block, the attachments table (joined to `staging_objects` by handle and owner), and the untrusted block with the body preview cut to 2048 bytes. Other states render a one-line status page (200).
- `POST /approve/<pa_id>` with `decision=approve|deny` and `csrf`: session, Origin, CSRF bound to the id. The transition and its audit row are one D1 batch: the `UPDATE` from `approvePending`/`denyPending` (exposed as `approveStatement`/`denyStatement` in `approval/pending.ts`), an `_assert` row that fails the batch when the update matched nothing, and the `outcome` audit row with decision `approved` or `denied`. A failed batch is 409. Then redirect to the GET.

- [ ] **Step 1 (RED): tests**

`worker/test/approve.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index";
import { Browser, csrfFrom } from "./browser";
import { FakeGoogle } from "./fake-google";
import { testEnv } from "./test-env";
import { seedUserAndAccount } from "./fixtures";
import { createPending } from "../src/approval/pending";
import { approvalView } from "../src/approval/view";

let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker({ googleFetch: g.fetch });
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "apa", alias: "personal", isDefault: true });
  await seedUserAndAccount(env.DB, { userId: "other-owner", accountId: "apb", alias: "personal", isDefault: true });
  await env.DB.prepare(
    "INSERT INTO staging_objects (handle, user_id, account_id, direction, r2_key, filename, mime, size, sha256, created_at, expires_at) VALUES (?, 'owner-sub', 'apa', 'upload', 'k', 'thesis.pdf', 'application/pdf', 2200000, ?, ?, ?)",
  )
    .bind("sh_" + "a".repeat(43), "0".repeat(64), Date.now(), Date.now() + 600_000)
    .run();
});

async function owner() {
  const b = new Browser(worker, testEnv());
  await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
  return b;
}

const payload = {
  to: ["prof@uni.edu.au"],
  cc: ["cc@uni.edu.au"],
  bcc: ["hidden@example.test"],
  subject: "Thesis draft \u202Efdp.exe",
  body: 'Hello <a href="https://evil.test">click</a>\n' + "x".repeat(5000),
  attachments: ["sh_" + "a".repeat(43)],
};

describe("approval views", () => {
  it("builds a typed view per action and falls back to raw for anything else", () => {
    const send = approvalView("send.message", payload);
    expect(send.kind).toBe("send");
    if (send.kind === "send") {
      expect(send.to).toEqual(["prof@uni.edu.au"]);
      expect(send.cc).toEqual(["cc@uni.edu.au"]);
      expect(send.bcc).toEqual(["hidden@example.test"]);
    }
    const trash = approvalView("trash.move", { message_ids: ["m1", "m2"] });
    expect(trash).toMatchObject({ kind: "targets", messageIds: ["m1", "m2"], count: 2 });
    const label = approvalView("label.apply", { thread_ids: ["t1"], add: ["Label_3"], remove: ["INBOX"] });
    expect(label).toMatchObject({ kind: "targets", threadIds: ["t1"], add: ["Label_3"], remove: ["INBOX"], count: 1 });
    expect(approvalView("label.manage", { op: "delete", label_id: "Label_9" })).toMatchObject({
      kind: "label",
      op: "delete",
      labelId: "Label_9",
    });
    expect(
      approvalView("attachment.stage_upload", { filename: "a.pdf", size: 10, mime: "application/pdf" }),
    ).toMatchObject({ kind: "upload", filename: "a.pdf" });
    expect(
      approvalView("send.forward", { message_id: "m9", to: ["x@y.test"], include_original_attachments: true }),
    ).toMatchObject({ kind: "send", messageId: "m9", includeOriginalAttachments: true });
    expect(approvalView("trash.move", { weird: 1 })).toMatchObject({ kind: "raw" });
    expect(approvalView("something.new", { a: 1 })).toMatchObject({ kind: "raw" });
  });
});

describe("approval page", () => {
  it("shows what a trash, label and forward action would touch, and the whole payload for an unknown shape", async () => {
    const b = await owner();
    const trash = await createPending(env.DB, {
      userId: "owner-sub",
      accountId: "apa",
      action: "trash.move",
      modifiers: [],
      payload: { message_ids: ["18fa<b>", "18fb"] },
      summary: "s",
    });
    const t = await (await b.get(`/approve/${trash.id}`)).text();
    expect(t).toContain("2 message(s)");
    expect(t).toContain("18fa&lt;b&gt;");
    expect(t).toContain("18fb");
    const label = await createPending(env.DB, {
      userId: "owner-sub",
      accountId: "apa",
      action: "label.apply",
      modifiers: ["+sensitive"],
      payload: { thread_ids: ["t1"], add: ["Label_3"] },
      summary: "s",
    });
    const l = await (await b.get(`/approve/${label.id}`)).text();
    expect(l).toContain("Label_3");
    expect(l).toContain("1 thread(s)");
    const fwd = await createPending(env.DB, {
      userId: "owner-sub",
      accountId: "apa",
      action: "send.forward",
      modifiers: [],
      payload: { message_id: "m9", to: ["a@x.test"], bcc: ["b@x.test"], include_original_attachments: true },
      summary: "s",
    });
    const f = await (await b.get(`/approve/${fwd.id}`)).text();
    expect(f).toContain("<th>To</th>");
    expect(f).toContain("<th>Bcc</th>");
    expect(f).toContain("b@x.test");
    expect(f).toContain("<th>Original attachments included</th><td>yes</td>");
    const odd = await createPending(env.DB, {
      userId: "owner-sub",
      accountId: "apa",
      action: "spam.mark",
      modifiers: [],
      payload: { unexpected: "shape<" },
      summary: "s",
    });
    const o = await (await b.get(`/approve/${odd.id}`)).text();
    expect(o).toContain("could not be summarised");
    expect(o).toContain("&quot;unexpected&quot;");
    expect(o).toContain("shape&lt;");
  });

  it("renders the send block with To, Cc and Bcc apart, attachments with sizes, and an escaped untrusted preview capped at 2 KB", async () => {
    const p = await createPending(env.DB, {
      userId: "owner-sub",
      accountId: "apa",
      action: "send.message",
      modifiers: ["+external", "+attachment"],
      payload,
      summary: "To: prof@uni.edu.au",
    });
    const b = await owner();
    const res = await b.get(`/approve/${p.id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("send.message");
    expect(html).toContain("personal");
    expect(html).toContain("+external");
    expect(html).toContain("prof@uni.edu.au");
    expect(html.indexOf("<th>To</th>")).toBeLessThan(html.indexOf("prof@uni.edu.au"));
    expect(html.indexOf("<th>Bcc</th>")).toBeLessThan(html.indexOf("hidden@example.test"));
    expect(html).toContain("thesis.pdf");
    expect(html).toContain("2.1 MB");
    expect(html).toContain("Thesis draft \\u{202E}fdp.exe");
    expect(html).toContain("untrusted");
    expect(html).toContain("&lt;a href=&quot;https://evil.test&quot;&gt;");
    expect(html).not.toContain('<a href="https://evil.test"');
    const preview = html.split('class="untrusted"')[1]!.split("</pre>")[0]!;
    expect(new TextEncoder().encode(preview).length).toBeLessThan(2400);
    expect(html).toContain("truncated");
  });

  it("is 404 for another owner's action and for an unknown id", async () => {
    const p = await createPending(env.DB, {
      userId: "other-owner",
      accountId: "apb",
      action: "trash.move",
      modifiers: [],
      payload: { message_id: "m" },
      summary: "s",
    });
    const b = await owner();
    expect((await b.get(`/approve/${p.id}`)).status).toBe(404);
    expect((await b.get(`/approve/pa_${"z".repeat(22)}`)).status).toBe(404);
    expect((await b.get(`/approve/${p.id}`)).headers.get("location")).toBeNull();
  });

  it("approve is the pending->approved transition, guarded by Origin and a CSRF token bound to this id", async () => {
    const a = await createPending(env.DB, {
      userId: "owner-sub",
      accountId: "apa",
      action: "send.message",
      modifiers: [],
      payload,
      summary: "s",
    });
    const bpend = await createPending(env.DB, {
      userId: "owner-sub",
      accountId: "apa",
      action: "send.message",
      modifiers: [],
      payload,
      summary: "s",
    });
    const b = await owner();
    const csrfA = csrfFrom(await (await b.get(`/approve/${a.id}`)).text(), `/approve/${a.id}`);
    expect((await b.post(`/approve/${bpend.id}`, { decision: "approve", csrf: csrfA })).status).toBe(403);
    expect(
      (await b.post(`/approve/${a.id}`, { decision: "approve", csrf: csrfA }, { origin: "https://evil.test" })).status,
    ).toBe(403);
    expect(
      (
        await b.fetch(`/approve/${a.id}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", origin: "" },
          body: `decision=approve&csrf=${csrfA}`,
        })
      ).status,
    ).toBe(403);
    const ok = await b.post(`/approve/${a.id}`, { decision: "approve", csrf: csrfA });
    expect(ok.status).toBe(303);
    const row = await env.DB.prepare("SELECT state, approved_via, payload_json FROM pending_actions WHERE id = ?")
      .bind(a.id)
      .first<any>();
    expect(row.state).toBe("approved");
    expect(row.approved_via).toBe("browser");
    expect(row.payload_json).not.toBeNull();
    const again = await b.post(`/approve/${a.id}`, { decision: "approve", csrf: csrfA });
    expect(again.status).toBe(409);
    expect(await (await b.get(`/approve/${a.id}`)).text()).toContain("approved");
    const audit = await env.DB.prepare(
      "SELECT decision, phase, summary FROM audit_log WHERE pending_id = ? ORDER BY id DESC LIMIT 1",
    )
      .bind(a.id)
      .first<any>();
    expect(audit).toEqual({ decision: "approved", phase: "outcome", summary: "recipients=3 attachments=1" });
    // The transition and the audit row are one batch: a second approve writes neither.
    const auditCount = await env.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE pending_id = ?")
      .bind(a.id)
      .first<{ n: number }>();
    await b.post(`/approve/${a.id}`, { decision: "approve", csrf: csrfA });
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE pending_id = ?")
        .bind(a.id)
        .first<{ n: number }>(),
    ).toEqual(auditCount);
  });

  it("deny purges the payload; an expired action cannot be approved", async () => {
    const d = await createPending(env.DB, {
      userId: "owner-sub",
      accountId: "apa",
      action: "send.message",
      modifiers: [],
      payload,
      summary: "s",
    });
    const b = await owner();
    const csrf = csrfFrom(await (await b.get(`/approve/${d.id}`)).text(), `/approve/${d.id}`);
    expect((await b.post(`/approve/${d.id}`, { decision: "deny", csrf })).status).toBe(303);
    const row = await env.DB.prepare("SELECT state, payload_json, summary FROM pending_actions WHERE id = ?")
      .bind(d.id)
      .first<any>();
    expect(row).toEqual({ state: "denied", payload_json: null, summary: "redacted" });

    const x = await createPending(env.DB, {
      userId: "owner-sub",
      accountId: "apa",
      action: "send.message",
      modifiers: [],
      payload,
      summary: "s",
      ttlMs: 1,
    });
    await new Promise((r) => setTimeout(r, 5));
    const page = await b.get(`/approve/${x.id}`);
    expect(await page.text()).toContain("expired");
    expect(page.status).toBe(200);
  });
});
```

- [ ] **Step 2: run, expect failure**

Run: `cd worker && npx vitest run test/approve.test.ts`

- [ ] **Step 3 (GREEN): approve.ts**

`worker/src/approval/view.ts`:

```ts
import { StagingHandle } from "@gmail-mcp/shared/schemas";

/**
 * What the owner is shown before approving. One shape per action family; anything that does not fit
 * becomes `raw`, which the page prints in full. Plan 3's tools write payloads to this contract.
 */
export type ApprovalView =
  | {
      kind: "send";
      to: string[];
      cc: string[];
      bcc: string[];
      subject: string | null;
      body: string | null;
      handles: string[];
      draftId: string | null;
      messageId: string | null;
      includeOriginalAttachments: boolean | null;
    }
  | {
      kind: "targets";
      messageIds: string[];
      threadIds: string[];
      add: string[];
      remove: string[];
      count: number;
    }
  | { kind: "label"; op: "create" | "update" | "delete" | null; labelId: string | null; name: string | null }
  | { kind: "upload"; filename: string; size: number; mime: string }
  | { kind: "raw"; reason: string };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function approvalView(action: string, payload: unknown): ApprovalView {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  switch (action) {
    case "send.message":
    case "send.draft":
    case "send.forward": {
      const view = {
        kind: "send" as const,
        to: strings(p.to),
        cc: strings(p.cc),
        bcc: strings(p.bcc),
        subject: str(p.subject),
        body: str(p.body),
        handles: strings(p.attachments).filter((h) => StagingHandle.safeParse(h).success),
        draftId: str(p.draft_id),
        messageId: str(p.message_id),
        includeOriginalAttachments:
          typeof p.include_original_attachments === "boolean" ? p.include_original_attachments : null,
      };
      if (action === "send.draft" && !view.draftId) return { kind: "raw", reason: "send.draft without draft_id" };
      if (action === "send.forward" && !view.messageId)
        return { kind: "raw", reason: "send.forward without message_id" };
      if (action !== "send.draft" && view.to.length + view.cc.length + view.bcc.length === 0)
        return { kind: "raw", reason: "no recipients" };
      return view;
    }
    case "trash.move":
    case "trash.restore":
    case "spam.mark":
    case "spam.unmark":
    case "label.apply": {
      const view = {
        kind: "targets" as const,
        messageIds: strings(p.message_ids).concat(str(p.message_id) ? [str(p.message_id)!] : []),
        threadIds: strings(p.thread_ids).concat(str(p.thread_id) ? [str(p.thread_id)!] : []),
        add: strings(p.add).concat(strings(p.label_ids)),
        remove: strings(p.remove),
        count: 0,
      };
      view.count = view.messageIds.length + view.threadIds.length;
      if (view.count === 0) return { kind: "raw", reason: "no target" };
      if (action === "label.apply" && view.add.length + view.remove.length === 0)
        return { kind: "raw", reason: "no labels" };
      return view;
    }
    case "label.manage": {
      const op = str(p.op);
      if (op !== "create" && op !== "update" && op !== "delete") return { kind: "raw", reason: "unknown label op" };
      return { kind: "label", op, labelId: str(p.label_id), name: str(p.name) };
    }
    case "attachment.stage_upload": {
      const filename = str(p.filename);
      const mime = str(p.mime);
      return filename && mime && typeof p.size === "number"
        ? { kind: "upload", filename, size: p.size, mime }
        : { kind: "raw", reason: "upload without filename, size and mime" };
    }
    default:
      return { kind: "raw", reason: `no view for ${action}` };
  }
}
```

Add to `worker/src/approval/pending.ts`, next to `approvePending` and `denyPending`, the statement forms the page batches:

```ts
export function approveStatement(
  db: D1Database,
  o: { id: string; userId: string; via: "browser" | "elicitation" },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE pending_actions SET state = 'approved', approved_at = ?, approved_via = ? WHERE id = ? AND user_id = ? AND state = 'pending' AND expires_at > ?`,
    )
    .bind(Date.now(), o.via, o.id, o.userId, Date.now());
}
export function denyStatement(db: D1Database, o: { id: string; userId: string }): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE pending_actions SET state = 'denied', payload_json = NULL, summary = 'redacted' WHERE id = ? AND user_id = ? AND state = 'pending' AND expires_at > ?`,
    )
    .bind(o.id, o.userId, Date.now());
}
/** Fails the batch unless the pending row is now in `state`. Same `_assert` trick as the claim. */
export function assertPendingState(db: D1Database, id: string, state: PendingState): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO _assert (x) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM pending_actions WHERE id = ? AND state = ?)`,
    )
    .bind(id, state);
}
```

In `worker/src/audit/log.ts`, split `write` so the statement can be batched:

```ts
export function auditStatement(
  db: D1Database,
  phase: "intent" | "outcome",
  b: Base & { gmailResultId?: string },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log (ts, user_id, account_id, tool, action, modifiers, phase, decision, pending_id, operation_id, gmail_result_id, summary, client_hint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      Date.now(),
      b.userId,
      b.accountId,
      b.tool,
      b.action,
      JSON.stringify(b.modifiers),
      phase,
      b.decision,
      b.pendingId ?? null,
      b.operationId ?? null,
      b.gmailResultId ?? null,
      render(b.facts),
      b.clientHint ?? null,
    );
}

async function write(
  db: D1Database,
  phase: "intent" | "outcome",
  b: Base & { gmailResultId?: string },
): Promise<number> {
  const res = await auditStatement(db, phase, b).run();
  return Number(res.meta.last_row_id ?? 0);
}
```

`Base` becomes an exported type (`export type AuditBase = ...`) so the page can name it. The existing audit tests keep passing: `auditIntent` and `auditOutcome` are unchanged in behaviour.

`worker/src/web/pages/approve.ts`:

```ts
import type { Env } from "../../env";
import { auditStatement } from "../../audit/log";
import {
  approveStatement,
  assertPendingState,
  denyStatement,
  getPending,
  type PendingRow,
} from "../../approval/pending";
import { approvalView, type ApprovalView } from "../../approval/view";
import { csrfToken } from "../csrf";
import { escapeHtml, escapeVisible, redirect } from "../html";
import { type Route, guardPost, page, readForm, requireSession } from "../router";
import type { Session } from "../session";

const PREVIEW_BYTES = 2048;

function cutBytes(s: string, max: number): { text: string; truncated: boolean } {
  let out = "";
  let n = 0;
  for (const ch of s) {
    const len = new TextEncoder().encode(ch).length;
    if (n + len > max) return { text: out, truncated: true };
    out += ch;
    n += len;
  }
  return { text: out, truncated: false };
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const list = (items: string[]) => (items.length === 0 ? "none" : items.map(escapeVisible).join("<br>"));
const row = (th: string, td: string) => `<tr><th>${th}</th><td>${td}</td></tr>`;

/** Recipient and attachment counts for the audit summary; the audit module renders the text itself. */
function facts(view: ApprovalView): { recipients?: number; attachments?: number; ids?: string[] } {
  if (view.kind === "send")
    return { recipients: view.to.length + view.cc.length + view.bcc.length, attachments: view.handles.length };
  if (view.kind === "targets") return { ids: [...view.messageIds, ...view.threadIds] };
  if (view.kind === "label") return { ids: view.labelId ? [view.labelId] : [] };
  return {};
}

async function viewRows(env: Env, pending: PendingRow, view: ApprovalView): Promise<string> {
  switch (view.kind) {
    case "send": {
      const files =
        view.handles.length > 0
          ? (
              await env.DB.prepare(
                `SELECT handle, filename, size FROM staging_objects WHERE user_id = ? AND account_id = ? AND handle IN (${view.handles.map(() => "?").join(",")})`,
              )
                .bind(pending.user_id, pending.account_id, ...view.handles)
                .all<{ handle: string; filename: string; size: number }>()
            ).results
          : [];
      const attachments =
        files.length === 0 && view.handles.length === 0
          ? "none"
          : files.map((f) => `${escapeVisible(f.filename)} (${human(f.size)})`).join("<br>") +
            (files.length < view.handles.length
              ? `<br><em>${view.handles.length - files.length} handle(s) not found</em>`
              : "");
      return [
        view.messageId ? row("In reply to / forwarding", escapeVisible(view.messageId)) : "",
        view.draftId ? row("Draft", escapeVisible(view.draftId)) : "",
        row("To", list(view.to)),
        row("Cc", list(view.cc)),
        row("Bcc", list(view.bcc)),
        row("Subject", view.subject === null ? "none" : escapeVisible(view.subject)),
        row("Attachments", attachments),
        view.includeOriginalAttachments === null
          ? ""
          : row("Original attachments included", view.includeOriginalAttachments ? "yes" : "no"),
      ].join("");
    }
    case "targets":
      return [
        row("Messages", `${view.messageIds.length} message(s)<br>${list(view.messageIds)}`),
        row("Threads", `${view.threadIds.length} thread(s)<br>${list(view.threadIds)}`),
        view.add.length ? row("Add labels", list(view.add)) : "",
        view.remove.length ? row("Remove labels", list(view.remove)) : "",
      ].join("");
    case "label":
      return [
        row("Operation", escapeHtml(view.op ?? "?")),
        row("Label id", view.labelId ? escapeVisible(view.labelId) : "new"),
        row("Name", view.name ? escapeVisible(view.name) : "unchanged"),
      ].join("");
    case "upload":
      return [
        row("File", escapeVisible(view.filename)),
        row("Size", human(view.size)),
        row("Type", escapeVisible(view.mime)),
      ].join("");
    case "raw":
      return row(
        "Payload",
        `<p class="untrusted-label">This payload could not be summarised (${escapeHtml(view.reason)}). Read it in full before deciding.</p><pre class="untrusted">${escapeVisible(pending.payload_json ?? "")}</pre>`,
      );
  }
}

async function render(env: Env, s: Session, pending: PendingRow): Promise<Response> {
  const account = await env.DB.prepare("SELECT alias FROM accounts WHERE id = ? AND user_id = ?")
    .bind(pending.account_id, pending.user_id)
    .first<{ alias: string }>();
  if (pending.state !== "pending" || pending.expires_at <= Date.now()) {
    const state = pending.state === "pending" ? "expired" : pending.state;
    return page(
      env,
      s,
      "Action " + state,
      `<p>This action is <strong>${escapeHtml(state)}</strong>. Nothing more can be done with it here.</p>`,
    );
  }
  const view = approvalView(pending.action, pending.payload_json ? JSON.parse(pending.payload_json) : {});
  const preview = view.kind === "send" && view.body !== null ? cutBytes(view.body, PREVIEW_BYTES) : null;
  const csrf = await csrfToken(env, s, "POST", "/approve", pending.id);
  const modifiers = (JSON.parse(pending.modifiers) as string[]).map(escapeHtml).join(" ") || "none";
  const body = `
<table>
${row("Action", escapeHtml(pending.action))}
${row("Account", escapeHtml(account?.alias ?? pending.account_id))}
${row("Modifiers", modifiers)}
${await viewRows(env, pending, view)}
${row("Expires", new Date(pending.expires_at).toISOString())}
</table>
${
  preview === null
    ? ""
    : `<p class="untrusted-label">Untrusted email content follows. It was written by whoever composed this message, which may be the model. Links are not clickable.</p>
<pre class="untrusted">${escapeVisible(preview.text)}</pre>
${preview.truncated ? '<p class="muted">Preview truncated at 2 KB.</p>' : ""}`
}
<form method="post" action="/approve/${escapeHtml(pending.id)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<button name="decision" value="approve" class="approve">Approve</button>
<button name="decision" value="deny" class="deny">Deny</button>
</form>`;
  return page(env, s, "Approve this action?", body);
}

export const approveRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/approve\/(pa_[A-Za-z0-9_-]{22})$/,
    handler: async ({ env, request, params }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const pending = await getPending(env.DB, params[0]!, s.userId);
      if (!pending) return page(env, s, "Not found", "<p>No such action.</p>", 404);
      return render(env, s, pending);
    },
  },
  {
    method: "POST",
    pattern: /^\/approve\/(pa_[A-Za-z0-9_-]{22})$/,
    handler: async ({ env, request, params }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const form = await readForm(request);
      const refused = await guardPost(env, request, s, form, "/approve", params[0]!);
      if (refused) return refused;
      const pending = await getPending(env.DB, params[0]!, s.userId);
      if (!pending) return page(env, s, "Not found", "<p>No such action.</p>", 404);
      const decision = form.get("decision");
      if (decision !== "approve" && decision !== "deny")
        return page(env, s, "Not applied", "<p>Unknown decision.</p>", 400);
      const view = approvalView(pending.action, pending.payload_json ? JSON.parse(pending.payload_json) : {});
      const base = {
        userId: s.userId,
        accountId: pending.account_id,
        tool: "approve_page",
        action: pending.action,
        modifiers: JSON.parse(pending.modifiers) as string[],
        decision: decision === "approve" ? "approved" : "denied",
        pendingId: pending.id,
        facts: facts(view),
      };
      // One batch: the transition, an assertion that it happened, and the audit row. If the row was
      // already decided, the assertion fails, the batch rolls back, and no audit row claims otherwise.
      try {
        await env.DB.batch([
          decision === "approve"
            ? approveStatement(env.DB, { id: pending.id, userId: s.userId, via: "browser" })
            : denyStatement(env.DB, { id: pending.id, userId: s.userId }),
          assertPendingState(env.DB, pending.id, decision === "approve" ? "approved" : "denied"),
          auditStatement(env.DB, "outcome", base),
        ]);
      } catch {
        return page(env, s, "Not applied", "<p>This action was already decided, cancelled or expired.</p>", 409);
      }
      return redirect(`/approve/${pending.id}`);
    },
  },
];
```

Mount `approveRoutes` in `index.ts`.

- [ ] **Step 4: run, expect PASS (5 tests), then commit**

```bash
git add worker/src/web/pages/approve.ts worker/src/approval/view.ts worker/src/approval/pending.ts worker/src/audit/log.ts worker/src/index.ts worker/test/approve.test.ts
git commit -m "feat(worker): approval page shows a typed view per action, falls back to the full payload, and audits in the same batch

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: The Accounts page

**Files:**

- Create: `worker/src/web/pages/accounts.ts`, `worker/test/accounts.test.ts`
- Modify: `worker/src/index.ts` (mount)

**Interfaces:**

- `GET /accounts`: session. Lists every account of the owner with alias, email, status, default flag, send limit, org domains, allowlist entries. A connect form (`GET /connect` with an `alias` input). Per account: reconnect link, and POST forms for `op=default`, `op=revoke`, `op=allowlist_add` (`pattern`), `op=allowlist_remove` (`pattern`), `op=send_limit` (`bytes`), `op=org_domains` (`domains`, comma separated). A companion section showing the client id or a `op=register_companion` form.
- `POST /accounts`: session, Origin, CSRF with route `/accounts` and object id = the `account` field (or `companion`). Trust-boundary ops require recent authentication (the 403 re-authentication page from `requireRecent` otherwise) and write an `intent` audit row with action `policy.edit`, decision `edited`, tool `accounts_page` and the op name in `facts.ids`: `revoke`, `register_companion`, `allowlist_add`, `allowlist_remove`, `org_domains`, and `send_limit` when the new value is higher than the stored one. `default` and a send-limit decrease need a session only. `revoke` calls `revokeAccount`, then `revokeOtherSessions`, and audits `account.connect` with decision `revoked` as well. Canonicalisation is shared with the trust rules, never reimplemented: an allowlist pattern is either `@` + `toAsciiDomain(domain)` or `parseAddress(pattern).normalized` (which keeps local-part case except where the provider folds it); each org domain is `toAsciiDomain(d)`; both throw `invalid_address` on garbage and the page answers 400. `bytes` is an integer within `1..26214400`.

- [ ] **Step 1 (RED): tests**

`worker/test/accounts.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index";
import { Browser, csrfFrom } from "./browser";
import { FakeGoogle } from "./fake-google";
import { testEnv } from "./test-env";
import { seedUserAndAccount } from "./fixtures";
import { Keyring } from "../src/crypto/keyring";
import { SESSION_COOKIE } from "../src/web/session";

let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker({ googleFetch: g.fetch });
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "ac1", alias: "personal", isDefault: true });
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "ac2", alias: "work" });
  await seedUserAndAccount(env.DB, { userId: "other-owner", accountId: "ac3", alias: "personal", isDefault: true });
});

async function owner() {
  const b = new Browser(worker, testEnv());
  await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
  return b;
}
async function tokenFor(b: Browser, objectId: string) {
  const html = await (await b.get("/accounts")).text();
  const block = html.split(`data-account="${objectId}"`)[1] ?? "";
  return csrfFrom(block);
}

describe("accounts page", () => {
  it("needs a session and lists only the owner's accounts", async () => {
    const anon = new Browser(worker, testEnv());
    expect((await anon.get("/accounts")).headers.get("location")).toBe("/login?return=%2Faccounts");
    const b = await owner();
    const html = await (await b.get("/accounts")).text();
    expect(html).toContain("personal");
    expect(html).toContain("work");
    expect(html).not.toContain("ac3");
    expect(html).toContain('action="/connect"');
    expect(html).not.toMatch(/refresh_token|access_token/);
  });

  it("set default moves the single default", async () => {
    const b = await owner();
    const res = await b.post("/accounts", { op: "default", account: "ac2", csrf: await tokenFor(b, "ac2") });
    expect(res.status).toBe(303);
    const rows = await env.DB.prepare(
      "SELECT id, is_default FROM accounts WHERE user_id = 'owner-sub' ORDER BY id",
    ).all<any>();
    expect(rows.results).toEqual([
      { id: "ac1", is_default: 0 },
      { id: "ac2", is_default: 1 },
    ]);
    expect((await b.post("/accounts", { op: "default", account: "ac3", csrf: await tokenFor(b, "ac2") })).status).toBe(
      403,
    );
  });

  it("trust settings need recent auth, are canonicalised the way the trust rules read them, and are audited", async () => {
    const b = await owner();
    const t = await tokenFor(b, "ac1");
    await env.DB.prepare("UPDATE web_sessions SET authenticated_at = 1 WHERE user_id = 'owner-sub'").run();
    const stale = await b.post("/accounts", {
      op: "allowlist_add",
      account: "ac1",
      pattern: "prof@uni.edu.au",
      csrf: t,
    });
    expect(stale.status).toBe(403);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM contact_allowlist WHERE account_id = 'ac1'").first<{
        n: number;
      }>(),
    ).toEqual({ n: 0 });
    await env.DB.prepare("UPDATE web_sessions SET authenticated_at = ? WHERE user_id = 'owner-sub'")
      .bind(Date.now())
      .run();

    expect(
      (await b.post("/accounts", { op: "allowlist_add", account: "ac1", pattern: "Prof.Name@Uni.EDU.AU", csrf: t }))
        .status,
    ).toBe(303);
    expect(
      (await b.post("/accounts", { op: "allowlist_add", account: "ac1", pattern: "@Bücher.example", csrf: t })).status,
    ).toBe(303);
    expect(
      (await b.post("/accounts", { op: "allowlist_add", account: "ac1", pattern: "Some.One+tag@gmail.com", csrf: t }))
        .status,
    ).toBe(303);
    expect(
      (await b.post("/accounts", { op: "allowlist_add", account: "ac1", pattern: "not an address", csrf: t })).status,
    ).toBe(400);
    expect((await b.post("/accounts", { op: "allowlist_add", account: "ac1", pattern: "@..", csrf: t })).status).toBe(
      400,
    );
    let list = (
      await env.DB.prepare("SELECT pattern FROM contact_allowlist WHERE account_id = 'ac1' ORDER BY pattern").all<any>()
    ).results.map((r) => r.pattern);
    // Local-part case is kept for a non-Gmail domain, the domain is lower-cased and punycoded, and the Gmail address is folded.
    expect(list).toEqual(["@xn--bcher-kva.example", "Prof.Name@uni.edu.au", "some.one@gmail.com"]);
    expect(
      (
        await b.post("/accounts", {
          op: "allowlist_remove",
          account: "ac1",
          pattern: "@xn--bcher-kva.example",
          csrf: t,
        })
      ).status,
    ).toBe(303);
    list = (
      await env.DB.prepare("SELECT pattern FROM contact_allowlist WHERE account_id = 'ac1' ORDER BY pattern").all<any>()
    ).results.map((r) => r.pattern);
    expect(list).toEqual(["Prof.Name@uni.edu.au", "some.one@gmail.com"]);

    expect((await b.post("/accounts", { op: "send_limit", account: "ac1", bytes: "10485760", csrf: t })).status).toBe(
      303,
    );
    expect(
      (await b.post("/accounts", { op: "send_limit", account: "ac1", bytes: "99999999999", csrf: t })).status,
    ).toBe(400);
    expect((await b.post("/accounts", { op: "send_limit", account: "ac1", bytes: "0", csrf: t })).status).toBe(400);
    expect(
      (
        await b.post("/accounts", {
          op: "org_domains",
          account: "ac1",
          domains: "Uni.edu.au, staff.uni.edu.au, bücher.example",
          csrf: t,
        })
      ).status,
    ).toBe(303);
    expect(
      (await b.post("/accounts", { op: "org_domains", account: "ac1", domains: "bad domain", csrf: t })).status,
    ).toBe(400);
    expect(
      (await b.post("/accounts", { op: "org_domains", account: "ac1", domains: "foo..com", csrf: t })).status,
    ).toBe(400);
    expect(
      (await b.post("/accounts", { op: "org_domains", account: "ac1", domains: "-foo.com", csrf: t })).status,
    ).toBe(400);
    const row = await env.DB.prepare(
      "SELECT send_limit_bytes, org_domains FROM accounts WHERE id = 'ac1'",
    ).first<any>();
    expect(row.send_limit_bytes).toBe(10485760);
    expect(JSON.parse(row.org_domains)).toEqual(["uni.edu.au", "staff.uni.edu.au", "xn--bcher-kva.example"]);

    // A decrease needs no recent auth; an increase does.
    await env.DB.prepare("UPDATE web_sessions SET authenticated_at = 1 WHERE user_id = 'owner-sub'").run();
    expect((await b.post("/accounts", { op: "send_limit", account: "ac1", bytes: "1048576", csrf: t })).status).toBe(
      303,
    );
    expect((await b.post("/accounts", { op: "send_limit", account: "ac1", bytes: "2097152", csrf: t })).status).toBe(
      403,
    );

    const audits = (
      await env.DB.prepare(
        "SELECT summary FROM audit_log WHERE user_id = 'owner-sub' AND tool = 'accounts_page' AND action = 'policy.edit' ORDER BY id",
      ).all<any>()
    ).results.map((r) => r.summary);
    expect(audits).toContain("ids=allowlist_add");
    expect(audits).toContain("ids=org_domains");
    expect(audits).toContain("ids=send_limit");
  });

  it("revoke needs recent authentication, wipes tokens, tells Google, and logs out other sessions", async () => {
    const b = await owner();
    const other = await owner();
    const ring = Keyring.fromEnv(testEnv());
    const rt = await ring.encrypt("rt-to-revoke", { userId: "owner-sub", accountId: "ac2", field: "refresh_token" });
    await env.DB.prepare("UPDATE accounts SET refresh_token_enc = ?, refresh_token_key_id = ? WHERE id = 'ac2'")
      .bind(rt.ciphertext, rt.keyId)
      .run();
    await env.DB.prepare("UPDATE web_sessions SET authenticated_at = 1 WHERE user_id = 'owner-sub'").run();
    const stale = await b.post("/accounts", { op: "revoke", account: "ac2", csrf: await tokenFor(b, "ac2") });
    expect(stale.status).toBe(403);
    expect(await stale.text()).toContain('name="return" value="/accounts"');
    expect((await env.DB.prepare("SELECT status FROM accounts WHERE id = 'ac2'").first<any>()).status).toBe("active");
    await env.DB.prepare("UPDATE web_sessions SET authenticated_at = ? WHERE user_id = 'owner-sub'")
      .bind(Date.now())
      .run();
    const ok = await b.post("/accounts", { op: "revoke", account: "ac2", csrf: await tokenFor(b, "ac2") });
    expect(ok.status).toBe(303);
    expect(g.revoked.has("rt-to-revoke")).toBe(true);
    const row = await env.DB.prepare("SELECT status, refresh_token_enc FROM accounts WHERE id = 'ac2'").first<any>();
    expect(row).toEqual({ status: "revoked", refresh_token_enc: null });
    expect((await other.get("/accounts")).status).toBe(303);
    expect((await b.get("/accounts")).status).toBe(200);
    expect(b.cookies.has(SESSION_COOKIE)).toBe(true);
    const audit = await env.DB.prepare(
      "SELECT decision FROM audit_log WHERE account_id = 'ac2' AND action = 'account.connect' ORDER BY id DESC LIMIT 1",
    ).first<any>();
    expect(audit.decision).toBe("revoked");
  });

  it("registers the companion once and shows its client id", async () => {
    const b = await owner();
    const html = await (await b.get("/accounts")).text();
    const t = csrfFrom(html.split('data-account="companion"')[1]!);
    expect((await b.post("/accounts", { op: "register_companion", account: "companion", csrf: t })).status).toBe(303);
    const again = await (await b.get("/accounts")).text();
    const id = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'companion_client_id'").first<any>())
      .value;
    expect(again).toContain(id);
    expect(again).not.toContain('value="register_companion"');
  });
});
```

- [ ] **Step 2: run, expect failure**

Run: `cd worker && npx vitest run test/accounts.test.ts`

- [ ] **Step 3 (GREEN): accounts.ts**

`worker/src/web/pages/accounts.ts`:

```ts
import type { Env } from "../../env";
import { auditOutcome } from "../../audit/log";
import { getCompanionClientId, registerCompanionClient } from "../../auth/companion";
import { auditIntent } from "../../audit/log";
import { revokeAccount } from "../../google/tokens";
import { parseAddress, toAsciiDomain } from "../../policy/recipients";
import { csrfToken } from "../csrf";
import { escapeHtml, redirect } from "../html";
import { type Route, guardPost, page, readForm, requireRecent, requireSession } from "../router";
import { revokeOtherSessions, type Session } from "../session";

const MAX_SEND_LIMIT = 26_214_400;

type AccountRow = {
  id: string;
  alias: string;
  google_email: string;
  status: string;
  is_default: number;
  send_limit_bytes: number;
  org_domains: string | null;
};

/**
 * Stored exactly as isTrusted() will read it, through the same two functions. A pattern that these
 * reject is not a trust decision we could later honour, so it is refused here with the same error.
 */
function canonicalPattern(raw: string): string {
  const p = raw.trim();
  if (p.startsWith("@")) return `@${toAsciiDomain(p.slice(1))}`;
  return parseAddress(p).normalized;
}

async function render(env: Env, s: Session, notice?: string): Promise<Response> {
  const accounts = (
    await env.DB.prepare(
      "SELECT id, alias, google_email, status, is_default, send_limit_bytes, org_domains FROM accounts WHERE user_id = ? ORDER BY alias",
    )
      .bind(s.userId)
      .all<AccountRow>()
  ).results;
  const allow = (
    await env.DB.prepare("SELECT account_id, pattern FROM contact_allowlist WHERE user_id = ? ORDER BY pattern")
      .bind(s.userId)
      .all<{ account_id: string; pattern: string }>()
  ).results;
  const companion = await getCompanionClientId(env.DB);
  const rows: string[] = [];
  for (const a of accounts) {
    const csrf = await csrfToken(env, s, "POST", "/accounts", a.id);
    const hidden = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="account" value="${escapeHtml(a.id)}">`;
    const patterns = allow.filter((x) => x.account_id === a.id).map((x) => x.pattern);
    rows.push(`<section data-account="${escapeHtml(a.id)}">
<h2>${escapeHtml(a.alias)} <span class="muted">${escapeHtml(a.google_email)} · ${escapeHtml(a.status)}${a.is_default ? " · default" : ""}</span></h2>
<p><a href="/connect?alias=${encodeURIComponent(a.alias)}">Reconnect</a></p>
<form method="post" action="/accounts" class="inline">${hidden}<button name="op" value="default"${a.is_default || a.status !== "active" ? " disabled" : ""}>Make default</button></form>
<form method="post" action="/accounts" class="inline">${hidden}<button name="op" value="revoke" class="deny"${a.status === "revoked" ? " disabled" : ""}>Revoke</button></form>
<h3>Trusted recipients</h3>
<ul>${patterns.map((p) => `<li>${escapeHtml(p)} <form method="post" action="/accounts" class="inline">${hidden}<input type="hidden" name="pattern" value="${escapeHtml(p)}"><button name="op" value="allowlist_remove">Remove</button></form></li>`).join("")}</ul>
<form method="post" action="/accounts">${hidden}<input name="pattern" placeholder="name@example.com or @example.com" required> <button name="op" value="allowlist_add">Add</button></form>
<h3>Limits</h3>
<form method="post" action="/accounts">${hidden}<label>Send limit (bytes) <input name="bytes" type="number" min="1" max="${MAX_SEND_LIMIT}" value="${a.send_limit_bytes}"></label> <button name="op" value="send_limit">Save</button></form>
<form method="post" action="/accounts">${hidden}<label>Organisation domains (Workspace only, comma separated) <input name="domains" value="${escapeHtml((JSON.parse(a.org_domains ?? "[]") as string[]).join(", "))}"></label> <button name="op" value="org_domains">Save</button></form>
</section>`);
  }
  const companionCsrf = await csrfToken(env, s, "POST", "/accounts", "companion");
  const body = `${notice ? `<p><strong>${escapeHtml(notice)}</strong></p>` : ""}
<form method="get" action="/connect"><label>Connect a Google account as <input name="alias" pattern="[a-z0-9_-]{1,32}" required placeholder="personal"></label> <button>Connect</button></form>
${rows.join("\n")}
<section data-account="companion">
<h2>Local companion</h2>
${
  companion
    ? `<p>Client id for <code>gmail-mcp-companion login</code>:</p><pre>${escapeHtml(companion)}</pre>`
    : `<form method="post" action="/accounts"><input type="hidden" name="csrf" value="${escapeHtml(companionCsrf)}"><input type="hidden" name="account" value="companion"><button name="op" value="register_companion">Register the companion client</button></form>`
}
</section>`;
  return page(env, s, "Accounts", body);
}

export const accountsRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/accounts$/,
    handler: async ({ env, request }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      return render(env, s);
    },
  },
  {
    method: "POST",
    pattern: /^\/accounts$/,
    handler: async ({ env, deps, request }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const form = await readForm(request);
      const objectId = form.get("account") ?? "";
      const refused = await guardPost(env, request, s, form, "/accounts", objectId);
      if (refused) return refused;
      const op = form.get("op") ?? "";
      const bad = (msg: string) => page(env, s, "Not saved", `<p>${escapeHtml(msg)}</p>`, 400);
      const auditTrust = (accountId: string | null) =>
        auditIntent(env.DB, {
          userId: s.userId,
          accountId,
          tool: "accounts_page",
          action: "policy.edit",
          modifiers: [],
          decision: "edited",
          facts: { ids: [op] },
        });

      if (op === "register_companion") {
        if (objectId !== "companion") return bad("wrong object");
        const recent = await requireRecent(env, s, request);
        if (recent) return recent;
        await registerCompanionClient(env, env.OAUTH_PROVIDER);
        await auditTrust(null);
        return redirect("/accounts");
      }

      // Ownership in the query, for every per-account op. A wrong id is a 403 rather than a 404 because
      // the CSRF token already bound the form to this account id; a mismatch here is a forged form.
      const acc = await env.DB.prepare("SELECT id, status, send_limit_bytes FROM accounts WHERE id = ? AND user_id = ?")
        .bind(objectId, s.userId)
        .first<{ id: string; status: string; send_limit_bytes: number }>();
      if (!acc) return page(env, s, "Refused", "<p>Not your account.</p>", 403);

      // Anything that widens what a send may do without asking is a trust decision: recent login, audited.
      const widens =
        op === "revoke" ||
        op === "allowlist_add" ||
        op === "allowlist_remove" ||
        op === "org_domains" ||
        (op === "send_limit" && Number(form.get("bytes")) > acc.send_limit_bytes);
      if (widens) {
        const recent = await requireRecent(env, s, request);
        if (recent) return recent;
      }

      switch (op) {
        case "default": {
          if (acc.status !== "active") return bad("only an active account can be the default");
          await env.DB.batch([
            env.DB.prepare("UPDATE accounts SET is_default = 0 WHERE user_id = ? AND is_default = 1").bind(s.userId),
            env.DB.prepare("UPDATE accounts SET is_default = 1 WHERE id = ? AND user_id = ?").bind(acc.id, s.userId),
          ]);
          return redirect("/accounts");
        }
        case "revoke": {
          await revokeAccount(env, deps, s.userId, acc.id);
          await revokeOtherSessions(env.DB, s.userId, s.idHash);
          await auditOutcome(env.DB, {
            userId: s.userId,
            accountId: acc.id,
            tool: "accounts_page",
            action: "account.connect",
            modifiers: [],
            decision: "revoked",
            facts: { ids: [acc.id] },
          });
          await auditTrust(acc.id);
          return redirect("/accounts");
        }
        case "allowlist_add": {
          let pattern: string;
          try {
            pattern = canonicalPattern(form.get("pattern") ?? "");
          } catch {
            return bad("a trusted recipient is an address or @domain");
          }
          await env.DB.prepare(
            "INSERT OR IGNORE INTO contact_allowlist (user_id, account_id, pattern) VALUES (?, ?, ?)",
          )
            .bind(s.userId, acc.id, pattern)
            .run();
          await auditTrust(acc.id);
          return redirect("/accounts");
        }
        case "allowlist_remove": {
          await env.DB.prepare("DELETE FROM contact_allowlist WHERE user_id = ? AND account_id = ? AND pattern = ?")
            .bind(s.userId, acc.id, form.get("pattern") ?? "")
            .run();
          await auditTrust(acc.id);
          return redirect("/accounts");
        }
        case "send_limit": {
          const bytes = Number(form.get("bytes"));
          if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_SEND_LIMIT)
            return bad(`send limit must be 1..${MAX_SEND_LIMIT} bytes`);
          await env.DB.prepare("UPDATE accounts SET send_limit_bytes = ? WHERE id = ? AND user_id = ?")
            .bind(bytes, acc.id, s.userId)
            .run();
          if (widens) await auditTrust(acc.id);
          return redirect("/accounts");
        }
        case "org_domains": {
          let domains: string[];
          try {
            domains = (form.get("domains") ?? "")
              .split(",")
              .map((d) => d.trim())
              .filter((d) => d !== "")
              .map(toAsciiDomain);
          } catch {
            return bad("each organisation domain must be a valid domain name");
          }
          await env.DB.prepare("UPDATE accounts SET org_domains = ? WHERE id = ? AND user_id = ?")
            .bind(domains.length ? JSON.stringify(domains) : null, acc.id, s.userId)
            .run();
          await auditTrust(acc.id);
          return redirect("/accounts");
        }
        default:
          return bad("unknown operation");
      }
    },
  },
];
```

`parseAddress` and `toAsciiDomain` in `policy/recipients.ts` throw `GmailMcpError("invalid_address")` on garbage (Plan 1 Task 6), and `isTrusted` compares allowlist entries through the same two functions, which is why the page stores their output and nothing else. If `toAsciiDomain` accepts `foo..com` or `-foo.com` today, tighten it there (empty labels, leading or trailing hyphens, labels over 63 bytes, total over 253) with a test in `recipients.test.ts`, so the page and the trust rules move together.

Mount `accountsRoutes`.

- [ ] **Step 4: run, expect PASS, then commit**

Run: `cd worker && npx vitest run test/accounts.test.ts test/login.test.ts`

```bash
git add worker/src/web/pages/accounts.ts worker/src/web/login.ts worker/src/index.ts worker/test/accounts.test.ts worker/test/login.test.ts
git commit -m "feat(worker): accounts page; trust settings need recent auth, share the trust rules' canonicalisation, and are audited

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: The Policy page

**Files:**

- Create: `worker/src/web/pages/policy.ts`, `worker/test/policy-page.test.ts`
- Modify: `worker/src/policy/engine.ts` (add `clearPolicy`), `worker/src/index.ts` (mount)

**Interfaces:**

- `policy/engine.ts` gains `setPolicyStatement` and `clearPolicyStatement`, the prepared forms of `setPolicy` and a new `clearPolicy`, plus `applyPolicyEdit(db, o: { userId; sessionIdHash; changes: PolicyChange[]; audit: AuditBase }): Promise<void>` which runs every change, the audit row and `revokeOtherSessions` as one `db.batch()`. `PolicyChange = { accountId: string | null; action: Action; level: Level | "inherit" }`.
- `GET /policy`: session. A table with one row per action in `ACTIONS` except `policy.edit` (shown as "browser only"), columns: default, owner-wide override (`<select name="g:<action>">` with `inherit|allow|ask|deny`), then one column per active account (`<select name="a:<accountId>:<action>">`). Below it the blocked-extension set, read-only. One Save form, CSRF object id `policy`.
- `POST /policy`: session, Origin, CSRF, recent authentication. Validates every field first (unknown actions and accounts are ignored, an unknown level is a 400 before any write), then calls `applyPolicyEdit`, so the policy rows, the `intent` audit row (`action: "policy.edit"`, `decision: "edited"`, `facts.ids` = the changed field names) and the revocation of every other session land together or not at all.

- [ ] **Step 1 (RED): tests**

`worker/test/policy-page.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index";
import { Browser, csrfFrom } from "./browser";
import { FakeGoogle } from "./fake-google";
import { testEnv } from "./test-env";
import { seedUserAndAccount } from "./fixtures";
import { applyPolicyEdit, effectiveLevel } from "../src/policy/engine";
import type { Level } from "@gmail-mcp/shared/actions";

let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker({ googleFetch: g.fetch });
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "pp1", alias: "personal", isDefault: true });
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "pp2", alias: "work" });
  await seedUserAndAccount(env.DB, { userId: "other-owner", accountId: "pp3", alias: "personal", isDefault: true });
});

async function owner() {
  const b = new Browser(worker, testEnv());
  await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
  return b;
}

describe("policy page", () => {
  it("renders the matrix with defaults, the browser-only row, and the blocked extensions", async () => {
    const b = await owner();
    const html = await (await b.get("/policy")).text();
    expect(html).toContain('name="g:send.message"');
    expect(html).toContain('name="a:pp1:send.message"');
    expect(html).toContain('name="a:pp2:send.message"');
    expect(html).not.toContain("pp3");
    expect(html).toContain("browser only");
    expect(html).toContain(".exe");
    expect(html).not.toContain('name="g:policy.edit"');
  });

  it("saving needs recent auth, applies overrides and inherit, audits, and logs out other sessions", async () => {
    const b = await owner();
    const other = await owner();
    const csrf = csrfFrom(await (await b.get("/policy")).text(), "/policy");
    await env.DB.prepare("UPDATE web_sessions SET authenticated_at = 1 WHERE user_id = 'owner-sub'").run();
    const stale = await b.post("/policy", { csrf, "g:send.message": "allow" });
    expect(stale.status).toBe(403);
    expect(await stale.text()).toContain('name="return" value="/policy"');
    expect(await effectiveLevel(env.DB, "owner-sub", "pp1", "send.message")).toBe("ask");
    await env.DB.prepare("UPDATE web_sessions SET authenticated_at = ? WHERE user_id = 'owner-sub'")
      .bind(Date.now())
      .run();

    expect(
      (
        await b.post("/policy", {
          csrf,
          "g:send.message": "allow",
          "a:pp2:send.message": "deny",
          "a:pp3:send.message": "allow",
          "g:made.up": "allow",
        })
      ).status,
    ).toBe(303);
    expect(await effectiveLevel(env.DB, "owner-sub", "pp1", "send.message")).toBe("allow");
    expect(await effectiveLevel(env.DB, "owner-sub", "pp2", "send.message")).toBe("deny");
    expect(await effectiveLevel(env.DB, "other-owner", "pp3", "send.message")).toBe("ask");
    const audit = await env.DB.prepare(
      "SELECT action, decision, summary FROM audit_log WHERE user_id = 'owner-sub' AND action = 'policy.edit' ORDER BY id DESC LIMIT 1",
    ).first<any>();
    expect(audit.decision).toBe("edited");
    expect(audit.summary).toContain("g:send.message");
    expect((await other.get("/policy")).status).toBe(303);

    const csrf2 = csrfFrom(await (await b.get("/policy")).text(), "/policy");
    await env.DB.prepare("UPDATE web_sessions SET authenticated_at = ? WHERE user_id = 'owner-sub'")
      .bind(Date.now())
      .run();
    expect(
      (await b.post("/policy", { csrf: csrf2, "g:send.message": "inherit", "a:pp2:send.message": "inherit" })).status,
    ).toBe(303);
    expect(await effectiveLevel(env.DB, "owner-sub", "pp2", "send.message")).toBe("ask");
    expect((await b.post("/policy", { csrf: csrf2, "g:trash.move": "yolo" })).status).toBe(400);
    expect(await effectiveLevel(env.DB, "owner-sub", "pp1", "trash.move")).toBe("ask");
  });

  it("a failure in the middle of an edit rolls back every change, the audit row and the session revocation", async () => {
    const other = await owner();
    const before = (await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_log WHERE user_id = 'owner-sub' AND action = 'policy.edit'",
    ).first<{ n: number }>())!.n;
    await expect(
      applyPolicyEdit(env.DB, {
        userId: "owner-sub",
        sessionIdHash: "no-session-is-kept-so-a-commit-would-revoke-every-session",
        changes: [
          { accountId: null, action: "trash.move", level: "deny" },
          // The CHECK constraint on policies.level rejects this; the batch rolls back.
          { accountId: null, action: "spam.mark", level: "bogus" as Level },
        ],
        audit: {
          userId: "owner-sub",
          accountId: null,
          tool: "policy_page",
          action: "policy.edit",
          modifiers: [],
          decision: "edited",
          facts: { ids: ["g:trash.move", "g:spam.mark"] },
        },
      }),
    ).rejects.toThrow();
    expect(await effectiveLevel(env.DB, "owner-sub", "pp1", "trash.move")).toBe("ask");
    expect(
      (await env.DB.prepare(
        "SELECT count(*) AS n FROM audit_log WHERE user_id = 'owner-sub' AND action = 'policy.edit'",
      ).first<{ n: number }>())!.n,
    ).toBe(before);
    expect((await other.get("/policy")).status).toBe(200);
  });
});
```

- [ ] **Step 2: run, expect failure**

Run: `cd worker && npx vitest run test/policy-page.test.ts`

- [ ] **Step 3 (GREEN): engine.ts addition and policy.ts**

Append to `worker/src/policy/engine.ts` (and add `import { auditStatement, type AuditBase } from "../audit/log";` and `import { revokeOtherSessionsStatement } from "../web/session";`):

```ts
export type PolicyChange = { accountId: string | null; action: Action; level: Level | "inherit" };

export function setPolicyStatement(
  db: D1Database,
  o: { userId: string; accountId: string | null; action: Action; level: Level },
): D1PreparedStatement {
  const now = Date.now();
  return o.accountId === null
    ? db
        .prepare(
          `INSERT INTO policies (user_id, account_id, action, level, updated_at) VALUES (?, NULL, ?, ?, ?)
           ON CONFLICT(user_id, action) WHERE account_id IS NULL DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`,
        )
        .bind(o.userId, o.action, o.level, now)
    : db
        .prepare(
          `INSERT INTO policies (user_id, account_id, action, level, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, account_id, action) WHERE account_id IS NOT NULL DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`,
        )
        .bind(o.userId, o.accountId, o.action, o.level, now);
}

export function clearPolicyStatement(
  db: D1Database,
  o: { userId: string; accountId: string | null; action: Action },
): D1PreparedStatement {
  return o.accountId === null
    ? db
        .prepare("DELETE FROM policies WHERE user_id = ? AND account_id IS NULL AND action = ?")
        .bind(o.userId, o.action)
    : db
        .prepare("DELETE FROM policies WHERE user_id = ? AND account_id = ? AND action = ?")
        .bind(o.userId, o.accountId, o.action);
}

export async function clearPolicy(
  db: D1Database,
  o: { userId: string; accountId: string | null; action: Action },
): Promise<void> {
  await clearPolicyStatement(db, o).run();
}

/**
 * A policy edit is one transaction: every row change, the audit row that says it happened, and the
 * revocation of every other session, together or not at all. Ownership of account_id rows is the
 * composite foreign key's job; the caller has already validated the shape.
 */
export async function applyPolicyEdit(
  db: D1Database,
  o: { userId: string; sessionIdHash: string; changes: PolicyChange[]; audit: AuditBase },
): Promise<void> {
  const stmts = o.changes.map((c) =>
    c.level === "inherit"
      ? clearPolicyStatement(db, { userId: o.userId, accountId: c.accountId, action: c.action })
      : setPolicyStatement(db, { userId: o.userId, accountId: c.accountId, action: c.action, level: c.level }),
  );
  stmts.push(auditStatement(db, "intent", o.audit));
  stmts.push(revokeOtherSessionsStatement(db, o.userId, o.sessionIdHash));
  await db.batch(stmts);
}
```

`setPolicy` from Plan 1 can now delegate to `setPolicyStatement(...).run()` after its `assertAccount` check; keep its tests green. In `worker/src/web/session.ts` add the statement form the batch needs:

```ts
export function revokeOtherSessionsStatement(db: D1Database, userId: string, keepIdHash: string): D1PreparedStatement {
  return db
    .prepare("UPDATE web_sessions SET revoked_at = ? WHERE user_id = ? AND id_hash != ? AND revoked_at IS NULL")
    .bind(Date.now(), userId, keepIdHash);
}
```

and let `revokeOtherSessions` call it.

`worker/src/web/pages/policy.ts`:

```ts
import { ACTIONS, DEFAULT_POLICY, LEVELS, type Action, type Level } from "@gmail-mcp/shared/actions";
import type { Env } from "../../env";
import { applyPolicyEdit, type PolicyChange } from "../../policy/engine";
import { BLOCKED_EXTENSIONS } from "../../policy/limits";
import { csrfToken } from "../csrf";
import { escapeHtml, redirect } from "../html";
import { type Route, guardPost, page, readForm, requireRecent, requireSession } from "../router";
import type { Session } from "../session";

const EDITABLE = ACTIONS.filter((a) => DEFAULT_POLICY[a] !== "browser");
const OPTIONS = ["inherit", ...LEVELS] as const;

function select(name: string, current: string): string {
  return `<select name="${escapeHtml(name)}">${OPTIONS.map((o) => `<option value="${o}"${o === current ? " selected" : ""}>${o}</option>`).join("")}</select>`;
}

async function render(env: Env, s: Session): Promise<Response> {
  const accounts = (
    await env.DB.prepare("SELECT id, alias FROM accounts WHERE user_id = ? AND status != 'revoked' ORDER BY alias")
      .bind(s.userId)
      .all<{ id: string; alias: string }>()
  ).results;
  const overrides = (
    await env.DB.prepare("SELECT account_id, action, level FROM policies WHERE user_id = ?")
      .bind(s.userId)
      .all<{ account_id: string | null; action: string; level: string }>()
  ).results;
  const current = (accountId: string | null, action: string) =>
    overrides.find((o) => o.account_id === accountId && o.action === action)?.level ?? "inherit";
  const csrf = await csrfToken(env, s, "POST", "/policy", "policy");
  const head = `<tr><th>Action</th><th>Default</th><th>All accounts</th>${accounts.map((a) => `<th>${escapeHtml(a.alias)}</th>`).join("")}</tr>`;
  const rows = EDITABLE.map(
    (a) =>
      `<tr><td>${escapeHtml(a)}</td><td>${DEFAULT_POLICY[a]}</td><td>${select(`g:${a}`, current(null, a))}</td>${accounts
        .map((acc) => `<td>${select(`a:${acc.id}:${a}`, current(acc.id, a))}</td>`)
        .join("")}</tr>`,
  );
  rows.push(`<tr><td>policy.edit</td><td colspan="${2 + accounts.length}">browser only</td></tr>`);
  const body = `<p>Effective level is the account column, else the all-accounts column, else the default. Modifiers can only raise a level. Saving signs out every other browser session.</p>
<form method="post" action="/policy"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<table>${head}${rows.join("")}</table>
<p><button>Save policy</button></p></form>
<h2>Blocked upload extensions</h2>
<p class="muted">What Gmail refuses to send. Applies to uploads only.</p>
<p>${[...BLOCKED_EXTENSIONS]
    .sort()
    .map((e) => `.${escapeHtml(e)}`)
    .join(" ")}</p>`;
  return page(env, s, "Policy", body);
}

export const policyRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/policy$/,
    handler: async ({ env, request }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      return render(env, s);
    },
  },
  {
    method: "POST",
    pattern: /^\/policy$/,
    handler: async ({ env, request }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const form = await readForm(request);
      const refused = await guardPost(env, request, s, form, "/policy", "policy");
      if (refused) return refused;
      const recent = await requireRecent(env, s, request);
      if (recent) return recent;

      const accounts = new Set(
        (
          await env.DB.prepare("SELECT id FROM accounts WHERE user_id = ?").bind(s.userId).all<{ id: string }>()
        ).results.map((r) => r.id),
      );
      const overrides = (
        await env.DB.prepare("SELECT account_id, action, level FROM policies WHERE user_id = ?")
          .bind(s.userId)
          .all<{ account_id: string | null; action: string; level: string }>()
      ).results;
      const current = (accountId: string | null, action: string) =>
        overrides.find((o) => o.account_id === accountId && o.action === action)?.level ?? "inherit";

      // Validate everything before writing anything: a bad level anywhere means no change at all.
      const changes: (PolicyChange & { field: string })[] = [];
      for (const [field, value] of form.entries()) {
        const m = /^(g|a):(?:([^:]+):)?([a-z_.]+)$/.exec(field);
        if (!m) continue;
        const accountId = m[1] === "a" ? m[2]! : null;
        const action = m[3]!;
        if (!(EDITABLE as readonly string[]).includes(action)) continue;
        if (accountId !== null && !accounts.has(accountId)) continue;
        if (!(OPTIONS as readonly string[]).includes(value))
          return page(env, s, "Not saved", `<p>Unknown level for ${escapeHtml(field)}.</p>`, 400);
        if (value === current(accountId, action)) continue;
        changes.push({ accountId, action: action as Action, level: value as Level | "inherit", field });
      }
      await applyPolicyEdit(env.DB, {
        userId: s.userId,
        sessionIdHash: s.idHash,
        changes,
        audit: {
          userId: s.userId,
          accountId: null,
          tool: "policy_page",
          action: "policy.edit",
          modifiers: [],
          decision: "edited",
          facts: { ids: changes.map((c) => c.field) },
        },
      });
      return redirect("/policy");
    },
  },
];
```

`render`'s audit summary sanitiser in `audit/log.ts` keeps `A-Za-z0-9_.:-`, so `g:send.message` and `a:pp2:send.message` survive intact.

Mount `policyRoutes`.

- [ ] **Step 4: run, expect PASS (2 tests), then commit**

```bash
git add worker/src/web/pages/policy.ts worker/src/policy/engine.ts worker/src/web/session.ts worker/src/index.ts worker/test/policy-page.test.ts
git commit -m "feat(worker): policy page edits the action matrix under recent auth; rows, audit and session revocation are one batch

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: The Audit page and the scheduled purge

**Files:**

- Create: `worker/src/web/pages/audit.ts`, `worker/test/audit-page.test.ts`
- Modify: `worker/src/index.ts` (mount), `worker/src/cron.ts` (`purgeStates`, `purgedStates` in `CronReport`)

**Interfaces:**

- `GET /audit?account=<alias>&action=<action>&days=<1..90>`: session. Up to 200 rows of the owner's audit log, newest first, filtered when the parameters parse; each row shows time (ISO), account alias, tool, action, modifiers, phase, decision, pending id, operation id, summary. Everything escaped. Filters are a `GET` form.
- `runCron` gains `purgedStates` from `purgeStates(db, now)` (Task 6), so consumed and expired `oauth_states` rows leave D1; `scheduled` already calls the provider's `purgeExpiredData` (Task 7). This task proves both through `worker.scheduled`.

- [ ] **Step 1 (RED): tests**

`worker/test/audit-page.test.ts`:

```ts
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index";
import { Browser } from "./browser";
import { FakeGoogle } from "./fake-google";
import { testEnv } from "./test-env";
import { seedUserAndAccount } from "./fixtures";
import { auditIntent } from "../src/audit/log";

let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker({ googleFetch: g.fetch });
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "au1", alias: "personal", isDefault: true });
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "au2", alias: "work" });
  await seedUserAndAccount(env.DB, { userId: "other-owner", accountId: "au3", alias: "personal", isDefault: true });
  await auditIntent(env.DB, {
    userId: "owner-sub",
    accountId: "au1",
    tool: "send_message",
    action: "send.message",
    modifiers: ["+external"],
    decision: "ask",
    pendingId: "pa_x",
    facts: { recipients: 2 },
  });
  await auditIntent(env.DB, {
    userId: "owner-sub",
    accountId: "au2",
    tool: "trash_message",
    action: "trash.move",
    modifiers: [],
    decision: "allow",
    facts: { ids: ["m<script>"] },
  });
  await auditIntent(env.DB, {
    userId: "other-owner",
    accountId: "au3",
    tool: "send_message",
    action: "send.message",
    modifiers: [],
    decision: "ask",
    facts: {},
  });
});

describe("audit page", () => {
  it("shows only the owner's rows, escaped, with working filters", async () => {
    const b = new Browser(worker, testEnv());
    await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
    const all = await (await b.get("/audit")).text();
    expect(all).toContain("send_message");
    expect(all).toContain("trash_message");
    expect(all).toContain("recipients=2");
    expect(all).not.toContain("au3");
    expect(all).not.toContain("<script>");
    const filtered = await (await b.get("/audit?action=trash.move&account=work")).text();
    expect(filtered).toContain("trash_message");
    expect(filtered).not.toContain("pa_x");
    expect((await b.get("/audit?days=999")).status).toBe(200);
  });

  it("scheduled runs recovery, purges stale oauth_states, and runs the provider purge", async () => {
    await env.DB.prepare(
      "INSERT INTO oauth_states (id, kind, payload, created_at, expires_at, consumed_at) VALUES ('st_old', 'login', '{}', 1, 2, 3)",
    ).run();
    const ctx = createExecutionContext();
    worker.scheduled!(
      { scheduledTime: Date.now(), cron: "*/5 * * * *", noRetry() {} } as ScheduledController,
      testEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM oauth_states WHERE id = 'st_old'").first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });
});
```

- [ ] **Step 2: run, expect failure**

- [ ] **Step 3 (GREEN): audit.ts**

`worker/src/web/pages/audit.ts`:

```ts
import { ACTIONS } from "@gmail-mcp/shared/actions";
import { AccountAlias } from "@gmail-mcp/shared/schemas";
import { escapeHtml } from "../html";
import { type Route, page, requireSession } from "../router";

type Row = {
  ts: number;
  alias: string | null;
  tool: string | null;
  action: string | null;
  modifiers: string | null;
  phase: string;
  decision: string | null;
  pending_id: string | null;
  operation_id: string | null;
  summary: string | null;
};

export const auditRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/audit$/,
    handler: async ({ env, request, url }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const alias = AccountAlias.safeParse(url.searchParams.get("account"));
      const action = url.searchParams.get("action");
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 90));
      const where = ["l.user_id = ?", "l.ts >= ?"];
      const binds: unknown[] = [s.userId, Date.now() - days * 86_400_000];
      if (alias.success) {
        where.push("a.alias = ?");
        binds.push(alias.data);
      }
      if (action && (ACTIONS as readonly string[]).includes(action)) {
        where.push("l.action = ?");
        binds.push(action);
      }
      const rows = (
        await env.DB.prepare(
          `SELECT l.ts, a.alias, l.tool, l.action, l.modifiers, l.phase, l.decision, l.pending_id, l.operation_id, l.summary
           FROM audit_log l LEFT JOIN accounts a ON a.id = l.account_id AND a.user_id = l.user_id
           WHERE ${where.join(" AND ")} ORDER BY l.id DESC LIMIT 200`,
        )
          .bind(...binds)
          .all<Row>()
      ).results;
      const cell = (v: string | number | null) => `<td>${v === null ? "" : escapeHtml(String(v))}</td>`;
      const body = `<form method="get" action="/audit" class="inline">
<label>Account <input name="account" value="${alias.success ? escapeHtml(alias.data) : ""}"></label>
<label>Action <select name="action"><option value="">any</option>${ACTIONS.map((a) => `<option${a === action ? " selected" : ""}>${a}</option>`).join("")}</select></label>
<label>Days <input name="days" type="number" min="1" max="90" value="${days}"></label>
<button>Filter</button></form>
<table><tr><th>Time</th><th>Account</th><th>Tool</th><th>Action</th><th>Modifiers</th><th>Phase</th><th>Decision</th><th>Pending</th><th>Operation</th><th>Summary</th></tr>
${rows.map((r) => `<tr>${cell(new Date(r.ts).toISOString())}${cell(r.alias)}${cell(r.tool)}${cell(r.action)}${cell(r.modifiers)}${cell(r.phase)}${cell(r.decision)}${cell(r.pending_id)}${cell(r.operation_id)}${cell(r.summary)}</tr>`).join("")}
</table>
<p class="muted">Metadata only, kept 90 days. Bodies, subjects and tokens are never stored here.</p>`;
      return page(env, s, "Audit", body);
    },
  },
];
```

Mount `auditRoutes`. The full mount list in `index.ts` is now `[...loginRoutes, ...authorizeRoutes, ...connectRoutes, ...approveRoutes, ...accountsRoutes, ...policyRoutes, ...auditRoutes]`. In `worker/src/cron.ts` add `purgedStates: await purgeStates(env.DB, now, limit)` to the report (import from `./web/state`), and extend `CronReport` accordingly; `cron.test.ts` from Plan 1 keeps passing because it asserts named fields, not the whole object. If it asserts the whole object, add the field there.

- [ ] **Step 4: run, expect PASS, then the whole suite and commit**

```bash
cd worker && npx vitest run
git add worker/src/web/pages/audit.ts worker/src/index.ts worker/test/audit-page.test.ts
git commit -m "feat(worker): audit page over the owner's metadata log; scheduled purge covers provider state

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Documentation, the Google Cloud runbook, and the final gate

**Files:**

- Create: `docs/runbooks/google-cloud.md`
- Modify: `README.md`, `docs/ARCHITECTURE.md`, `CHANGELOG.md`, `CLAUDE.md`, `worker/.dev.vars.example` (already done in Task 1; confirm), `.github/dependabot.yml` if it names packages individually

- [ ] **Step 1: runbook**

`docs/runbooks/google-cloud.md`:

```markdown
# Google Cloud setup

Two projects, per the design (section 4.4). Both use the same steps; only the publishing status differs.

| Project              | Publishing status                                 | Used by                                  |
| -------------------- | ------------------------------------------------- | ---------------------------------------- |
| `gmail-mcp-dev`      | Testing                                           | a scratch Gmail account, manual test run |
| `gmail-mcp-personal` | In production, unverified, personal-use exemption | the owner's real accounts                |

## Steps

1. Create the project and enable the Gmail API.
2. Configure the OAuth consent screen as **External**. Add the scopes `openid`, `email`, `profile` and
   `https://www.googleapis.com/auth/gmail.modify`. Do not add `https://mail.google.com/`.
3. In Testing status, add the Google accounts you will connect as test users. Refresh tokens issued by
   a Testing project expire after 7 days unless only profile scopes were requested, which is why the
   owner's login (profile scopes) keeps working while a connected Gmail account in the dev project
   needs reconnecting weekly.
4. Create an OAuth client of type **Web application** with these redirect URIs, replacing the host:
   - `https://<WORKER_HOSTNAME>/oidc/callback`
   - `https://<WORKER_HOSTNAME>/connect/callback`
5. Put the client id and secret into the Worker: `wrangler secret put GOOGLE_CLIENT_ID` and
   `wrangler secret put GOOGLE_CLIENT_SECRET`. Locally, `worker/.dev.vars`.
6. For `gmail-mcp-personal`, move the consent screen to **In production**. Leave it unverified. The
   personal-use exemption covers apps used by fewer than 100 users known to the owner; the unverified
   warning still shows during consent.

## First login

Deploy with `OWNER_GOOGLE_SUBS` empty and `OWNER_EMAILS` set to your address. Open the Worker, log in,
and the page shows your Google `sub`. Set `wrangler secret put OWNER_GOOGLE_SUBS` to that value and log
in again. `OWNER_EMAILS` is never consulted after that.

## Local development

`wrangler dev` serves `http://localhost:8787`. The session cookie carries the `__Host-` prefix, which
browsers accept on `localhost` over plain HTTP because they treat it as a secure context. Google accepts
`http://localhost:8787/...` redirect URIs on a Web application client, so add the two callbacks with
that origin to the dev project's client. Set `WORKER_HOSTNAME=localhost:8787` in `.dev.vars` only if you
also change the `https://` scheme the code builds; the simpler path is a `wrangler dev --remote` or a
deployed dev Worker.
```

Check that last paragraph against the code before committing: `WORKER_HOSTNAME` is used with a fixed `https://` prefix in `audienceFor`, `loginRedirectUri`, `connectRedirectUri` and `checkOrigin`. If local HTTP is wanted, add a `WORKER_SCHEME` var defaulting to `https`, thread it through those four call sites, and say so in the runbook; otherwise state plainly that local runs use a deployed dev Worker.

- [ ] **Step 2: README, ARCHITECTURE, CHANGELOG, CLAUDE.md**

README: replace the "Running the server locally" section's dev-bearer paragraph and the seeded-account commands with the runbook link and the login flow; the Inspector command becomes an OAuth run (`npx @modelcontextprotocol/inspector@2.5.0 http://localhost:8787/mcp` opens the browser flow).

ARCHITECTURE: add a short "Identity" section under the parts that carry the weight: the provider validates tokens, `requireScope` binds scope to route and the principal to the token owner, pages need a session and a CSRF token, and Google refresh tokens are stored encrypted per account.

CHANGELOG under Unreleased: Added (OAuth provider, owner login, account connection, pages, companion registration), Removed (development bearer), Security (scope-per-client, audience per route, sessions and CSRF).

Spec amendments in `docs/superpowers/specs/2026-09-09-gmail-mcp-design.md`, each one or two sentences, with the revision note at the top bumped:

- 3.2: OAuth `state`, OIDC `nonce` and pending consent requests live in the D1 table `oauth_states` and are consumed by one atomic statement; KV holds the provider's own state only, because KV is eventually consistent and cannot give one-use semantics.
- 3.2 schema: `accounts.credential_version`; every credential write is conditional on it and on `status = 'active'`; revocation is local-first.
- 4.2: the remembered-consent cookie is bound to the owner's `sub`; `iat` is checked against a 10 minute maximum age with 60 s tolerance.
- 4.6: the `Content-Security-Policy` line gains `https://accounts.google.com` in `form-action`, because browsers apply `form-action` to the redirect that follows a form post, and the consent page adds the client's redirect origin the same way. `/reauth` is a POST. The approval page renders a typed view per action and the full payload for anything else. Trust settings on `/accounts` require recent authentication and are audited as `policy.edit`. Policy edits and approval decisions write their audit row in the same transaction as the change.

CLAUDE.md: update the repository shape (`src/auth`, `src/google`, `src/web`), the "Current state" paragraph (Plan 2 complete, next is Plan 3), delete the trap about `.dev.vars` and the dev bearer, and add two new traps: "`resourceMetadata.resource` binds every token to one audience" and "`createClient` chooses the client id".

- [ ] **Step 3: de-slop**

Run the `stop-slop` skill over the runbook and every edited document. Report what changed.

- [ ] **Step 4: the gate**

```bash
npm run verify
```

Read the output. Exit code 0 is the claim.

- [ ] **Step 5: commit and push**

```bash
git add docs/runbooks/google-cloud.md README.md docs/ARCHITECTURE.md CHANGELOG.md
git commit -m "docs: Google Cloud runbook, identity section, changelog for OAuth and the pages; drop the dev bearer from the README

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push
```

`CLAUDE.md` is gitignored; edit it, do not stage it.

---

## Plan self-review

**Spec coverage for this plan's scope**

| Spec item                                                                                         | Task                                  |
| ------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 1.3 alias grammar at connect                                                                      | 8                                     |
| 3.1 `user_id` from the verified principal only                                                    | 7 (`requireScope`), 6 (sessions)      |
| 3.3 encrypt with AAD, cache with expiry, refresh, lazy re-encrypt, `needs_reconnect`, revoke      | 8, 9                                  |
| 3.7 `GET /staging/<handle>` and ack with owner in the query                                       | 7                                     |
| 3.8 bidi and control characters shown as escapes                                                  | 2, 10                                 |
| 3.10 audit rows for connect, revoke, approve, deny, policy edit                                   | 8, 10, 11, 12                         |
| 4.1 scopes per client, scope and audience per route                                               | 7                                     |
| 4.2 provider options, CIMD, DCR, loopback redirect, consent page, OIDC login checks, bootstrap    | 6, 7                                  |
| 4.3 connect entry with signed id, offline consent, callback verification, upsert, send-as, revoke | 8, 9, 11                              |
| 4.4 Google Cloud projects                                                                         | 14 (runbook)                          |
| 4.5 companion pre-registration and `staging` scope                                                | 7, 11                                 |
| 4.6 pages, session rules, CSRF, headers, recent auth, revoke other sessions                       | 2, 3, 4, 10, 11, 12, 13               |
| 4.7 OAuth and web adversarial rows                                                                | 6, 7, 8, 10, 11, 12 (listed per test) |
| Plan 1 carry-over: delete the dev bearer                                                          | 7                                     |

Left to Plan 3 by design: the URL-mode elicitation wait loop and `requestState` (spec 1.4, 3.4), `execute_pending`, the `needs_reconnect` elicitation on a tool call, `connect_account` as elicitation. Left to Plan 4: `/staging/intent`, `PUT /staging/<ticket>`, the companion login CLI.

**4.7 rows and where each is tested:** redirect_uri substitution (7), authorization-code replay (7), `state` replay including two callbacks racing on one state (6, 8), two consent decisions racing on one request (7), remembered consent under a different owner (7), `nonce` replay (6: a consumed state cannot be reused, and a token carrying another nonce is refused), stale and future `iat` (5), revoke racing a refresh and a re-encryption (9), a failed connect revoking its fresh grant (8), two first connections and two reconnects racing (8), a policy edit failing midway (12), trust settings without recent auth (11), issuer mix-up and wrong audience and expired `id_token` (5), session fixation (6), CSRF token from another pending action (10), open-redirect attempts (2, 6), a DCR client requesting `staging` (7), `mcp` token to `/staging` and `staging` token to `/mcp` (7), approval URL opened under a different session (10), `last_seen_at` alone attempting a recent-auth action (3, 11, 12). CIMD metadata tampering is exercised by the library's own conformance suite and by Plan 5's end-to-end run with a real Claude Code client; `execute_pending` replay, `requestState` tampering and the retried elicitation with changed recipients belong to Plan 3.

**Placeholder scan:** none. Every step carries its code or its exact command.

**Type consistency:** `Principal` is defined once in `auth/principal.ts` (Task 7) and consumed by `server.ts` and `staging/routes.ts`; `Session` (Task 3) is what `csrfToken`, `page`, `guardPost` and every page take; `OidcState` (Task 6) is extended, not redefined, by `connect.ts` (Task 8); `Deps` (Task 1) reaches `buildServer`, `oidc.ts`, `tokens.ts` and `connect.ts` with one shape; `signToken`/`verifyToken` (Task 4) back CSRF, the approved-clients cookie and the connect elicitation id with distinct purposes; `approvalView` (Task 10) is the payload contract Plan 3 must honour; `auditStatement` (Task 10) is what the approval batch and `applyPolicyEdit` (Task 12) put inside `db.batch()`; `putState`/`consumeState` (Task 6) serve login, connect and consent with distinct kinds; `registerCompanionClient(env, helpersOrWorker)` (Task 7) is called with `env.OAUTH_PROVIDER` by the Accounts page (Task 11) and with the worker by tests.

**Settled by reading the unpacked library, not guessed:** `apiHandlers` prefix matching; `ctx.props` and `env.OAUTH_PROVIDER` injection; `createClient` generating the id; grant resource binding from `request.resource`; loopback port flexibility; `unwrapToken` shape; `parseAuthRequest` error handling with and without `redirectUri`; `completeAuthorization` revoking prior grants for the same client and user by default (which is why re-authorising Claude Code invalidates the previous token: acceptable, and noted for Plan 5's end-to-end run).

**Runtime facts each first run must confirm:** Task 5 (`jose` inside workerd), Task 7 (the CIMD advertisement under the test runtime), Task 11 (whether `toAsciiDomain` already rejects empty labels and edge hyphens), Task 14 (whether local HTTP development is worth a `WORKER_SCHEME` var).

**Bounds this plan does not close:** the library keeps authorization codes, grants and tokens in KV, so single use of an authorization code rests on the library's KV handling rather than on D1; the plan's own one-use state (`oauth_states`) does not depend on it. `completeAuthorization` revokes the previous grant for the same client and user by default, which is one active grant per installation.

## Gauntlet (2026-09-09, before execution)

The draft was attacked as a hostile reviewer and every empirical question was settled against the unpacked `@cloudflare/workers-oauth-provider` 0.10.3 and the workspace `node_modules` rather than by reasoning. Adopted, with the receipt that settled each:

1. The spec's `form-action 'self'` would have broken OAuth in Chrome. Chrome applies `form-action` to the redirect that follows a form submission, so the consent POST's 302 back to `http://localhost:<port>/callback` or `https://claude.ai/...` would have been blocked, and so would the `/reauth` and `/connect` 303s to Google. Fix: `form-action` names `https://accounts.google.com` on every page and the consent page adds the client's redirect origin (Task 2, Task 7); Task 14 amends the spec's header line.
2. The draft made `/reauth` a GET. Spec 4.6 puts it behind CSRF. It is now a POST with a CSRF token, and the "recent login required" response is a 403 page carrying the form rather than a redirect (Tasks 4, 6, 11, 12).
3. The provider cache was keyed by hostname alone, so two `createWorker` calls with different fake Googles would have shared the first one's `deps`. Keyed by `deps` then hostname (Task 7).
4. `mintToken` searched for the consent form under the wrong action string and posted to a URL derived from an empty `res.url`. It now keeps the consent path from the redirect (Task 7).
5. The CSRF test appended `"x"` to a base64 key, which makes `atob` throw rather than return `false`. It now uses a second valid key (Task 4).
6. `escape` shadowed the deprecated global. Renamed `escapeHtml` throughout.
7. The smoke test hands the shared Proxy env to the provider, which writes `env.OAUTH_PROVIDER` onto it. Task 7 changes it to a spread copy.
8. The consent page is hardened: DCR client names are capped at 100 characters and rendered with visible escapes; `CimdFetchError` from `parseAuthRequest` renders a 400 instead of a 500; the page tells the owner to continue only if they started the flow themselves (Task 7).
9. The `unusedPage` lint hack and the landing-page stand-in in Task 6 are gone; the landing page renders the header forms whenever a session exists, permanently.
10. Measured rather than assumed: `audienceMatches` is origin plus path-boundary prefix (so `/staging` covers `/staging/<handle>`); `parseAuthRequest` returns `[]` for an absent or empty `scope`; DCR answers 201; `parseAddress` throws; `jose` 6.2.12 is already installed transitively and exports every name the plan imports.

Rejected after checking: "double token lookup in `requireScope` is wasteful" (one KV read per request is the price of checking the token's own scope rather than trusting props; kept); "`completeAuthorization` revoking the previous grant will surprise users" (library default, matches one active grant per client per installation; noted for Plan 5's end-to-end run rather than overridden).

Scorecard at plan stage: spec coverage 9/10 (elicitation and `requestState` deferred to Plan 3 by design); falsifiability 8/10 (every adversarial row in 4.7 that this plan owns has a named test; the two library behaviours flagged for first-run confirmation are the residual); ambition 7/10 (this plan builds no new mechanism, it wires standard OAuth correctly, and the gauntlet's value was catching the CSP defect that would have made every client flow fail at the last redirect). What moves it higher: a real Claude Code run against a deployed dev Worker, which is Plan 5.

## Review round 2 (2026-09-10, external review of the gauntleted draft)

Raouf's line-by-line review returned six blockers and fourteen majors. Each was checked against the plan text, the unpacked library and Plan 1's code before it was adopted. All twenty are adopted; one was refined by measurement.

Blockers: one-use OIDC state moves from KV get-then-delete to a D1 `oauth_states` table consumed by `UPDATE ... RETURNING` (Task 6), and consent requests use the same table with their own kind (Task 7); remembered consent is bound to the owner's `sub` and cleared when the owner changes (Task 7); the audience-weakening fallback is deleted and the path-specific metadata behaviour is read from the library's source instead (header, Task 7); credential writes are guarded by `status = 'active' AND credential_version = <read>` and revocation is local-first (Task 9, migration in Task 1); the approval page renders a typed view per action family with To, Cc and Bcc apart, and prints the entire payload for any shape it does not know (Task 10).

Majors: policy rows, audit and session revocation are one batch (Task 12); the approval transition and its audit row are one batch with an `_assert` guard (Task 10); allowlist, organisation domains, send-limit increases, companion registration and revocation need recent authentication and are audited (Task 11); allowlist and domain values are canonicalised by the same two functions `isTrusted` reads them with, so local-part case is kept where the trust rules keep it (Task 11); Google token bodies are validated with zod and the connect callback checks the granted scope before storing anything (Tasks 5, 8); `iat` is checked with `maxTokenAge` rather than merely required (Task 5); the bootstrap page tells the owner to confirm the identity and the `OWNER_EMAILS` comment no longer claims it is not an input (Tasks 1, 6); a failed connect revokes the refresh token it just received (Task 8); the first-account default is decided inside the INSERT and a lost race on `google_sub` retries as a reconnect (Task 8); companion registration is serialised through a reservation row (Task 7); the `/staging` protected-resource document is asserted and both scopes are published (Task 7); HMAC framing is length-prefixed (Task 4).

Refined by measurement: the review's single-statement `UPDATE ... RETURNING` for revocation cannot return the old ciphertext, because SQLite 3.50 returns post-update values (measured with `sqlite3`); `revokeAccount` therefore reads, wipes under a version guard, and only then calls Google, which keeps the local-first order the review asked for.

Scorecard after round 2: spec coverage 9/10 (unchanged; elicitation stays in Plan 3); falsifiability 9/10 (every race the review named has a test that runs two requests concurrently inside workerd; what remains untested is the library's own KV code handling); concurrency safety 8/10 (up from 4: the four races that could have resurrected credentials, double-granted a consent, or replayed a login are closed, and the residual is the library's KV); ambition unchanged at 7/10. What moves falsifiability higher: Plan 5's fault injection, which kills the Worker between the guarded write and the response.
