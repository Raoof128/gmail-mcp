# Gmail MCP Plan 1: Worker Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and test the Worker's authority core (schema, crypto, canonical hashing, recipient trust, policy engine, pending/operations claim, staging, audit, cron) and expose it through a dev-only MCP endpoint, with no Gmail or OAuth yet.

**Architecture:** A Cloudflare Worker (`worker/`) with D1, R2 and KV bindings, sharing action names and schemas with a `shared/` package. Every module is a pure function or a small class over the `Env` bindings, tested in the Workers runtime with `@cloudflare/vitest-plugin`. The MCP handler in the last task uses `createMcpHandler` from `agents/mcp/server` behind a static dev bearer that exists only when the `DEV_STATIC_TOKEN` secret is set; production OAuth arrives in Plan 2.

**Tech Stack:** TypeScript 5.x, npm workspaces, wrangler 4.x, `agents` (Cloudflare), `@modelcontextprotocol/server` 2.0.0, zod 4, vitest 4 + `@cloudflare/vitest-plugin`, D1 (SQLite), R2, KV.

**Spec:** `docs/superpowers/specs/2026-09-09-gmail-mcp-design.md` (revision 3). Sections implemented here: 2.1, 2.2, 2.7, 2.8, 3.1–3.4, 3.7 (server side), 3.9 (D1 rows only), 3.10, and the cron in 3.7.

**Plan series:**
1. Worker foundations (this plan)
2. OAuth and identity: `workers-oauth-provider`, Google OIDC login, Flow A, Flow B, Flow C client, web sessions, CSRF, pages (spec 4.1–4.6)
3. Gmail tools and send pipeline: the 38 tools, MIME streaming, operations execution, reconciliation, error handling (spec 2.3, 3.5, 3.8, 3.9)
4. Companion: stdio MCP, Keychain, `/staging/intent` client, elicitation both wire forms (spec 2.4, 3.6, 4.5)
5. Protected Gmail suite, fault injection, end-to-end (spec 4.7)

## Global Constraints

- Every write tool requires an explicit `account`; reads fall back to the default account (spec 1.3).
- Policy values are exactly `allow | ask | deny`; modifiers only raise a level (spec 2.2).
- `user_id` is never read from tool arguments (spec 3.1).
- All child tables carry `(user_id, account_id)` foreign keys to `accounts(user_id, id)` (spec 3.2).
- Global policy rows use `account_id IS NULL` and are unique via partial index, never a composite primary key (spec 3.2).
- AAD framing: `"gmail-mcp:v1" \0 user_id \0 account_id \0 field_name` (spec 3.3).
- Canonical JSON is RFC 8785 JCS; `payload_hash = sha256(canonical bytes)` (spec 3.4).
- The claim is one D1 `batch()` with `_assert` rows forcing rollback on failed preconditions (spec 3.4).
- Staging handles are `sh_` + 32 random bytes base64url; download TTL 30 min; pending TTL 15 min; cron every 5 min (spec 3.7).
- Argument caps: subject 998 bytes, body 512 KB, recipients 500, canonical payload 1 MB, staged file 25 MB (spec 2.7).
- Tokens, bodies and full subjects never appear in audit rows (spec 3.10).
- Dependencies pinned to exact versions in `package.json` (spec 5).
- Tests run only in the Workers runtime; no real Gmail in this plan.
- Commit after every green step with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File structure

```
gmail/
  package.json                     npm workspaces root
  tsconfig.base.json
  shared/
    package.json
    src/actions.ts                 Action, Modifier, Level, DEFAULT_POLICY
    src/errors.ts                  GmailMcpError, ErrorCode
    src/schemas.ts                 zod: StagingHandleResponse, PendingApprovalResult, UploadIntent
    test/actions.test.ts
  worker/
    package.json
    wrangler.jsonc
    vitest.config.ts
    tsconfig.json
    migrations/0001_init.sql
    src/env.ts                     Env type
    src/index.ts                   fetch + scheduled exports
    src/db/migrate-for-tests.ts    applies migrations/*.sql through the D1 binding
    src/crypto/keyring.ts          AES-GCM encrypt/decrypt with key ids and AAD framing
    src/crypto/canonical.ts        JCS + sha256
    src/crypto/random.ts           ids and handles
    src/policy/recipients.ts       address parsing, trust set, +external, +bulk
    src/policy/engine.ts           effective level, modifiers, decide()
    src/policy/limits.ts           argument caps, blocked extensions, filename sanitiser
    src/approval/pending.ts        create, approve, deny, cancel, expire
    src/approval/claim.ts          the atomic claim batch
    src/operations/journal.ts      acquire, transition, release
    src/staging/store.ts           ingest, get, ack, reserve, purge
    src/audit/log.ts               intent/outcome rows
    src/cron.ts                    scheduled handler
    src/mcp/server.ts              createMcpHandler factory, dev bearer, first tools
    test/setup.ts                  migration + fixtures
    test/*.test.ts                 one file per module
```

---

### Task 1: Workspace and Worker scaffold with a smoke test

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `shared/package.json`, `shared/tsconfig.json`, `worker/package.json`, `worker/tsconfig.json`, `worker/wrangler.jsonc`, `worker/vitest.config.ts`, `worker/src/env.ts`, `worker/src/index.ts`, `worker/test/smoke.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `Env` type with bindings `DB: D1Database`, `STAGING: R2Bucket`, `OAUTH_KV: KVNamespace`, secrets `TOKEN_KEKS`, `TOKEN_KEK_CURRENT`, `STATE_HMAC_KEY`, `CSRF_HMAC_KEY`, `DEV_STATIC_TOKEN?`, var `WORKER_HOSTNAME`. Default export with `fetch` and `scheduled`.

- [ ] **Step 1: Root workspace files**

`package.json`:
```json
{
  "name": "gmail-mcp",
  "private": true,
  "workspaces": ["shared", "worker"],
  "scripts": {
    "test": "npm run test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present"
  },
  "devDependencies": {
    "typescript": "5.9.3"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "types": []
  }
}
```

Append to `.gitignore`:
```
node_modules/
.wrangler/
.dev.vars
dist/
```

- [ ] **Step 2: Shared package skeleton**

`shared/package.json`:
```json
{
  "name": "@gmail-mcp/shared",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    "./actions": "./src/actions.ts",
    "./errors": "./src/errors.ts",
    "./schemas": "./src/schemas.ts"
  },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": { "zod": "4.5.4" },
  "devDependencies": { "vitest": "4.1.11" }
}
```

`shared/tsconfig.json`:
```json
{ "extends": "../tsconfig.base.json", "include": ["src", "test"] }
```

- [ ] **Step 3: Worker package files**

`worker/package.json`:
```json
{
  "name": "@gmail-mcp/worker",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "migrate:local": "wrangler d1 migrations apply gmail-mcp --local"
  },
  "dependencies": {
    "@gmail-mcp/shared": "0.0.1",
    "@modelcontextprotocol/server": "2.0.0",
    "agents": "0.22.0",
    "zod": "4.5.4"
  },
  "devDependencies": {
    "@cloudflare/vitest-plugin": "1.1.6",
    "@cloudflare/workers-types": "5.20260908.1",
    "vitest": "4.1.11",
    "wrangler": "4.130.0"
  }
}
```

Versions above were measured from the npm registry on 2026-09-09. `@cloudflare/vitest-plugin` 1.1.6 peers on vitest ^4.1.0, so vitest stays on 4.x even though 5.0 exists. If `npm install` reports a peer conflict, run `npm view <pkg> version` and pin the current one; never use ranges.

`worker/tsconfig.json`:
```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "types": ["@cloudflare/workers-types", "@cloudflare/vitest-plugin"] },
  "include": ["src", "test"]
}
```

`worker/wrangler.jsonc`:
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "gmail-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-11",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "vars": { "WORKER_HOSTNAME": "gmail-mcp.example.workers.dev" },
  "d1_databases": [{ "binding": "DB", "database_name": "gmail-mcp", "database_id": "local-dev", "migrations_dir": "migrations" }],
  "r2_buckets": [{ "binding": "STAGING", "bucket_name": "gmail-mcp-staging" }],
  "kv_namespaces": [{ "binding": "OAUTH_KV", "id": "local-dev" }],
  "triggers": { "crons": ["*/5 * * * *"] },
  "observability": { "enabled": true }
}
```

`worker/vitest.config.ts`:
```ts
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
  },
});
```

`worker/src/env.ts`:
```ts
export interface Env {
  DB: D1Database;
  STAGING: R2Bucket;
  OAUTH_KV: KVNamespace;
  WORKER_HOSTNAME: string;
  TOKEN_KEKS: string;          // JSON { key_id: base64 32 bytes }
  TOKEN_KEK_CURRENT: string;   // key_id
  STATE_HMAC_KEY: string;      // base64 32 bytes
  CSRF_HMAC_KEY: string;       // base64 32 bytes
  DEV_STATIC_TOKEN?: string;   // dev only
  DEV_STATIC_USER?: string;    // dev only: user_id the static token maps to
}
```

`worker/src/index.ts`:
```ts
import type { Env } from "./env";

export default {
  async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    return new Response("not found", { status: 404 });
  },
  async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext): Promise<void> {},
} satisfies ExportedHandler<Env>;
```

`worker/test/setup.ts` (migrations are added in Task 3; keep this file minimal now):
```ts
// Runs before each test file inside the Workers runtime.
export {};
```

- [ ] **Step 4: Write the failing smoke test**

`worker/test/smoke.test.ts`:
```ts
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

describe("worker smoke", () => {
  it("returns 404 for an unknown path", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://x.test/nope"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });

  it("has the D1, R2 and KV bindings", () => {
    expect(env.DB).toBeDefined();
    expect(env.STAGING).toBeDefined();
    expect(env.OAUTH_KV).toBeDefined();
  });
});
```

- [ ] **Step 5: Install and run**

Run from repo root:
```bash
npm install
```
Then:
```bash
cd worker && npx vitest run test/smoke.test.ts
```
Expected: both tests PASS. The import form follows the plugin docs: bindings via `env` from `cloudflare:workers`, execution-context helpers from `cloudflare:test`. If the installed plugin rejects either import, read `node_modules/@cloudflare/vitest-plugin/README.md` and adjust once, then keep that form in every later test.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: workspace scaffold with Worker smoke test

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Shared actions, errors and schemas

**Files:**
- Create: `shared/src/actions.ts`, `shared/src/errors.ts`, `shared/src/schemas.ts`, `shared/test/actions.test.ts`, `shared/vitest.config.ts`

**Interfaces:**
- Produces: `type Action`, `type Modifier`, `type Level`, `ACTIONS`, `MODIFIERS`, `DEFAULT_POLICY: Record<Action, Level | "browser">`, `raise(level: Level): Level`, `class GmailMcpError`, `ErrorCode` union, zod schemas `StagingHandleResponse`, `PendingApprovalResult`, `UploadIntent`.

- [ ] **Step 1: Write the failing test**

`shared/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
```

`shared/test/actions.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { ACTIONS, DEFAULT_POLICY, MODIFIERS, raise } from "../src/actions";
import { PendingApprovalResult, StagingHandleResponse } from "../src/schemas";

describe("actions", () => {
  it("has a default for every action", () => {
    for (const a of ACTIONS) expect(DEFAULT_POLICY[a]).toBeDefined();
  });
  it("matches the spec defaults", () => {
    expect(DEFAULT_POLICY["send.message"]).toBe("ask");
    expect(DEFAULT_POLICY["read.search"]).toBe("allow");
    expect(DEFAULT_POLICY["policy.edit"]).toBe("browser");
    expect(DEFAULT_POLICY["trash.restore"]).toBe("allow");
  });
  it("raise only goes up", () => {
    expect(raise("allow")).toBe("ask");
    expect(raise("ask")).toBe("ask");
    expect(raise("deny")).toBe("deny");
  });
  it("lists the five modifiers", () => {
    expect([...MODIFIERS].sort()).toEqual(["+attachment", "+bulk", "+external", "+overwrite", "+sensitive"]);
  });
});

describe("schemas", () => {
  it("accepts a staging handle response", () => {
    const r = StagingHandleResponse.parse({
      handle: "sh_abc", account: "personal", filename: "a.pdf", mime: "application/pdf",
      size: 10, sha256: "0".repeat(64), expires_at: "2026-09-09T00:00:00Z",
    });
    expect(r.handle).toBe("sh_abc");
  });
  it("rejects a pending result with a bad status", () => {
    expect(() => PendingApprovalResult.parse({ status: "done" })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd shared && npx vitest run`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`shared/src/actions.ts`:
