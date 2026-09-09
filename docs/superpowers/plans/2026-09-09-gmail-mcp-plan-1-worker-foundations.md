# Gmail MCP Plan 1: Worker Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and test the Worker's authority core (schema, crypto, canonical hashing, recipient trust, policy engine, pending/operations claim, staging, audit, cron) and expose it through a dev-only MCP endpoint, with no Gmail or OAuth yet.

**Architecture:** A Cloudflare Worker (`worker/`) with D1, R2 and KV bindings, sharing action names and schemas with a `shared/` package. Every module is a pure function or a small class over the `Env` bindings. Worker code is tested inside the Workers runtime with `@cloudflare/vitest-plugin`; the `shared` package is plain TypeScript tested under Node. The MCP handler in the last task uses `createMcpHandler` from `agents/mcp/server` behind a static dev bearer that exists only when both `DEV_STATIC_TOKEN` and `DEV_STATIC_USER` are set; Plan 2 deletes that code path when OAuth lands.

**Tech Stack:** TypeScript 5.9, npm workspaces, wrangler 4.130, `agents` 0.22, `@modelcontextprotocol/server` 2.0.0, zod 4.5, vitest 4.1 + `@cloudflare/vitest-plugin` 1.1, D1 (SQLite), R2, KV.

**Spec:** `docs/superpowers/specs/2026-09-09-gmail-mcp-design.md` (revision 3). Sections implemented here: 2.1, 2.2, 2.7, 2.8, 3.1–3.4, 3.7 (server side), 3.10, and the cron in 3.7.

**Plan series:**
1. Worker foundations (this plan)
2. OAuth and identity: `workers-oauth-provider`, Google OIDC login, Flow A, Flow B, Flow C client, web sessions, CSRF, pages (spec 4.1–4.6). Acceptance criterion carried from this plan: the `DEV_STATIC_TOKEN` code path is deleted, not left dormant.
3. Gmail tools and send pipeline: the 38 tools, MIME streaming, operations execution, reconciliation, error handling (spec 2.3, 3.5, 3.8, 3.9)
4. Companion: stdio MCP, Keychain, `/staging/intent` client, elicitation both wire forms (spec 2.4, 3.6, 4.5)
5. Protected Gmail suite, fault injection, end-to-end (spec 4.7)

## Global Constraints

- Every write tool requires an explicit `account`; reads fall back to the default account (spec 1.3).
- Policy values are exactly `allow | ask | deny`; modifiers only raise a level (spec 2.2).
- `user_id` is never read from tool arguments (spec 3.1).
- All child tables carry `(user_id, account_id)` foreign keys to `accounts(user_id, id)`; references to operations carry `(user_id, account_id, operation_id)` (spec 3.2).
- Global policy rows use `account_id IS NULL` and are unique via partial index (spec 3.2).
- AAD framing: `"gmail-mcp:v1" \0 user_id \0 account_id \0 field_name` (spec 3.3).
- Canonical JSON is RFC 8785 JCS over I-JSON input; `payload_hash = sha256(UTF-8 bytes of the stored payload_json)` (spec 3.4).
- The claim is one D1 `batch()` with `_assert` rows forcing rollback on failed preconditions; the attachment handles reserved are extracted from the approved server-held payload, never from the caller (spec 3.4).
- An idempotency key is bound to `(action, payload_hash)`; reuse with a different pair is `idempotency_conflict` (spec 3.5).
- Staging handles are `sh_` + 32 random bytes base64url (43 chars); download TTL 30 min; pending TTL 15 min; cron every 5 min (spec 3.7).
- Argument caps: subject 998 bytes, body 512 KB, recipients 500 raw, canonical payload 1 MB, staged file 25 MB (spec 2.7).
- Tokens, bodies and subjects never appear in audit rows. The audit module builds its own stored summary from structured facts; callers cannot pass free text (spec 3.10).
- Dependencies pinned to exact versions, `package-lock.json` committed, CI installs with `npm ci`. If `npm install` reports a conflict, stop, record it in the task's commit message, revise the dependency set deliberately, and rerun; never pin "whatever is current" mid-task.
- Every task is RED then GREEN: write the test, run it and read the failure, then implement.
- Commit after every green step with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

**Measured on 2026-09-09 (npm registry and unpacked packages):** typescript 5.9.3, zod 4.5.4, vitest 4.1.11 (the plugin peers on ^4.1.0; vitest 5 exists and is not used), wrangler 4.130.0 (published 2026-09-08), agents 0.22.0 (exports `./mcp/server`, peers on `@modelcontextprotocol/server` 2.0.0 and zod ^4), `@modelcontextprotocol/server` 2.0.0, `@cloudflare/vitest-plugin` 1.1.6 (exports `./types`; its `cloudflare:test` module exports `env: Cloudflare.Env`, `SELF`, `createExecutionContext`, `waitOnExecutionContext`, `applyD1Migrations(db, migrations)`; its package root exports `cloudflareTest` and `readD1Migrations(path)`; `cloudflareTest` accepts `miniflare.bindings`), `@types/node` 24.13.3.

---

## File structure

```
gmail/
  package.json                     npm workspaces root
  package-lock.json
  tsconfig.base.json
  shared/
    package.json  tsconfig.json  vitest.config.ts
    src/actions.ts                 Action, Modifier, Level, DEFAULT_POLICY, JOURNALED_ACTIONS
    src/errors.ts                  GmailMcpError, ErrorCode
    src/schemas.ts                 zod: AccountAlias, StagingHandle, Sha256Hex, StagingHandleResponse, PendingApprovalResult, UploadIntent
    test/actions.test.ts
  worker/
    package.json  tsconfig.json  wrangler.jsonc  vitest.config.ts
    worker-configuration.d.ts      generated by `wrangler types`, committed
    migrations/0001_init.sql
    src/env.ts                     augments Cloudflare.Env with secrets; exports Env
    src/index.ts                   fetch + scheduled exports
    src/crypto/keyring.ts          AES-GCM encrypt/decrypt with key ids and AAD framing
    src/crypto/canonical.ts        strict JCS + sha256
    src/crypto/random.ts           ids and handles
    src/policy/recipients.ts       restricted address grammar, trust set, +external, +bulk
    src/policy/engine.ts           account ownership, effective level, modifiers
    src/policy/limits.ts           argument caps, blocked extensions, filename and header safety
    src/approval/pending.ts        create, approve, deny, cancel, finish
    src/approval/claim.ts          the atomic claim batch, handles from payload
    src/operations/journal.ts      atomic acquire, transition
    src/staging/store.ts           ingest, read, ack, hold, consume, release, purge
    src/audit/log.ts               structured intent/outcome rows
    src/cron.ts                    bounded, transactional recovery
    src/mcp/auth-dev.ts            dev bearer
    src/mcp/server.ts              McpServer factory and control tools
    test/setup.ts                  applies migrations per file
    test/fixtures.ts               seedUserAndAccount
    test/env.d.ts                  TEST_MIGRATIONS binding type
    test/mcp-client.ts             minimal JSON-RPC helper for protocol-level tests
    test/*.test.ts
```

---

### Task 1: Workspace and Worker scaffold with a smoke test

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `shared/package.json`, `shared/tsconfig.json`, `shared/vitest.config.ts`, `worker/package.json`, `worker/tsconfig.json`, `worker/wrangler.jsonc`, `worker/vitest.config.ts`, `worker/src/env.ts`, `worker/src/index.ts`, `worker/test/setup.ts`, `worker/test/env.d.ts`, `worker/test/smoke.test.ts`, `worker/migrations/.gitkeep`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `Env` (= `Cloudflare.Env` augmented) with bindings `DB: D1Database`, `STAGING: R2Bucket`, `OAUTH_KV: KVNamespace`, var `WORKER_HOSTNAME`, secrets `TOKEN_KEKS`, `TOKEN_KEK_CURRENT`, `STATE_HMAC_KEY`, `CSRF_HMAC_KEY`, optional `DEV_STATIC_TOKEN`, `DEV_STATIC_USER`. Default export with `fetch` and `scheduled`.

- [x] **Step 1 (RED): write the smoke test first**

`worker/test/smoke.test.ts`:
```ts
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
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

- [x] **Step 2: root and shared package files**

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
  "devDependencies": { "typescript": "5.9.3" }
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

`shared/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
```

- [x] **Step 3: worker package files**

`worker/package.json`:
```json
{
  "name": "@gmail-mcp/worker",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "types": "wrangler types",
    "dev": "wrangler dev",
    "test": "npm run types && vitest run",
    "typecheck": "npm run types && tsc --noEmit",
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
    "@types/node": "24.13.3",
    "vitest": "4.1.11",
    "wrangler": "4.130.0"
  }
}
```

`worker/tsconfig.json`:
```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "types": ["./worker-configuration.d.ts", "@cloudflare/vitest-plugin/types", "node"] },
  "include": ["src", "test", "worker-configuration.d.ts"]
}
```

`worker/wrangler.jsonc`:
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "gmail-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "vars": { "WORKER_HOSTNAME": "gmail-mcp.example.workers.dev" },
  "d1_databases": [{ "binding": "DB", "database_name": "gmail-mcp", "database_id": "local-dev", "migrations_dir": "migrations" }],
  "r2_buckets": [{ "binding": "STAGING", "bucket_name": "gmail-mcp-staging" }],
  "kv_namespaces": [{ "binding": "OAUTH_KV", "id": "local-dev" }],
  "triggers": { "crons": ["*/5 * * * *"] },
  "observability": { "enabled": true }
}
```