```ts
export const ACTIONS = [
  "read.search", "read.message", "read.attachment",
  "draft.write",
  "send.message", "send.draft", "send.forward",
  "label.manage", "label.apply",
  "spam.mark", "spam.unmark",
  "trash.move", "trash.restore",
  "attachment.stage_upload",
  "fs.save",
  "account.read", "account.connect",
  "policy.read", "policy.edit",
] as const;
export type Action = (typeof ACTIONS)[number];

export const MODIFIERS = ["+attachment", "+external", "+bulk", "+sensitive", "+overwrite"] as const;
export type Modifier = (typeof MODIFIERS)[number];

export const LEVELS = ["allow", "ask", "deny"] as const;
export type Level = (typeof LEVELS)[number];

export const DEFAULT_POLICY: Record<Action, Level | "browser"> = {
  "read.search": "allow",
  "read.message": "allow",
  "read.attachment": "allow",
  "draft.write": "allow",
  "send.message": "ask",
  "send.draft": "ask",
  "send.forward": "ask",
  "label.manage": "ask",
  "label.apply": "allow",
  "spam.mark": "ask",
  "spam.unmark": "allow",
  "trash.move": "ask",
  "trash.restore": "allow",
  "attachment.stage_upload": "ask",
  "fs.save": "allow",
  "account.read": "allow",
  "account.connect": "ask",
  "policy.read": "allow",
  "policy.edit": "browser",
};

/** Modifiers only raise. allow -> ask; ask and deny unchanged. */
export function raise(level: Level): Level {
  return level === "allow" ? "ask" : level;
}

/** Actions whose external side effect is journaled in `operations` (spec 3.5). */
export const JOURNALED_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  "send.message", "send.draft", "send.forward", "draft.write", "label.manage",
]);
```

`shared/src/errors.ts`:
```ts
export type ErrorCode =
  | "policy_denied" | "pending_approval" | "pending_not_approved" | "pending_expired"
  | "pending_replayed" | "payload_mismatch" | "delivery_unknown"
  | "account_not_found" | "account_needs_reconnect" | "handle_invalid" | "handle_expired"
  | "handle_reserved" | "limit_exceeded" | "blocked_extension" | "invalid_address"
  | "unauthorized" | "forbidden" | "internal";

export class GmailMcpError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "GmailMcpError";
  }
}
```

`shared/src/schemas.ts`:
```ts
import { z } from "zod";

export const StagingHandleResponse = z.object({
  handle: z.string().regex(/^sh_[A-Za-z0-9_-]+$/),
  account: z.string(),
  filename: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  expires_at: z.string(),
});
export type StagingHandleResponse = z.infer<typeof StagingHandleResponse>;

export const PendingApprovalResult = z.object({
  status: z.literal("pending_approval"),
  action_id: z.string(),
  action: z.string(),
  modifiers: z.array(z.string()),
  account: z.string(),
  summary: z.string(),
  approval: z.object({ mode: z.literal("url"), url: z.url() }),
  expires_at: z.string(),
});
export type PendingApprovalResult = z.infer<typeof PendingApprovalResult>;

export const UploadIntent = z.object({
  account: z.string(),
  filename: z.string().min(1).max(255),
  size: z.number().int().positive().max(25 * 1024 * 1024),
  mime: z.string().min(1),
  sha256: z.string().length(64),
  pending_id: z.string().optional(),
});
export type UploadIntent = z.infer<typeof UploadIntent>;
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd shared && npx vitest run`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add shared
git commit -m "feat(shared): action taxonomy, defaults, errors, schemas

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: D1 schema migration with constraint tests

**Files:**
- Create: `worker/migrations/0001_init.sql`, `worker/src/db/migrate-for-tests.ts`, `worker/test/schema.test.ts`
- Create: `worker/test/fixtures.ts`
- Modify: `worker/test/setup.ts`

**Interfaces:**
- Produces: the tables in spec 3.2; `applyMigrations(db: D1Database): Promise<void>` for tests; test fixture `seedUserAndAccount(db, {userId, accountId, alias})`.

- [ ] **Step 1: Write the migration**

`worker/migrations/0001_init.sql`:
```sql
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  alias TEXT NOT NULL CHECK (length(alias) BETWEEN 1 AND 32 AND alias NOT GLOB '*[^a-z0-9_-]*'),
  google_sub TEXT NOT NULL,
  google_email TEXT NOT NULL,
  send_as TEXT NOT NULL DEFAULT '[]',
  org_domains TEXT,
  scopes TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','needs_reconnect','revoked')),
  is_default INTEGER NOT NULL DEFAULT 0,
  send_limit_bytes INTEGER NOT NULL DEFAULT 26214400,
  refresh_token_enc BLOB, refresh_token_key_id TEXT,
  access_token_enc BLOB, access_token_key_id TEXT, access_expires_at INTEGER,
  created_at INTEGER NOT NULL, last_refresh_at INTEGER,
  UNIQUE (user_id, id),
  UNIQUE (user_id, alias),
  UNIQUE (user_id, google_sub)
);
CREATE UNIQUE INDEX accounts_one_default ON accounts(user_id) WHERE is_default = 1;

CREATE TABLE policies (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  account_id TEXT,
  action TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('allow','ask','deny')),
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id)
);
CREATE UNIQUE INDEX policies_global_unique  ON policies(user_id, action) WHERE account_id IS NULL;
CREATE UNIQUE INDEX policies_account_unique ON policies(user_id, account_id, action) WHERE account_id IS NOT NULL;

CREATE TABLE contact_allowlist (
  user_id TEXT NOT NULL, account_id TEXT NOT NULL, pattern TEXT NOT NULL,
  PRIMARY KEY (account_id, pattern),
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id)
);

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  action TEXT NOT NULL,
  idempotency_key TEXT,
  state TEXT NOT NULL CHECK (state IN ('claimed','executing','delivery_unknown','executed','failed_safe')),
  payload_hash TEXT NOT NULL,
  rfc822_message_id TEXT,
  gmail_result_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id)
);
CREATE UNIQUE INDEX operations_idempotency
  ON operations(user_id, account_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE pending_actions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  action TEXT NOT NULL, modifiers TEXT NOT NULL,
  payload_json TEXT,
  payload_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','approved','executing','executed','failed','denied','cancelled','expired')),
  operation_id TEXT REFERENCES operations(id),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  approved_at INTEGER, approved_via TEXT,
  executed_at INTEGER, error TEXT,
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id)
);

CREATE TABLE staging_objects (
  handle TEXT PRIMARY KEY,
  user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('download','upload')),
  r2_key TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL,
  size INTEGER NOT NULL, sha256 TEXT NOT NULL,
  source_message_id TEXT, source_attachment_id TEXT,
  reserved_by_operation_id TEXT REFERENCES operations(id),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER,
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id)
);

CREATE TABLE _assert (x INTEGER NOT NULL CHECK (x = 0));

CREATE TABLE web_sessions (
  id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL, authenticated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL, user_id TEXT, account_id TEXT,
  tool TEXT, action TEXT, modifiers TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('intent','outcome')),
  decision TEXT,
  pending_id TEXT, operation_id TEXT, gmail_result_id TEXT,
  summary TEXT,
  client_hint TEXT
);
CREATE INDEX audit_log_ts ON audit_log(ts);
CREATE INDEX pending_actions_state_expires ON pending_actions(state, expires_at);
CREATE INDEX operations_state_updated ON operations(state, updated_at);
CREATE INDEX staging_objects_expires ON staging_objects(expires_at);
```

- [ ] **Step 2: Migration runner and setup**

`worker/src/db/migrate-for-tests.ts`:
```ts
import init from "../../migrations/0001_init.sql?raw";

/**
 * Splits on ';' at line ends. Migrations must not contain ';' inside string literals.
 * Idempotent: if the test runtime does not isolate storage per file, a second call is a no-op.
 */
export async function applyMigrations(db: D1Database): Promise<void> {
  const already = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'")
    .first<{ name: string }>();
  if (already) return;
  const statements = init
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));
  for (const sql of statements) {
    await db.prepare(sql).run();
  }
}
```

If `?raw` imports are not supported by the plugin's bundler, replace the import with `import { readFileSync } from "node:fs"` guarded behind `nodejs_compat`, or inline the SQL as a template string exported from `worker/src/db/schema.sql.ts` and have the migration file generated from it. Keep one source of truth.

`worker/test/setup.ts` (hooks only; fixtures live in a separate module so importing them never re-registers hooks):
```ts
import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";
import { applyMigrations } from "../src/db/migrate-for-tests";

beforeAll(async () => {
  await applyMigrations(env.DB);
});
```

`worker/test/fixtures.ts`:
```ts
export async function seedUserAndAccount(
  db: D1Database,
  o: { userId: string; accountId: string; alias: string; isDefault?: boolean; orgDomains?: string[]; sendAs?: string[] },
): Promise<void> {
  const now = Date.now();
  await db.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind(o.userId, `${o.userId}@example.test`, now).run();
  await db.prepare(
    `INSERT INTO accounts (id, user_id, alias, google_sub, google_email, send_as, org_domains, scopes, status, is_default, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).bind(
    o.accountId, o.userId, o.alias, `sub-${o.accountId}`, `${o.alias}@example.test`,
    JSON.stringify(o.sendAs ?? []), o.orgDomains ? JSON.stringify(o.orgDomains) : null,
    "gmail.modify", o.isDefault ? 1 : 0, now,
  ).run();
}
```

- [ ] **Step 3: Write the failing schema tests**

`worker/test/schema.test.ts`:
```ts
import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { seedUserAndAccount } from "./fixtures";

describe("schema constraints", () => {
  it("rejects duplicate global policy rows (NULL account_id)", async () => {
    await seedUserAndAccount(env.DB, { userId: "u1", accountId: "a1", alias: "personal" });
    const ins = "INSERT INTO policies (user_id, account_id, action, level, updated_at) VALUES ('u1', NULL, 'send.message', 'ask', 1)";
    await env.DB.prepare(ins).run();
    await expect(env.DB.prepare(ins).run()).rejects.toThrow(/UNIQUE/);
  });

  it("rejects an alias with a slash or uppercase", async () => {
    await seedUserAndAccount(env.DB, { userId: "u2", accountId: "a2", alias: "ok-alias" });
    await expect(seedUserAndAccount(env.DB, { userId: "u2", accountId: "a3", alias: "a/../x" })).rejects.toThrow(/CHECK/);
    await expect(seedUserAndAccount(env.DB, { userId: "u2", accountId: "a4", alias: "Work" })).rejects.toThrow(/CHECK/);
  });

  it("allows only one default account per user", async () => {
    await seedUserAndAccount(env.DB, { userId: "u3", accountId: "a5", alias: "one", isDefault: true });
    await expect(seedUserAndAccount(env.DB, { userId: "u3", accountId: "a6", alias: "two", isDefault: true })).rejects.toThrow(/UNIQUE/);
  });

  it("rejects a pending action whose account belongs to another user", async () => {
    await seedUserAndAccount(env.DB, { userId: "u4", accountId: "a7", alias: "x" });
    await seedUserAndAccount(env.DB, { userId: "u5", accountId: "a8", alias: "y" });
    await expect(
      env.DB.prepare(
        `INSERT INTO pending_actions (id, user_id, account_id, action, modifiers, payload_hash, summary, state, created_at, expires_at)
         VALUES ('p1', 'u4', 'a8', 'send.message', '[]', 'h', 's', 'pending', 1, 2)`,
      ).run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("_assert rejects any non-zero row", async () => {
    await expect(env.DB.prepare("INSERT INTO _assert (x) VALUES (1)").run()).rejects.toThrow(/CHECK/);
    await env.DB.prepare("INSERT INTO _assert (x) SELECT 1 WHERE 1 = 0").run(); // inserts nothing, succeeds
  });
});
```

- [ ] **Step 4: Run to verify it fails, then passes**

Run: `cd worker && npx vitest run test/schema.test.ts`
Expected first run: FAIL (tables missing until setup applies the migration; if setup errors on `?raw`, apply the fallback in Step 2).
After the migration applies: PASS (5 tests). If the FOREIGN KEY test passes trivially because foreign keys are off, add `await env.DB.prepare("PRAGMA foreign_keys = ON").run()` at the top of `applyMigrations` and rerun.

- [ ] **Step 5: Commit**

```bash
git add worker/migrations worker/src/db worker/test
git commit -m "feat(worker): D1 schema with ownership FKs, partial unique policy indexes, _assert

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Keyring encryption with AAD framing

**Files:**
- Create: `worker/src/crypto/keyring.ts`, `worker/src/crypto/random.ts`, `worker/test/keyring.test.ts`

**Interfaces:**
- Produces: `class Keyring { static fromEnv(env: Env): Keyring; encrypt(plain: string, aad: AadParts): Promise<{ciphertext: Uint8Array; keyId: string}>; decrypt(ciphertext: Uint8Array, keyId: string, aad: AadParts): Promise<string>; currentKeyId: string }`, `type AadParts = { userId: string; accountId: string; field: string }`, `frameAad(p: AadParts): Uint8Array`, `randomId(prefix: string): string`, `randomHandle(): string`, `b64url(bytes: Uint8Array): string`, `fromB64url(s: string): Uint8Array`.

- [ ] **Step 1: Write the failing test**

`worker/test/keyring.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { Keyring, frameAad } from "../src/crypto/keyring";
import { randomHandle, randomId } from "../src/crypto/random";

const k1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const k2 = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
const envLike = { TOKEN_KEKS: JSON.stringify({ k1, k2 }), TOKEN_KEK_CURRENT: "k2" } as any;
const aad = { userId: "u", accountId: "a", field: "refresh_token" };

describe("keyring", () => {
  it("round-trips with the current key", async () => {
    const kr = Keyring.fromEnv(envLike);
    const { ciphertext, keyId } = await kr.encrypt("secret", aad);
    expect(keyId).toBe("k2");
    expect(await kr.decrypt(ciphertext, keyId, aad)).toBe("secret");
  });
  it("decrypts with an older key in the ring", async () => {
    const kr = Keyring.fromEnv({ ...envLike, TOKEN_KEK_CURRENT: "k1" });
    const { ciphertext } = await kr.encrypt("old", aad);
    const kr2 = Keyring.fromEnv(envLike);
    expect(await kr2.decrypt(ciphertext, "k1", aad)).toBe("old");
  });
  it("fails on AAD mismatch, unknown key id, truncated ciphertext", async () => {
    const kr = Keyring.fromEnv(envLike);
    const { ciphertext, keyId } = await kr.encrypt("s", aad);
    await expect(kr.decrypt(ciphertext, keyId, { ...aad, accountId: "other" })).rejects.toThrow();
    await expect(kr.decrypt(ciphertext, "nope", aad)).rejects.toThrow(/unknown key/);
    await expect(kr.decrypt(ciphertext.slice(0, 20), keyId, aad)).rejects.toThrow();
  });
  it("frames AAD with NUL separators and a version prefix", () => {
    const bytes = frameAad(aad);
    expect(new TextDecoder().decode(bytes)).toBe("gmail-mcp:v1\0u\0a\0refresh_token");
  });
  it("makes distinct ids and handles", () => {
    expect(randomId("op")).toMatch(/^op_[A-Za-z0-9_-]{22,}$/);
    expect(randomHandle()).toMatch(/^sh_[A-Za-z0-9_-]{43}$/);
    expect(randomHandle()).not.toBe(randomHandle());
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npx vitest run test/keyring.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`worker/src/crypto/random.ts`:
```ts
export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}
/** 16 random bytes -> 22 chars. */
export function randomId(prefix: string): string {
  return `${prefix}_${b64url(randomBytes(16))}`;
}
/** 32 random bytes -> 43 chars. */
export function randomHandle(): string {
  return `sh_${b64url(randomBytes(32))}`;
}
```

`worker/src/crypto/keyring.ts`:
```ts
import type { Env } from "../env";

export type AadParts = { userId: string; accountId: string; field: string };

export function frameAad(p: AadParts): Uint8Array {
  return new TextEncoder().encode(["gmail-mcp:v1", p.userId, p.accountId, p.field].join("\0"));
}

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export class Keyring {
  private readonly keys = new Map<string, CryptoKey>();

  private constructor(private readonly raw: Record<string, string>, public readonly currentKeyId: string) {}

  /** Keys are imported lazily on first use, so construction stays synchronous. */
  static fromEnv(env: Pick<Env, "TOKEN_KEKS" | "TOKEN_KEK_CURRENT">): Keyring {
    const raw = JSON.parse(env.TOKEN_KEKS) as Record<string, string>;
    if (!(env.TOKEN_KEK_CURRENT in raw)) throw new Error("TOKEN_KEK_CURRENT not in TOKEN_KEKS");
    return new Keyring(raw, env.TOKEN_KEK_CURRENT);
  }

  private async key(id: string): Promise<CryptoKey> {
    const cached = this.keys.get(id);
    if (cached) return cached;
    const b64 = this.raw[id];
    if (!b64) throw new Error(`unknown key id ${id}`);
    const bytes = fromB64(b64);
    if (bytes.length !== 32) throw new Error(`key ${id} must be 32 bytes`);
    const k = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
    this.keys.set(id, k);
    return k;
  }

  async encrypt(plain: string, aad: AadParts): Promise<{ ciphertext: Uint8Array; keyId: string }> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const k = await this.key(this.currentKeyId);
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: frameAad(aad) }, k, new TextEncoder().encode(plain),
    ));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv, 0);
    out.set(ct, 12);
    return { ciphertext: out, keyId: this.currentKeyId };
  }

  async decrypt(ciphertext: Uint8Array, keyId: string, aad: AadParts): Promise<string> {
    if (ciphertext.length < 12 + 16) throw new Error("ciphertext too short");
    const k = await this.key(keyId);
    const iv = ciphertext.slice(0, 12);
    const body = ciphertext.slice(12);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: frameAad(aad) }, k, body);
    return new TextDecoder().decode(plain);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd worker && npx vitest run test/keyring.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/src/crypto worker/test/keyring.test.ts
git commit -m "feat(worker): AES-GCM keyring with framed AAD and per-ciphertext key ids

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: RFC 8785 canonical JSON and payload hashing

**Files:**
- Create: `worker/src/crypto/canonical.ts`, `worker/test/canonical.test.ts`

**Interfaces:**
- Produces: `canonicalize(value: unknown): string`, `payloadHash(value: unknown): Promise<string>` (hex sha256 of UTF-8 canonical bytes), `sha256Hex(bytes: Uint8Array): Promise<string>`.

- [ ] **Step 1: Write the failing test**

`worker/test/canonical.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { canonicalize, payloadHash } from "../src/crypto/canonical";

describe("JCS canonicalize", () => {
  it("sorts object keys by UTF-16 code units and drops whitespace", () => {
    expect(canonicalize({ b: 1, a: [true, null, "x"] })).toBe('{"a":[true,null,"x"],"b":1}');
  });
  it("serialises numbers like ES JSON.stringify", () => {
    expect(canonicalize({ n: 1e21, m: 0.000001, z: -0, i: 10 })).toBe('{"i":10,"m":0.000001,"n":1e+21,"z":0}');
  });
  it("escapes strings per JSON and keeps non-ASCII unescaped", () => {
    expect(canonicalize({ s: "é\n\"" })).toBe('{"s":"é\\n\\""}');
  });
  it("omits undefined properties and rejects functions", () => {
    expect(canonicalize({ a: undefined, b: 2 })).toBe('{"b":2}');
    expect(() => canonicalize({ f: () => 1 })).toThrow();
  });
  it("hashes deterministically regardless of key order", async () => {
    const h1 = await payloadHash({ to: ["a@x.test"], subject: "s" });
    const h2 = await payloadHash({ subject: "s", to: ["a@x.test"] });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npx vitest run test/canonical.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`worker/src/crypto/canonical.ts`:
```ts
/** RFC 8785 JSON Canonicalization Scheme for JSON-compatible values. */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean": return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("non-finite number");
      return JSON.stringify(value); // ES number-to-string, which JCS mandates
    case "string": return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return "[" + value.map((v) => (v === undefined ? "null" : canonicalize(v))).join(",") + "]";
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort((a, b) => {
        // UTF-16 code unit order, which is JS default string comparison
        return a < b ? -1 : a > b ? 1 : 0;
      });
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
    }
    default:
      throw new TypeError(`cannot canonicalize ${typeof value}`);
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function payloadHash(value: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalize(value)));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd worker && npx vitest run test/canonical.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/src/crypto/canonical.ts worker/test/canonical.test.ts
git commit -m "feat(worker): RFC 8785 canonical JSON and payload hashing

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Recipient parsing and trust rules

**Files:**
- Create: `worker/src/policy/recipients.ts`, `worker/test/recipients.test.ts`

**Interfaces:**
- Produces: `parseAddress(raw: string): ParsedAddress` throwing `GmailMcpError("invalid_address")`, `type ParsedAddress = { local: string; domain: string; normalized: string }`, `type TrustContext = { selfAddresses: string[]; allowlist: string[]; orgDomains: string[] }`, `isTrusted(addr: ParsedAddress, ctx: TrustContext): boolean`, `recipientModifiers(all: string[], ctx: TrustContext): Modifier[]` returning `+external` and/or `+bulk`, `MAX_RECIPIENTS = 500`.

- [ ] **Step 1: Write the failing test**

`worker/test/recipients.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseAddress, isTrusted, recipientModifiers } from "../src/policy/recipients";

const consumer = { selfAddresses: ["raouf@gmail.com"], allowlist: ["friend@example.com", "@uni.edu.au"], orgDomains: [] };
const workspace = { selfAddresses: ["me@corp.example"], allowlist: [], orgDomains: ["corp.example"] };

describe("parseAddress", () => {
  it("parses bare and display-name forms", () => {
    expect(parseAddress("A B <a.b@Example.COM>").normalized).toBe("a.b@example.com");
    expect(parseAddress("x@y.test").domain).toBe("y.test");
  });
  it("strips gmail +tags for comparison but keeps dots", () => {
    expect(parseAddress("raouf+news@gmail.com").normalized).toBe("raouf@gmail.com");
    expect(parseAddress("ra.ouf@gmail.com").normalized).toBe("ra.ouf@gmail.com");
  });
  it("converts IDN domains to punycode", () => {
    expect(parseAddress("a@bücher.example").domain).toBe("xn--bcher-kva.example");
  });
  it("rejects malformed, CR/LF and multiple addresses", () => {
    for (const bad of ["nope", "a@b@c", "a@b.test\r\nBcc: x@y", "a@b.test, c@d.test", "<a@b.test"]) {
      expect(() => parseAddress(bad), bad).toThrow(/invalid_address|invalid/);
    }
  });
});

describe("isTrusted", () => {
  it("consumer: only self, allowlist and exact domain", () => {
    expect(isTrusted(parseAddress("raouf@gmail.com"), consumer)).toBe(true);
    expect(isTrusted(parseAddress("someone@gmail.com"), consumer)).toBe(false);
    expect(isTrusted(parseAddress("friend@example.com"), consumer)).toBe(true);
    expect(isTrusted(parseAddress("prof@uni.edu.au"), consumer)).toBe(true);
    expect(isTrusted(parseAddress("prof@evil-uni.edu.au"), consumer)).toBe(false);
    expect(isTrusted(parseAddress("prof@sub.uni.edu.au"), consumer)).toBe(false);
  });
  it("workspace: org domains are internal", () => {
    expect(isTrusted(parseAddress("colleague@corp.example"), workspace)).toBe(true);
    expect(isTrusted(parseAddress("colleague@corp.example.evil"), workspace)).toBe(false);
  });
});

describe("recipientModifiers", () => {
  it("adds +external when any recipient is untrusted", () => {
    expect(recipientModifiers(["raouf@gmail.com", "stranger@x.test"], consumer)).toEqual(["+external"]);
    expect(recipientModifiers(["raouf@gmail.com"], consumer)).toEqual([]);
  });
  it("adds +bulk above 10 distinct recipients and dedupes", () => {
    const many = Array.from({ length: 11 }, (_, i) => `p${i}@uni.edu.au`);
    expect(recipientModifiers(many, consumer)).toEqual(["+bulk"]);
    const dup = Array.from({ length: 11 }, () => "p@uni.edu.au");
    expect(recipientModifiers(dup, consumer)).toEqual([]);
  });
  it("rejects more than 500 recipients", () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => `p${i}@uni.edu.au`);
    expect(() => recipientModifiers(tooMany, consumer)).toThrow(/limit_exceeded/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npx vitest run test/recipients.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`worker/src/policy/recipients.ts`:
```ts
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Modifier } from "@gmail-mcp/shared/actions";

export type ParsedAddress = { local: string; domain: string; normalized: string };
export type TrustContext = { selfAddresses: string[]; allowlist: string[]; orgDomains: string[] };
export const MAX_RECIPIENTS = 500;
export const BULK_THRESHOLD = 10;