`worker/vitest.config.ts` (migrations are read on the Node side and handed to the Worker as a binding, exactly as the plugin's `applyD1Migrations` docs describe):
```ts
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"], include: ["test/**/*.test.ts"] },
  };
});
```

`worker/test/env.d.ts`:
```ts
import type { D1Migration } from "cloudflare:test";
declare global {
  namespace Cloudflare {
    interface Env { TEST_MIGRATIONS: D1Migration[] }
  }
}
export {};
```

`worker/test/setup.ts`:
```ts
import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
```

`worker/src/env.ts` (the generated `worker-configuration.d.ts` declares bindings and vars from `wrangler.jsonc`; secrets are declared here by interface merging so there is one `Env` for code and tests):
```ts
declare global {
  namespace Cloudflare {
    interface Env {
      TOKEN_KEKS: string;          // JSON { key_id: base64 32 bytes }
      TOKEN_KEK_CURRENT: string;   // key_id
      STATE_HMAC_KEY: string;      // base64 32 bytes
      CSRF_HMAC_KEY: string;       // base64 32 bytes
      DEV_STATIC_TOKEN?: string;   // dev only; Plan 2 deletes the code that reads it
      DEV_STATIC_USER?: string;    // dev only
    }
  }
}
export type Env = Cloudflare.Env;
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

Create an empty `worker/migrations/.gitkeep` so `readD1Migrations` finds the directory before Task 3 adds the first file.

- [x] **Step 4: install, generate types, run**

From the repo root:
```bash
npm install && git add package-lock.json
```
```bash
cd worker && npm run types && npx vitest run test/smoke.test.ts
```
Expected: both tests PASS. `wrangler types` writes `worker/worker-configuration.d.ts`; commit it. If `readD1Migrations` is not exported from the package root in the installed build, import it from `@cloudflare/vitest-plugin/config` instead (the docs name that subpath); this is the only fallback in the task.

- [x] **Step 5: commit**

```bash
git add -A
git commit -m "chore: workspace scaffold, generated Worker types, smoke test

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Shared actions, errors and strict schemas

**Files:**
- Create: `shared/src/actions.ts`, `shared/src/errors.ts`, `shared/src/schemas.ts`, `shared/test/actions.test.ts`

**Interfaces:**
- Produces: `ACTIONS`, `type Action`, `MODIFIERS`, `type Modifier`, `LEVELS`, `type Level`, `DEFAULT_POLICY`, `raise`, `JOURNALED_ACTIONS`; `GmailMcpError`, `ErrorCode`; zod `AccountAlias`, `StagingHandle`, `Sha256Hex`, `StagingHandleResponse`, `PendingApprovalResult`, `UploadIntent`.

- [x] **Step 1 (RED): test**

`shared/test/actions.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { ACTIONS, DEFAULT_POLICY, MODIFIERS, raise } from "../src/actions";
import { AccountAlias, PendingApprovalResult, StagingHandle, StagingHandleResponse, Sha256Hex } from "../src/schemas";

const H = "sh_" + "A".repeat(43);

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

describe("strict schemas", () => {
  it("accepts only well-formed handles, hashes and aliases", () => {
    expect(StagingHandle.safeParse(H).success).toBe(true);
    expect(StagingHandle.safeParse("sh_abc").success).toBe(false);
    expect(Sha256Hex.safeParse("a".repeat(64)).success).toBe(true);
    expect(Sha256Hex.safeParse("A".repeat(64)).success).toBe(false);
    expect(AccountAlias.safeParse("uni-2026").success).toBe(true);
    expect(AccountAlias.safeParse("Uni").success).toBe(false);
    expect(AccountAlias.safeParse("a/b").success).toBe(false);
  });
  it("accepts a staging handle response and rejects a loose one", () => {
    const ok = StagingHandleResponse.safeParse({ handle: H, account: "personal", filename: "a.pdf", mime: "application/pdf", size: 10, sha256: "0".repeat(64), expires_at: "2026-09-09T00:00:00Z" });
    expect(ok.success).toBe(true);
    const bad = StagingHandleResponse.safeParse({ handle: H, account: "personal", filename: "a.pdf", mime: "application/pdf", size: 10, sha256: "0".repeat(64), expires_at: "tomorrow" });
    expect(bad.success).toBe(false);
  });
  it("pending result requires known action and modifier names", () => {
    const base = { status: "pending_approval", action_id: "pa_x", account: "personal", summary: "s", approval: { mode: "url", url: "https://x.test/approve/pa_x" }, expires_at: "2026-09-09T00:00:00Z" };
    expect(PendingApprovalResult.safeParse({ ...base, action: "send.message", modifiers: ["+external"] }).success).toBe(true);
    expect(PendingApprovalResult.safeParse({ ...base, action: "send.anything", modifiers: [] }).success).toBe(false);
    expect(PendingApprovalResult.safeParse({ ...base, action: "send.message", modifiers: ["+magic"] }).success).toBe(false);
  });
});
```

- [x] **Step 2: run, expect module-not-found failures**

Run: `cd shared && npx vitest run`

- [x] **Step 3 (GREEN): implement**

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
  "read.search": "allow", "read.message": "allow", "read.attachment": "allow",
  "draft.write": "allow",
  "send.message": "ask", "send.draft": "ask", "send.forward": "ask",
  "label.manage": "ask", "label.apply": "allow",
  "spam.mark": "ask", "spam.unmark": "allow",
  "trash.move": "ask", "trash.restore": "allow",
  "attachment.stage_upload": "ask",
  "fs.save": "allow",
  "account.read": "allow", "account.connect": "ask",
  "policy.read": "allow", "policy.edit": "browser",
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
  | "pending_replayed" | "payload_mismatch" | "delivery_unknown" | "idempotency_conflict"
  | "account_not_found" | "account_needs_reconnect" | "handle_invalid" | "handle_expired"
  | "handle_reserved" | "limit_exceeded" | "blocked_extension" | "invalid_address" | "invalid_header"
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
import { ACTIONS, MODIFIERS } from "./actions";

export const AccountAlias = z.string().regex(/^[a-z0-9_-]{1,32}$/);
export const StagingHandle = z.string().regex(/^sh_[A-Za-z0-9_-]{43}$/);
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const StagingHandleResponse = z.object({
  handle: StagingHandle,
  account: AccountAlias,
  filename: z.string().min(1).max(255),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: Sha256Hex,
  expires_at: z.iso.datetime(),
});
export type StagingHandleResponse = z.infer<typeof StagingHandleResponse>;

export const PendingApprovalResult = z.object({
  status: z.literal("pending_approval"),
  action_id: z.string().regex(/^pa_[A-Za-z0-9_-]{22}$/),
  action: z.enum(ACTIONS),
  modifiers: z.array(z.enum(MODIFIERS)),
  account: AccountAlias,
  summary: z.string(),
  approval: z.object({ mode: z.literal("url"), url: z.url() }),
  expires_at: z.iso.datetime(),
});
export type PendingApprovalResult = z.infer<typeof PendingApprovalResult>;

export const UploadIntent = z.object({
  account: AccountAlias,
  filename: z.string().min(1).max(255),
  size: z.number().int().positive().max(25 * 1024 * 1024),
  mime: z.string().min(1),
  sha256: Sha256Hex,
  pending_id: z.string().regex(/^pa_[A-Za-z0-9_-]{22}$/).optional(),
});
export type UploadIntent = z.infer<typeof UploadIntent>;
```

- [x] **Step 4: run, expect PASS (7 tests)**

Run: `cd shared && npx vitest run`

- [x] **Step 5: commit**

```bash
git add shared
git commit -m "feat(shared): action taxonomy, defaults, error codes, strict contracts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: D1 schema with ownership invariants

**Files:**
- Create: `worker/test/fixtures.ts`, `worker/test/schema.test.ts`, `worker/migrations/0001_init.sql`

**Interfaces:**
- Produces: the tables in spec 3.2 plus `execution_started_at` on `pending_actions`; `seedUserAndAccount(db, {userId, accountId, alias, isDefault?, orgDomains?, sendAs?})`.

- [x] **Step 1 (RED): fixtures and tests before the migration exists**

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

export async function insertOperation(db: D1Database, id: string, userId: string, accountId: string, state: string, updatedAt = Date.now()): Promise<void> {
  await db.prepare(
    `INSERT INTO operations (id, user_id, account_id, action, state, payload_hash, created_at, updated_at) VALUES (?, ?, ?, 'send.message', ?, 'h', ?, ?)`,
  ).bind(id, userId, accountId, state, updatedAt, updatedAt).run();
}
```

`worker/test/schema.test.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { seedUserAndAccount, insertOperation } from "./fixtures";

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

  it("allows only one default account per user and only 0/1 as the flag", async () => {
    await seedUserAndAccount(env.DB, { userId: "u3", accountId: "a5", alias: "one", isDefault: true });
    await expect(seedUserAndAccount(env.DB, { userId: "u3", accountId: "a6", alias: "two", isDefault: true })).rejects.toThrow(/UNIQUE/);
    await expect(env.DB.prepare("UPDATE accounts SET is_default = 2 WHERE id = 'a5'").run()).rejects.toThrow(/CHECK/);
  });

  it("rejects a pending action whose account belongs to another user", async () => {
    await seedUserAndAccount(env.DB, { userId: "u4", accountId: "a7", alias: "x" });
    await seedUserAndAccount(env.DB, { userId: "u5", accountId: "a8", alias: "y" });
    await expect(env.DB.prepare(
      `INSERT INTO pending_actions (id, user_id, account_id, action, modifiers, payload_hash, summary, state, created_at, expires_at)
       VALUES ('p1', 'u4', 'a8', 'send.message', '[]', 'h', 's', 'pending', 1, 2)`).run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("rejects a staging reservation or pending link to an operation of a different account", async () => {
    await seedUserAndAccount(env.DB, { userId: "u6", accountId: "a9", alias: "p" });
    await seedUserAndAccount(env.DB, { userId: "u6", accountId: "a10", alias: "q" });
    await insertOperation(env.DB, "op_a9", "u6", "a9", "claimed");
    await env.DB.prepare(
      `INSERT INTO staging_objects (handle, user_id, account_id, direction, r2_key, filename, mime, size, sha256, created_at, expires_at)
       VALUES ('sh_x', 'u6', 'a10', 'upload', 'k', 'f', 'm', 1, 'h', 1, 9999999999999)`).run();
    await expect(env.DB.prepare("UPDATE staging_objects SET reserved_by_operation_id = 'op_a9' WHERE handle = 'sh_x'").run()).rejects.toThrow(/FOREIGN KEY/);
    await expect(env.DB.prepare(
      `INSERT INTO pending_actions (id, user_id, account_id, action, modifiers, payload_hash, summary, state, operation_id, created_at, expires_at)
       VALUES ('p2', 'u6', 'a10', 'send.message', '[]', 'h', 's', 'executing', 'op_a9', 1, 2)`).run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("_assert rejects any non-zero row and accepts an empty insert", async () => {
    await expect(env.DB.prepare("INSERT INTO _assert (x) VALUES (1)").run()).rejects.toThrow(/CHECK/);
    await env.DB.prepare("INSERT INTO _assert (x) SELECT 1 WHERE 1 = 0").run();
  });

  it("bounds send_limit_bytes", async () => {
    await seedUserAndAccount(env.DB, { userId: "u7", accountId: "a11", alias: "s" });
    await expect(env.DB.prepare("UPDATE accounts SET send_limit_bytes = 0 WHERE id = 'a11'").run()).rejects.toThrow(/CHECK/);
    await expect(env.DB.prepare("UPDATE accounts SET send_limit_bytes = 999999999 WHERE id = 'a11'").run()).rejects.toThrow(/CHECK/);
  });
});
```

- [x] **Step 2: run, expect failures ("no such table")**

Run: `cd worker && npx vitest run test/schema.test.ts`

- [x] **Step 3 (GREEN): the migration**

`worker/migrations/0001_init.sql`:
```sql
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
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  send_limit_bytes INTEGER NOT NULL DEFAULT 26214400 CHECK (send_limit_bytes BETWEEN 1 AND 26214400),
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
  UNIQUE (user_id, account_id, id),
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
  operation_id TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  approved_at INTEGER, approved_via TEXT,
  execution_started_at INTEGER, executed_at INTEGER, error TEXT,
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id),
  FOREIGN KEY (user_id, account_id, operation_id) REFERENCES operations(user_id, account_id, id)
);

CREATE TABLE staging_objects (
  handle TEXT PRIMARY KEY,
  user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('download','upload')),
  r2_key TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL,
  size INTEGER NOT NULL, sha256 TEXT NOT NULL,
  source_message_id TEXT, source_attachment_id TEXT,
  reserved_by_operation_id TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER,
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id),
  FOREIGN KEY (user_id, account_id, reserved_by_operation_id) REFERENCES operations(user_id, account_id, id)
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

A composite foreign key with a NULL member (`operation_id IS NULL`) is not enforced by SQLite, which is exactly what allows unclaimed pending rows; once set, the triple must match a real operation of the same account.

- [x] **Step 4: run, expect PASS (7 tests)**

Run: `cd worker && npx vitest run test/schema.test.ts`. If the FOREIGN KEY tests pass without the migration having FK enforcement, D1 has it on by default; if they fail with "no such error", add `PRAGMA foreign_keys = ON;` as the first line of the migration and rerun.

- [x] **Step 5: commit**

```bash
git add worker/migrations worker/test
git commit -m "feat(worker): D1 schema with account-scoped operation references and bounded flags

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Keyring encryption with AAD framing

**Files:**
- Create: `worker/src/crypto/random.ts`, `worker/src/crypto/keyring.ts`, `worker/test/keyring.test.ts`

**Interfaces:**
- Produces: `Keyring.fromEnv(env)`, `keyring.encrypt(plain, aad) -> {ciphertext, keyId}`, `keyring.decrypt(ciphertext, keyId, aad) -> string`, `keyring.currentKeyId`, `type AadParts = { userId; accountId; field }`, `frameAad`, `randomId(prefix)` (16 bytes, 22 chars), `randomHandle()` (32 bytes, 43 chars), `b64url`, `fromB64url`.

- [x] **Step 1 (RED): test**

`worker/test/keyring.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { Keyring, frameAad } from "../src/crypto/keyring";
import { randomHandle, randomId } from "../src/crypto/random";

const k1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const k2 = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
const envLike = { TOKEN_KEKS: JSON.stringify({ k1, k2 }), TOKEN_KEK_CURRENT: "k2" };
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
    expect(await Keyring.fromEnv(envLike).decrypt(ciphertext, "k1", aad)).toBe("old");
  });
  it("fails on AAD mismatch, unknown key id, truncated ciphertext", async () => {
    const kr = Keyring.fromEnv(envLike);
    const { ciphertext, keyId } = await kr.encrypt("s", aad);
    await expect(kr.decrypt(ciphertext, keyId, { ...aad, accountId: "other" })).rejects.toThrow();
    await expect(kr.decrypt(ciphertext, "nope", aad)).rejects.toThrow(/unknown key/);
    await expect(kr.decrypt(ciphertext.slice(0, 20), keyId, aad)).rejects.toThrow();
  });
  it("frames AAD with NUL separators and a version prefix", () => {
    expect(new TextDecoder().decode(frameAad(aad))).toBe("gmail-mcp:v1\0u\0a\0refresh_token");
  });
  it("makes distinct ids and handles of the documented shape", () => {
    expect(randomId("op")).toMatch(/^op_[A-Za-z0-9_-]{22}$/);
    expect(randomHandle()).toMatch(/^sh_[A-Za-z0-9_-]{43}$/);
    expect(randomHandle()).not.toBe(randomHandle());
  });
});
```

- [x] **Step 2: run, expect failure**

Run: `cd worker && npx vitest run test/keyring.test.ts`

- [x] **Step 3 (GREEN): implement**

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
export function randomId(prefix: string): string {
  return `${prefix}_${b64url(randomBytes(16))}`;
}
export function randomHandle(): string {
  return `sh_${b64url(randomBytes(32))}`;
}
```

`worker/src/crypto/keyring.ts`:
```ts
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

  static fromEnv(env: { TOKEN_KEKS: string; TOKEN_KEK_CURRENT: string }): Keyring {
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
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: frameAad(aad) }, k, new TextEncoder().encode(plain)));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv, 0);
    out.set(ct, 12);
    return { ciphertext: out, keyId: this.currentKeyId };
  }

  async decrypt(ciphertext: Uint8Array, keyId: string, aad: AadParts): Promise<string> {
    if (ciphertext.length < 12 + 16) throw new Error("ciphertext too short");
    const k = await this.key(keyId);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ciphertext.slice(0, 12), additionalData: frameAad(aad) }, k, ciphertext.slice(12));
    return new TextDecoder().decode(plain);
  }
}
```

- [x] **Step 4: run, expect PASS (5 tests)**