const ADDR_SPEC = /^([A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+)@([A-Za-z0-9\u00a1-\uffff.-]+)$/u;

function fail(raw: string): never {
  throw new GmailMcpError("invalid_address", `invalid_address: ${raw.slice(0, 64)}`);
}

export function toAsciiDomain(domain: string): string {
  try {
    const host = new URL(`http://${domain}/`).hostname; // punycode via WHATWG URL
    if (!host || host !== host.toLowerCase() || host.includes("..")) fail(domain);
    return host;
  } catch {
    fail(domain);
  }
}

export function parseAddress(raw: string): ParsedAddress {
  if (/[\r\n\0]/.test(raw) || raw.includes(",")) fail(raw);
  let spec = raw.trim();
  const m = spec.match(/^(?:"[^"]*"|[^<]*)<([^<>]+)>$/);
  if (m) spec = m[1]!.trim();
  else if (/[<>]/.test(spec)) fail(raw);
  const parts = spec.match(ADDR_SPEC);
  if (!parts) fail(raw);
  const localRaw = parts[1]!;
  const domain = toAsciiDomain(parts[2]!);
  const isGmail = domain === "gmail.com" || domain === "googlemail.com";
  const local = (isGmail ? localRaw.split("+")[0]! : localRaw).toLowerCase();
  if (local.length === 0) fail(raw);
  return { local, domain, normalized: `${local}@${domain}` };
}

export function isTrusted(addr: ParsedAddress, ctx: TrustContext): boolean {
  const norm = (s: string) => parseAddress(s).normalized;
  if (ctx.selfAddresses.some((s) => norm(s) === addr.normalized)) return true;
  for (const p of ctx.allowlist) {
    if (p.startsWith("@")) {
      if (toAsciiDomain(p.slice(1)) === addr.domain) return true;
    } else if (norm(p) === addr.normalized) return true;
  }
  return ctx.orgDomains.some((d) => toAsciiDomain(d) === addr.domain);
}

export function recipientModifiers(all: string[], ctx: TrustContext): Modifier[] {
  const parsed = all.map(parseAddress);
  const distinct = new Set(parsed.map((p) => p.normalized));
  if (distinct.size > MAX_RECIPIENTS) {
    throw new GmailMcpError("limit_exceeded", `limit_exceeded: recipients ${distinct.size} > ${MAX_RECIPIENTS}`);
  }
  const mods: Modifier[] = [];
  if (parsed.some((p) => !isTrusted(p, ctx))) mods.push("+external");
  if (distinct.size > BULK_THRESHOLD) mods.push("+bulk");
  return mods;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd worker && npx vitest run test/recipients.test.ts`
Expected: PASS (9 tests). If the IDN test fails because the runtime's URL parser keeps Unicode, replace `toAsciiDomain` with an import of `punycode` from `node:punycode` under `nodejs_compat` (`toASCII(domain.toLowerCase())`) and rerun.

- [ ] **Step 5: Commit**

```bash
git add worker/src/policy/recipients.ts worker/test/recipients.test.ts
git commit -m "feat(worker): recipient parsing, trust rules, +external and +bulk

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Argument limits, blocked extensions, filename sanitiser

**Files:**
- Create: `worker/src/policy/limits.ts`, `worker/test/limits.test.ts`

**Interfaces:**
- Produces: `LIMITS = { subjectBytes: 998, bodyBytes: 524288, inlineAttachmentBytes: 1048576, stagedFileBytes: 26214400, canonicalPayloadBytes: 1048576 }`, `BLOCKED_EXTENSIONS: ReadonlySet<string>`, `assertNotBlocked(filename: string): void`, `sanitizeFilename(name: string): string`, `assertHeaderSafe(field: string, value: string): void`, `utf8Length(s: string): number`.

- [ ] **Step 1: Write the failing test**

`worker/test/limits.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { BLOCKED_EXTENSIONS, assertNotBlocked, sanitizeFilename, assertHeaderSafe, LIMITS, utf8Length } from "../src/policy/limits";

describe("blocked extensions", () => {
  it("contains Google's published set", () => {
    for (const e of ["exe", "dll", "bat", "cmd", "js", "jse", "vbs", "msi", "jar", "apk", "appx", "iso", "ps1", "mjs", "msix", "lnk", "vhd", "xll"]) {
      expect(BLOCKED_EXTENSIONS.has(e), e).toBe(true);
    }
  });
  it("rejects by final extension, case-insensitively, and not by name prefix", () => {
    expect(() => assertNotBlocked("setup.EXE")).toThrow(/blocked_extension/);
    expect(() => assertNotBlocked("report.pdf")).not.toThrow();
    expect(() => assertNotBlocked("archive.tar.gz")).not.toThrow();
    expect(() => assertNotBlocked("exe")).not.toThrow();
  });
});

describe("sanitizeFilename", () => {
  it("keeps basename only and strips path characters", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\x\\a.pdf")).toBe("a.pdf");
  });
  it("replaces control and bidi characters and NFC-normalises", () => {
    expect(sanitizeFilename("in\u202evoice.pdf")).toBe("in_voice.pdf");
    expect(sanitizeFilename("a\u0000b.txt")).toBe("a_b.txt");
    expect(sanitizeFilename("e\u0301.txt")).toBe("\u00e9.txt");
  });
  it("never returns empty or dot-only names", () => {
    expect(sanitizeFilename("..")).toBe("attachment");
    expect(sanitizeFilename("")).toBe("attachment");
  });
});

describe("headers and sizes", () => {
  it("rejects CR, LF, NUL in header values", () => {
    expect(() => assertHeaderSafe("subject", "hi\r\nBcc: x")).toThrow(/invalid/);
    expect(() => assertHeaderSafe("subject", "ok")).not.toThrow();
  });
  it("enforces subject byte cap", () => {
    expect(() => assertHeaderSafe("subject", "x".repeat(LIMITS.subjectBytes + 1))).toThrow(/limit_exceeded/);
    expect(utf8Length("é")).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npx vitest run test/limits.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`worker/src/policy/limits.ts`:
```ts
import { GmailMcpError } from "@gmail-mcp/shared/errors";

export const LIMITS = {
  subjectBytes: 998,
  bodyBytes: 512 * 1024,
  inlineAttachmentBytes: 1024 * 1024,
  stagedFileBytes: 25 * 1024 * 1024,
  canonicalPayloadBytes: 1024 * 1024,
} as const;

/** Seeded from support.google.com/mail/answer/6590 on 2026-09-09. Overridable via the policy page later. */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  "ade", "adp", "apk", "appx", "appxbundle", "bat", "cab", "chm", "cmd", "com", "cpl", "diagcab", "diagcfg",
  "diagpack", "dll", "dmg", "ex", "ex_", "exe", "hta", "img", "ins", "iso", "isp", "jar", "jnlp", "js", "jse",
  "lib", "lnk", "mde", "mjs", "msc", "msi", "msix", "msixbundle", "msp", "mst", "nsh", "pif", "ps1", "scr",
  "sct", "shb", "sys", "vb", "vbe", "vbs", "vhd", "vxd", "wsc", "wsf", "wsh", "xll",
]);

export function assertNotBlocked(filename: string): void {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return;
  const ext = filename.slice(dot + 1).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw new GmailMcpError("blocked_extension", `blocked_extension: .${ext}`);
  }
}

const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function sanitizeFilename(name: string): string {
  let base = name.split(/[\\/]/).pop() ?? "";
  base = base.normalize("NFC").replace(CONTROL_OR_BIDI, "_").trim();
  if (base === "" || /^\.+$/.test(base)) return "attachment";
  return base.slice(0, 255);
}