- [x] **Step 5: commit**

```bash
git add worker/src/crypto worker/test/keyring.test.ts
git commit -m "feat(worker): AES-GCM keyring with framed AAD and per-ciphertext key ids

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Strict RFC 8785 canonical JSON and payload hashing

**Files:**
- Create: `worker/src/crypto/canonical.ts`, `worker/test/canonical.test.ts`

**Interfaces:**
- Produces: `canonicalize(value: unknown): string` (throws `TypeError` on `undefined` anywhere, functions, symbols, bigint, non-finite numbers, non-plain objects, lone surrogates), `sha256Hex(bytes): Promise<string>`, `hashCanonical(canonical: string): Promise<string>` (sha256 of the UTF-8 bytes of the exact string that gets stored).

- [x] **Step 1 (RED): test, including the RFC 8785 §3.2.3 example**

`worker/test/canonical.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { canonicalize, hashCanonical } from "../src/crypto/canonical";

describe("JCS canonicalize", () => {
  it("matches the RFC 8785 example", () => {
    const input = {
      numbers: [333333333.33333329, 1e30, 4.5, 0.002, 1e-27],
      string: "\u20ac$\u000f\u000aA'\u0042\u0022\u005c\\\"\u002f",
      literals: [null, true, false],
    };
    expect(canonicalize(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });
  it("sorts keys by UTF-16 code units", () => {
    expect(canonicalize({ b: 1, a: [true, null, "x"], "\u00e9": 0, "z": 0 })).toBe('{"a":[true,null,"x"],"b":1,"z":0,"é":0}');
  });
  it("rejects non I-JSON input instead of guessing", () => {
    expect(() => canonicalize({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalize([1, undefined])).toThrow(TypeError);
    expect(() => canonicalize({ f: () => 1 })).toThrow(TypeError);
    expect(() => canonicalize({ n: NaN })).toThrow(TypeError);
    expect(() => canonicalize({ d: new Date(0) })).toThrow(TypeError);
    expect(() => canonicalize({ s: "\ud800" })).toThrow(TypeError);
    expect(() => canonicalize({ b: 1n })).toThrow(TypeError);
  });
  it("hashes the exact stored string", async () => {
    const c1 = canonicalize({ to: ["a@x.test"], subject: "s" });
    const c2 = canonicalize({ subject: "s", to: ["a@x.test"] });
    expect(c1).toBe(c2);
    expect(await hashCanonical(c1)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashCanonical(c1)).toBe(await hashCanonical(c2));
  });
});
```

- [x] **Step 2: run, expect failure**

- [x] **Step 3 (GREEN): implement**

`worker/src/crypto/canonical.ts`:
```ts
/**
 * RFC 8785 JSON Canonicalization Scheme over I-JSON input.
 * Anything that is not a plain JSON value is a TypeError: callers canonicalise schema-validated data only.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("non-finite number");
      return JSON.stringify(value);
    case "string":
      if (!value.isWellFormed()) throw new TypeError("lone surrogate in string");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return "[" + value.map((v) => canonicalize(v)).join(",") + "]";
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new TypeError("non-plain object");
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return "{" + keys.map((k) => {
        if (!k.isWellFormed()) throw new TypeError("lone surrogate in key");
        return JSON.stringify(k) + ":" + canonicalize(obj[k]);
      }).join(",") + "}";
    }
    default:
      throw new TypeError(`cannot canonicalize ${typeof value}`);
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hashCanonical(canonical: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonical));
}
```

`String.prototype.isWellFormed` is ES2024 and present in workerd; the `target` is ES2023, so if `tsc` complains, add `"lib": ["ES2024"]` to `worker/tsconfig.json`.

- [x] **Step 4: run, expect PASS (4 tests)**

If the RFC example fails on the number `333333333.33333329`, print `JSON.stringify(333333333.33333329)`; the RFC expects `333333333.3333333`, which is ES number formatting, so a mismatch means a typo in the test string, not the implementation.

- [x] **Step 5: commit**

```bash
git add worker/src/crypto/canonical.ts worker/test/canonical.test.ts
git commit -m "feat(worker): strict RFC 8785 canonicalisation and stored-bytes hashing

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Recipient grammar and trust rules

**Files:**
- Create: `worker/src/policy/recipients.ts`, `worker/test/recipients.test.ts`

**Interfaces:**
- Produces: `parseAddress(raw): ParsedAddress` (restricted grammar, throws `invalid_address`), `type ParsedAddress = { local: string; domain: string; normalized: string }`, `type TrustContext = { selfAddresses: string[]; allowlist: string[]; orgDomains: string[] }`, `isTrusted(addr, ctx)`, `recipientModifiers(all: string[], ctx): Modifier[]`, `MAX_RECIPIENTS = 500`, `BULK_THRESHOLD = 10`.

Normalisation rules: domain lower-cased and converted to ASCII; local part kept case-exact except for Gmail and Googlemail, where it is lower-cased and the `+tag` removed. The grammar is deliberately restricted: no quoted local parts, no comments, no leading, trailing or consecutive dots, one address per string, display names allowed only in the `Name <addr>` form without commas. Plan 3 may swap in a full RFC 5322 parser; this module is a permission boundary and prefers false negatives.

- [x] **Step 1 (RED): test**

`worker/test/recipients.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseAddress, isTrusted, recipientModifiers } from "../src/policy/recipients";

const consumer = { selfAddresses: ["raouf@gmail.com"], allowlist: ["Friend@example.com", "@uni.edu.au"], orgDomains: [] };
const workspace = { selfAddresses: ["me@corp.example"], allowlist: [], orgDomains: ["corp.example"] };

describe("parseAddress", () => {
  it("parses bare and display-name forms, lower-casing only the domain", () => {
    expect(parseAddress("A B <A.b@Example.COM>").normalized).toBe("A.b@example.com");
    expect(parseAddress("x@y.test").domain).toBe("y.test");
  });
  it("normalises gmail local parts only", () => {
    expect(parseAddress("Raouf+news@gmail.com").normalized).toBe("raouf@gmail.com");
    expect(parseAddress("ra.ouf@gmail.com").normalized).toBe("ra.ouf@gmail.com");
    expect(parseAddress("Someone+tag@example.com").normalized).toBe("Someone+tag@example.com");
  });
  it("converts IDN domains to punycode", () => {
    expect(parseAddress("a@bücher.example").domain).toBe("xn--bcher-kva.example");
  });
  it("rejects malformed, control characters, dot abuse and multiple addresses", () => {
    for (const bad of ["nope", "a@b@c", "a@b.test\r\nBcc: x@y", "a@b.test, c@d.test", "<a@b.test", ".a@b.test", "a.@b.test", "a..b@b.test", "\"quoted\"@b.test", "a@b"]) {
      expect(() => parseAddress(bad), bad).toThrow(/invalid_address/);
    }
  });
});

describe("isTrusted", () => {
  it("consumer: self, allowlist entries, exact allowlisted domain", () => {
    expect(isTrusted(parseAddress("raouf@gmail.com"), consumer)).toBe(true);
    expect(isTrusted(parseAddress("someone@gmail.com"), consumer)).toBe(false);
    expect(isTrusted(parseAddress("Friend@example.com"), consumer)).toBe(true);
    expect(isTrusted(parseAddress("friend@example.com"), consumer)).toBe(false); // local part is case-exact outside gmail
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
  it("adds +bulk above 10 distinct recipients", () => {
    const many = Array.from({ length: 11 }, (_, i) => `p${i}@uni.edu.au`);
    expect(recipientModifiers(many, consumer)).toEqual(["+bulk"]);
    const dup = Array.from({ length: 11 }, () => "p@uni.edu.au");
    expect(recipientModifiers(dup, consumer)).toEqual([]);
  });
  it("rejects more than 500 raw recipients even when they repeat", () => {
    const tooMany = Array.from({ length: 501 }, () => "p@uni.edu.au");
    expect(() => recipientModifiers(tooMany, consumer)).toThrow(/limit_exceeded/);
  });
});
```

- [x] **Step 2: run, expect failure**

- [x] **Step 3 (GREEN): implement**

`worker/src/policy/recipients.ts`:
```ts
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Modifier } from "@gmail-mcp/shared/actions";

export type ParsedAddress = { local: string; domain: string; normalized: string };
export type TrustContext = { selfAddresses: string[]; allowlist: string[]; orgDomains: string[] };
export const MAX_RECIPIENTS = 500;
export const BULK_THRESHOLD = 10;

const LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN = /^[A-Za-z0-9\u00a1-\uffff-]+(?:\.[A-Za-z0-9\u00a1-\uffff-]+)+$/u;

function fail(raw: string): never {
  throw new GmailMcpError("invalid_address", `invalid_address: ${raw.slice(0, 64)}`);
}

export function toAsciiDomain(domain: string): string {
  if (!DOMAIN.test(domain)) fail(domain);
  try {
    const host = new URL(`http://${domain}/`).hostname;
    if (!host || host.includes("..")) fail(domain);
    return host.toLowerCase();
  } catch {
    fail(domain);
  }
}

export function parseAddress(raw: string): ParsedAddress {
  if (/[\r\n\0]/.test(raw) || raw.includes(",") || raw.includes('"')) fail(raw);
  let spec = raw.trim();
  const m = spec.match(/^[^<>]*<([^<>]+)>$/);
  if (m) spec = m[1]!.trim();
  else if (/[<>]/.test(spec)) fail(raw);
  const at = spec.lastIndexOf("@");
  if (at <= 0 || at === spec.length - 1 || spec.indexOf("@") !== at) fail(raw);
  const localRaw = spec.slice(0, at);
  const domainRaw = spec.slice(at + 1);
  if (!LOCAL.test(localRaw)) fail(raw);
  const domain = toAsciiDomain(domainRaw);
  const isGmail = domain === "gmail.com" || domain === "googlemail.com";
  const local = isGmail ? localRaw.split("+")[0]!.toLowerCase() : localRaw;
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
  if (all.length > MAX_RECIPIENTS) {
    throw new GmailMcpError("limit_exceeded", `limit_exceeded: recipients ${all.length} > ${MAX_RECIPIENTS}`);
  }
  const parsed = all.map(parseAddress);
  const distinct = new Set(parsed.map((p) => p.normalized));
  const mods: Modifier[] = [];
  if (parsed.some((p) => !isTrusted(p, ctx))) mods.push("+external");
  if (distinct.size > BULK_THRESHOLD) mods.push("+bulk");
  return mods;
}
```

- [x] **Step 4: run, expect PASS (9 tests)**

If the IDN case fails because the runtime's URL parser keeps Unicode, replace the `new URL` line with `toASCII(domain.toLowerCase())` from `node:punycode` under `nodejs_compat` and rerun.

- [x] **Step 5: commit**

```bash
git add worker/src/policy/recipients.ts worker/test/recipients.test.ts
git commit -m "feat(worker): restricted address grammar, trust rules, +external and +bulk

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Argument limits, blocked extensions, filename and header safety

**Files:**
- Create: `worker/src/policy/limits.ts`, `worker/test/limits.test.ts`

**Interfaces:**
- Produces: `LIMITS`, `BLOCKED_EXTENSIONS`, `assertNotBlocked(filename)`, `sanitizeFilename(name)` (UTF-8 byte-bounded to 255, never splits a scalar, keeps the extension), `assertHeaderSafe(field, value)` (throws `invalid_header`, and `limit_exceeded` for subject over 998 bytes), `utf8Length(s)`.

- [x] **Step 1 (RED): test**

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
  it("truncates by UTF-8 bytes without splitting a scalar and keeps the extension", () => {
    const emoji = "😀"; // 4 bytes
    const long = emoji.repeat(100) + ".pdf"; // 404 bytes
    const out = sanitizeFilename(long);
    expect(utf8Length(out)).toBeLessThanOrEqual(255);
    expect(out.endsWith(".pdf")).toBe(true);
    expect(out.isWellFormed()).toBe(true);
    expect(utf8Length(out)).toBe(4 * 62 + 4); // 62 emoji + ".pdf" = 252 bytes
  });
});

describe("headers and sizes", () => {
  it("rejects CR, LF, NUL in header values with invalid_header", () => {
    expect(() => assertHeaderSafe("subject", "hi\r\nBcc: x")).toThrow(/invalid_header/);
    expect(() => assertHeaderSafe("subject", "ok")).not.toThrow();
  });
  it("enforces subject byte cap", () => {
    expect(() => assertHeaderSafe("subject", "x".repeat(LIMITS.subjectBytes + 1))).toThrow(/limit_exceeded/);
    expect(utf8Length("é")).toBe(2);
  });
});
```

- [x] **Step 2: run, expect failure**

- [x] **Step 3 (GREEN): implement**

`worker/src/policy/limits.ts`:
```ts
import { GmailMcpError } from "@gmail-mcp/shared/errors";

export const LIMITS = {
  subjectBytes: 998,
  bodyBytes: 512 * 1024,
  inlineAttachmentBytes: 1024 * 1024,
  stagedFileBytes: 25 * 1024 * 1024,
  canonicalPayloadBytes: 1024 * 1024,
  filenameBytes: 255,
} as const;

/** Seeded from support.google.com/mail/answer/6590 on 2026-09-09. Applies to outbound uploads. */
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
  if (BLOCKED_EXTENSIONS.has(ext)) throw new GmailMcpError("blocked_extension", `blocked_extension: .${ext}`);
}

const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Cuts a string to at most `max` UTF-8 bytes on a scalar boundary. */
function truncateUtf8(s: string, max: number): string {
  let out = "";
  let bytes = 0;
  for (const ch of s) { // iterates by code point, never splits a surrogate pair
    const n = utf8Length(ch);
    if (bytes + n > max) break;
    out += ch;
    bytes += n;
  }
  return out;
}

export function sanitizeFilename(name: string): string {
  let base = name.split(/[\\/]/).pop() ?? "";
  base = base.normalize("NFC").replace(CONTROL_OR_BIDI, "_").trim();
  if (base === "" || /^\.+$/.test(base)) return "attachment";
  if (utf8Length(base) <= LIMITS.filenameBytes) return base;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 && base.length - dot <= 16 ? base.slice(dot) : "";
  const stem = dot > 0 && ext ? base.slice(0, dot) : base;
  const cut = truncateUtf8(stem, LIMITS.filenameBytes - utf8Length(ext));
  return (cut === "" ? "attachment" : cut) + ext;
}

export function assertHeaderSafe(field: string, value: string): void {
  if (/[\r\n\0]/.test(value)) throw new GmailMcpError("invalid_header", `invalid_header: ${field} contains control characters`);
  if (field === "subject" && utf8Length(value) > LIMITS.subjectBytes) {
    throw new GmailMcpError("limit_exceeded", `limit_exceeded: subject > ${LIMITS.subjectBytes} bytes`);
  }
}
```

- [x] **Step 4: run, expect PASS (8 tests)**

- [x] **Step 5: commit**

```bash
git add worker/src/policy/limits.ts worker/test/limits.test.ts
git commit -m "feat(worker): limits, blocked extension set, byte-safe filenames, header safety

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Policy engine with ownership check

**Files:**
- Create: `worker/src/policy/engine.ts`, `worker/test/engine.test.ts`

**Interfaces:**
- Produces: `assertAccount(db, userId, accountId): Promise<void>` throwing `account_not_found`, `effectiveLevel(db, userId, accountId, action): Promise<Level>`, `decide(db, {userId, accountId, action, modifiers}): Promise<Decision>`, `setPolicy(db, {userId, accountId: string | null, action, level})`.

Each test seeds its own user so ordering cannot matter.

- [x] **Step 1 (RED): test**

`worker/test/engine.test.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { seedUserAndAccount } from "./fixtures";
import { decide, effectiveLevel, setPolicy } from "../src/policy/engine";

describe("effectiveLevel", () => {
  it("falls back to spec defaults", async () => {
    await seedUserAndAccount(env.DB, { userId: "e1", accountId: "e1a", alias: "personal" });
    expect(await effectiveLevel(env.DB, "e1", "e1a", "send.message")).toBe("ask");
    expect(await effectiveLevel(env.DB, "e1", "e1a", "read.search")).toBe("allow");
  });
  it("global override beats default, account override beats global", async () => {
    await seedUserAndAccount(env.DB, { userId: "e2", accountId: "e2a", alias: "personal" });
    await seedUserAndAccount(env.DB, { userId: "e2", accountId: "e2b", alias: "uni" });
    await setPolicy(env.DB, { userId: "e2", accountId: null, action: "send.message", level: "allow" });
    expect(await effectiveLevel(env.DB, "e2", "e2a", "send.message")).toBe("allow");
    await setPolicy(env.DB, { userId: "e2", accountId: "e2b", action: "send.message", level: "deny" });
    expect(await effectiveLevel(env.DB, "e2", "e2b", "send.message")).toBe("deny");
    expect(await effectiveLevel(env.DB, "e2", "e2a", "send.message")).toBe("allow");
  });
  it("refuses browser-only actions", async () => {
    await seedUserAndAccount(env.DB, { userId: "e3", accountId: "e3a", alias: "p" });
    await expect(effectiveLevel(env.DB, "e3", "e3a", "policy.edit")).rejects.toThrow(/browser/);
  });
  it("refuses unknown and foreign accounts before evaluating policy", async () => {
    await seedUserAndAccount(env.DB, { userId: "e4", accountId: "e4a", alias: "p" });
    await seedUserAndAccount(env.DB, { userId: "e5", accountId: "e5a", alias: "p" });
    await expect(effectiveLevel(env.DB, "e4", "nope", "read.search")).rejects.toThrow(/account_not_found/);
    await expect(effectiveLevel(env.DB, "e4", "e5a", "read.search")).rejects.toThrow(/account_not_found/);
  });
  it("setPolicy upserts instead of duplicating", async () => {
    await seedUserAndAccount(env.DB, { userId: "e6", accountId: "e6a", alias: "p" });
    await setPolicy(env.DB, { userId: "e6", accountId: null, action: "trash.move", level: "allow" });
    await setPolicy(env.DB, { userId: "e6", accountId: null, action: "trash.move", level: "deny" });
    expect(await effectiveLevel(env.DB, "e6", "e6a", "trash.move")).toBe("deny");
  });
});

describe("decide with modifiers", () => {
  it("raises allow to ask, leaves ask and deny", async () => {
    await seedUserAndAccount(env.DB, { userId: "e7", accountId: "e7a", alias: "p" });
    await seedUserAndAccount(env.DB, { userId: "e7", accountId: "e7b", alias: "q" });
    await setPolicy(env.DB, { userId: "e7", accountId: "e7a", action: "send.message", level: "allow" });
    await setPolicy(env.DB, { userId: "e7", accountId: "e7b", action: "send.message", level: "deny" });
    expect(await decide(env.DB, { userId: "e7", accountId: "e7a", action: "send.message", modifiers: ["+external"] })).toEqual({ base: "allow", level: "ask", modifiers: ["+external"] });
    expect((await decide(env.DB, { userId: "e7", accountId: "e7b", action: "send.message", modifiers: ["+attachment"] })).level).toBe("deny");
    expect((await decide(env.DB, { userId: "e7", accountId: "e7a", action: "label.apply", modifiers: [] })).level).toBe("allow");
  });
});
```

- [x] **Step 2: run, expect failure**

- [x] **Step 3 (GREEN): implement**

`worker/src/policy/engine.ts`:
```ts
import { DEFAULT_POLICY, raise, type Action, type Level, type Modifier } from "@gmail-mcp/shared/actions";
import { GmailMcpError } from "@gmail-mcp/shared/errors";

export type Decision = { level: Level; base: Level; modifiers: Modifier[] };

export async function assertAccount(db: D1Database, userId: string, accountId: string): Promise<void> {
  const row = await db.prepare("SELECT id FROM accounts WHERE id = ? AND user_id = ?").bind(accountId, userId).first<{ id: string }>();
  if (!row) throw new GmailMcpError("account_not_found", "account_not_found");
}

export async function effectiveLevel(db: D1Database, userId: string, accountId: string, action: Action): Promise<Level> {
  const def = DEFAULT_POLICY[action];
  if (def === "browser") throw new Error(`action ${action} is browser-only`);
  await assertAccount(db, userId, accountId);
  const row = await db
    .prepare(`SELECT level FROM policies WHERE user_id = ? AND action = ? AND (account_id = ? OR account_id IS NULL)
              ORDER BY account_id IS NULL ASC LIMIT 1`)
    .bind(userId, action, accountId)
    .first<{ level: Level }>();
  return row?.level ?? def;
}

export async function decide(db: D1Database, o: { userId: string; accountId: string; action: Action; modifiers: Modifier[] }): Promise<Decision> {
  const base = await effectiveLevel(db, o.userId, o.accountId, o.action);
  return { base, level: o.modifiers.length > 0 ? raise(base) : base, modifiers: [...o.modifiers] };
}

export async function setPolicy(db: D1Database, o: { userId: string; accountId: string | null; action: Action; level: Level }): Promise<void> {
  const now = Date.now();
  if (o.accountId === null) {
    await db.prepare(
      `INSERT INTO policies (user_id, account_id, action, level, updated_at) VALUES (?, NULL, ?, ?, ?)
       ON CONFLICT(user_id, action) WHERE account_id IS NULL DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`,
    ).bind(o.userId, o.action, o.level, now).run();
  } else {
    await assertAccount(db, o.userId, o.accountId);
    await db.prepare(
      `INSERT INTO policies (user_id, account_id, action, level, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, account_id, action) WHERE account_id IS NOT NULL DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`,
    ).bind(o.userId, o.accountId, o.action, o.level, now).run();
  }
}
```

- [x] **Step 4: run, expect PASS (6 tests)**

- [x] **Step 5: commit**

```bash
git add worker/src/policy/engine.ts worker/test/engine.test.ts
git commit -m "feat(worker): policy engine that verifies account ownership before deciding

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Pending actions, atomic journal, and the claim from the approved payload

**Files:**
- Create: `worker/src/operations/journal.ts`, `worker/src/approval/pending.ts`, `worker/src/approval/claim.ts`, `worker/test/claim.test.ts`

**Interfaces:**
- `journal.acquire(db, {userId, accountId, action, idempotencyKey?, payloadHash}) -> {operationId, existing: OperationRow | null}`: atomic insert-or-return through the unique index; an existing row with a different `action` or `payload_hash` throws `idempotency_conflict`.
- `journal.transition(db, operationId, from: OpState[], to, patch?) -> boolean`.
- `createPending(db, {userId, accountId, action, modifiers, payload, summary, ttlMs?}) -> PendingRow`: canonicalises, stores `payload_json`, hashes the stored string.
- `approvePending`, `denyPending`, `cancelPending` (from `pending` or `approved`), `getPending`, `finishPending`.
- `claimPending(db, {id, userId}) -> {operationId, pending, handles}`: handles come only from `payload_json.attachments`.
- `type PendingRow`, `type OperationRow`, `type OpState`.

Payload convention used by Plan 3's tools: a pending payload for any `send.*` or `draft.write` action carries `attachments: string[]` of staging handles (possibly empty). No other field is inspected by the claim.

- [x] **Step 1 (RED): test**

`worker/test/claim.test.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedUserAndAccount } from "./fixtures";
import { createPending, approvePending, cancelPending, denyPending, getPending } from "../src/approval/pending";
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
const H = (s: string) => "sh_" + s.padEnd(43, "A");
const mk = (payload: unknown, extra: Record<string, unknown> = {}) =>
  createPending(env.DB, { userId: "cu", accountId: "ca", action: "send.message", modifiers: [], payload, summary: "To: someone", ...extra });

describe("pending lifecycle", () => {
  it("stores canonical payload, hashes the stored string, 15 minute ttl, approves once", async () => {
    const p = await mk({ to: ["a@x.test"], attachments: [] });
    expect(p.payload_json).toBe('{"attachments":[],"to":["a@x.test"]}');
    expect(p.expires_at - p.created_at).toBe(15 * 60_000);
    expect(await approvePending(env.DB, { id: p.id, userId: "cu", via: "browser" })).toBe(true);
    expect(await approvePending(env.DB, { id: p.id, userId: "cu", via: "browser" })).toBe(false);
  });
  it("cannot be approved or read by another user", async () => {
    const p = await mk({ id: 1, attachments: [] });
    expect(await approvePending(env.DB, { id: p.id, userId: "cu2", via: "browser" })).toBe(false);
    expect(await getPending(env.DB, p.id, "cu2")).toBeNull();
  });
  it("cancel works from pending and approved, never from executing; deny and cancel redact", async () => {
    const p = await mk({ n: 1, attachments: [] });
    await approvePending(env.DB, { id: p.id, userId: "cu", via: "browser" });
    expect(await cancelPending(env.DB, { id: p.id, userId: "cu" })).toBe(true);
    const after = await getPending(env.DB, p.id, "cu");
    expect(after).toMatchObject({ state: "cancelled", payload_json: null, summary: "redacted" });
    const q = await mk({ n: 2, attachments: [] });
    expect(await denyPending(env.DB, { id: q.id, userId: "cu" })).toBe(true);
    expect(await getPending(env.DB, q.id, "cu")).toMatchObject({ state: "denied", payload_json: null, summary: "redacted" });
    const r = await mk({ n: 3, attachments: [] });
    await approvePending(env.DB, { id: r.id, userId: "cu", via: "browser" });
    await claimPending(env.DB, { id: r.id, userId: "cu" });
    expect(await cancelPending(env.DB, { id: r.id, userId: "cu" })).toBe(false);
  });
});

describe("claimPending", () => {
  it("claims an approved row exactly once under concurrency and records execution_started_at", async () => {
    const p = await mk({ n: 4, attachments: [] });
    await approvePending(env.DB, { id: p.id, userId: "cu", via: "elicitation" });
    const results = await Promise.allSettled([claimPending(env.DB, { id: p.id, userId: "cu" }), claimPending(env.DB, { id: p.id, userId: "cu" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const row = await getPending(env.DB, p.id, "cu");
    expect(row?.state).toBe("executing");
    expect(row?.execution_started_at).not.toBeNull();
    expect(row?.executed_at).toBeNull();
    const ops = await env.DB.prepare("SELECT count(*) AS c FROM operations WHERE idempotency_key = ?").bind(p.id).first<{ c: number }>();
    expect(ops?.c).toBe(1);
  });
  it("rejects unapproved, cancelled and expired rows without creating an operation", async () => {
    const before = (await env.DB.prepare("SELECT count(*) AS c FROM operations").first<{ c: number }>())!.c;
    const p1 = await mk({ n: 5, attachments: [] });
    await expect(claimPending(env.DB, { id: p1.id, userId: "cu" })).rejects.toThrow(/pending_not_approved/);
    await cancelPending(env.DB, { id: p1.id, userId: "cu" });
    await expect(claimPending(env.DB, { id: p1.id, userId: "cu" })).rejects.toThrow(/pending_not_approved/);
    const p2 = await mk({ n: 6, attachments: [] }, { ttlMs: -1 });
    await expect(claimPending(env.DB, { id: p2.id, userId: "cu" })).rejects.toThrow(/pending_expired|pending_not_approved/);
    expect((await env.DB.prepare("SELECT count(*) AS c FROM operations").first<{ c: number }>())!.c).toBe(before);
  });
  it("reserves exactly the handles in the approved payload and nothing the caller could add", async () => {
    await stageUpload(H("ok1"));
    await stageUpload(H("other"));
    const p = await mk({ attachments: [H("ok1")] }, { modifiers: ["+attachment"] });
    await approvePending(env.DB, { id: p.id, userId: "cu", via: "browser" });
    const r = await claimPending(env.DB, { id: p.id, userId: "cu" });
    expect(r.handles).toEqual([H("ok1")]);
    const rows = await env.DB.prepare("SELECT handle, reserved_by_operation_id AS r FROM staging_objects WHERE handle IN (?, ?)").bind(H("ok1"), H("other")).all<{ handle: string; r: string | null }>();
    const byHandle = Object.fromEntries(rows.results.map((x) => [x.handle, x.r]));
    expect(byHandle[H("ok1")]).toBe(r.operationId);
    expect(byHandle[H("other")]).toBeNull();
  });
  it("rolls back the whole claim when a payload handle is foreign, consumed or missing", async () => {
    await stageUpload(H("foreign"), "cb", "cu2");
    const p = await mk({ attachments: [H("foreign")] }, { modifiers: ["+attachment"] });
    await approvePending(env.DB, { id: p.id, userId: "cu", via: "browser" });
    const before = (await env.DB.prepare("SELECT count(*) AS c FROM operations").first<{ c: number }>())!.c;
    await expect(claimPending(env.DB, { id: p.id, userId: "cu" })).rejects.toThrow(/handle_reserved/);
    expect((await env.DB.prepare("SELECT count(*) AS c FROM operations").first<{ c: number }>())!.c).toBe(before);
    expect((await getPending(env.DB, p.id, "cu"))?.state).toBe("approved");
  });
});

describe("operations journal", () => {
  it("returns the existing row for a repeated key with the same action and hash", async () => {
    const a = await acquire(env.DB, { userId: "cu", accountId: "ca", action: "send.message", idempotencyKey: "k1", payloadHash: "h1" });
    expect(a.existing).toBeNull();
    await transition(env.DB, a.operationId, ["claimed"], "executed", { gmail_result_id: "m1" });
    const b = await acquire(env.DB, { userId: "cu", accountId: "ca", action: "send.message", idempotencyKey: "k1", payloadHash: "h1" });
    expect(b.operationId).toBe(a.operationId);
    expect(b.existing).toMatchObject({ state: "executed", gmail_result_id: "m1" });
  });
  it("refuses a reused key with a different action or hash", async () => {
    await acquire(env.DB, { userId: "cu", accountId: "ca", action: "send.message", idempotencyKey: "k2", payloadHash: "h2" });
    await expect(acquire(env.DB, { userId: "cu", accountId: "ca", action: "send.message", idempotencyKey: "k2", payloadHash: "OTHER" })).rejects.toThrow(/idempotency_conflict/);
    await expect(acquire(env.DB, { userId: "cu", accountId: "ca", action: "draft.write", idempotencyKey: "k2", payloadHash: "h2" })).rejects.toThrow(/idempotency_conflict/);
  });
  it("is atomic under concurrent acquisition of the same key", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      acquire(env.DB, { userId: "cu", accountId: "ca", action: "send.message", idempotencyKey: "k3", payloadHash: "h3" })));
    const ids = new Set(results.map((r) => r.operationId));
    expect(ids.size).toBe(1);
    const n = await env.DB.prepare("SELECT count(*) AS c FROM operations WHERE idempotency_key = 'k3'").first<{ c: number }>();
    expect(n?.c).toBe(1);
  });
  it("transition only from allowed states", async () => {
    const a = await acquire(env.DB, { userId: "cu", accountId: "ca", action: "send.message", payloadHash: "h4" });
    expect(await transition(env.DB, a.operationId, ["executing"], "executed")).toBe(false);
    expect(await transition(env.DB, a.operationId, ["claimed"], "executing")).toBe(true);
  });
});
```

- [x] **Step 2: run, expect failure**

- [x] **Step 3 (GREEN): journal**

`worker/src/operations/journal.ts`:
```ts
import type { Action } from "@gmail-mcp/shared/actions";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import { randomId } from "../crypto/random";

export type OpState = "claimed" | "executing" | "delivery_unknown" | "executed" | "failed_safe";
export type OperationRow = {
  id: string; user_id: string; account_id: string; action: string; idempotency_key: string | null;
  state: OpState; payload_hash: string; rfc822_message_id: string | null; gmail_result_id: string | null;
  created_at: number; updated_at: number;
};

/**
 * Insert-or-return. The unique partial index on (user_id, account_id, idempotency_key) is the arbiter:
 * INSERT OR IGNORE either creates the row or does nothing, and the SELECT that follows returns the winner.
 * A winner with a different action or payload hash is a conflict, never a silent reuse.
 */
export async function acquire(
  db: D1Database,
  o: { userId: string; accountId: string; action: Action; idempotencyKey?: string; payloadHash: string },
): Promise<{ operationId: string; existing: OperationRow | null }> {
  const id = randomId("op");
  const now = Date.now();
  if (!o.idempotencyKey) {
    await db.prepare(
      `INSERT INTO operations (id, user_id, account_id, action, idempotency_key, state, payload_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'claimed', ?, ?, ?)`,
    ).bind(id, o.userId, o.accountId, o.action, o.payloadHash, now, now).run();
    return { operationId: id, existing: null };
  }
  await db.prepare(
    `INSERT OR IGNORE INTO operations (id, user_id, account_id, action, idempotency_key, state, payload_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?)`,
  ).bind(id, o.userId, o.accountId, o.action, o.idempotencyKey, o.payloadHash, now, now).run();
  const row = await db
    .prepare("SELECT * FROM operations WHERE user_id = ? AND account_id = ? AND idempotency_key = ?")
    .bind(o.userId, o.accountId, o.idempotencyKey)
    .first<OperationRow>();
  if (!row) throw new GmailMcpError("internal", "acquire: row vanished after insert");
  if (row.action !== o.action || row.payload_hash !== o.payloadHash) {
    throw new GmailMcpError("idempotency_conflict", "idempotency_conflict: key previously used for a different operation");
  }
  if (row.id === id) return { operationId: id, existing: null };
  return { operationId: row.id, existing: row };
}

export async function transition(
  db: D1Database, operationId: string, from: OpState[], to: OpState,
  patch: { gmail_result_id?: string; rfc822_message_id?: string } = {},
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE operations SET state = ?, updated_at = ?,
         gmail_result_id = COALESCE(?, gmail_result_id), rfc822_message_id = COALESCE(?, rfc822_message_id)
       WHERE id = ? AND state IN (${from.map(() => "?").join(",")})`,
    )
    .bind(to, Date.now(), patch.gmail_result_id ?? null, patch.rfc822_message_id ?? null, operationId, ...from)
    .run();
  return (res.meta.changes ?? 0) === 1;
}
```

A `failed_safe` row with a key blocks reuse of that key on purpose: the caller sees `existing.state === "failed_safe"` and decides whether to retry with a new key. Silently freeing keys is how duplicate sends happen.

- [x] **Step 4 (GREEN): pending**

`worker/src/approval/pending.ts`:
```ts
import type { Action, Modifier } from "@gmail-mcp/shared/actions";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import { canonicalize, hashCanonical } from "../crypto/canonical";
import { randomId } from "../crypto/random";
import { LIMITS } from "../policy/limits";

export const PENDING_TTL_MS = 15 * 60_000;

export type PendingState = "pending" | "approved" | "executing" | "executed" | "failed" | "denied" | "cancelled" | "expired";
export type PendingRow = {
  id: string; user_id: string; account_id: string; action: Action; modifiers: string;
  payload_json: string | null; payload_hash: string; summary: string; state: PendingState;
  operation_id: string | null; created_at: number; expires_at: number;
  approved_at: number | null; approved_via: string | null;
  execution_started_at: number | null; executed_at: number | null; error: string | null;
};

export async function createPending(
  db: D1Database,
  o: { userId: string; accountId: string; action: Action; modifiers: Modifier[]; payload: unknown; summary: string; ttlMs?: number },
): Promise<PendingRow> {
  const canonical = canonicalize(o.payload);
  if (new TextEncoder().encode(canonical).length > LIMITS.canonicalPayloadBytes) {
    throw new GmailMcpError("limit_exceeded", "limit_exceeded: canonical payload > 1 MB");
  }
  const hash = await hashCanonical(canonical);
  const id = randomId("pa");
  const now = Date.now();
  await db.prepare(
    `INSERT INTO pending_actions (id, user_id, account_id, action, modifiers, payload_json, payload_hash, summary, state, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).bind(id, o.userId, o.accountId, o.action, JSON.stringify(o.modifiers), canonical, hash, o.summary, now, now + (o.ttlMs ?? PENDING_TTL_MS)).run();
  return (await getPending(db, id, o.userId))!;
}

export async function getPending(db: D1Database, id: string, userId: string): Promise<PendingRow | null> {
  return db.prepare("SELECT * FROM pending_actions WHERE id = ? AND user_id = ?").bind(id, userId).first<PendingRow>();
}

async function setState(db: D1Database, id: string, userId: string, from: PendingState[], to: PendingState, extra = "", binds: unknown[] = []): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE pending_actions SET state = ? ${extra} WHERE id = ? AND user_id = ? AND state IN (${from.map(() => "?").join(",")}) AND expires_at > ?`)
    .bind(to, ...binds, id, userId, ...from, Date.now())
    .run();
  return (res.meta.changes ?? 0) === 1;
}

export function approvePending(db: D1Database, o: { id: string; userId: string; via: "browser" | "elicitation" }): Promise<boolean> {
  return setState(db, o.id, o.userId, ["pending"], "approved", ", approved_at = ?, approved_via = ?", [Date.now(), o.via]);
}
export function denyPending(db: D1Database, o: { id: string; userId: string }): Promise<boolean> {
  return setState(db, o.id, o.userId, ["pending"], "denied", ", payload_json = NULL, summary = 'redacted'");
}
/** The owner may withdraw approval any time before execution starts. */
export function cancelPending(db: D1Database, o: { id: string; userId: string }): Promise<boolean> {
  return setState(db, o.id, o.userId, ["pending", "approved"], "cancelled", ", payload_json = NULL, summary = 'redacted'");
}

/** Terminal purge per spec 3.4. `executed_at` is set only here, when the side effect is confirmed. */
export async function finishPending(db: D1Database, id: string, to: "executed" | "failed", error?: string): Promise<void> {
  await db.prepare(
    `UPDATE pending_actions SET state = ?, payload_json = NULL, summary = 'redacted', error = ?, executed_at = ? WHERE id = ? AND state = 'executing'`,
  ).bind(to, error ?? null, Date.now(), id).run();
}
```

- [x] **Step 5 (GREEN): claim**

`worker/src/approval/claim.ts`:
```ts
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import { StagingHandle } from "@gmail-mcp/shared/schemas";
import { randomId } from "../crypto/random";
import { getPending, type PendingRow } from "./pending";

/** Handles come from the approved payload only. Any other shape is a payload_mismatch, never a guess. */
export function handlesFromPayload(payloadJson: string | null): string[] {
  if (payloadJson === null) throw new GmailMcpError("payload_mismatch", "payload_mismatch: payload purged");
  const parsed = JSON.parse(payloadJson) as { attachments?: unknown };
  const list = parsed.attachments ?? [];
  if (!Array.isArray(list) || !list.every((h) => StagingHandle.safeParse(h).success)) {
    throw new GmailMcpError("payload_mismatch", "payload_mismatch: attachments must be staging handles");
  }
  return [...new Set(list as string[])];
}

/**
 * Spec 3.4: one D1 batch, in this order because foreign keys are immediate:
 * 1 insert operation (claimed) -> 2 claim pending (approved -> executing) -> 3 assert the claim happened ->
 * 4 reserve payload handles -> 5 assert the reservation count. `_assert` has CHECK (x = 0); an inserted 1
 * raises and rolls the whole batch back.
 */
export async function claimPending(
  db: D1Database,
  o: { id: string; userId: string },
): Promise<{ operationId: string; pending: PendingRow; handles: string[] }> {
  const before = await getPending(db, o.id, o.userId);
  if (!before) throw new GmailMcpError("pending_not_approved", "pending_not_approved: unknown");
  if (before.expires_at <= Date.now()) throw new GmailMcpError("pending_expired", "pending_expired");
  if (before.state !== "approved") throw new GmailMcpError("pending_not_approved", `pending_not_approved: ${before.state}`);
  const handles = handlesFromPayload(before.payload_json);

  const operationId = randomId("op");
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO operations (id, user_id, account_id, action, idempotency_key, state, payload_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?)`,
    ).bind(operationId, before.user_id, before.account_id, before.action, before.id, before.payload_hash, now, now),
    db.prepare(
      `UPDATE pending_actions SET state = 'executing', operation_id = ?, execution_started_at = ?
       WHERE id = ? AND user_id = ? AND state = 'approved' AND expires_at > ?`,
    ).bind(operationId, now, o.id, o.userId, now),
    db.prepare(
      `INSERT INTO _assert (x) SELECT 1 WHERE NOT EXISTS (
         SELECT 1 FROM pending_actions WHERE id = ? AND operation_id = ? AND state = 'executing')`,
    ).bind(o.id, operationId),
  ];
  if (handles.length > 0) {
    stmts.push(
      db.prepare(
        `UPDATE staging_objects SET reserved_by_operation_id = ?
         WHERE handle IN (${handles.map(() => "?").join(",")}) AND user_id = ? AND account_id = ? AND direction = 'upload'
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
    const after = await getPending(db, o.id, o.userId);
    if (after?.state === "approved" && handles.length > 0) {
      throw new GmailMcpError("handle_reserved", `handle_reserved: one or more payload handles unavailable (${msg})`);
    }
    if (after?.state !== "approved") throw new GmailMcpError("pending_replayed", `pending_replayed: ${after?.state ?? "unknown"}`);
    throw new GmailMcpError("internal", msg);
  }
  return { operationId, pending: (await getPending(db, o.id, o.userId))!, handles };
}
```

- [x] **Step 6: run, expect PASS (11 tests)**

Run: `cd worker && npx vitest run test/claim.test.ts`

- [x] **Step 7: commit**

```bash
git add worker/src/approval worker/src/operations worker/test/claim.test.ts
git commit -m "feat(worker): payload-bound atomic journal, cancellable approvals, claim from approved payload

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Staging store

**Files:**
- Create: `worker/src/staging/store.ts`, `worker/test/staging.test.ts`

**Interfaces:**
- `ingest(env, {userId, accountId, direction, filename, mime, length, body, declaredSha256?, source?}) -> StagingRow`: rejects over-cap `length` before reading, `FixedLengthStream(length)`, `tee()` into R2 and `DigestStream`, all branches observed, blocked extensions enforced for uploads only, R2 object deleted if the D1 insert fails.
- `openForRead(env, {handle, userId})`: download handles only, owner-checked, TTL-checked.
- `ack(env, {handle, userId}) -> boolean`: TTL-checked.
- `extendExpiry(db, handles, userId, accountId, until)`, `consume(db, operationId)` (clears the reservation), `release(db, operationId)`, `purgeExpired(env, now, limit = 200)` (batched R2 delete, transactional D1 delete).

- [x] **Step 1 (RED): test**

`worker/test/staging.test.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedUserAndAccount, insertOperation } from "./fixtures";
import { ingest, openForRead, ack, purgeExpired, extendExpiry, consume, release } from "../src/staging/store";
import { sha256Hex } from "../src/crypto/canonical";

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
const stream = (b: Uint8Array) => new Response(b).body!;
const up = (name: string, data: Uint8Array, extra: Record<string, unknown> = {}) =>
  ingest(env, { userId: "su", accountId: "sa", direction: "upload", filename: name, mime: "application/octet-stream", length: data.byteLength, body: stream(data), ...extra });
const down = (name: string, data: Uint8Array) =>
  ingest(env, { userId: "su", accountId: "sa", direction: "download", filename: name, mime: "application/octet-stream", length: data.byteLength, body: stream(data) });

beforeAll(async () => {
  await seedUserAndAccount(env.DB, { userId: "su", accountId: "sa", alias: "main" });
  await seedUserAndAccount(env.DB, { userId: "su2", accountId: "sb", alias: "main" });
});

describe("ingest", () => {
  it("stores bytes, computes sha256, sanitises the filename, sets 30 min ttl", async () => {
    const data = bytes(1000);
    const row = await down("../x\u202e.pdf", data);
    expect(row.handle).toMatch(/^sh_[A-Za-z0-9_-]{43}$/);
    expect(row.filename).toBe("x_.pdf");
    expect(row.size).toBe(1000);
    expect(row.sha256).toBe(await sha256Hex(data));
    expect(row.expires_at - row.created_at).toBe(30 * 60_000);
    expect((await (await env.STAGING.get(row.r2_key))!.arrayBuffer()).byteLength).toBe(1000);
  });
  it("blocks dangerous extensions on upload only", async () => {
    await expect(up("run.exe", bytes(1))).rejects.toThrow(/blocked_extension/);
    const d = await down("run.exe", bytes(1));
    expect(d.filename).toBe("run.exe");
  });
  it("rejects over-cap lengths before reading any bytes", async () => {
    await expect(up("big.bin", bytes(1), { length: 25 * 1024 * 1024 + 1 })).rejects.toThrow(/limit_exceeded/);
  });
  it("rejects a body whose byte count differs from length, leaving no R2 object or row", async () => {
    await expect(up("short.bin", bytes(3), { length: 5 })).rejects.toThrow();
    await expect(up("long.bin", bytes(7), { length: 5 })).rejects.toThrow();
    expect((await env.DB.prepare("SELECT count(*) AS c FROM staging_objects WHERE filename IN ('short.bin','long.bin')").first<{ c: number }>())?.c).toBe(0);
    const listed = await env.STAGING.list({ prefix: "stg/su/" });
    expect(listed.objects.filter((o) => o.size === 3 || o.size === 7 || o.size === 5)).toHaveLength(0);
  });
  it("rejects a declared sha256 that does not match and leaves no row", async () => {
    await expect(up("a.txt", bytes(5), { declaredSha256: "0".repeat(64) })).rejects.toThrow(/handle_invalid/);
    expect((await env.DB.prepare("SELECT count(*) AS c FROM staging_objects WHERE filename = 'a.txt'").first<{ c: number }>())?.c).toBe(0);
  });
  it("deletes the R2 object when the D1 insert fails", async () => {
    const before = (await env.STAGING.list({ prefix: "stg/ghost/" })).objects.length;
    await expect(ingest(env, { userId: "ghost", accountId: "nope", direction: "upload", filename: "g.bin", mime: "x", length: 2, body: stream(bytes(2)) })).rejects.toThrow();
    expect((await env.STAGING.list({ prefix: "stg/ghost/" })).objects.length).toBe(before);
  });
});

describe("read and ack", () => {
  it("streams downloads to the owner only, allows re-read before ack, blocks after ack and after expiry", async () => {
    const row = await down("r.txt", bytes(3, 9));
    const first = await openForRead(env, { handle: row.handle, userId: "su" });
    expect(new Uint8Array(await new Response(first.body).arrayBuffer())).toEqual(bytes(3, 9));
    await expect(openForRead(env, { handle: row.handle, userId: "su2" })).rejects.toThrow(/handle_invalid/);
    await openForRead(env, { handle: row.handle, userId: "su" });
    expect(await ack(env, { handle: row.handle, userId: "su" })).toBe(true);
    expect(await ack(env, { handle: row.handle, userId: "su" })).toBe(false);
    await expect(openForRead(env, { handle: row.handle, userId: "su" })).rejects.toThrow(/handle_invalid/);
    const stale = await down("stale.txt", bytes(1));
    await env.DB.prepare("UPDATE staging_objects SET expires_at = 1 WHERE handle = ?").bind(stale.handle).run();
    expect(await ack(env, { handle: stale.handle, userId: "su" })).toBe(false);
    await expect(openForRead(env, { handle: stale.handle, userId: "su" })).rejects.toThrow(/handle_expired/);
  });
  it("never serves upload handles through the read path", async () => {
    const u = await up("u.bin", bytes(2));
    await expect(openForRead(env, { handle: u.handle, userId: "su" })).rejects.toThrow(/handle_invalid/);
  });
});

describe("hold, reserve, consume, release, purge", () => {
  it("consume clears the reservation so purge can collect the object", async () => {
    const c = await up("c.bin", bytes(2));
    await insertOperation(env.DB, "op_c", "su", "sa", "executing");
    await env.DB.prepare("UPDATE staging_objects SET reserved_by_operation_id = 'op_c' WHERE handle = ?").bind(c.handle).run();
    await consume(env.DB, "op_c");
    const row = await env.DB.prepare("SELECT consumed_at AS ca, reserved_by_operation_id AS r FROM staging_objects WHERE handle = ?").bind(c.handle).first<{ ca: number | null; r: string | null }>();
    expect(row?.ca).not.toBeNull();
    expect(row?.r).toBeNull();
    await purgeExpired(env, Date.now());
    expect(await env.DB.prepare("SELECT 1 FROM staging_objects WHERE handle = ?").bind(c.handle).first()).toBeNull();
    expect(await env.STAGING.get(c.r2_key)).toBeNull();
  });
  it("release clears an unconsumed reservation", async () => {
    const d = await up("d.bin", bytes(2));
    await insertOperation(env.DB, "op_d", "su", "sa", "claimed");
    await env.DB.prepare("UPDATE staging_objects SET reserved_by_operation_id = 'op_d' WHERE handle = ?").bind(d.handle).run();
    await release(env.DB, "op_d");
    expect((await env.DB.prepare("SELECT reserved_by_operation_id AS r FROM staging_objects WHERE handle = ?").bind(d.handle).first<{ r: string | null }>())?.r).toBeNull();
  });
  it("purge removes expired unreserved objects in one pass and keeps reserved ones", async () => {
    const a = await up("a.bin", bytes(2));
    const b = await up("b.bin", bytes(2));
    await env.DB.prepare("UPDATE staging_objects SET expires_at = 1 WHERE handle IN (?, ?)").bind(a.handle, b.handle).run();
    await insertOperation(env.DB, "op_x", "su", "sa", "delivery_unknown");
    await env.DB.prepare("UPDATE staging_objects SET reserved_by_operation_id = 'op_x' WHERE handle = ?").bind(b.handle).run();
    const r = await purgeExpired(env, Date.now());
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    expect(await env.STAGING.get(a.r2_key)).toBeNull();
    expect(await env.STAGING.get(b.r2_key)).not.toBeNull();
  });
  it("extendExpiry only raises", async () => {
    const e = await up("e.bin", bytes(2));
    await extendExpiry(env.DB, [e.handle], "su", "sa", e.expires_at + 99_000);
    await extendExpiry(env.DB, [e.handle], "su", "sa", 1);
    expect((await env.DB.prepare("SELECT expires_at AS x FROM staging_objects WHERE handle = ?").bind(e.handle).first<{ x: number }>())?.x).toBe(e.expires_at + 99_000);
  });
});
```

- [x] **Step 2: run, expect failure**

- [x] **Step 3 (GREEN): implement**

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
  if (o.direction === "upload") assertNotBlocked(filename);
  if (!Number.isInteger(o.length) || o.length < 0 || o.length > LIMITS.stagedFileBytes) {
    throw new GmailMcpError("limit_exceeded", `limit_exceeded: length ${o.length} not within 0..${LIMITS.stagedFileBytes}`);
  }
  const handle = randomHandle();
  const r2Key = `stg/${o.userId}/${handle}`;
  const fixed = new FixedLengthStream(o.length);
  const pumping = o.body.pipeTo(fixed.writable);
  const [forR2, forDigest] = fixed.readable.tee();
  const digest = new crypto.DigestStream("SHA-256");
  const settled = await Promise.allSettled([
    env.STAGING.put(r2Key, forR2, { httpMetadata: { contentType: o.mime } }),
    forDigest.pipeTo(digest),
    pumping,
  ]);
  const failure = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failure) {
    await env.STAGING.delete(r2Key).catch(() => {});
    if (failure.reason instanceof GmailMcpError) throw failure.reason;
    throw new GmailMcpError("internal", `ingest failed: ${String((failure.reason as Error)?.message ?? failure.reason)}`);
  }
  const sha256 = hex(await digest.digest);
  if (o.declaredSha256 && o.declaredSha256.toLowerCase() !== sha256) {
    await env.STAGING.delete(r2Key);
    throw new GmailMcpError("handle_invalid", "handle_invalid: declared sha256 mismatch");
  }
  const now = Date.now();
  const row: StagingRow = {
    handle, user_id: o.userId, account_id: o.accountId, direction: o.direction, r2_key: r2Key,
    filename, mime: o.mime, size: o.length, sha256,
    source_message_id: o.source?.messageId ?? null, source_attachment_id: o.source?.attachmentId ?? null,
    reserved_by_operation_id: null, created_at: now, expires_at: now + DOWNLOAD_TTL_MS, consumed_at: null,
  };
  try {
    await env.DB.prepare(
      `INSERT INTO staging_objects (handle, user_id, account_id, direction, r2_key, filename, mime, size, sha256,
         source_message_id, source_attachment_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(row.handle, row.user_id, row.account_id, row.direction, row.r2_key, row.filename, row.mime, row.size, row.sha256,
      row.source_message_id, row.source_attachment_id, row.created_at, row.expires_at).run();
  } catch (e) {
    await env.STAGING.delete(r2Key).catch(() => {});
    throw e;
  }
  return row;
}

export async function openForRead(env: Env, o: { handle: string; userId: string }): Promise<{ row: StagingRow; body: ReadableStream }> {
  const row = await env.DB
    .prepare("SELECT * FROM staging_objects WHERE handle = ? AND user_id = ? AND direction = 'download' AND consumed_at IS NULL")
    .bind(o.handle, o.userId).first<StagingRow>();
  if (!row) throw new GmailMcpError("handle_invalid", "handle_invalid");
  if (row.expires_at <= Date.now()) throw new GmailMcpError("handle_expired", "handle_expired");
  const obj = await env.STAGING.get(row.r2_key);
  if (!obj) throw new GmailMcpError("handle_invalid", "handle_invalid: object missing");
  return { row, body: obj.body };
}

export async function ack(env: Env, o: { handle: string; userId: string }): Promise<boolean> {
  const now = Date.now();
  const res = await env.DB
    .prepare("UPDATE staging_objects SET consumed_at = ? WHERE handle = ? AND user_id = ? AND direction = 'download' AND consumed_at IS NULL AND expires_at > ?")
    .bind(now, o.handle, o.userId, now).run();
  return (res.meta.changes ?? 0) === 1;
}

export async function extendExpiry(db: D1Database, handles: string[], userId: string, accountId: string, until: number): Promise<void> {
  if (handles.length === 0) return;
  await db.prepare(
    `UPDATE staging_objects SET expires_at = MAX(expires_at, ?) WHERE handle IN (${handles.map(() => "?").join(",")}) AND user_id = ? AND account_id = ?`,
  ).bind(until, ...handles, userId, accountId).run();
}

/** Marks reserved uploads used and clears the reservation so the purge can collect them. */
export async function consume(db: D1Database, operationId: string): Promise<void> {
  await db.prepare("UPDATE staging_objects SET consumed_at = ?, reserved_by_operation_id = NULL WHERE reserved_by_operation_id = ? AND consumed_at IS NULL")
    .bind(Date.now(), operationId).run();
}

export async function release(db: D1Database, operationId: string): Promise<void> {
  await db.prepare("UPDATE staging_objects SET reserved_by_operation_id = NULL WHERE reserved_by_operation_id = ? AND consumed_at IS NULL")
    .bind(operationId).run();
}

export async function purgeExpired(env: Env, now: number, limit = 200): Promise<{ deleted: number }> {
  const rows = await env.DB
    .prepare(`SELECT handle, r2_key FROM staging_objects
              WHERE (expires_at <= ? OR consumed_at IS NOT NULL) AND reserved_by_operation_id IS NULL LIMIT ?`)
    .bind(now, limit).all<{ handle: string; r2_key: string }>();
  if (rows.results.length === 0) return { deleted: 0 };
  await env.STAGING.delete(rows.results.map((r) => r.r2_key));
  await env.DB.batch(rows.results.map((r) => env.DB.prepare("DELETE FROM staging_objects WHERE handle = ?").bind(r.handle)));
  return { deleted: rows.results.length };
}
```

- [x] **Step 4: run, expect PASS (12 tests)**

`FixedLengthStream` and `crypto.DigestStream` are Workers globals declared by the generated `worker-configuration.d.ts`. `R2Bucket.delete` accepts an array of keys.

- [x] **Step 5: commit**

```bash
git add worker/src/staging worker/test/staging.test.ts
git commit -m "feat(worker): staging store with exact-length ingest, download-only reads, consume clears reservation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Structured audit and transactional cron

**Files:**
- Create: `worker/src/audit/log.ts`, `worker/src/cron.ts`, `worker/test/cron.test.ts`
- Modify: `worker/src/index.ts`

**Interfaces:**
- `type AuditFacts = { recipients?: number; attachments?: number; ids?: string[] }`; `auditIntent(db, {userId, accountId, tool, action, modifiers, decision, pendingId?, operationId?, facts, clientHint?}) -> number`; `auditOutcome(db, {...same, gmailResultId?})`. The module renders the stored summary; there is no free-text parameter.
- `runCron(env, now, limit = 200) -> CronReport`.

- [x] **Step 1 (RED): test**

`worker/test/cron.test.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedUserAndAccount, insertOperation } from "./fixtures";
import { runCron } from "../src/cron";
import { auditIntent, auditOutcome } from "../src/audit/log";

beforeAll(async () => {
  await seedUserAndAccount(env.DB, { userId: "ku", accountId: "ka", alias: "main" });
});

describe("audit", () => {
  it("writes intent and outcome rows and renders the summary itself", async () => {
    const id = await auditIntent(env.DB, { userId: "ku", accountId: "ka", tool: "send_message", action: "send.message", modifiers: ["+external"], decision: "ask", facts: { recipients: 2, attachments: 1 } });
    expect(id).toBeGreaterThan(0);
    await auditOutcome(env.DB, { userId: "ku", accountId: "ka", tool: "send_message", action: "send.message", modifiers: [], decision: "executed", gmailResultId: "m9", facts: { ids: ["m9"] } });
    const rows = await env.DB.prepare("SELECT phase, summary FROM audit_log WHERE user_id = 'ku' ORDER BY id").all<{ phase: string; summary: string }>();
    expect(rows.results).toEqual([{ phase: "intent", summary: "recipients=2 attachments=1" }, { phase: "outcome", summary: "ids=m9" }]);
  });
});

describe("cron", () => {
  it("expires pending, promotes stale executing, fails stale claimed transactionally, purges old audit", async () => {
    const old = Date.now() - 10 * 60_000;
    await env.DB.prepare(`INSERT INTO pending_actions (id, user_id, account_id, action, modifiers, payload_json, payload_hash, summary, state, created_at, expires_at)
      VALUES ('pa_old', 'ku', 'ka', 'send.message', '[]', '{"x":1}', 'h', 'To: secret', 'pending', ?, ?)`).bind(old, old + 1).run();
    await insertOperation(env.DB, "op_exec", "ku", "ka", "executing", old);
    await insertOperation(env.DB, "op_claim", "ku", "ka", "claimed", old);
    await insertOperation(env.DB, "op_fresh", "ku", "ka", "executing");
    await env.DB.prepare(`INSERT INTO pending_actions (id, user_id, account_id, action, modifiers, payload_json, payload_hash, summary, state, operation_id, created_at, expires_at)
      VALUES ('pa_claim', 'ku', 'ka', 'send.message', '[]', '{"x":2}', 'h', 'To: secret', 'executing', 'op_claim', ?, ?)`).bind(old, old + 900_000).run();
    await env.DB.prepare(`INSERT INTO staging_objects (handle, user_id, account_id, direction, r2_key, filename, mime, size, sha256, reserved_by_operation_id, created_at, expires_at)
      VALUES ('sh_res', 'ku', 'ka', 'upload', 'k', 'f', 'm', 1, 'h', 'op_claim', ?, ?)`).bind(old, old + 900_000).run();
    await env.DB.prepare(`INSERT INTO audit_log (ts, phase, summary) VALUES (?, 'intent', 'ancient')`).bind(Date.now() - 91 * 86_400_000).run();

    const report = await runCron(env, Date.now());
    expect(report.expiredPending).toBeGreaterThanOrEqual(1);
    expect(report.promotedUnknown).toBeGreaterThanOrEqual(1);
    expect(report.failedSafe).toBeGreaterThanOrEqual(1);
    expect(report.purgedAudit).toBeGreaterThanOrEqual(1);

    expect(await env.DB.prepare("SELECT state, payload_json, summary FROM pending_actions WHERE id = 'pa_old'").first()).toEqual({ state: "expired", payload_json: null, summary: "redacted" });
    const byId = Object.fromEntries((await env.DB.prepare("SELECT id, state FROM operations WHERE id IN ('op_exec','op_claim','op_fresh')").all<{ id: string; state: string }>()).results.map((r) => [r.id, r.state]));
    expect(byId).toEqual({ op_exec: "delivery_unknown", op_claim: "failed_safe", op_fresh: "executing" });
    expect(await env.DB.prepare("SELECT state, payload_json, error FROM pending_actions WHERE id = 'pa_claim'").first()).toEqual({ state: "failed", payload_json: null, error: "failed_safe" });
    expect((await env.DB.prepare("SELECT reserved_by_operation_id AS r FROM staging_objects WHERE handle = 'sh_res'").first<{ r: string | null }>())?.r).toBeNull();
  });
  it("does not touch a claimed operation that progressed between select and recovery", async () => {
    const old = Date.now() - 10 * 60_000;
    await insertOperation(env.DB, "op_race", "ku", "ka", "claimed", old);
    await env.DB.prepare(`INSERT INTO staging_objects (handle, user_id, account_id, direction, r2_key, filename, mime, size, sha256, reserved_by_operation_id, created_at, expires_at)
      VALUES ('sh_race', 'ku', 'ka', 'upload', 'k', 'f', 'm', 1, 'h', 'op_race', ?, ?)`).bind(old, old + 900_000).run();
    // Simulate the send worker winning: it moved the row to executing after the cron's SELECT.
    const { recoverClaimed } = await import("../src/cron");
    await env.DB.prepare("UPDATE operations SET state = 'executing', updated_at = ? WHERE id = 'op_race'").bind(Date.now()).run();
    await expect(recoverClaimed(env.DB, "op_race", Date.now())).resolves.toBe(false);
    expect((await env.DB.prepare("SELECT reserved_by_operation_id AS r FROM staging_objects WHERE handle = 'sh_race'").first<{ r: string | null }>())?.r).toBe("op_race");
  });
});
```

- [x] **Step 2: run, expect failure**

- [x] **Step 3 (GREEN): audit**

`worker/src/audit/log.ts`:
```ts
export type AuditFacts = { recipients?: number; attachments?: number; ids?: string[] };

type Base = {
  userId: string; accountId: string | null; tool: string; action: string; modifiers: string[];
  decision: string; pendingId?: string; operationId?: string; facts: AuditFacts; clientHint?: string;
};

/** The only way a summary reaches the audit table. Counts and ids, never text from mail. */
function render(f: AuditFacts): string {
  const parts: string[] = [];
  if (f.recipients !== undefined) parts.push(`recipients=${f.recipients}`);
  if (f.attachments !== undefined) parts.push(`attachments=${f.attachments}`);
  if (f.ids && f.ids.length > 0) parts.push(`ids=${f.ids.slice(0, 10).map((s) => s.replace(/[^A-Za-z0-9_.:-]/g, "")).join(",")}`);
  return parts.join(" ");
}

async function write(db: D1Database, phase: "intent" | "outcome", b: Base & { gmailResultId?: string }): Promise<number> {
  const res = await db.prepare(
    `INSERT INTO audit_log (ts, user_id, account_id, tool, action, modifiers, phase, decision, pending_id, operation_id, gmail_result_id, summary, client_hint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(Date.now(), b.userId, b.accountId, b.tool, b.action, JSON.stringify(b.modifiers), phase, b.decision,
    b.pendingId ?? null, b.operationId ?? null, b.gmailResultId ?? null, render(b.facts), b.clientHint ?? null).run();
  return Number(res.meta.last_row_id ?? 0);
}

export const auditIntent = (db: D1Database, b: Base) => write(db, "intent", b);
export const auditOutcome = (db: D1Database, b: Base & { gmailResultId?: string }) => write(db, "outcome", b);
```

- [x] **Step 4 (GREEN): cron**

`worker/src/cron.ts`:
```ts
import type { Env } from "./env";
import { purgeExpired } from "./staging/store";

export type CronReport = { expiredPending: number; promotedUnknown: number; failedSafe: number; purgedStaging: number; purgedAudit: number };

const STALE_MS = 2 * 60_000;
const AUDIT_RETENTION_MS = 90 * 86_400_000;

/**
 * One transactional recovery for a stale `claimed` operation: the transition is asserted, so if the send
 * worker moved the row to `executing` in the meantime, nothing else in the batch runs.
 */
export async function recoverClaimed(db: D1Database, operationId: string, now: number): Promise<boolean> {
  try {
    await db.batch([
      db.prepare(`UPDATE operations SET state = 'failed_safe', updated_at = ? WHERE id = ? AND state = 'claimed'`).bind(now, operationId),
      db.prepare(`INSERT INTO _assert (x) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM operations WHERE id = ? AND state = 'failed_safe')`).bind(operationId),
      db.prepare(`UPDATE staging_objects SET reserved_by_operation_id = NULL WHERE reserved_by_operation_id = ? AND consumed_at IS NULL`).bind(operationId),
      db.prepare(`UPDATE pending_actions SET state = 'failed', payload_json = NULL, summary = 'redacted', error = 'failed_safe' WHERE operation_id = ? AND state = 'executing'`).bind(operationId),
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function runCron(env: Env, now: number, limit = 200): Promise<CronReport> {
  const expired = await env.DB.prepare(
    `UPDATE pending_actions SET state = 'expired', payload_json = NULL, summary = 'redacted'
     WHERE id IN (SELECT id FROM pending_actions WHERE state IN ('pending','approved') AND expires_at <= ? LIMIT ?)`,
  ).bind(now, limit).run();

  const promoted = await env.DB.prepare(
    `UPDATE operations SET state = 'delivery_unknown', updated_at = ?
     WHERE id IN (SELECT id FROM operations WHERE state = 'executing' AND updated_at <= ? LIMIT ?)`,
  ).bind(now, now - STALE_MS, limit).run();

  const stale = await env.DB.prepare(`SELECT id FROM operations WHERE state = 'claimed' AND updated_at <= ? LIMIT ?`)
    .bind(now - STALE_MS, limit).all<{ id: string }>();
  let failedSafe = 0;
  for (const r of stale.results) if (await recoverClaimed(env.DB, r.id, now)) failedSafe++;

  const staging = await purgeExpired(env, now, limit);
  const audit = await env.DB.prepare(`DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE ts <= ? LIMIT ?)`)
    .bind(now - AUDIT_RETENTION_MS, limit).run();

  return {
    expiredPending: expired.meta.changes ?? 0,
    promotedUnknown: promoted.meta.changes ?? 0,
    failedSafe,
    purgedStaging: staging.deleted,
    purgedAudit: audit.meta.changes ?? 0,
  };
}
```

Modify `worker/src/index.ts`:
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

- [x] **Step 5: run, expect PASS (3 tests)**

- [x] **Step 6: commit**

```bash
git add worker/src/audit worker/src/cron.ts worker/src/index.ts worker/test/cron.test.ts
git commit -m "feat(worker): structured audit facts and bounded transactional cron recovery

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Dev-gated MCP endpoint, tested at the protocol level

**Files:**
- Create: `worker/src/mcp/auth-dev.ts`, `worker/src/mcp/server.ts`, `worker/test/mcp-client.ts`, `worker/test/mcp.test.ts`
- Modify: `worker/src/index.ts`

**Interfaces:**
- `type Principal = { userId: string; scope: "mcp" | "staging" }`; `authenticateDev(request, env): Principal | null` (requires both `DEV_STATIC_TOKEN` and `DEV_STATIC_USER`).
- `buildServer(env, principal): McpServer` registering `list_accounts`, `get_policy`, `list_pending`, `cancel_pending` with `z.object` input schemas, the form MCP SDK v2 documents.
- `POST /mcp` returns 401 with a `WWW-Authenticate` challenge without a valid bearer.
- Test helper `rpc(env, token, method, params, id)` that posts JSON-RPC to the Worker and parses either a JSON body or an SSE body.

- [x] **Step 1 (RED): helper and tests**

`worker/test/mcp-client.ts`:
```ts
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";

export async function rpc(env: unknown, token: string | null, method: string, params: unknown, id = 1): Promise<{ status: number; json: any }> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await worker.fetch(new Request("https://x.test/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }), env as any, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let json: any = null;
  if (text.trim().startsWith("{")) json = JSON.parse(text);
  else {
    const line = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:")).pop();
    if (line) json = JSON.parse(line.slice(5));
  }
  return { status: res.status, json };
}
```

`worker/test/mcp.test.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedUserAndAccount } from "./fixtures";
import { rpc } from "./mcp-client";

const devEnv = Object.assign(Object.create(env), { DEV_STATIC_TOKEN: "dev-token", DEV_STATIC_USER: "mu" });
const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } };

beforeAll(async () => {
  await seedUserAndAccount(env.DB, { userId: "mu", accountId: "ma", alias: "personal", isDefault: true });
});

describe("/mcp auth gate", () => {
  it("401 without a bearer, with a wrong bearer, and when the dev path is not fully configured", async () => {
    expect((await rpc(devEnv, null, "initialize", INIT)).status).toBe(401);
    expect((await rpc(devEnv, "nope", "initialize", INIT)).status).toBe(401);
    expect((await rpc(env, "dev-token", "initialize", INIT)).status).toBe(401);
    const tokenOnly = Object.assign(Object.create(env), { DEV_STATIC_TOKEN: "dev-token" });
    expect((await rpc(tokenOnly, "dev-token", "initialize", INIT)).status).toBe(401);
  });
});

describe("protocol", () => {
  it("initialize then tools/list returns the four control tools", async () => {
    const init = await rpc(devEnv, "dev-token", "initialize", INIT, 1);
    expect(init.status).toBe(200);
    expect(init.json?.result?.serverInfo?.name).toBe("gmail-mcp");
    const list = await rpc(devEnv, "dev-token", "tools/list", {}, 2);
    const names = (list.json?.result?.tools ?? []).map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["cancel_pending", "get_policy", "list_accounts", "list_pending"]);
  });
  it("get_policy resolves the default account and reports browser-only actions", async () => {
    const call = await rpc(devEnv, "dev-token", "tools/call", { name: "get_policy", arguments: {} }, 3);
    const text = call.json?.result?.content?.[0]?.text as string;
    const parsed = JSON.parse(text);
    expect(parsed.account).toBe("personal");
    expect(parsed.policy["send.message"]).toBe("ask");
    expect(parsed.policy["policy.edit"]).toBe("browser");
  });
});
```

- [x] **Step 2: run, expect failure**

- [x] **Step 3 (GREEN): dev auth**

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

/** Dev only. Both secrets must be present; a bypass never manufactures an identity. Plan 2 deletes this file. */
export function authenticateDev(request: Request, env: Env): Principal | null {
  if (!env.DEV_STATIC_TOKEN || !env.DEV_STATIC_USER) return null;
  const m = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (!m || !constantTimeEqual(m[1]!, env.DEV_STATIC_TOKEN)) return null;
  return { userId: env.DEV_STATIC_USER, scope: "mcp" };
}
```

- [x] **Step 4 (GREEN): server factory**

`worker/src/mcp/server.ts`:
```ts
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ACTIONS, DEFAULT_POLICY, type Action } from "@gmail-mcp/shared/actions";
import { AccountAlias } from "@gmail-mcp/shared/schemas";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
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
  if (!row) throw new GmailMcpError("account_not_found", alias ? `account_not_found: ${alias}` : "account_not_found: no default account");
  return row;
}

export function buildServer(env: Env, principal: Principal): McpServer {
  const server = new McpServer({ name: "gmail-mcp", version: "0.0.1" });

  server.registerTool(
    "list_accounts",
    { description: "List connected Gmail accounts: alias, email, status, default flag. Never returns tokens.",
      inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () => {
      const rows = await env.DB.prepare("SELECT alias, google_email AS email, status, is_default, scopes FROM accounts WHERE user_id = ? ORDER BY alias").bind(principal.userId).all();
      return text({ accounts: rows.results });
    },
  );

  server.registerTool(
    "get_policy",
    { description: "Effective allow/ask/deny policy for an account after overrides.",
      inputSchema: z.object({ account: AccountAlias.optional() }), annotations: { readOnlyHint: true } },
    async ({ account }) => {
      const acc = await resolveAccount(env, principal.userId, account);
      const policy: Record<string, string> = {};
      for (const a of ACTIONS) policy[a] = DEFAULT_POLICY[a] === "browser" ? "browser" : await effectiveLevel(env.DB, principal.userId, acc.id, a as Action);
      return text({ account: acc.alias, policy });
    },
  );

  server.registerTool(
    "list_pending",
    { description: "List pending and approved-but-unexecuted approvals for the caller.",
      inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () => {
      const rows = await env.DB.prepare(
        `SELECT p.id, a.alias AS account, p.action, p.modifiers, p.summary, p.state, p.expires_at
         FROM pending_actions p JOIN accounts a ON a.id = p.account_id AND a.user_id = p.user_id
         WHERE p.user_id = ? AND p.state IN ('pending','approved') ORDER BY p.created_at DESC LIMIT 50`,
      ).bind(principal.userId).all();
      return text({ pending: rows.results });
    },
  );

  server.registerTool(
    "cancel_pending",
    { description: "Withdraw a pending or approved action before it executes.",
      inputSchema: z.object({ action_id: z.string().regex(/^pa_[A-Za-z0-9_-]{22}$/) }), annotations: { readOnlyHint: false, destructiveHint: false } },
    async ({ action_id }) => text({ cancelled: await cancelPending(env.DB, { id: action_id, userId: principal.userId }) }),
  );

  return server;
}
```

- [x] **Step 5 (GREEN): wire `/mcp`**

`worker/src/index.ts`:
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
      return createMcpHandler(() => buildServer(env, principal))(request, env, ctx);
    }
    return new Response("not found", { status: 404 });
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env, Date.now()));
  },
} satisfies ExportedHandler<Env>;
```

- [x] **Step 6: run, expect PASS (3 tests)**

Run: `cd worker && npx vitest run test/mcp.test.ts`. The stateless handler accepts a 2025 client's `initialize` and subsequent calls without a session id; if `tools/list` returns a JSON-RPC error demanding initialisation, the handler is in the 2026-07-28-only mode and the helper must add `_meta` protocol negotiation as its README documents. That is the one runtime behaviour this task cannot pin from documentation.

- [x] **Step 7: manual check with MCP Inspector**

Create `worker/.dev.vars` (git-ignored):
```
DEV_STATIC_TOKEN=dev-token
DEV_STATIC_USER=mu
TOKEN_KEKS={"k1":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="}
TOKEN_KEK_CURRENT=k1
STATE_HMAC_KEY=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=
CSRF_HMAC_KEY=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=
```
```bash
cd worker && npm run migrate:local && npx wrangler d1 execute gmail-mcp --local --command "INSERT INTO users (id,email,created_at) VALUES ('mu','mu@example.test',0); INSERT INTO accounts (id,user_id,alias,google_sub,google_email,scopes,status,is_default,created_at) VALUES ('ma','mu','personal','s','p@example.test','gmail.modify','active',1,0);"
```
In one terminal `npm run dev`; in another:
```bash
npx @modelcontextprotocol/inspector@2.5.0 --cli http://localhost:8787/mcp --transport http --header "Authorization: Bearer dev-token" --method tools/list
```
Expected: the four tool names.

- [x] **Step 8: full suite and typecheck**

```bash
npm run typecheck && npm test
```
Expected: all green, then `git add package-lock.json worker/worker-configuration.d.ts` if either changed.

- [x] **Step 9: commit**

```bash
git add worker/src worker/test
git commit -m "feat(worker): dev-gated /mcp endpoint with protocol-level tests

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Plan self-review

**Spec coverage for this plan's scope**

| Spec item | Task |
|---|---|
| 2.1 actions and defaults | 2 |
| 2.2 modifiers raise only, `+external`, `+bulk` | 2, 6, 8 |
| 2.7 caps, blocked set (uploads) | 7, 9 (payload cap), 10 (file cap) |
| 2.8 recipient trust rules, case handling | 6 |
| 3.1 identity root | 12 (principal from auth, never from args); 8 (ownership verified in the engine) |
| 3.2 schema, ownership FKs incl. operation references, partial indexes, `_assert` | 3 |
| 3.3 keyring, AAD framing | 4 |
| 3.4 strict JCS, stored-bytes hash, state machine, atomic claim from approved payload, terminal purge | 5, 9, 11 |
| 3.5 journal rows, payload-bound atomic idempotency | 9 (execution itself is Plan 3) |
| 3.7 handles, hold, reservation, consume clears reservation, ack TTL, purge | 9, 10, 11 |
| 3.10 structured audit, redaction enforced by the module | 11 |
| cron, bounded and transactional | 11 |

Not in this plan by design: 2.3 Gmail tools, 3.5 send pipeline, 3.6 upload intent endpoint, 3.8 MIME, 3.9 Google error handling, all of section 4, the companion. `extendExpiry`, `finishPending`, `JOURNALED_ACTIONS` and `handlesFromPayload` are consumed by Plan 3's tool layer.

**Placeholder scan:** none.

**Type consistency:** `Principal` (Task 12) consumed by `server.ts`; `PendingRow.execution_started_at` (Task 9) matches the column (Task 3); `claimPending` returns `handles` (Task 9) and reads `StagingHandle` (Task 2); `insertOperation` fixture (Task 3) used by Tasks 10 and 11; `recoverClaimed` exported from `cron.ts` and imported by its test; `hashCanonical` (Task 5) used by `createPending` (Task 9); `AuditFacts` shape shared by Task 11's test.

**Settled by measurement, not left to first install:** package versions; `agents/mcp/server` export; `createMcpHandler(factory)(request, env, ctx)` call shape (Cloudflare handler API docs); `z.object` input schemas (MCP SDK v2 docs); `cloudflare:test` exports `env`, `SELF`, `applyD1Migrations`; `readD1Migrations` and `cloudflareTest({ miniflare: { bindings } })` from the unpacked plugin; `R2Bucket.delete(keys[])`; `FixedLengthStream` erroring on short or long writes.

**Two behaviours a first run must confirm:** whether `readD1Migrations` is importable from the package root or only from `/config` (Task 1 names both), and whether the stateless handler serves a 2025-style `initialize` + `tools/list` without `_meta` negotiation (Task 12 names the adjustment).