export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function assertHeaderSafe(field: string, value: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new GmailMcpError("invalid_address", `invalid ${field}: control characters`);
  }
  if (field === "subject" && utf8Length(value) > LIMITS.subjectBytes) {
    throw new GmailMcpError("limit_exceeded", `limit_exceeded: subject > ${LIMITS.subjectBytes} bytes`);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd worker && npx vitest run test/limits.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/src/policy/limits.ts worker/test/limits.test.ts
git commit -m "feat(worker): argument limits, blocked extension set, filename and header safety

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Policy engine

**Files:**
- Create: `worker/src/policy/engine.ts`, `worker/test/engine.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_POLICY`, `raise`, `Level`, `Action`, `Modifier` from shared; `accounts`, `policies` tables.
- Produces: `effectiveLevel(db, userId, accountId, action): Promise<Level>` (throws for `browser` actions), `decide(db, {userId, accountId, action, modifiers}): Promise<Decision>` where `type Decision = { level: Level; base: Level; modifiers: Modifier[] }`, `setPolicy(db, {userId, accountId: string | null, action, level})`.

- [ ] **Step 1: Write the failing test**

`worker/test/engine.test.ts`:
```ts
import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import { seedUserAndAccount } from "./fixtures";
import { decide, effectiveLevel, setPolicy } from "../src/policy/engine";

beforeAll(async () => {
  await seedUserAndAccount(env.DB, { userId: "pu", accountId: "pa1", alias: "personal" });
  await seedUserAndAccount(env.DB, { userId: "pu", accountId: "pa2", alias: "uni" });
});

describe("effectiveLevel", () => {
  it("falls back to spec defaults", async () => {
    expect(await effectiveLevel(env.DB, "pu", "pa1", "send.message")).toBe("ask");
    expect(await effectiveLevel(env.DB, "pu", "pa1", "read.search")).toBe("allow");
  });
  it("global override beats default, account override beats global", async () => {
    await setPolicy(env.DB, { userId: "pu", accountId: null, action: "send.message", level: "allow" });
    expect(await effectiveLevel(env.DB, "pu", "pa1", "send.message")).toBe("allow");
    await setPolicy(env.DB, { userId: "pu", accountId: "pa2", action: "send.message", level: "deny" });
    expect(await effectiveLevel(env.DB, "pu", "pa2", "send.message")).toBe("deny");
    expect(await effectiveLevel(env.DB, "pu", "pa1", "send.message")).toBe("allow");
  });
  it("refuses browser-only actions", async () => {
    await expect(effectiveLevel(env.DB, "pu", "pa1", "policy.edit")).rejects.toThrow(/browser/);
  });
  it("setPolicy upserts instead of duplicating", async () => {
    await setPolicy(env.DB, { userId: "pu", accountId: null, action: "trash.move", level: "allow" });
    await setPolicy(env.DB, { userId: "pu", accountId: null, action: "trash.move", level: "deny" });
    expect(await effectiveLevel(env.DB, "pu", "pa1", "trash.move")).toBe("deny");
  });
});

describe("decide with modifiers", () => {
  it("raises allow to ask, leaves ask and deny", async () => {
    const d1 = await decide(env.DB, { userId: "pu", accountId: "pa1", action: "send.message", modifiers: ["+external"] });
    expect(d1).toEqual({ base: "allow", level: "ask", modifiers: ["+external"] });
    const d2 = await decide(env.DB, { userId: "pu", accountId: "pa2", action: "send.message", modifiers: ["+attachment"] });
    expect(d2.level).toBe("deny");
    const d3 = await decide(env.DB, { userId: "pu", accountId: "pa1", action: "label.apply", modifiers: [] });
    expect(d3.level).toBe("allow");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npx vitest run test/engine.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`worker/src/policy/engine.ts`:
```ts
import { DEFAULT_POLICY, raise, type Action, type Level, type Modifier } from "@gmail-mcp/shared/actions";

export type Decision = { level: Level; base: Level; modifiers: Modifier[] };

export async function effectiveLevel(db: D1Database, userId: string, accountId: string, action: Action): Promise<Level> {
  const def = DEFAULT_POLICY[action];
  if (def === "browser") throw new Error(`action ${action} is browser-only`);
  const row = await db
    .prepare(
      `SELECT level FROM policies
       WHERE user_id = ? AND action = ? AND (account_id = ? OR account_id IS NULL)
       ORDER BY account_id IS NULL ASC LIMIT 1`,
    )
    .bind(userId, action, accountId)
    .first<{ level: Level }>();
  return row?.level ?? def;
}

export async function decide(
  db: D1Database,
  o: { userId: string; accountId: string; action: Action; modifiers: Modifier[] },
): Promise<Decision> {
  const base = await effectiveLevel(db, o.userId, o.accountId, o.action);
  const level = o.modifiers.length > 0 ? raise(base) : base;
  return { base, level, modifiers: [...o.modifiers] };
}

export async function setPolicy(
  db: D1Database,
  o: { userId: string; accountId: string | null; action: Action; level: Level },
): Promise<void> {
  const now = Date.now();
  if (o.accountId === null) {
    await db.prepare(
      `INSERT INTO policies (user_id, account_id, action, level, updated_at) VALUES (?, NULL, ?, ?, ?)
       ON CONFLICT(user_id, action) WHERE account_id IS NULL DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`,
    ).bind(o.userId, o.action, o.level, now).run();
  } else {
    await db.prepare(
      `INSERT INTO policies (user_id, account_id, action, level, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, account_id, action) WHERE account_id IS NOT NULL DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`,
    ).bind(o.userId, o.accountId, o.action, o.level, now).run();
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd worker && npx vitest run test/engine.test.ts`
Expected: PASS (5 tests). The `ORDER BY account_id IS NULL ASC` puts the account-specific row (0) before the global row (1).

- [ ] **Step 5: Commit**

```bash
git add worker/src/policy/engine.ts worker/test/engine.test.ts
git commit -m "feat(worker): policy engine with overrides and modifier raising

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Pending actions and the atomic claim

**Files:**
- Create: `worker/src/approval/pending.ts`, `worker/src/approval/claim.ts`, `worker/src/operations/journal.ts`, `worker/test/claim.test.ts`

**Interfaces:**
- Consumes: `payloadHash`, `randomId`, `Action`, `Modifier`.
- Produces:
  - `createPending(db, {userId, accountId, action, modifiers, payload, summary, ttlMs?}): Promise<PendingRow>` (computes hash, stores canonical JSON, TTL default 15 min)
  - `approvePending(db, {id, userId, via: "browser" | "elicitation"}): Promise<boolean>` (atomic `pending → approved`)
  - `denyPending`, `cancelPending` similar, returning boolean
  - `getPending(db, id, userId): Promise<PendingRow | null>`
  - `claimPending(db, {id, userId, handles: string[]}): Promise<{operationId: string; pending: PendingRow}>` throwing `GmailMcpError("pending_replayed" | "pending_expired" | "pending_not_approved" | "handle_reserved")`
  - `journal.acquire(db, {userId, accountId, action, idempotencyKey?, payloadHash}): Promise<{operationId: string; existing: OperationRow | null}>`
  - `journal.transition(db, operationId, from: OpState[], to: OpState, patch?)`: Promise<boolean>`
  - `type PendingRow`, `type OperationRow`, `type OpState`.

- [ ] **Step 1: Write the failing test**

`worker/test/claim.test.ts`:
```ts
import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import { seedUserAndAccount } from "./fixtures";
import { createPending, approvePending, cancelPending, getPending } from "../src/approval/pending";
import { claimPending } from "../src/approval/claim";
import { acquire, transition } from "../src/operations/journal";

beforeAll(async () => {
  await seedUserAndAccount(env.DB, { userId: "cu", accountId: "ca", alias: "main" });
  await seedUserAndAccount(env.DB, { userId: "cu2", accountId: "cb", alias: "main" });
});

async function stageUpload(handle: string, accountId = "ca", userId = "cu") {
  await env.DB.prepare(
    `INSERT INTO staging_objects (handle, user_id, account_id, direction, r2_key, filename, mime, size, sha256, created_at, expires_at)
     VALUES (?, ?, ?, 'upload', ?, 'f.pdf', 'application/pdf', 1, 'h', ?, ?)`,
  ).bind(handle, userId, accountId, `stg/${handle}`, Date.now(), Date.now() + 60_000).run();
}

describe("pending lifecycle", () => {
  it("creates with hash and 15 minute ttl, approves once", async () => {
    const p = await createPending(env.DB, { userId: "cu", accountId: "ca", action: "send.message", modifiers: ["+external"], payload: { to: ["a@x.test"] }, summary: "s" });
    expect(p.state).toBe("pending");
    expect(p.expires_at - p.created_at).toBe(15 * 60_000);
    expect(await approvePending(env.DB, { id: p.id, userId: "cu", via: "browser" })).toBe(true);
    expect(await approvePending(env.DB, { id: p.id, userId: "cu", via: "browser" })).toBe(false);
    expect((await getPending(env.DB, p.id, "cu"))?.state).toBe("approved");
  });
  it("cannot be approved by another user", async () => {
    const p = await createPending(env.DB, { userId: "cu", accountId: "ca", action: "trash.move", modifiers: [], payload: { id: 1 }, summary: "s" });
    expect(await approvePending(env.DB, { id: p.id, userId: "cu2", via: "browser" })).toBe(false);
    expect(await getPending(env.DB, p.id, "cu2")).toBeNull();
  });
});

describe("claimPending", () => {
  it("claims an approved row exactly once even under concurrency", async () => {
    const p = await createPending(env.DB, { userId: "cu", accountId: "ca", action: "send.message", modifiers: [], payload: { n: 1 }, summary: "s" });
    await approvePending(env.DB, { id: p.id, userId: "cu", via: "elicitation" });
    const results = await Promise.allSettled([
      claimPending(env.DB, { id: p.id, userId: "cu", handles: [] }),
      claimPending(env.DB, { id: p.id, userId: "cu", handles: [] }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    const ops = await env.DB.prepare("SELECT count(*) AS c FROM operations WHERE user_id = 'cu'").first<{ c: number }>();
    expect(ops?.c).toBe(1);
  });
  it("rejects unapproved, cancelled and expired rows without creating an operation", async () => {
    const before = (await env.DB.prepare("SELECT count(*) AS c FROM operations").first<{ c: number }>())!.c;
    const p1 = await createPending(env.DB, { userId: "cu", accountId: "ca", action: "send.message", modifiers: [], payload: { n: 2 }, summary: "s" });
    await expect(claimPending(env.DB, { id: p1.id, userId: "cu", handles: [] })).rejects.toThrow(/pending_not_approved/);
    await cancelPending(env.DB, { id: p1.id, userId: "cu" });
    await expect(claimPending(env.DB, { id: p1.id, userId: "cu", handles: [] })).rejects.toThrow(/pending_not_approved/);
    const p2 = await createPending(env.DB, { userId: "cu", accountId: "ca", action: "send.message", modifiers: [], payload: { n: 3 }, summary: "s", ttlMs: -1 });
    await approvePending(env.DB, { id: p2.id, userId: "cu", via: "browser" }); // returns false: already expired
    await expect(claimPending(env.DB, { id: p2.id, userId: "cu", handles: [] })).rejects.toThrow(/pending_expired|pending_not_approved/);
    const after = (await env.DB.prepare("SELECT count(*) AS c FROM operations").first<{ c: number }>())!.c;
    expect(after).toBe(before);
  });
  it("reserves upload handles atomically and rolls back on a missing or foreign handle", async () => {
    await stageUpload("sh_ok1");
    await stageUpload("sh_foreign", "cb", "cu2");
    const p = await createPending(env.DB, { userId: "cu", accountId: "ca", action: "send.message", modifiers: ["+attachment"], payload: { a: ["sh_ok1"] }, summary: "s" });
    await approvePending(env.DB, { id: p.id, userId: "cu", via: "browser" });
    const before = (await env.DB.prepare("SELECT count(*) AS c FROM operations").first<{ c: number }>())!.c;
    await expect(claimPending(env.DB, { id: p.id, userId: "cu", handles: ["sh_ok1", "sh_foreign"] })).rejects.toThrow(/handle_reserved/);
    const after = (await env.DB.prepare("SELECT count(*) AS c FROM operations").first<{ c: number }>())!.c;
    expect(after).toBe(before);
    expect((await getPending(env.DB, p.id, "cu"))?.state).toBe("approved");
    const r = await claimPending(env.DB, { id: p.id, userId: "cu", handles: ["sh_ok1"] });
    const row = await env.DB.prepare("SELECT reserved_by_operation_id AS r FROM staging_objects WHERE handle = 'sh_ok1'").first<{ r: string }>();
    expect(row?.r).toBe(r.operationId);
  });
});

describe("operations journal", () => {
  it("returns the existing row for a repeated idempotency key", async () => {
    const a = await acquire(env.DB, { userId: "cu", accountId: "ca", action: "send.message", idempotencyKey: "k1", payloadHash: "h" });
    expect(a.existing).toBeNull();
    await transition(env.DB, a.operationId, ["claimed"], "executed", { gmail_result_id: "m1" });
    const b = await acquire(env.DB, { userId: "cu", accountId: "ca", action: "send.message", idempotencyKey: "k1", payloadHash: "h" });
    expect(b.existing?.state).toBe("executed");
    expect(b.existing?.gmail_result_id).toBe("m1");
  });
  it("transition only from allowed states", async () => {
    const a = await acquire(env.DB, { userId: "cu", accountId: "ca", action: "send.message", payloadHash: "h" });
    expect(await transition(env.DB, a.operationId, ["executing"], "executed")).toBe(false);
    expect(await transition(env.DB, a.operationId, ["claimed"], "executing")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npx vitest run test/claim.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the journal**

`worker/src/operations/journal.ts`:
```ts
import type { Action } from "@gmail-mcp/shared/actions";
import { randomId } from "../crypto/random";

export type OpState = "claimed" | "executing" | "delivery_unknown" | "executed" | "failed_safe";
export type OperationRow = {
  id: string; user_id: string; account_id: string; action: string; idempotency_key: string | null;
  state: OpState; payload_hash: string; rfc822_message_id: string | null; gmail_result_id: string | null;
  created_at: number; updated_at: number;
};

export async function acquire(
  db: D1Database,
  o: { userId: string; accountId: string; action: Action; idempotencyKey?: string; payloadHash: string },
): Promise<{ operationId: string; existing: OperationRow | null }> {
  if (o.idempotencyKey) {
    const existing = await db
      .prepare("SELECT * FROM operations WHERE user_id = ? AND account_id = ? AND idempotency_key = ?")
      .bind(o.userId, o.accountId, o.idempotencyKey)
      .first<OperationRow>();
    if (existing && existing.state !== "failed_safe") return { operationId: existing.id, existing };
    if (existing) {
      // failed_safe rows may be superseded: free the key
      await db.prepare("UPDATE operations SET idempotency_key = NULL WHERE id = ?").bind(existing.id).run();
    }
  }
  const id = randomId("op");
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO operations (id, user_id, account_id, action, idempotency_key, state, payload_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?)`,
    )
    .bind(id, o.userId, o.accountId, o.action, o.idempotencyKey ?? null, o.payloadHash, now, now)
    .run();
  return { operationId: id, existing: null };
}

export async function transition(
  db: D1Database,
  operationId: string,
  from: OpState[],
  to: OpState,
  patch: { gmail_result_id?: string; rfc822_message_id?: string } = {},
): Promise<boolean> {
  const placeholders = from.map(() => "?").join(",");
  const res = await db
    .prepare(
      `UPDATE operations SET state = ?, updated_at = ?,
         gmail_result_id = COALESCE(?, gmail_result_id),
         rfc822_message_id = COALESCE(?, rfc822_message_id)
       WHERE id = ? AND state IN (${placeholders})`,
    )
    .bind(to, Date.now(), patch.gmail_result_id ?? null, patch.rfc822_message_id ?? null, operationId, ...from)
    .run();
  return (res.meta.changes ?? 0) === 1;
}
```

- [ ] **Step 4: Implement pending**

`worker/src/approval/pending.ts`:
```ts
import type { Action, Modifier } from "@gmail-mcp/shared/actions";
import { canonicalize, payloadHash } from "../crypto/canonical";
import { randomId } from "../crypto/random";
import { LIMITS } from "../policy/limits";
import { GmailMcpError } from "@gmail-mcp/shared/errors";

export const PENDING_TTL_MS = 15 * 60_000;

export type PendingState = "pending" | "approved" | "executing" | "executed" | "failed" | "denied" | "cancelled" | "expired";
export type PendingRow = {
  id: string; user_id: string; account_id: string; action: Action; modifiers: string;
  payload_json: string | null; payload_hash: string; summary: string; state: PendingState;
  operation_id: string | null; created_at: number; expires_at: number;
  approved_at: number | null; approved_via: string | null; executed_at: number | null; error: string | null;
};

export async function createPending(
  db: D1Database,
  o: { userId: string; accountId: string; action: Action; modifiers: Modifier[]; payload: unknown; summary: string; ttlMs?: number },
): Promise<PendingRow> {
  const canonical = canonicalize(o.payload);
  if (new TextEncoder().encode(canonical).length > LIMITS.canonicalPayloadBytes) {
    throw new GmailMcpError("limit_exceeded", "limit_exceeded: canonical payload > 1 MB");
  }
  const hash = await payloadHash(o.payload);
  const id = randomId("pa");
  const now = Date.now();
  const expires = now + (o.ttlMs ?? PENDING_TTL_MS);
  await db
    .prepare(
      `INSERT INTO pending_actions (id, user_id, account_id, action, modifiers, payload_json, payload_hash, summary, state, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .bind(id, o.userId, o.accountId, o.action, JSON.stringify(o.modifiers), canonical, hash, o.summary, now, expires)
    .run();
  return (await getPending(db, id, o.userId))!;
}

export async function getPending(db: D1Database, id: string, userId: string): Promise<PendingRow | null> {
  return db.prepare("SELECT * FROM pending_actions WHERE id = ? AND user_id = ?").bind(id, userId).first<PendingRow>();
}

async function setState(
  db: D1Database, id: string, userId: string, from: PendingState, to: PendingState, extra = "", binds: unknown[] = [],
): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE pending_actions SET state = ? ${extra} WHERE id = ? AND user_id = ? AND state = ? AND expires_at > ?`)
    .bind(to, ...binds, id, userId, from, Date.now())
    .run();
  return (res.meta.changes ?? 0) === 1;
}

export function approvePending(db: D1Database, o: { id: string; userId: string; via: "browser" | "elicitation" }): Promise<boolean> {
  return setState(db, o.id, o.userId, "pending", "approved", ", approved_at = ?, approved_via = ?", [Date.now(), o.via]);
}
export function denyPending(db: D1Database, o: { id: string; userId: string }): Promise<boolean> {
  return setState(db, o.id, o.userId, "pending", "denied", ", payload_json = NULL");
}
export function cancelPending(db: D1Database, o: { id: string; userId: string }): Promise<boolean> {
  return setState(db, o.id, o.userId, "pending", "cancelled", ", payload_json = NULL");
}

/** Terminal purge per spec 3.4: null the payload and redact the summary. */
export async function finishPending(db: D1Database, id: string, to: "executed" | "failed", error?: string): Promise<void> {
  await db
    .prepare(
      `UPDATE pending_actions SET state = ?, payload_json = NULL, summary = 'redacted', error = ?, executed_at = ? WHERE id = ? AND state = 'executing'`,
    )
    .bind(to, error ?? null, Date.now(), id)
    .run();
}
```

- [ ] **Step 5: Implement the claim batch**

`worker/src/approval/claim.ts`:
```ts
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Action } from "@gmail-mcp/shared/actions";
import { randomId } from "../crypto/random";
import { getPending, type PendingRow } from "./pending";

/**
 * Spec 3.4: one D1 batch. Order matters because foreign keys are immediate:
 * 1 insert operation (claimed) -> 2 claim pending (approved -> executing) ->
 * 3 assert claim happened -> 4 reserve handles -> 5 assert reservation count.
 * `_assert` has CHECK (x = 0); inserting 1 raises and rolls the batch back.
 */
export async function claimPending(
  db: D1Database,
  o: { id: string; userId: string; handles: string[] },
): Promise<{ operationId: string; pending: PendingRow }> {
  const before = await getPending(db, o.id, o.userId);
  if (!before) throw new GmailMcpError("pending_not_approved", "pending_not_approved: unknown");
  if (before.expires_at <= Date.now()) throw new GmailMcpError("pending_expired", "pending_expired");
  if (before.state !== "approved") throw new GmailMcpError("pending_not_approved", `pending_not_approved: ${before.state}`);

  const operationId = randomId("op");
  const now = Date.now();
  const handles = [...new Set(o.handles)];
  const stmts: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO operations (id, user_id, account_id, action, idempotency_key, state, payload_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?)`,
    ).bind(operationId, before.user_id, before.account_id, before.action as Action, before.id, before.payload_hash, now, now),
    db.prepare(
      `UPDATE pending_actions SET state = 'executing', operation_id = ?, executed_at = ?
       WHERE id = ? AND user_id = ? AND state = 'approved' AND expires_at > ?`,
    ).bind(operationId, now, o.id, o.userId, now),
    db.prepare(
      `INSERT INTO _assert (x) SELECT 1 WHERE NOT EXISTS (
         SELECT 1 FROM pending_actions WHERE id = ? AND operation_id = ? AND state = 'executing')`,
    ).bind(o.id, operationId),
  ];
  if (handles.length > 0) {
    const ph = handles.map(() => "?").join(",");
    stmts.push(
      db.prepare(
        `UPDATE staging_objects SET reserved_by_operation_id = ?
         WHERE handle IN (${ph}) AND user_id = ? AND account_id = ? AND direction = 'upload'
           AND consumed_at IS NULL AND reserved_by_operation_id IS NULL AND expires_at > ?`,
      ).bind(operationId, ...handles, before.user_id, before.account_id, now),
      db.prepare(
        `INSERT INTO _assert (x) SELECT 1 WHERE (SELECT count(*) FROM staging_objects WHERE reserved_by_operation_id = ?) != ?`,
      ).bind(operationId, handles.length),
    );
  }
  try {
    await db.batch(stmts);
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    // Distinguish which assertion fired by re-reading state.
    const after = await getPending(db, o.id, o.userId);
    if (after?.state === "approved" && handles.length > 0) {
      throw new GmailMcpError("handle_reserved", `handle_reserved: one or more handles unavailable (${msg})`);
    }
    if (after?.state !== "approved") {
      throw new GmailMcpError("pending_replayed", `pending_replayed: ${after?.state ?? "unknown"}`);
    }
    throw new GmailMcpError("internal", msg);
  }
  const pending = (await getPending(db, o.id, o.userId))!;
  return { operationId, pending };
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd worker && npx vitest run test/claim.test.ts`
Expected: PASS (7 tests). If the concurrency test yields two fulfilled claims, D1's local emulation serialised nothing and the `_assert` statement is not firing: check that statement 3 references the same `operationId` that statement 2 set, and that the batch error propagates (the plugin surfaces it as a rejected promise).

- [ ] **Step 7: Commit**

```bash
git add worker/src/approval worker/src/operations worker/test/claim.test.ts
git commit -m "feat(worker): pending actions, operations journal, atomic claim with _assert rollback

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Staging store (R2 ingest, get, ack, purge)

**Files:**
- Create: `worker/src/staging/store.ts`, `worker/test/staging.test.ts`

**Interfaces:**
- Consumes: `randomHandle`, `sha256Hex`, `sanitizeFilename`, `assertNotBlocked`, `LIMITS`.
- Produces:
  - `ingest(env, {userId, accountId, direction, filename, mime, length, body: ReadableStream<Uint8Array>, declaredSha256?, source?}): Promise<StagingRow>` (rejects `length` over 25 MB before reading, wraps the body in `FixedLengthStream(length)` so a short or long body errors, tees into R2 and `DigestStream`, verifies the declared hash when given)
  - `openForRead(env, {handle, userId}): Promise<{row: StagingRow; body: ReadableStream}>` throwing `handle_invalid | handle_expired`
  - `ack(env, {handle, userId}): Promise<boolean>`
  - `extendExpiry(db, handles: string[], userId, accountId, until: number)`
  - `consume(db, operationId)`, `release(db, operationId)`
  - `purgeExpired(env, now): Promise<{deleted: number}>`
  - `type StagingRow`.

- [ ] **Step 1: Write the failing test**

`worker/test/staging.test.ts`:
```ts
import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import { seedUserAndAccount } from "./fixtures";
import { ingest, openForRead, ack, purgeExpired, extendExpiry, consume, release } from "../src/staging/store";
import { sha256Hex } from "../src/crypto/canonical";

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
const stream = (b: Uint8Array) => new Response(b).body!;

beforeAll(async () => {
  await seedUserAndAccount(env.DB, { userId: "su", accountId: "sa", alias: "main" });
  await seedUserAndAccount(env.DB, { userId: "su2", accountId: "sb", alias: "main" });
});

const up = (name: string, data: Uint8Array, extra: Record<string, unknown> = {}) =>
  ingest(env, { userId: "su", accountId: "sa", direction: "upload", filename: name, mime: "application/octet-stream", length: data.byteLength, body: stream(data), ...extra });

describe("ingest", () => {
  it("stores bytes in R2, computes sha256, sanitises the filename, sets 30 min ttl", async () => {
    const data = bytes(1000);
    const row = await ingest(env, { userId: "su", accountId: "sa", direction: "download", filename: "../x\u202e.pdf", mime: "application/pdf", length: 1000, body: stream(data) });
    expect(row.handle).toMatch(/^sh_/);
    expect(row.filename).toBe("x_.pdf");
    expect(row.size).toBe(1000);
    expect(row.sha256).toBe(await sha256Hex(data));
    expect(row.expires_at - row.created_at).toBe(30 * 60_000);
    const obj = await env.STAGING.get(row.r2_key);
    expect((await obj!.arrayBuffer()).byteLength).toBe(1000);
  });
  it("rejects blocked extensions and over-cap lengths before reading any bytes", async () => {
    await expect(up("run.exe", bytes(1))).rejects.toThrow(/blocked_extension/);
    await expect(up("big.bin", bytes(1), { length: 25 * 1024 * 1024 + 1 })).rejects.toThrow(/limit_exceeded/);
  });
  it("rejects a body whose byte count differs from length, leaving no R2 object or row", async () => {
    await expect(up("short.bin", bytes(3), { length: 5 })).rejects.toThrow();
    await expect(up("long.bin", bytes(7), { length: 5 })).rejects.toThrow();
    const n = await env.DB.prepare("SELECT count(*) AS c FROM staging_objects WHERE filename IN ('short.bin','long.bin')").first<{ c: number }>();
    expect(n?.c).toBe(0);
    const listed = await env.STAGING.list({ prefix: "stg/su/" });
    expect(listed.objects.filter((o) => o.size === 3 || o.size === 7)).toHaveLength(0);
  });
  it("rejects a declared sha256 that does not match and leaves no row", async () => {
    await expect(up("a.txt", bytes(5), { declaredSha256: "0".repeat(64) })).rejects.toThrow(/handle_invalid/);
    const n = await env.DB.prepare("SELECT count(*) AS c FROM staging_objects WHERE filename = 'a.txt'").first<{ c: number }>();
    expect(n?.c).toBe(0);
  });
});

describe("read and ack", () => {
  it("streams to the owner, refuses other users, allows re-read before ack, blocks after ack", async () => {
    const row = await ingest(env, { userId: "su", accountId: "sa", direction: "download", filename: "r.txt", mime: "text/plain", length: 3, body: stream(bytes(3, 9)) });
    const first = await openForRead(env, { handle: row.handle, userId: "su" });
    expect(new Uint8Array(await new Response(first.body).arrayBuffer())).toEqual(bytes(3, 9));
    await expect(openForRead(env, { handle: row.handle, userId: "su2" })).rejects.toThrow(/handle_invalid/);
    await openForRead(env, { handle: row.handle, userId: "su" }); // re-read ok
    expect(await ack(env, { handle: row.handle, userId: "su" })).toBe(true);
    expect(await ack(env, { handle: row.handle, userId: "su" })).toBe(false);
    await expect(openForRead(env, { handle: row.handle, userId: "su" })).rejects.toThrow(/handle_invalid/);
  });
});

describe("expiry, hold, consume, release, purge", () => {
  it("purges expired unreserved objects from R2 and D1, keeps reserved ones", async () => {
    const a = await up("a.bin", bytes(2));
    const b = await up("b.bin", bytes(2));
    await env.DB.prepare("UPDATE staging_objects SET expires_at = 1 WHERE handle IN (?, ?)").bind(a.handle, b.handle).run();
    await env.DB.prepare("INSERT INTO operations (id, user_id, account_id, action, state, payload_hash, created_at, updated_at) VALUES ('op_x', 'su', 'sa', 'send.message', 'delivery_unknown', 'h', 1, 1)").run();
    await env.DB.prepare("UPDATE staging_objects SET reserved_by_operation_id = 'op_x' WHERE handle = ?").bind(b.handle).run();
    const r = await purgeExpired(env, Date.now());
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    expect(await env.STAGING.get(a.r2_key)).toBeNull();
    expect(await env.STAGING.get(b.r2_key)).not.toBeNull();
  });
  it("extendExpiry, consume and release update the right rows", async () => {
    const c = await up("c.bin", bytes(2));
    await extendExpiry(env.DB, [c.handle], "su", "sa", c.expires_at + 99_000);
    const e = await env.DB.prepare("SELECT expires_at AS e FROM staging_objects WHERE handle = ?").bind(c.handle).first<{ e: number }>();
    expect(e?.e).toBe(c.expires_at + 99_000);
    await env.DB.prepare("INSERT INTO operations (id, user_id, account_id, action, state, payload_hash, created_at, updated_at) VALUES ('op_y', 'su', 'sa', 'send.message', 'executing', 'h', 1, 1)").run();
    await env.DB.prepare("UPDATE staging_objects SET reserved_by_operation_id = 'op_y' WHERE handle = ?").bind(c.handle).run();
    await release(env.DB, "op_y");
    expect((await env.DB.prepare("SELECT reserved_by_operation_id AS r FROM staging_objects WHERE handle = ?").bind(c.handle).first<{ r: string | null }>())?.r).toBeNull();
    await env.DB.prepare("UPDATE staging_objects SET reserved_by_operation_id = 'op_y' WHERE handle = ?").bind(c.handle).run();
    await consume(env.DB, "op_y");
    expect((await env.DB.prepare("SELECT consumed_at AS c FROM staging_objects WHERE handle = ?").bind(c.handle).first<{ c: number | null }>())?.c).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npx vitest run test/staging.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`worker/src/staging/store.ts`:
```ts
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Env } from "../env";
import { randomHandle } from "../crypto/random";
import { LIMITS, assertNotBlocked, sanitizeFilename } from "../policy/limits";

export const DOWNLOAD_TTL_MS = 30 * 60_000;

export type StagingRow = {
  handle: string; user_id: string; account_id: string; direction: "download" | "upload";
  r2_key: string; filename: string; mime: string; size: number; sha256: string;
  source_message_id: string | null; source_attachment_id: string | null;
  reserved_by_operation_id: string | null; created_at: number; expires_at: number; consumed_at: number | null;
};

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function ingest(
  env: Env,
  o: {
    userId: string; accountId: string; direction: "download" | "upload"; filename: string; mime: string;
    length: number; body: ReadableStream<Uint8Array>; declaredSha256?: string;
    source?: { messageId: string; attachmentId: string };
  },
): Promise<StagingRow> {
  const filename = sanitizeFilename(o.filename);
  assertNotBlocked(filename);
  if (!Number.isInteger(o.length) || o.length < 0 || o.length > LIMITS.stagedFileBytes) {
    throw new GmailMcpError("limit_exceeded", `limit_exceeded: length ${o.length} not within 0..${LIMITS.stagedFileBytes}`);
  }
  const handle = randomHandle();
  const r2Key = `stg/${o.userId}/${handle}`;
  // FixedLengthStream errors if the body is shorter or longer than `length`, so the cap above is exact,
  // and R2 receives a known-length stream.
  const fixed = new FixedLengthStream(o.length);
  const pumping = o.body.pipeTo(fixed.writable);
  const [forR2, forDigest] = fixed.readable.tee();
  const digest = new crypto.DigestStream("SHA-256");
  // Run all three concurrently and observe every rejection: an unobserved rejection from the digest branch
  // would surface as an unhandled promise rejection and fail the process.
  const settled = await Promise.allSettled([
    env.STAGING.put(r2Key, forR2, { httpMetadata: { contentType: o.mime } }),
    forDigest.pipeTo(digest),
    pumping,
  ]);
  const failure = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failure) {
    await env.STAGING.delete(r2Key).catch(() => {});
    const reason = failure.reason;
    if (reason instanceof GmailMcpError) throw reason;
    throw new GmailMcpError("internal", `ingest failed: ${String((reason as Error)?.message ?? reason)}`);
  }
  const put = (settled[0] as PromiseFulfilledResult<R2Object | null>).value;
  const sha256 = hex(await digest.digest);
  if (o.declaredSha256 && o.declaredSha256.toLowerCase() !== sha256) {
    await env.STAGING.delete(r2Key);
    throw new GmailMcpError("handle_invalid", "handle_invalid: declared sha256 mismatch");
  }
  const now = Date.now();
  const row: StagingRow = {
    handle, user_id: o.userId, account_id: o.accountId, direction: o.direction, r2_key: r2Key,
    filename, mime: o.mime, size: put?.size ?? o.length, sha256,
    source_message_id: o.source?.messageId ?? null, source_attachment_id: o.source?.attachmentId ?? null,
    reserved_by_operation_id: null, created_at: now, expires_at: now + DOWNLOAD_TTL_MS, consumed_at: null,
  };
  await env.DB.prepare(
    `INSERT INTO staging_objects (handle, user_id, account_id, direction, r2_key, filename, mime, size, sha256,
       source_message_id, source_attachment_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(row.handle, row.user_id, row.account_id, row.direction, row.r2_key, row.filename, row.mime, row.size, row.sha256,
    row.source_message_id, row.source_attachment_id, row.created_at, row.expires_at).run();
  return row;
}

export async function openForRead(env: Env, o: { handle: string; userId: string }): Promise<{ row: StagingRow; body: ReadableStream }> {
  const row = await env.DB
    .prepare("SELECT * FROM staging_objects WHERE handle = ? AND user_id = ? AND consumed_at IS NULL")
    .bind(o.handle, o.userId)
    .first<StagingRow>();
  if (!row) throw new GmailMcpError("handle_invalid", "handle_invalid");
  if (row.expires_at <= Date.now()) throw new GmailMcpError("handle_expired", "handle_expired");
  const obj = await env.STAGING.get(row.r2_key);
  if (!obj) throw new GmailMcpError("handle_invalid", "handle_invalid: object missing");
  return { row, body: obj.body };
}

export async function ack(env: Env, o: { handle: string; userId: string }): Promise<boolean> {
  const res = await env.DB
    .prepare("UPDATE staging_objects SET consumed_at = ? WHERE handle = ? AND user_id = ? AND direction = 'download' AND consumed_at IS NULL")
    .bind(Date.now(), o.handle, o.userId)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

export async function extendExpiry(db: D1Database, handles: string[], userId: string, accountId: string, until: number): Promise<void> {
  if (handles.length === 0) return;
  const ph = handles.map(() => "?").join(",");
  await db.prepare(
    `UPDATE staging_objects SET expires_at = MAX(expires_at, ?) WHERE handle IN (${ph}) AND user_id = ? AND account_id = ?`,
  ).bind(until, ...handles, userId, accountId).run();
}

export async function consume(db: D1Database, operationId: string): Promise<void> {
  await db.prepare("UPDATE staging_objects SET consumed_at = ? WHERE reserved_by_operation_id = ? AND consumed_at IS NULL")
    .bind(Date.now(), operationId).run();
}

export async function release(db: D1Database, operationId: string): Promise<void> {
  await db.prepare("UPDATE staging_objects SET reserved_by_operation_id = NULL WHERE reserved_by_operation_id = ? AND consumed_at IS NULL")
    .bind(operationId).run();
}

export async function purgeExpired(env: Env, now: number): Promise<{ deleted: number }> {
  const rows = await env.DB
    .prepare(
      `SELECT handle, r2_key FROM staging_objects
       WHERE (expires_at <= ? OR consumed_at IS NOT NULL) AND reserved_by_operation_id IS NULL LIMIT 200`,
    )
    .bind(now)
    .all<{ handle: string; r2_key: string }>();
  let deleted = 0;
  for (const r of rows.results) {
    await env.STAGING.delete(r.r2_key);
    await env.DB.prepare("DELETE FROM staging_objects WHERE handle = ?").bind(r.handle).run();
    deleted++;
  }
  return { deleted };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd worker && npx vitest run test/staging.test.ts`
Expected: PASS (7 tests). `crypto.DigestStream` and `FixedLengthStream` are Workers-specific globals present in workerd; if TypeScript cannot see them, confirm `@cloudflare/workers-types` is in `tsconfig.json` `types`. If the "long.bin" case passes bytes through instead of erroring, the runtime silently truncated: assert on `settled[2]` (the `pumping` promise) rejecting, which FixedLengthStream guarantees when more bytes are written than declared.

- [ ] **Step 5: Commit**

```bash
git add worker/src/staging worker/test/staging.test.ts
git commit -m "feat(worker): staging store with tee ingest, owner-checked reads, ack, hold, purge

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Audit log and cron

**Files:**
- Create: `worker/src/audit/log.ts`, `worker/src/cron.ts`, `worker/test/cron.test.ts`
- Modify: `worker/src/index.ts`

**Interfaces:**
- Produces: `auditIntent(db, {userId, accountId, tool, action, modifiers, decision, pendingId?, operationId?, summary, clientHint?}): Promise<number>`, `auditOutcome(db, {...same, gmailResultId?})`, `redactSummary(s: {recipientCount?: number; attachmentCount?: number; ids?: string[]}): string`, `runCron(env, now): Promise<CronReport>` with `type CronReport = { expiredPending: number; promotedUnknown: number; failedSafe: number; purgedStaging: number; purgedAudit: number }`.

- [ ] **Step 1: Write the failing test**

`worker/test/cron.test.ts`:
```ts
import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import { seedUserAndAccount } from "./fixtures";
import { runCron } from "../src/cron";
import { auditIntent, auditOutcome, redactSummary } from "../src/audit/log";

beforeAll(async () => {
  await seedUserAndAccount(env.DB, { userId: "ku", accountId: "ka", alias: "main" });
});

describe("audit", () => {
  it("writes intent and outcome rows with redacted summaries only", async () => {
    const id = await auditIntent(env.DB, { userId: "ku", accountId: "ka", tool: "send_message", action: "send.message", modifiers: ["+external"], decision: "ask", summary: redactSummary({ recipientCount: 2, attachmentCount: 1 }) });
    expect(id).toBeGreaterThan(0);
    await auditOutcome(env.DB, { userId: "ku", accountId: "ka", tool: "send_message", action: "send.message", modifiers: [], decision: "executed", gmailResultId: "m9", summary: redactSummary({ ids: ["m9"] }) });
    const rows = await env.DB.prepare("SELECT phase, decision, summary FROM audit_log WHERE user_id = 'ku' ORDER BY id").all<{ phase: string; decision: string; summary: string }>();
    expect(rows.results.map((r) => r.phase)).toEqual(["intent", "outcome"]);
    expect(rows.results[0]!.summary).toBe("recipients=2 attachments=1");
    expect(rows.results[1]!.summary).toBe("ids=m9");
  });
});

describe("cron", () => {
  it("expires pending, promotes stale executing to delivery_unknown, stale claimed to failed_safe, purges old audit", async () => {
    const old = Date.now() - 10 * 60_000;
    await env.DB.prepare(`INSERT INTO pending_actions (id, user_id, account_id, action, modifiers, payload_json, payload_hash, summary, state, created_at, expires_at)
      VALUES ('pa_old', 'ku', 'ka', 'send.message', '[]', '{"x":1}', 'h', 'To: secret', 'pending', ?, ?)`).bind(old, old + 1).run();
    await env.DB.prepare(`INSERT INTO operations (id, user_id, account_id, action, state, payload_hash, created_at, updated_at) VALUES ('op_exec', 'ku', 'ka', 'send.message', 'executing', 'h', ?, ?)`).bind(old, old).run();
    await env.DB.prepare(`INSERT INTO operations (id, user_id, account_id, action, state, payload_hash, created_at, updated_at) VALUES ('op_claim', 'ku', 'ka', 'send.message', 'claimed', 'h', ?, ?)`).bind(old, old).run();
    await env.DB.prepare(`INSERT INTO operations (id, user_id, account_id, action, state, payload_hash, created_at, updated_at) VALUES ('op_fresh', 'ku', 'ka', 'send.message', 'executing', 'h', ?, ?)`).bind(Date.now(), Date.now()).run();
    await env.DB.prepare(`INSERT INTO audit_log (ts, phase, summary) VALUES (?, 'intent', 'ancient')`).bind(Date.now() - 91 * 86_400_000).run();

    const report = await runCron(env, Date.now());
    expect(report.expiredPending).toBeGreaterThanOrEqual(1);
    expect(report.promotedUnknown).toBeGreaterThanOrEqual(1);
    expect(report.failedSafe).toBeGreaterThanOrEqual(1);
    expect(report.purgedAudit).toBeGreaterThanOrEqual(1);

    const p = await env.DB.prepare("SELECT state, payload_json, summary FROM pending_actions WHERE id = 'pa_old'").first<{ state: string; payload_json: string | null; summary: string }>();
    expect(p).toEqual({ state: "expired", payload_json: null, summary: "redacted" });
    const states = await env.DB.prepare("SELECT id, state FROM operations WHERE id IN ('op_exec','op_claim','op_fresh')").all<{ id: string; state: string }>();
    const byId = Object.fromEntries(states.results.map((r) => [r.id, r.state]));
    expect(byId).toEqual({ op_exec: "delivery_unknown", op_claim: "failed_safe", op_fresh: "executing" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npx vitest run test/cron.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement audit**

`worker/src/audit/log.ts`:
```ts
type Base = {
  userId: string; accountId: string | null; tool: string; action: string; modifiers: string[];
  decision: string; pendingId?: string; operationId?: string; summary: string; clientHint?: string;
};

export function redactSummary(s: { recipientCount?: number; attachmentCount?: number; ids?: string[] }): string {
  const parts: string[] = [];
  if (s.recipientCount !== undefined) parts.push(`recipients=${s.recipientCount}`);
  if (s.attachmentCount !== undefined) parts.push(`attachments=${s.attachmentCount}`);
  if (s.ids && s.ids.length > 0) parts.push(`ids=${s.ids.slice(0, 10).join(",")}`);
  return parts.join(" ");
}

async function write(db: D1Database, phase: "intent" | "outcome", b: Base & { gmailResultId?: string }): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO audit_log (ts, user_id, account_id, tool, action, modifiers, phase, decision, pending_id, operation_id, gmail_result_id, summary, client_hint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(Date.now(), b.userId, b.accountId, b.tool, b.action, JSON.stringify(b.modifiers), phase, b.decision,
      b.pendingId ?? null, b.operationId ?? null, b.gmailResultId ?? null, b.summary, b.clientHint ?? null)
    .run();
  return Number(res.meta.last_row_id ?? 0);
}

export const auditIntent = (db: D1Database, b: Base) => write(db, "intent", b);
export const auditOutcome = (db: D1Database, b: Base & { gmailResultId?: string }) => write(db, "outcome", b);
```

- [ ] **Step 4: Implement cron and wire it**

`worker/src/cron.ts`:
```ts
import type { Env } from "./env";
import { purgeExpired, release } from "./staging/store";

export type CronReport = { expiredPending: number; promotedUnknown: number; failedSafe: number; purgedStaging: number; purgedAudit: number };

const STALE_MS = 2 * 60_000;
const AUDIT_RETENTION_MS = 90 * 86_400_000;

export async function runCron(env: Env, now: number): Promise<CronReport> {
  const expired = await env.DB
    .prepare(`UPDATE pending_actions SET state = 'expired', payload_json = NULL, summary = 'redacted'
              WHERE state IN ('pending','approved') AND expires_at <= ?`)
    .bind(now).run();

  const promoted = await env.DB
    .prepare(`UPDATE operations SET state = 'delivery_unknown', updated_at = ? WHERE state = 'executing' AND updated_at <= ?`)
    .bind(now, now - STALE_MS).run();

  const staleClaimed = await env.DB
    .prepare(`SELECT id FROM operations WHERE state = 'claimed' AND updated_at <= ?`)
    .bind(now - STALE_MS).all<{ id: string }>();
  for (const r of staleClaimed.results) {
    await env.DB.prepare(`UPDATE operations SET state = 'failed_safe', updated_at = ? WHERE id = ? AND state = 'claimed'`).bind(now, r.id).run();
    await release(env.DB, r.id);
    await env.DB.prepare(`UPDATE pending_actions SET state = 'failed', payload_json = NULL, summary = 'redacted', error = 'failed_safe' WHERE operation_id = ? AND state = 'executing'`).bind(r.id).run();
  }

  const staging = await purgeExpired(env, now);
  const audit = await env.DB.prepare(`DELETE FROM audit_log WHERE ts <= ?`).bind(now - AUDIT_RETENTION_MS).run();

  return {
    expiredPending: expired.meta.changes ?? 0,
    promotedUnknown: promoted.meta.changes ?? 0,
    failedSafe: staleClaimed.results.length,
    purgedStaging: staging.deleted,
    purgedAudit: audit.meta.changes ?? 0,
  };
}
```

Modify `worker/src/index.ts` so `scheduled` calls it:
```ts
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
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd worker && npx vitest run test/cron.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add worker/src/audit worker/src/cron.ts worker/src/index.ts worker/test/cron.test.ts
git commit -m "feat(worker): audit rows and 5-minute cron for expiry, promotion, purge

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Dev-only MCP endpoint with the first control tools

**Files:**
- Create: `worker/src/mcp/server.ts`, `worker/src/mcp/auth-dev.ts`, `worker/test/mcp.test.ts`
- Modify: `worker/src/index.ts`

**Interfaces:**
- Consumes: `getPending`, `cancelPending`, `effectiveLevel`, `DEFAULT_POLICY`, `ACTIONS`.
- Produces: `buildServer(env: Env, principal: Principal): McpServer` registering `get_policy`, `list_pending`, `cancel_pending`, `list_accounts`; `type Principal = { userId: string; scope: "mcp" | "staging" }`; `authenticateDev(request, env): Principal | null`; `POST /mcp` returns 401 without a valid bearer. Plan 2 replaces `authenticateDev` with the OAuth provider and keeps `buildServer` unchanged.

- [ ] **Step 1: Write the failing test**

`worker/test/mcp.test.ts`:
```ts
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import worker from "../src/index";
import { seedUserAndAccount } from "./fixtures";
import { buildServer } from "../src/mcp/server";

const devEnv = { ...env, DEV_STATIC_TOKEN: "dev-token", DEV_STATIC_USER: "mu" } as any;

beforeAll(async () => {
  await seedUserAndAccount(env.DB, { userId: "mu", accountId: "ma", alias: "personal", isDefault: true });
});

describe("/mcp auth gate", () => {
  it("returns 401 without a bearer and 401 with a wrong bearer", async () => {
    const ctx = createExecutionContext();
    const r1 = await worker.fetch(new Request("https://x.test/mcp", { method: "POST", body: "{}" }), devEnv, ctx);
    const r2 = await worker.fetch(new Request("https://x.test/mcp", { method: "POST", body: "{}", headers: { authorization: "Bearer nope" } }), devEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
    expect(r1.headers.get("www-authenticate")).toMatch(/Bearer/);
  });
  it("refuses the dev bearer entirely when DEV_STATIC_TOKEN is unset", async () => {
    const ctx = createExecutionContext();
    const r = await worker.fetch(new Request("https://x.test/mcp", { method: "POST", body: "{}", headers: { authorization: "Bearer dev-token" } }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(r.status).toBe(401);
  });
  it("does not return 401 with the dev bearer set", async () => {
    const ctx = createExecutionContext();
    const r = await worker.fetch(new Request("https://x.test/mcp", { method: "POST", body: "{}", headers: { authorization: "Bearer dev-token", "content-type": "application/json" } }), devEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(r.status).not.toBe(401);
  });
});

describe("buildServer tools", () => {
  it("registers the four control tools", () => {
    const server = buildServer(devEnv, { userId: "mu", scope: "mcp" });
    const names = Object.keys((server as any)._registeredTools ?? {});
    for (const n of ["get_policy", "list_pending", "cancel_pending", "list_accounts"]) expect(names).toContain(n);
  });
});
```

If `_registeredTools` is not how the SDK 2.0.0 `McpServer` stores tools, open `node_modules/@modelcontextprotocol/server` and use the public accessor it provides (search for `registerTool` in the built file); update the test to that accessor and keep it in a helper `listToolNames(server)` in `worker/src/mcp/server.ts`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npx vitest run test/mcp.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement dev auth**

`worker/src/mcp/auth-dev.ts`:
```ts
import type { Env } from "../env";

export type Principal = { userId: string; scope: "mcp" | "staging" };

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Dev only. Active solely when DEV_STATIC_TOKEN is set; Plan 2 replaces this with OAuth. */
export function authenticateDev(request: Request, env: Env & { DEV_STATIC_USER?: string }): Principal | null {
  if (!env.DEV_STATIC_TOKEN) return null;
  const h = request.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  if (!constantTimeEqual(m[1]!, env.DEV_STATIC_TOKEN)) return null;
  return { userId: env.DEV_STATIC_USER ?? "dev-user", scope: "mcp" };
}
```

- [ ] **Step 4: Implement the server factory**

`worker/src/mcp/server.ts`:
```ts
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ACTIONS, DEFAULT_POLICY, type Action } from "@gmail-mcp/shared/actions";
import type { Env } from "../env";
import type { Principal } from "./auth-dev";
import { effectiveLevel } from "../policy/engine";
import { cancelPending } from "../approval/pending";

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

async function resolveAccount(env: Env, userId: string, alias?: string): Promise<{ id: string; alias: string }> {
  const row = alias
    ? await env.DB.prepare("SELECT id, alias FROM accounts WHERE user_id = ? AND alias = ?").bind(userId, alias).first<{ id: string; alias: string }>()
    : await env.DB.prepare("SELECT id, alias FROM accounts WHERE user_id = ? AND is_default = 1").bind(userId).first<{ id: string; alias: string }>();
  if (!row) throw new Error(alias ? `account_not_found: ${alias}` : "account_not_found: no default account");
  return row;
}

export function buildServer(env: Env, principal: Principal): McpServer {
  const server = new McpServer({ name: "gmail-mcp", version: "0.0.1" });

  server.registerTool(
    "list_accounts",
    { description: "List connected Gmail accounts: alias, email, status, default flag. Never returns tokens.",
      inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () => {
      const rows = await env.DB
        .prepare("SELECT alias, google_email AS email, status, is_default AS is_default, scopes FROM accounts WHERE user_id = ? ORDER BY alias")
        .bind(principal.userId).all();
      return text({ accounts: rows.results });
    },
  );

  server.registerTool(
    "get_policy",
    { description: "Effective allow/ask/deny policy for an account after overrides.",
      inputSchema: z.object({ account: z.string().optional() }), annotations: { readOnlyHint: true } },
    async ({ account }) => {
      const acc = await resolveAccount(env, principal.userId, account);
      const out: Record<string, string> = {};
      for (const a of ACTIONS) {
        out[a] = DEFAULT_POLICY[a] === "browser" ? "browser" : await effectiveLevel(env.DB, principal.userId, acc.id, a as Action);
      }
      return text({ account: acc.alias, policy: out });
    },
  );

  server.registerTool(
    "list_pending",
    { description: "List pending approvals for the caller.",
      inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () => {
      const rows = await env.DB
        .prepare(`SELECT p.id, a.alias AS account, p.action, p.modifiers, p.summary, p.state, p.expires_at
                  FROM pending_actions p JOIN accounts a ON a.id = p.account_id
                  WHERE p.user_id = ? AND p.state IN ('pending','approved') ORDER BY p.created_at DESC LIMIT 50`)
        .bind(principal.userId).all();
      return text({ pending: rows.results });
    },
  );

  server.registerTool(
    "cancel_pending",
    { description: "Cancel a pending approval you created.",
      inputSchema: z.object({ action_id: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false } },
    async ({ action_id }) => {
      const ok = await cancelPending(env.DB, { id: action_id, userId: principal.userId });
      return text({ cancelled: ok });
    },
  );

  return server;
}

export function listToolNames(server: McpServer): string[] {
  const reg = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools;
  return reg ? Object.keys(reg) : [];
}
```

If the installed SDK's `registerTool` expects a raw zod shape (`{ account: z.string().optional() }`) instead of `z.object(...)`, follow the type error: the Cloudflare handler API page shows the raw-shape form. Use one form consistently.

- [ ] **Step 5: Wire `/mcp`**

Replace `worker/src/index.ts`:
```ts
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
      const handler = createMcpHandler(() => buildServer(env, principal));
      return handler(request, env, ctx);
    }
    return new Response("not found", { status: 404 });
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env, Date.now()));
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd worker && npx vitest run test/mcp.test.ts`
Expected: PASS (4 tests). If `createMcpHandler`'s returned function has a different call shape in the installed `agents` version (for example it wants `(request, env, ctx)` bound differently), read `node_modules/agents/dist/mcp/server.d.ts` and adapt the two lines in `index.ts`.

- [ ] **Step 7: Manual check with MCP Inspector**

Create `worker/.dev.vars` (git-ignored):
```
DEV_STATIC_TOKEN=dev-token
DEV_STATIC_USER=mu
TOKEN_KEKS={"k1":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="}
TOKEN_KEK_CURRENT=k1
STATE_HMAC_KEY=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=
CSRF_HMAC_KEY=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=
```
Run:
```bash
cd worker && npm run migrate:local && npx wrangler d1 execute gmail-mcp --local --command "INSERT INTO users (id,email,created_at) VALUES ('mu','mu@example.test',0); INSERT INTO accounts (id,user_id,alias,google_sub,google_email,scopes,status,is_default,created_at) VALUES ('ma','mu','personal','s','p@example.test','gmail.modify','active',1,0);"
```
Then in one terminal `npm run dev`, and in another:
```bash
npx @modelcontextprotocol/inspector --cli http://localhost:8787/mcp --transport http --header "Authorization: Bearer dev-token" --method tools/list
```
Expected: the four tool names in the output. Then:
```bash
npx @modelcontextprotocol/inspector --cli http://localhost:8787/mcp --transport http --header "Authorization: Bearer dev-token" --method tools/call --tool-name get_policy
```
Expected: JSON with `send.message: "ask"` and `policy.edit: "browser"`.

- [ ] **Step 8: Run the whole suite and typecheck**

```bash
npm run typecheck && npm test
```
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add worker/src worker/test
git commit -m "feat(worker): dev-gated /mcp endpoint with control tools

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Plan self-review

**Spec coverage for this plan's scope**

| Spec item | Task |
|---|---|
| 2.1 actions and defaults | 2 |
| 2.2 modifiers raise only, `+external`, `+bulk` | 2, 6, 8 |
| 2.7 caps, blocked set | 7, 9 (payload cap), 10 (file cap) |
| 2.8 recipient trust rules | 6 |
| 3.1 identity root | 12 (principal from auth, never from args) |
| 3.2 schema, FKs, partial indexes, `_assert` | 3 |
| 3.3 keyring, AAD framing | 4 |
| 3.4 JCS, state machine, atomic claim, terminal purge | 5, 9, 11 |
| 3.5 journal rows and idempotency acquire | 9 (execution itself is Plan 3) |
| 3.7 handles, hold, reservation, ack, purge | 9, 10, 11 |
| 3.10 audit intent/outcome, redaction | 11 |
| cron | 11 |

Not in this plan by design: 2.3 Gmail tools, 3.5 send pipeline, 3.6 upload intent endpoint, 3.8 MIME, 3.9 Google error handling, all of section 4, the companion. Each has a named follow-up plan in the header.

**Placeholder scan:** none. Every step has code or an exact command.

**Type consistency:** `Principal` defined in Task 12 `auth-dev.ts` and consumed by `server.ts`; `PendingRow`, `claimPending`, `acquire`, `transition` names match between Task 9 implementation and test; `StagingRow`, `ingest`, `openForRead`, `ack`, `extendExpiry`, `consume`, `release`, `purgeExpired` match between Task 10 and Task 11's cron; `effectiveLevel`, `decide`, `setPolicy` match Task 8 and Task 12.

**Measured on 2026-09-09 from the npm registry:** every pinned version in Task 1; `agents` 0.22.0 exports `./mcp/server` and peers on `@modelcontextprotocol/server` 2.0.0 and zod ^4; `@cloudflare/vitest-plugin` 1.1.6 peers on vitest ^4.1.0.

**Still to verify on first install:** the `?raw` SQL import under the plugin's bundler, the plugin's ambient types for `cloudflare:test`, the SDK's `registerTool` schema form (raw shape vs `z.object`), the `createMcpHandler` call shape, and whether R2's local emulation enforces known-length streams the same way production does. Each task names the fallback to apply if the installed version differs.

**Not wired in this plan, by design:** `extendExpiry` (the pending-creation hold, spec 3.7) and `finishPending` are exported but only called from the tool layer in Plan 3. `JOURNALED_ACTIONS` is consumed in Plan 3.
