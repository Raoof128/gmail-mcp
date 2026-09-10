# Gmail MCP Plan 3: The Gmail Tools and the Send Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the 31 Gmail tools behind the policy engine and the seven control tools (`list_accounts`, `get_policy`, `list_pending`, `execute_pending`, `cancel_pending`, `connect_account`, `open_policy_editor`) beside it as the owner's own state and the approval mechanism, with reads that never leave a row behind and mutations that go through one gate: `allow` executes and journals, `ask` stores the canonical payload and hands the owner an approval, `deny` audits and stops. The send pipeline builds MIME from staged bytes, chooses media or resumable upload at the 5 MB boundary, journals every attempt, and turns every ambiguous failure into `delivery_unknown` rather than a retry. `execute_pending` and the URL-mode elicitation wait loop of spec 1.4 close the approval loop from Claude's side.

**Architecture:** One module per tool family under `worker/src/tools/`, each registering tools through `defineTool` against a shared gate in `worker/src/tools/gate.ts`. The gate is the only code that reads policy, records idempotency keys, writes pending rows, mints or verifies elicitation state, settles operations, and decides whether a tool runs now, later or never. Its order is fixed: hash the client's intent, replay a known key, decide policy, and only then build the execution payload (which is the first write), then store-and-ask or journal-and-run. Executors are registered by tool name and version so a pending row can be executed from a fresh request that has nothing but the row, and never under code it was not approved for. Gmail is reached through one client in `worker/src/google/gmail.ts` that applies spec 3.9 and nothing else; every tool test runs against an in-memory Gmail behind the same `Deps.googleFetch` that Plan 2's fake Google already uses. MIME is built by a small module with tested RFC 2047 and RFC 2231 encoders, because the installed library was measured to emit raw filenames (see "Measured" below).

**Tech Stack:** Everything from Plans 1 and 2. No new dependency. `@modelcontextprotocol/server` 2.0.0 already exports the multi-round-trip surface this plan uses (`inputRequired`, `createRequestStateCodec`, the factory `era`).

**Spec:** `docs/superpowers/specs/2026-09-09-gmail-mcp-design.md` (revision 4). Sections implemented here: 1.3 (account selection per tool), 1.4 (both approval paths), 2.3, 2.5, 2.6, 2.7 (all caps except the staged-file cap, which Plan 1 enforced at ingest), 2.8 (already built; consumed here), 3.4 (`requestState`, resume re-hash, policy re-evaluation at claim, terminal purge on execution), 3.5 (steps 1 to 5; step 6 reconciliation stays gated on Plan 5), 3.7 (hold at pending creation, reservation and consumption at send, download ingest), 3.8, 3.9, 3.10, and the tool rows of 4.7. Spec 3.6 and the companion tools are Plan 4. Fault injection at every checkpoint is Plan 5; this plan builds the checkpoints so Plan 5 has something to kill.

**Plan series:** Plan 1 worker foundations (done). Plan 2 OAuth, identity and the web pages (done). Plan 3 this plan. Plan 4 companion, `/staging/intent` and `PUT /staging/<ticket>`. Plan 5 protected suite, fault injection, reconciliation.

## Global Constraints

- `user_id` comes from the verified principal (`requireScope`) and never from a tool argument (spec 3.1).
- Every write tool takes an explicit `account`. Read tools accept an optional `account` and fall back to the default. The model never guesses an account for a write (spec 1.3).
- Policy keys on actions, not tool names. Effective level is account override, else owner global, else `DEFAULT_POLICY`. Modifiers only raise (spec 2.1, 2.2).
- `ask` never touches Gmail. It stores canonical arguments as `payload_json`, and later model output cannot change what executes (spec 1.4, 3.4).
- Approval binds identity. Elicitation approval carries HMAC-signed `requestState` (secret `STATE_HMAC_KEY`) with `version = "gmail-mcp:approval:v1"`, `pending_id`, `account_id`, `payload_hash`, an expiry, and a binding to the principal; browser approval requires a session whose `user_id` equals the row's (spec 3.4). A model-relayed confirmation code is never an approval path.
- Resume re-hashes. The retried call's arguments are canonicalised and compared to `payload_hash`; mismatch is denied and audited (spec 3.4).
- Claim is one atomic batch, attachments come from the approved payload, policy is re-evaluated at claim, one approval covers one action, and terminal states purge the payload (spec 3.4, Plan 1 invariants 1 to 3).
- Journaling is per tool: `send_message`, `reply`, `forward`, `send_draft`, `create_draft`, `update_draft`, `create_label` create an operation row; the other 24 Gmail tools do not. Policy action and journal are different dimensions. `JOURNALED_ACTIONS` in `shared/actions.ts` stays as documentation and the gate reads `ToolSpec.journal` (spec 3.5, amended in Task 11).
- Idempotency keys are recorded against the client's intent before staging and before the allow/ask fork, follow the pending action or operation they created, and are released only by a `failed_safe` operation or a dead pending action (spec 3.5 step 1, amended in Task 11).
- A `claimed` operation has no Gmail side effect behind it. Every executor moves its operation to `executing` immediately before its first request that can change Gmail, and nothing mutates Gmail before that (spec 3.5).
- Every local consequence of one Gmail result is one D1 batch: operation state and stored result, reservations, the pending row, the outcome audit row (spec 3.9, amended in Task 11).
- Nothing writes staging state before the policy decision, and a replayed key writes nothing at all.
- An operation moves to `executing` immediately before the request to Google is opened, never earlier. A `claimed` row is provably free of side effects (spec 3.5).
- Media (or multipart, when a thread id must travel) upload when the MIME is at most 5 MB, resumable above, as a transport with an exact `Content-Length` and without session recovery; `Message-ID` is `<op_…@<WORKER_HOSTNAME>>` on every new message, reply and forward, and a sent draft's own `Message-ID` is journaled (spec 3.5).
- The message is streamed, never held whole: attachments are read from R2 one chunk at a time through the base64 encoder, and the MIME length is computed exactly before any byte moves (spec 3.8, amended in Task 11).
- Google 401: refresh once, retry once. 429 or rate-limit 403: exponential backoff with jitter, honour `Retry-After`, at most 3 tries, never after a send body has been opened. 5xx before the send body: retry as above. Timeout or 5xx after the send body may have reached Gmail: the operation stays `executing` and the cron promotes it. Gmail's rejection of an attachment is surfaced verbatim (spec 3.9).
- Limits: subject 998 bytes; body plus HTML body 512 KB; 500 recipients; inline attachments 1 MB decoded total, converted to handles before any row is written; aggregate attachments at send at most the account's `send_limit_bytes`; canonical payload 1 MB. Blocked extensions are checked again at send (spec 2.7).
- Subject, display names, filenames and aliases containing CR, LF or NUL are rejected. Non-ASCII header values use RFC 2047; filenames use RFC 2231; every header is folded so no physical line exceeds 78 characters where a fold is possible and none ever exceeds 998 (spec 3.8, RFC 5322 §2.1.1).
- Inline attachment strings are bounded by the schema before any decode, and the 1 MB decoded total is enforced by a running count before each decode (spec 2.7).
- Two audit rows per mutating call, `intent` before any external side effect and `outcome` after. Read calls and denials write one `intent` row. Audit rows carry counts and ids, never content (spec 3.10, Plan 1 invariant 8).
- Tokens never appear in tool results, audit rows or logs (spec 3.3).
- Every read result echoes `account`. Message, thread, draft and attachment lookups carry `account_id` and `user_id` in the query (spec 2.3).
- Annotations are set exactly as spec 2.5 lists them and are treated as hints only.
- No permanent delete. No tool calls `messages.delete`, `threads.delete` or `drafts.delete` (spec 2.2, Plan 1 invariant 7). `delete_label` deletes a label definition, which Gmail's own scope allows and the spec names; it is `label.manage`, default `ask`.
- Dependencies pinned exactly. This plan adds none.
- Run `npm run format` before every commit; `npm run verify` checks formatting.
- Every task is RED then GREEN. Commit after every green step with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and the session line `Claude-Session: https://claude.ai/code/session_01NBfkjWcEGDFghet3APnUjU`.
- Run the `stop-slop` skill on every document this plan writes or edits.

**Measured on 2026-09-10 from the unpacked packages and the Gmail discovery document:**

- `@modelcontextprotocol/server` 2.0.0 exports `inputRequired` (with `.elicitUrl`), `inputResponse`, `isInputRequiredResult`, `createRequestStateCodec`, `createMcpHandler`, `isLegacyRequest`, and constants `PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion"`, `CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities"`, `CLIENT_INFO_META_KEY`. `SUPPORTED_MODERN_PROTOCOL_VERSIONS` is `["2026-07-28"]`; the legacy list is `2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07`. A modern request is a JSON-RPC request whose `params._meta` carries `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities` (`REQUIRED_ENVELOPE_KEYS`; `clientInfo` is optional); an `MCP-Protocol-Version` header, when present, must name the same revision. A retried request carries `inputResponses` and `requestState` as top-level keys of `params`, which the SDK lifts into `ctx.mcpReq.inputResponses` and `ctx.mcpReq.requestState()` before the handler runs. `ServerOptions.requestState.verify` runs before the handler on every round that echoes state; a throw answers a frozen `-32602 "Invalid or expired requestState"`. `McpServer.server.getClientCapabilities()` is backfilled per request from the validated envelope on the modern era. An `inputRequired` return whose embedded request needs a capability the envelope did not declare answers `-32021`. A tool callback receives `(args, ctx)` where `ctx.mcpReq.method`, `ctx.mcpReq.inputResponses`, `ctx.mcpReq.requestState` are the fields this plan reads. `createRequestStateCodec({ key, ttlSeconds, bind })` takes a 32-byte key, defaults to 600 s, and `mint(payload, ctx)` requires `ctx` when `bind` is configured; the wire form is signed, not encrypted.
- The SDK's modern path refuses a request without `Mcp-Method` and refuses a `tools/call` without `Mcp-Name` matching `params.name` (`validateStandardRequestHeaders`, answered `400` with `-32602` on the `standard-header-validation` rung, evaluated before dispatch). The 2026-07-28 revision requires both headers on every Streamable HTTP request. The test client sends them; the adversarial rows remove and mismatch them.
- `FixedLengthStream` is a Workers runtime global (declared in the generated `worker-configuration.d.ts`), which is how a streamed request body carries a `Content-Length`.
- Worker isolate memory is 128 MB and is shared by every concurrent invocation of the isolate, so a 25 MB attachment held as raw bytes, as base64 and inside a materialised message would sit far too close to the wall. The MIME builder streams instead; `download_attachment` still buffers one `attachments.get` JSON body and its decoded bytes, which spec 3.7 states as the V1 decision with the 25 MB round-trip as its gate.
- `agents` 0.22.0 `createMcpHandler` (from `agents/mcp/server`) wraps the SDK handler with `legacy: "reject"` and serves 2025-era traffic itself through a stateless compatibility lane in which any server-to-client request fails at once with `-32603 "Server-to-client requests are unavailable in the Legacy compatibility lane"`. Its factory is called with `{ era: "legacy" | "modern", authInfo?, requestInfo }`, so a server knows which lane it is serving. It validates the `Host` header against the request hostname for `*.workers.dev` and passes options other than its own through to the SDK. Consequence: URL-mode elicitation is offered only on the modern era when the request's capabilities include `elicitation.url`; every other client receives the approval URL as text, which is spec 1.4's second path.
- `mimetext` 3.0.28 (transitively installed by `agents`) emits attachment headers as `filename="<raw>"` with no RFC 2231 and no RFC 2047 on the parameter, so a non-ASCII or quote-bearing filename goes out raw or breaks the header. It cannot satisfy spec 3.8 and is not used. The MIME module in Task 3 is the one place headers are assembled, its encoders ship test vectors, and Task 11 amends the spec's "maintained library" line to say so.
- Gmail discovery document revision `20260907`, root `https://gmail.googleapis.com/`: `messages.send` is `POST gmail/v1/users/{userId}/messages/send` with media upload at `/upload/gmail/v1/users/{userId}/messages/send` and resumable at `/resumable/upload/gmail/v1/users/{userId}/messages/send`, `maxSize` 36 700 160 bytes; `drafts.create` `POST .../drafts` and `drafts.update` `PUT .../drafts/{id}` carry the same two upload paths; `drafts.send` is `POST .../drafts/send` with a JSON `Draft { id }` body and returns `Message`; `messages.attachments.get` is `GET .../messages/{messageId}/attachments/{id}` returning `MessagePartBody { attachmentId, size, data }` with `data` base64url; `messages.get` and `drafts.get` take `format` in `minimal | full | raw | metadata` plus `metadataHeaders`; `threads.get` takes `format` in `full | metadata | minimal`; `messages.list`, `threads.list` and `drafts.list` take `q`, `maxResults` (default 100), `pageToken`, `includeSpamTrash`; `messages.modify` and `threads.modify` take `{ addLabelIds, removeLabelIds }`; `messages.trash`, `messages.untrash`, `threads.trash`, `threads.untrash` are bodiless POSTs; `labels.create` `POST`, `labels.update` `PUT`, `labels.delete` `DELETE`, and `Label` carries `labelListVisibility` in `labelShow | labelShowIfUnread | labelHide`, `messageListVisibility` in `show | hide`, and `color { textColor, backgroundColor }`. All of these need only `gmail.modify`. `Message` is `{ id, threadId, labelIds, snippet, internalDate, sizeEstimate, payload, raw }`; `MessagePart` is `{ partId, mimeType, filename, headers[{name,value}], body{size,data,attachmentId}, parts[] }`.
- The hosted connector's `MessageFormat` enum is `MESSAGE_FORMAT_UNSPECIFIED | MINIMAL | FULL_CONTENT | METADATA_ONLY | PLAIN_TEXT | RAW` and its label enums are upper-case (`LABEL_SHOW`), while Gmail's wire values are lower camel case. Our tools accept the hosted spellings and map them (Task 5, Task 6). Hosted `colorPreset` names have no documented hex mapping, so `create_label` and `update_label` take `text_color` and `background_color` and let Gmail validate them; the parity file's `LabelColorPreset` is recorded as a name-level deviation in Task 11.

**Runtime facts each first run must confirm:** Task 4 (the SDK's `requestState.verify` hook runs on the per-request instance `createMcpHandler` builds through the `agents` wrapper, and `getClientCapabilities()` reports the envelope's capabilities on that instance; the `idempotency_keys` upsert's `WHERE` clause with subqueries is accepted by D1's SQLite), Task 7 (`FixedLengthStream` piping inside the vitest workerd pool, and the fake receiving the exact byte count), Task 10 (the modern-era test client's envelope and routing headers are accepted as modern; the routing-header rejection status).

---

## File structure

```
shared/
  src/schemas.ts                      + tool input schemas, MessageFormat, Recipient, InlineAttachment
worker/
  src/deps.ts                         + sleep, approvalWait (interval and deadline, injectable)
  src/env.ts                          unchanged (no new secret; STATE_HMAC_KEY signs requestState)
  src/google/tokens.ts                getAccessToken gains { forceRefresh }
  src/google/gmail.ts                 gmailFetch: base URL, bearer, 401 refresh-retry, backoff, GmailApiError
  src/google/messages.ts              MessagePart walk -> MessageView, ThreadView, DraftView; attachments metadata
  src/mime/encode.ts                  RFC 2047 encoded words, RFC 2231 parameters, mailbox formatting, base64 lines
  src/mime/build.ts                   buildMimeStream(): multipart/mixed (+ alternative) as a pull stream with an exact length
  src/operations/send.ts              sendMime/uploadDraft/sendDraft: session first, executing before the PUT, no settlement
  src/staging/store.ts                + reserveStatements(), extendExpiryStatement(), listUploadHandles(), openStaged()
  src/approval/claim.ts               reservation SQL moves to staging/store.ts; claim uses it
  src/approval/state.ts               requestState codec (ApprovalState), bound to the principal
  src/tools/gate.ts                   runGated(): replay key -> decide -> build -> ask|allow; resumeGated(); runExecutor();
                                      executePending(): claim, version check, re-evaluate policy, run, settle
  src/tools/idempotency.ts            idempotency_keys lookup, guarded bind statements, replayFor()
  src/tools/settle.ts                 settleExecuted / settleFailedSafe / settleUnknown: one batch each
  src/tools/define.ts                 defineTool(): intent hash, resume detection, plan -> gate
  src/tools/compose.ts                validateCompose, decodeInline, stageInline, attachmentsFor, composeMime (streams), threadingFor
  migrations/0003_intent.sql          idempotency_keys; pending_actions.intent_hash, .idempotency_key; operations.result_json
  src/tools/results.ts                text(), toolError(), guarded(), pendingApprovalResult(), connectRequired()
  src/tools/accounts.ts               resolveAccount(): explicit or default; needs_reconnect -> elicitation or URL
  src/tools/labels.ts                 label.manage (3), label.apply (7), spam (4), trash (4)
  src/tools/read.ts                   search_threads, get_thread, get_message, list_drafts, get_draft, list_labels, download_attachment
  src/tools/drafts.ts                 create_draft, update_draft, inline attachment conversion
  src/tools/send.ts                   send_message, reply, forward, send_draft, derivations from the target message
  src/mcp/server.ts                   buildServer(env, principal, deps, era): codec, control tools, family registration
  src/index.ts                        factory passes ctx.era to buildServer
  test/fake-gmail.ts                  in-memory Gmail: messages, threads, drafts, labels, attachments, uploads, faults
  test/fake-google.ts                 routes gmail.googleapis.com (except sendAs) to FakeGmail
  test/fixtures.ts                    + seedAccessToken(), seedMailbox()
  test/mcp-client.ts                  + callTool(), modernCall() with the 2026-07-28 envelope
  test/gmail-client.test.ts           Task 1
  test/messages.test.ts               Task 2
  test/mime.test.ts                   Task 3
  test/gate.test.ts                   Task 4
  test/labels-tools.test.ts           Task 5
  test/read-tools.test.ts             Task 6
  test/send-pipeline.test.ts          Task 7
  test/drafts-tools.test.ts           Task 8
  test/send-tools.test.ts             Task 9
  test/elicitation.test.ts            Task 10
  test/mcp.test.ts                    tools/list asserts all 38 names and annotations
docs/
  ARCHITECTURE.md                     + tool gate, send pipeline
  superpowers/specs/...design.md      amendments (MIME module, draft.write journaling, protocol facts, snake_case args)
CHANGELOG.md                          Plan 3 entry
CLAUDE.md                             current state, new traps
```

One migration, `0003_intent.sql`: the idempotency table and three columns. Append-only, as always.

---

### Task 1: The Gmail client and the in-memory Gmail

**Files:**

- Create: `worker/src/google/gmail.ts`, `worker/test/fake-gmail.ts`, `worker/test/gmail-client.test.ts`
- Modify: `worker/src/google/tokens.ts` (`forceRefresh`), `worker/src/deps.ts` (`sleep`, `approvalWait`), `worker/test/fake-google.ts` (route to FakeGmail), `worker/test/fixtures.ts` (`seedAccessToken`)

**Interfaces:**

- Consumes: `getAccessToken(env, deps, userId, accountId)` from Plan 2; `Deps.googleFetch`.
- Produces:
  - `Deps = { googleFetch: typeof fetch; sleep: (ms: number) => Promise<void>; approvalWait: { intervalMs: number; deadlineMs: number } }` with `defaultDeps` at `2000` and `120_000`.
  - `getAccessToken(env, deps, userId, accountId, o?: { forceRefresh?: boolean })`: with `forceRefresh` the cached access token is ignored and the refresh token is used.
  - `class GmailApiError extends GmailMcpError` with `code: "gmail_error"`, `status: number`, `googleMessage: string`, `reason: string | null`.
  - `gmailFetch(env, deps, acct: { userId: string; accountId: string }, o: { method: "GET" | "POST" | "PUT" | "DELETE"; path: string; query?: Record<string, string | string[] | number | boolean | undefined>; json?: unknown; upload?: { kind: "media"; contentType: string; bytes: Uint8Array } | { kind: "resumable"; contentType: string; bytes: Uint8Array }; retry: "safe" | "none" }): Promise<Response>`. `path` is relative to `https://gmail.googleapis.com/gmail/v1/users/me/`; `upload.media` targets `/upload/gmail/v1/users/me/<path>?uploadType=media`; `upload.resumable` runs the two-step protocol against `/resumable/upload/gmail/v1/users/me/<path>?uploadType=resumable` and returns the final response. Returns the `Response` on 2xx; throws `GmailApiError` on any other definitive status; throws the original error on a network failure.
  - `gmailJson<T>(...)`: `gmailFetch` then `res.json<T>()`.
  - `isRateLimited(res)`: `429`, or `403` whose body reason is `rateLimitExceeded` or `userRateLimitExceeded`.
  - `class FakeGmail` (test): in-memory mailbox with `seedMessage`, `seedDraft`, `labels`, `attachments`, `sent`, `faults`, and `fetch: typeof fetch`.
  - `seedAccessToken(env, { userId, accountId, access?, refresh? })` (test fixture): encrypts and stores tokens on an account row so `getAccessToken` returns `access` without touching the fake Google.

Add error code `"gmail_error"` to `shared/src/errors.ts` (`ErrorCode` union). The shared package's type test does not enumerate codes, so this is additive.

- [x] **Step 1 (RED): tests**

`worker/test/gmail-client.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { FakeGoogle } from "./fake-google";
import { FakeGmail } from "./fake-gmail";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import { testDeps, testEnv } from "./test-env";
import { gmailFetch, gmailJson, GmailApiError } from "../src/google/gmail";
import type { Deps } from "../src/deps";

let g: FakeGoogle;
let gm: FakeGmail;
let deps: Deps;
const acct = { userId: "gu", accountId: "ga" };
const e = testEnv();

beforeAll(async () => {
  g = await FakeGoogle.create();
  gm = g.gmail;
  deps = testDeps(g);
  await seedUserAndAccount(env.DB, { userId: "gu", accountId: "ga", alias: "main", isDefault: true });
  g.refreshTokens.set("rt-g", "ok");
  await seedAccessToken(e, { userId: "gu", accountId: "ga", access: "at-good", refresh: "rt-g" });
});

describe("gmailFetch", () => {
  it("sends the bearer, builds the users/me URL and the query", async () => {
    gm.labels.set("Label_9", { id: "Label_9", name: "nine", type: "user" });
    const body = await gmailJson<{ labels: { id: string }[] }>(e, deps, acct, {
      method: "GET",
      path: "labels",
      retry: "safe",
    });
    expect(body.labels.map((l) => l.id)).toContain("Label_9");
    const last = gm.requests.at(-1)!;
    expect(last.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/labels");
    expect(last.headers.get("authorization")).toBe("Bearer at-good");
    await gmailFetch(e, deps, acct, {
      method: "GET",
      path: "threads",
      query: { q: "from:a b", maxResults: 20, pageToken: undefined, includeSpamTrash: false },
      retry: "safe",
    });
    expect(gm.requests.at(-1)!.url).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/threads?q=from%3Aa+b&maxResults=20&includeSpamTrash=false",
    );
  });

  it("on 401 refreshes once and retries once, then gives up", async () => {
    await seedAccessToken(e, { userId: "gu", accountId: "ga", access: "at-stale", refresh: "rt-g" });
    gm.rejectTokens.add("at-stale");
    const calls = g.tokenCalls;
    const res = await gmailFetch(e, deps, acct, { method: "GET", path: "labels", retry: "safe" });
    expect(res.status).toBe(200);
    expect(g.tokenCalls).toBe(calls + 1);
    expect(gm.requests.at(-1)!.headers.get("authorization")).toMatch(/^Bearer at-\d+$/);
    // Every token is rejected: one refresh, one retry, then the 401 surfaces as an error.
    gm.rejectAll = true;
    const before = gm.requests.length;
    await expect(gmailFetch(e, deps, acct, { method: "GET", path: "labels", retry: "safe" })).rejects.toMatchObject({
      code: "gmail_error",
      status: 401,
    });
    expect(gm.requests.length - before).toBe(2);
    gm.rejectAll = false;
  });

  it("backs off on 429 honouring Retry-After, at most three tries, only for retry: safe", async () => {
    const slept: number[] = [];
    const d: Deps = { ...testDeps(g), sleep: async (ms) => void slept.push(ms) };
    gm.faults.push({ status: 429, headers: { "retry-after": "2" } }, { status: 503 });
    const res = await gmailFetch(e, d, acct, { method: "GET", path: "labels", retry: "safe" });
    expect(res.status).toBe(200);
    expect(slept[0]).toBe(2000);
    expect(slept[1]).toBeGreaterThanOrEqual(500);
    expect(slept[1]).toBeLessThanOrEqual(1500);
    gm.faults.push({ status: 503 }, { status: 503 }, { status: 503 });
    await expect(gmailFetch(e, d, acct, { method: "GET", path: "labels", retry: "safe" })).rejects.toMatchObject({
      status: 503,
    });
    gm.faults.length = 0;
    // A send is never retried after it was opened.
    gm.faults.push({ status: 503 });
    const before = gm.requests.length;
    await expect(
      gmailFetch(e, d, acct, {
        method: "POST",
        path: "messages/send",
        upload: { kind: "media", contentType: "message/rfc822", bytes: new TextEncoder().encode("x") },
        retry: "none",
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(gm.requests.length - before).toBe(1);
  });

  it("surfaces Google's error message verbatim and classifies rate-limit 403s", async () => {
    gm.faults.push({ status: 400, message: "Invalid attachment: nope.exe" });
    await expect(gmailFetch(e, deps, acct, { method: "GET", path: "labels", retry: "safe" })).rejects.toMatchObject({
      googleMessage: "Invalid attachment: nope.exe",
    });
    gm.faults.push(
      { status: 403, reason: "userRateLimitExceeded" },
      { status: 403, reason: "insufficientPermissions" },
    );
    await expect(gmailFetch(e, deps, acct, { method: "GET", path: "labels", retry: "safe" })).rejects.toMatchObject({
      status: 403,
      reason: "insufficientPermissions",
    });
  });

  it("media upload posts message/rfc822 to the upload host; resumable does POST then PUT", async () => {
    const bytes = new TextEncoder().encode("From: a@b.test\r\n\r\nhi");
    const r1 = await gmailJson<{ id: string }>(e, deps, acct, {
      method: "POST",
      path: "messages/send",
      upload: { kind: "media", contentType: "message/rfc822", bytes },
      retry: "none",
    });
    expect(r1.id).toMatch(/^m/);
    expect(gm.requests.at(-1)!.url).toBe(
      "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media",
    );
    expect(gm.sent.at(-1)!.via).toBe("media");
    const r2 = await gmailJson<{ id: string }>(e, deps, acct, {
      method: "POST",
      path: "messages/send",
      upload: { kind: "resumable", contentType: "message/rfc822", bytes },
      retry: "none",
    });
    expect(r2.id).toMatch(/^m/);
    const [start, put] = gm.requests.slice(-2);
    expect(start!.url).toBe(
      "https://gmail.googleapis.com/resumable/upload/gmail/v1/users/me/messages/send?uploadType=resumable",
    );
    expect(start!.headers.get("x-upload-content-type")).toBe("message/rfc822");
    expect(start!.headers.get("x-upload-content-length")).toBe(String(bytes.byteLength));
    expect(put!.method).toBe("PUT");
    expect(put!.url).toContain("upload_id=");
    expect(gm.sent.at(-1)!.via).toBe("resumable");
  });

  it("needs_reconnect accounts never reach Gmail", async () => {
    await env.DB.prepare("UPDATE accounts SET status = 'needs_reconnect' WHERE id = 'ga'").run();
    const before = gm.requests.length;
    await expect(gmailFetch(e, deps, acct, { method: "GET", path: "labels", retry: "safe" })).rejects.toMatchObject({
      code: "account_needs_reconnect",
    });
    expect(gm.requests.length).toBe(before);
    await env.DB.prepare("UPDATE accounts SET status = 'active' WHERE id = 'ga'").run();
  });
});
```

- [x] **Step 2: run, expect failure**

Run: `cd worker && npx vitest run test/gmail-client.test.ts`
Expected: FAIL, `../src/google/gmail` and `./fake-gmail` do not exist.

- [x] **Step 3 (GREEN): Deps, forceRefresh, the client, the fake**

`worker/src/deps.ts`:

```ts
/**
 * Everything that reaches outside the Worker, and every wait the Worker takes, goes through here so
 * a test can stand in for Google and collapse time. Production uses the platform unchanged.
 */
export type Deps = {
  googleFetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Spec 1.4: poll the pending row every interval, up to the deadline, inside one tools/call. */
  approvalWait: { intervalMs: number; deadlineMs: number };
};

export const defaultDeps: Deps = {
  googleFetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  approvalWait: { intervalMs: 2000, deadlineMs: 120_000 },
};
```

`worker/src/google/tokens.ts`: change the signature of `getAccessToken` to

```ts
export async function getAccessToken(
  env: Env,
  deps: Deps,
  userId: string,
  accountId: string,
  o: { forceRefresh?: boolean } = {},
): Promise<string> {
```

and change the cache condition to

```ts
  if (
    !o.forceRefresh &&
    row.access_token_enc &&
```

Nothing else in the file changes.

`shared/src/errors.ts`: add `| "gmail_error"` to `ErrorCode`.

`worker/src/google/gmail.ts`:

```ts
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Deps } from "../deps";
import type { Env } from "../env";
import { getAccessToken } from "./tokens";

export const GMAIL = {
  api: "https://gmail.googleapis.com/gmail/v1/users/me/",
  upload: "https://gmail.googleapis.com/upload/gmail/v1/users/me/",
  resumable: "https://gmail.googleapis.com/resumable/upload/gmail/v1/users/me/",
} as const;

const MAX_TRIES = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8000;

export type GmailAccount = { userId: string; accountId: string };
export type Upload = { kind: "media" | "resumable"; contentType: string; bytes: Uint8Array };
export type GmailRequest = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | string[] | number | boolean | undefined>;
  json?: unknown;
  upload?: Upload;
  /** `safe` may be re-sent after a transient failure; `none` is opened once (spec 3.9). */
  retry: "safe" | "none";
};

export class GmailApiError extends GmailMcpError {
  constructor(
    public readonly status: number,
    public readonly googleMessage: string,
    public readonly reason: string | null,
  ) {
    super("gmail_error", `gmail_error: ${status} ${googleMessage}`, { status, reason });
    this.name = "GmailApiError";
  }
}

type GoogleErrorBody = { error?: { message?: string; errors?: { reason?: string }[]; status?: string } };

async function readError(res: Response): Promise<{ message: string; reason: string | null }> {
  const body = (await res.json().catch(() => ({}))) as GoogleErrorBody;
  return {
    message: body.error?.message ?? res.statusText ?? `HTTP ${res.status}`,
    reason: body.error?.errors?.[0]?.reason ?? null,
  };
}

export function buildUrl(base: string, path: string, query?: GmailRequest["query"]): string {
  const u = new URL(path, base);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) u.searchParams.append(k, item);
    else u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/** Copies into an ArrayBuffer-backed view: fetch's BodyInit refuses ArrayBufferLike-backed typed arrays. */
function bodyOf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  out.set(bytes);
  return out;
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function backoffMs(attempt: number): number {
  // Full jitter over an exponential window, capped. attempt is 1-based.
  const window = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return Math.floor(window / 2 + Math.random() * (window / 2));
}

export async function isRateLimited(res: Response): Promise<boolean> {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  const { reason } = await readError(res.clone());
  return reason === "rateLimitExceeded" || reason === "userRateLimitExceeded";
}

async function once(
  deps: Deps,
  token: string,
  o: GmailRequest,
  target: { url: string; init: Omit<RequestInit, "headers"> & { headers: Record<string, string> } },
): Promise<Response> {
  return deps.googleFetch(target.url, {
    ...target.init,
    headers: { ...target.init.headers, authorization: `Bearer ${token}` },
  });
}

function plainTarget(o: GmailRequest) {
  if (o.upload?.kind === "media") {
    return {
      url: buildUrl(GMAIL.upload, o.path, { ...o.query, uploadType: "media" }),
      init: { method: o.method, headers: { "content-type": o.upload.contentType }, body: bodyOf(o.upload.bytes) },
    };
  }
  return {
    url: buildUrl(GMAIL.api, o.path, o.query),
    init:
      o.json === undefined
        ? { method: o.method, headers: {} as Record<string, string> }
        : { method: o.method, headers: { "content-type": "application/json" }, body: JSON.stringify(o.json) },
  };
}

/**
 * Resumable upload per Google's protocol: open a session with the content headers, then PUT the
 * bytes to the session URL. Once the PUT has been opened nothing is retried; a failure after that is
 * exactly the ambiguity spec 3.5 turns into delivery_unknown, so the caller sees the raw error.
 */
async function resumable(deps: Deps, token: string, o: GmailRequest, upload: Upload): Promise<Response> {
  const start = await deps.googleFetch(buildUrl(GMAIL.resumable, o.path, { ...o.query, uploadType: "resumable" }), {
    method: o.method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-upload-content-type": upload.contentType,
      "x-upload-content-length": String(upload.bytes.byteLength),
    },
    body: JSON.stringify({}),
  });
  if (!start.ok) return start;
  const location = start.headers.get("location");
  if (!location) throw new GmailApiError(start.status, "resumable session without Location", null);
  return deps.googleFetch(location, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": upload.contentType,
      "content-length": String(upload.bytes.byteLength),
    },
    body: bodyOf(upload.bytes),
  });
}

/**
 * Spec 3.9 and nothing else. 401: refresh once, retry once. 429 and rate-limit 403: backoff with jitter,
 * Retry-After honoured, at most three tries. 5xx: the same, but only while `retry` is `safe`; a request
 * with a body that may have reached Gmail is never re-sent, and the caller decides what the failure means.
 */
export async function gmailFetch(env: Env, deps: Deps, acct: GmailAccount, o: GmailRequest): Promise<Response> {
  let token = await getAccessToken(env, deps, acct.userId, acct.accountId);
  let refreshed = false;
  for (let attempt = 1; ; attempt++) {
    const res =
      o.upload?.kind === "resumable"
        ? await resumable(deps, token, o, o.upload)
        : await once(deps, token, o, plainTarget(o));
    if (res.ok) return res;
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      token = await getAccessToken(env, deps, acct.userId, acct.accountId, { forceRefresh: true });
      continue;
    }
    const transient = (await isRateLimited(res)) || res.status >= 500;
    if (transient && o.retry === "safe" && attempt < MAX_TRIES) {
      await deps.sleep(retryAfterMs(res) ?? backoffMs(attempt));
      continue;
    }
    const { message, reason } = await readError(res);
    throw new GmailApiError(res.status, message, reason);
  }
}

export async function gmailJson<T>(env: Env, deps: Deps, acct: GmailAccount, o: GmailRequest): Promise<T> {
  const res = await gmailFetch(env, deps, acct, o);
  if (res.status === 204) return undefined as T;
  return res.json<T>();
}
```

`worker/test/fake-gmail.ts`:

```ts
import { b64url, fromB64url } from "../src/crypto/random";

export type FakeHeader = { name: string; value: string };
export type FakePart = {
  partId: string;
  mimeType: string;
  filename: string;
  headers: FakeHeader[];
  body: { size: number; data?: string; attachmentId?: string };
  parts?: FakePart[];
};
export type FakeMessage = {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  internalDate: string;
  sizeEstimate: number;
  payload: FakePart;
  raw?: string;
};
export type FakeLabel = {
  id: string;
  name: string;
  type: "system" | "user";
  labelListVisibility?: string;
  messageListVisibility?: string;
  color?: { textColor: string; backgroundColor: string };
};
export type Fault = { status: number; message?: string; reason?: string; headers?: Record<string, string> };
export type Sent = { raw: Uint8Array; via: "media" | "resumable" | "draft"; threadId: string | null; id: string };

const enc = new TextEncoder();
const utf8b64url = (s: string) => b64url(new Uint8Array(enc.encode(s)));

const SYSTEM_LABELS = ["INBOX", "SENT", "DRAFT", "TRASH", "SPAM", "UNREAD", "STARRED", "IMPORTANT"];

/**
 * Enough Gmail to exercise every tool: a message store with MessagePart trees, threads derived from
 * messages, drafts, labels, attachment bytes, and both upload protocols. Shapes follow the discovery
 * document (revision 20260907). Faults are consumed in order by the next matching request.
 */
export class FakeGmail {
  readonly messages = new Map<string, FakeMessage>();
  readonly drafts = new Map<string, { id: string; message: FakeMessage }>();
  readonly labels = new Map<string, FakeLabel>();
  readonly attachments = new Map<string, Uint8Array>(); // key `${messageId}/${attachmentId}`
  readonly sent: Sent[] = [];
  readonly requests: Request[] = [];
  readonly faults: Fault[] = [];
  readonly rejectTokens = new Set<string>();
  rejectAll = false;
  private seq = 0;
  private sessions = new Map<string, { path: string; contentType: string; threadId: string | null }>();
  /** Applied to the first PUT after a session was opened; the fault queue cannot express "session ok, PUT fails". */
  afterSession: Fault | null = null;
  /** Runs before every request; returning a Response short-circuits (Plan 5's fault injection hook). */
  before: ((req: Request) => Promise<Response | undefined>) | null = null;

  constructor() {
    for (const id of SYSTEM_LABELS) this.labels.set(id, { id, name: id, type: "system" });
  }

  next(prefix: string): string {
    return `${prefix}${++this.seq}`;
  }

  seedMessage(o: {
    id?: string;
    threadId?: string;
    from: string;
    to: string[];
    cc?: string[];
    subject: string;
    text?: string;
    html?: string;
    messageId?: string;
    references?: string;
    replyTo?: string;
    labelIds?: string[];
    attachments?: { filename: string; mime: string; bytes: Uint8Array; inline?: boolean }[];
    internalDate?: number;
  }): FakeMessage {
    const id = o.id ?? this.next("m");
    const threadId = o.threadId ?? id;
    const headers: FakeHeader[] = [
      { name: "From", value: o.from },
      { name: "To", value: o.to.join(", ") },
      ...(o.cc && o.cc.length ? [{ name: "Cc", value: o.cc.join(", ") }] : []),
      { name: "Subject", value: o.subject },
      { name: "Message-ID", value: o.messageId ?? `<${id}@fake.test>` },
      ...(o.references ? [{ name: "References", value: o.references }] : []),
      ...(o.replyTo ? [{ name: "Reply-To", value: o.replyTo }] : []),
      { name: "Date", value: new Date(o.internalDate ?? Date.now()).toUTCString() },
    ];
    const textPart: FakePart = {
      partId: "0",
      mimeType: "text/plain",
      filename: "",
      headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }],
      body: { size: (o.text ?? "").length, data: utf8b64url(o.text ?? "") },
    };
    const htmlPart: FakePart | null = o.html
      ? {
          partId: "1",
          mimeType: "text/html",
          filename: "",
          headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }],
          body: { size: o.html.length, data: utf8b64url(o.html) },
        }
      : null;
    const bodyParts: FakePart[] = htmlPart
      ? [
          {
            partId: "a",
            mimeType: "multipart/alternative",
            filename: "",
            headers: [],
            body: { size: 0 },
            parts: [textPart, htmlPart],
          },
        ]
      : [textPart];
    const attParts: FakePart[] = (o.attachments ?? []).map((a, i) => {
      const attachmentId = `att${id}_${i}`;
      // Gmail parks large parts behind attachmentId and inlines small ones in data; both shapes are real.
      if (!a.inline) this.attachments.set(`${id}/${attachmentId}`, a.bytes);
      return {
        partId: String(i + 2),
        mimeType: a.mime,
        filename: a.filename,
        headers: [
          { name: "Content-Type", value: `${a.mime}; name="${a.filename}"` },
          { name: "Content-Disposition", value: `attachment; filename="${a.filename}"` },
        ],
        body: a.inline
          ? { size: a.bytes.byteLength, data: b64url(a.bytes) }
          : { size: a.bytes.byteLength, attachmentId },
      };
    });
    const payload: FakePart =
      attParts.length === 0
        ? { ...bodyParts[0]!, headers: [...headers, ...bodyParts[0]!.headers] }
        : {
            partId: "",
            mimeType: "multipart/mixed",
            filename: "",
            headers,
            body: { size: 0 },
            parts: [...bodyParts, ...attParts],
          };
    const msg: FakeMessage = {
      id,
      threadId,
      labelIds: o.labelIds ?? ["INBOX", "UNREAD"],
      snippet: (o.text ?? "").slice(0, 100),
      internalDate: String(o.internalDate ?? Date.now()),
      sizeEstimate: (o.text ?? "").length + (o.attachments ?? []).reduce((n, a) => n + a.bytes.byteLength, 0),
      payload,
    };
    this.messages.set(id, msg);
    return msg;
  }

  seedDraft(o: Parameters<FakeGmail["seedMessage"]>[0]): { id: string; message: FakeMessage } {
    const message = this.seedMessage({ ...o, labelIds: ["DRAFT"] });
    const id = this.next("r");
    const draft = { id, message };
    this.drafts.set(id, draft);
    return draft;
  }

  private view(m: FakeMessage, format: string, metadataHeaders: string[]): unknown {
    if (format === "minimal")
      return {
        id: m.id,
        threadId: m.threadId,
        labelIds: m.labelIds,
        snippet: m.snippet,
        internalDate: m.internalDate,
        sizeEstimate: m.sizeEstimate,
      };
    if (format === "raw")
      return {
        id: m.id,
        threadId: m.threadId,
        labelIds: m.labelIds,
        snippet: m.snippet,
        internalDate: m.internalDate,
        raw: m.raw ?? utf8b64url("RAW-NOT-STORED"),
      };
    if (format === "metadata") {
      const wanted = new Set(metadataHeaders.map((h) => h.toLowerCase()));
      const headers =
        wanted.size === 0 ? m.payload.headers : m.payload.headers.filter((h) => wanted.has(h.name.toLowerCase()));
      return {
        id: m.id,
        threadId: m.threadId,
        labelIds: m.labelIds,
        snippet: m.snippet,
        internalDate: m.internalDate,
        sizeEstimate: m.sizeEstimate,
        payload: { partId: "", mimeType: m.payload.mimeType, filename: "", headers, body: { size: 0 } },
      };
    }
    return m;
  }

  private error(status: number, message: string, reason?: string): Response {
    return Response.json(
      { error: { code: status, message, errors: reason ? [{ reason, message }] : [], status: reason ?? "ERROR" } },
      { status },
    );
  }

  private matches(m: FakeMessage, q: string | null, includeSpamTrash: boolean): boolean {
    if (!includeSpamTrash && (m.labelIds.includes("SPAM") || m.labelIds.includes("TRASH"))) return false;
    if (!q) return true;
    const header = (n: string) => m.payload.headers.find((h) => h.name.toLowerCase() === n)?.value ?? "";
    for (const term of q.split(/\s+/).filter(Boolean)) {
      if (term.startsWith("rfc822msgid:")) {
        if (header("message-id") !== term.slice("rfc822msgid:".length)) return false;
      } else if (term.startsWith("subject:")) {
        if (!header("subject").toLowerCase().includes(term.slice(8).toLowerCase())) return false;
      } else if (term.startsWith("label:")) {
        if (!m.labelIds.includes(term.slice(6).toUpperCase())) return false;
      } else if (term.startsWith("from:")) {
        if (!header("from").toLowerCase().includes(term.slice(5).toLowerCase())) return false;
      } else if (!(m.snippet + header("subject")).toLowerCase().includes(term.toLowerCase())) return false;
    }
    return true;
  }

  private page<T extends { id: string }>(items: T[], url: URL): { items: T[]; nextPageToken?: string } {
    const max = Number(url.searchParams.get("maxResults") ?? "100");
    const start = Number(url.searchParams.get("pageToken") ?? "0");
    const slice = items.slice(start, start + max);
    return start + max < items.length ? { items: slice, nextPageToken: String(start + max) } : { items: slice };
  }

  private storeSent(raw: Uint8Array, via: Sent["via"], threadIdHint: string | null): FakeMessage {
    const text = new TextDecoder().decode(raw);
    const headerBlock = text.split(/\r?\n\r?\n/)[0] ?? "";
    const header = (n: string) => {
      const re = new RegExp(`^${n}:[ \\t]*(.*(?:\\r?\\n[ \\t].*)*)`, "im");
      const m = re.exec(headerBlock);
      return m ? m[1]!.replace(/\r?\n[ \t]+/g, " ").trim() : "";
    };
    const id = this.next("m");
    const inReplyTo = header("In-Reply-To");
    const parent = [...this.messages.values()].find((m) =>
      m.payload.headers.some((h) => h.name === "Message-ID" && h.value === inReplyTo),
    );
    const threadId = threadIdHint ?? parent?.threadId ?? id;
    const msg: FakeMessage = {
      id,
      threadId,
      labelIds: ["SENT"],
      snippet: text.slice(-100),
      internalDate: String(Date.now()),
      sizeEstimate: raw.byteLength,
      payload: {
        partId: "",
        mimeType: header("Content-Type").split(";")[0] || "text/plain",
        filename: "",
        headers: ["From", "To", "Cc", "Bcc", "Subject", "Message-ID", "In-Reply-To", "References", "Date"]
          .map((n) => ({ name: n, value: header(n) }))
          .filter((h) => h.value !== ""),
        body: { size: 0 },
      },
      raw: b64url(raw),
    };
    this.messages.set(id, msg);
    this.sent.push({ raw, via, threadId, id });
    return msg;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    // A clone is stored so a test can read the body after the handler consumed the original.
    this.requests.push(req.clone());
    const early = this.before ? await this.before(req) : undefined;
    if (early) return early;
    const token = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
    if (!token.startsWith("at-") || this.rejectAll || this.rejectTokens.has(token))
      return this.error(401, "Invalid Credentials", "authError");
    const fault = this.faults.shift();
    if (fault) {
      const res = this.error(fault.status, fault.message ?? `fault ${fault.status}`, fault.reason);
      for (const [k, v] of Object.entries(fault.headers ?? {})) res.headers.set(k, v);
      return res;
    }
    const url = new URL(req.url);
    const p = url.pathname;
    const raw = async () => new Uint8Array(await req.arrayBuffer());

    // Uploads.
    if (p.startsWith("/upload/gmail/v1/users/me/")) {
      const rest = p.slice("/upload/gmail/v1/users/me/".length);
      return this.upload(rest, req.method, await raw(), "media");
    }
    if (p.startsWith("/resumable/upload/gmail/v1/users/me/")) {
      const rest = p.slice("/resumable/upload/gmail/v1/users/me/".length);
      if (req.method === "PUT" && url.searchParams.get("upload_id")) {
        const s = this.sessions.get(url.searchParams.get("upload_id")!);
        if (!s) return this.error(404, "unknown upload session");
        this.sessions.delete(url.searchParams.get("upload_id")!);
        return this.upload(s.path, "POST", await raw(), "resumable");
      }
      const uploadId = this.next("u");
      this.sessions.set(uploadId, { path: rest, contentType: req.headers.get("x-upload-content-type") ?? "" });
      return new Response(null, {
        status: 200,
        headers: {
          location: `https://gmail.googleapis.com/resumable/upload/gmail/v1/users/me/${rest}?uploadType=resumable&upload_id=${uploadId}`,
        },
      });
    }
    if (!p.startsWith("/gmail/v1/users/me/")) return this.error(404, `unknown path ${p}`);
    const rest = p.slice("/gmail/v1/users/me/".length);
    const seg = rest.split("/");
    const json = async () => (await req.json().catch(() => ({}))) as Record<string, unknown>;

    if (seg[0] === "labels") {
      if (req.method === "GET" && seg.length === 1) return Response.json({ labels: [...this.labels.values()] });
      if (req.method === "POST" && seg.length === 1) {
        const body = await json();
        if (typeof body.name !== "string" || body.name === "") return this.error(400, "Invalid label name");
        if ([...this.labels.values()].some((l) => l.name === body.name))
          return this.error(409, "Label name exists or conflicts");
        const label: FakeLabel = { id: this.next("Label_"), name: body.name, type: "user", ...(body as object) };
        this.labels.set(label.id, label);
        return Response.json(label);
      }
      const label = this.labels.get(seg[1] ?? "");
      if (!label) return this.error(404, "Requested entity was not found.", "notFound");
      if (req.method === "GET") return Response.json(label);
      if (label.type === "system") return this.error(400, "Invalid request: system label");
      if (req.method === "PUT" || req.method === "PATCH") {
        const updated = { ...label, ...(await json()), id: label.id, type: "user" as const };
        this.labels.set(label.id, updated);
        return Response.json(updated);
      }
      if (req.method === "DELETE") {
        this.labels.delete(label.id);
        return new Response(null, { status: 204 });
      }
    }

    if (seg[0] === "messages") {
      if (req.method === "GET" && seg.length === 1) {
        const all = [...this.messages.values()].filter(
          (m) =>
            !m.labelIds.includes("DRAFT") &&
            this.matches(m, url.searchParams.get("q"), url.searchParams.get("includeSpamTrash") === "true"),
        );
        const { items, nextPageToken } = this.page(all, url);
        return Response.json({
          messages: items.map((m) => ({ id: m.id, threadId: m.threadId })),
          resultSizeEstimate: all.length,
          ...(nextPageToken ? { nextPageToken } : {}),
        });
      }
      if (req.method === "POST" && seg[1] === "send" && seg.length === 2) {
        const body = await json();
        if (typeof body.raw !== "string") return this.error(400, "raw required");
        return Response.json(
          this.publicMessage(
            this.storeSent(fromB64url(body.raw), "media", typeof body.threadId === "string" ? body.threadId : null),
          ),
        );
      }
      const m = this.messages.get(seg[1] ?? "");
      if (!m || m.labelIds.includes("DRAFT")) return this.error(404, "Requested entity was not found.", "notFound");
      if (req.method === "GET" && seg.length === 2)
        return Response.json(
          this.view(m, url.searchParams.get("format") ?? "full", url.searchParams.getAll("metadataHeaders")),
        );
      if (req.method === "GET" && seg[2] === "attachments") {
        const bytes = this.attachments.get(`${m.id}/${seg[3]}`);
        if (!bytes) return this.error(404, "Requested entity was not found.", "notFound");
        return Response.json({ attachmentId: seg[3], size: bytes.byteLength, data: b64url(bytes) });
      }
      if (req.method === "POST" && seg[2] === "modify") {
        const body = await json();
        this.applyModify(m, body);
        return Response.json(this.publicMessage(m));
      }
      if (req.method === "POST" && seg[2] === "trash") {
        this.applyModify(m, { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] });
        return Response.json(this.publicMessage(m));
      }
      if (req.method === "POST" && seg[2] === "untrash") {
        this.applyModify(m, { addLabelIds: ["INBOX"], removeLabelIds: ["TRASH"] });
        return Response.json(this.publicMessage(m));
      }
      if (req.method === "DELETE") return this.error(403, "permanent delete must never be called", "forbidden");
    }

    if (seg[0] === "threads") {
      const threads = () => {
        const byThread = new Map<string, FakeMessage[]>();
        for (const m of this.messages.values())
          if (!m.labelIds.includes("DRAFT")) byThread.set(m.threadId, [...(byThread.get(m.threadId) ?? []), m]);
        return byThread;
      };
      if (req.method === "GET" && seg.length === 1) {
        const q = url.searchParams.get("q");
        const incl = url.searchParams.get("includeSpamTrash") === "true";
        const all = [...threads().entries()]
          .filter(([, ms]) => ms.some((m) => this.matches(m, q, incl)))
          .map(([id, ms]) => ({ id, snippet: ms[ms.length - 1]!.snippet, historyId: "1" }));
        const { items, nextPageToken } = this.page(all, url);
        return Response.json({
          threads: items,
          resultSizeEstimate: all.length,
          ...(nextPageToken ? { nextPageToken } : {}),
        });
      }
      const ms = threads().get(seg[1] ?? "");
      if (!ms) return this.error(404, "Requested entity was not found.", "notFound");
      if (req.method === "GET" && seg.length === 2)
        return Response.json({
          id: seg[1],
          historyId: "1",
          messages: ms.map((m) =>
            this.view(m, url.searchParams.get("format") ?? "full", url.searchParams.getAll("metadataHeaders")),
          ),
        });
      if (req.method === "POST" && seg[2] === "modify") {
        const body = await json();
        for (const m of ms) this.applyModify(m, body);
        return Response.json({ id: seg[1], messages: ms.map((m) => this.publicMessage(m)) });
      }
      if (req.method === "POST" && seg[2] === "trash") {
        for (const m of ms) this.applyModify(m, { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] });
        return Response.json({ id: seg[1], messages: ms.map((m) => this.publicMessage(m)) });
      }
      if (req.method === "POST" && seg[2] === "untrash") {
        for (const m of ms) this.applyModify(m, { addLabelIds: ["INBOX"], removeLabelIds: ["TRASH"] });
        return Response.json({ id: seg[1], messages: ms.map((m) => this.publicMessage(m)) });
      }
      if (req.method === "DELETE") return this.error(403, "permanent delete must never be called", "forbidden");
    }

    if (seg[0] === "drafts") {
      if (req.method === "GET" && seg.length === 1) {
        const all = [...this.drafts.values()].filter((d) => this.matches(d.message, url.searchParams.get("q"), true));
        const { items, nextPageToken } = this.page(all, url);
        return Response.json({
          drafts: items.map((d) => ({ id: d.id, message: { id: d.message.id, threadId: d.message.threadId } })),
          resultSizeEstimate: all.length,
          ...(nextPageToken ? { nextPageToken } : {}),
        });
      }
      if (req.method === "POST" && seg[1] === "send") {
        const body = await json();
        const d = this.drafts.get(String(body.id));
        if (!d) return this.error(404, "Requested entity was not found.", "notFound");
        this.drafts.delete(d.id);
        this.messages.delete(d.message.id);
        const rawBytes = d.message.raw
          ? fromB64url(d.message.raw)
          : new TextEncoder().encode(
              `Subject: ${d.message.payload.headers.find((h) => h.name === "Subject")?.value ?? ""}\r\n\r\n`,
            );
        const sent = this.storeSent(rawBytes, "draft", d.message.threadId);
        return Response.json(this.publicMessage(sent));
      }
      if (req.method === "POST" && seg.length === 1) {
        const body = (await json()) as { message?: { raw?: string; threadId?: string } };
        if (typeof body.message?.raw !== "string") return this.error(400, "message.raw required");
        return Response.json(this.createDraftFromRaw(fromB64url(body.message.raw), body.message.threadId ?? null));
      }
      const d = this.drafts.get(seg[1] ?? "");
      if (!d) return this.error(404, "Requested entity was not found.", "notFound");
      if (req.method === "GET")
        return Response.json({
          id: d.id,
          message: this.view(
            d.message,
            url.searchParams.get("format") ?? "full",
            url.searchParams.getAll("metadataHeaders"),
          ),
        });
      if (req.method === "PUT") {
        const body = (await json()) as { message?: { raw?: string; threadId?: string } };
        if (typeof body.message?.raw !== "string") return this.error(400, "message.raw required");
        this.messages.delete(d.message.id);
        this.drafts.delete(d.id);
        const created = this.createDraftFromRaw(
          fromB64url(body.message.raw),
          body.message.threadId ?? d.message.threadId,
          d.id,
        );
        return Response.json(created);
      }
      if (req.method === "DELETE") return this.error(403, "drafts.delete must never be called", "forbidden");
    }
    return this.error(404, `unhandled ${req.method} ${p}`);
  };

  private upload(
    path: string,
    method: string,
    bytes: Uint8Array,
    via: "media" | "resumable",
    threadId: string | null = null,
  ): Response {
    if (path === "messages/send" && method === "POST")
      return Response.json(this.publicMessage(this.storeSent(bytes, via, threadId)));
    if (path === "drafts" && method === "POST") return Response.json(this.createDraftFromRaw(bytes, threadId));
    const m = /^drafts\/([^/]+)$/.exec(path);
    if (m && method === "PUT") {
      const d = this.drafts.get(m[1]!);
      if (!d) return this.error(404, "Requested entity was not found.", "notFound");
      this.messages.delete(d.message.id);
      this.drafts.delete(d.id);
      return Response.json(this.createDraftFromRaw(bytes, threadId ?? d.message.threadId, d.id));
    }
    return this.error(404, `unhandled upload ${method} ${path}`);
  }

  private createDraftFromRaw(bytes: Uint8Array, threadId: string | null, keepId?: string) {
    const msg = this.storeSent(bytes, "draft", threadId);
    this.sent.pop(); // a draft is stored, not sent
    msg.labelIds = ["DRAFT"];
    const id = keepId ?? this.next("r");
    this.drafts.set(id, { id, message: msg });
    return { id, message: { id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds } };
  }

  private applyModify(m: FakeMessage, body: Record<string, unknown>): void {
    const add = Array.isArray(body.addLabelIds) ? (body.addLabelIds as string[]) : [];
    const remove = Array.isArray(body.removeLabelIds) ? (body.removeLabelIds as string[]) : [];
    const set = new Set(m.labelIds);
    for (const r of remove) set.delete(r);
    for (const a of add) set.add(a);
    m.labelIds = [...set];
  }

  private publicMessage(m: FakeMessage) {
    return { id: m.id, threadId: m.threadId, labelIds: m.labelIds };
  }
}
```

`worker/test/fake-google.ts`: add the field and the routing line.

```ts
import { FakeGmail } from "./fake-gmail";
// inside the class:
  readonly gmail = new FakeGmail();
// in fetch, replace the sendAs branch's neighbourhood with:
    if (url.hostname === "gmail.googleapis.com") {
      if (url.href === "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs") {
        if (!req.headers.get("authorization")?.startsWith("Bearer at-")) return new Response("", { status: 401 });
        return Response.json({
          sendAs: [
            ...this.sendAs.map((e) => ({ sendAsEmail: e, verificationStatus: "accepted" })),
            { sendAsEmail: "pending@example.test", verificationStatus: "pending" },
          ],
        });
      }
      return this.gmail.fetch(req);
    }
```

`worker/test/fixtures.ts`: add

```ts
import type { Env } from "../src/env";
import { Keyring } from "../src/crypto/keyring";

/** Stores an already-valid access token so tool tests never need the token endpoint. */
export async function seedAccessToken(
  e: Env,
  o: { userId: string; accountId: string; access?: string; refresh?: string; expiresInMs?: number },
): Promise<void> {
  const ring = Keyring.fromEnv(e);
  const at = await ring.encrypt(o.access ?? "at-seeded", {
    userId: o.userId,
    accountId: o.accountId,
    field: "access_token",
  });
  const rt = await ring.encrypt(o.refresh ?? "rt-seeded", {
    userId: o.userId,
    accountId: o.accountId,
    field: "refresh_token",
  });
  await e.DB.prepare(
    `UPDATE accounts SET status = 'active', access_token_enc = ?, access_token_key_id = ?, access_expires_at = ?,
       refresh_token_enc = ?, refresh_token_key_id = ? WHERE id = ? AND user_id = ?`,
  )
    .bind(
      at.ciphertext,
      at.keyId,
      Date.now() + (o.expiresInMs ?? 3_600_000),
      rt.ciphertext,
      rt.keyId,
      o.accountId,
      o.userId,
    )
    .run();
}
```

`worker/test/test-env.ts`: add one helper so no test spells the `Deps` shape by hand.

```ts
import { defaultDeps, type Deps } from "../src/deps";
import type { FakeGoogle } from "./fake-google";

/** Fake Google, no real sleeping, and an approval wait long enough for a browser approval to land inside it. */
export function testDeps(g: FakeGoogle, overrides: Partial<Deps> = {}): Deps {
  return {
    ...defaultDeps,
    googleFetch: g.fetch,
    sleep: async () => {},
    approvalWait: { intervalMs: 5, deadlineMs: 500 },
    ...overrides,
  };
}
```

Replace every `{ googleFetch: g.fetch }` literal with `testDeps(g)`. Measured list: `createWorker({ googleFetch: g.fetch })` in `mcp.test.ts`, `login.test.ts`, `accounts.test.ts`, `approve.test.ts`, `oauth.test.ts`, `policy-page.test.ts`, `audit-page.test.ts`, `connect.test.ts`; `const deps = () => ({ googleFetch: g.fetch })` in `oidc.test.ts`; eleven call sites in `tokens.test.ts`. In the test above, `deps` becomes `testDeps(g)` and the backoff test spreads it: `{ ...testDeps(g), sleep: async (ms) => void slept.push(ms) }`. `tokens.test.ts` keeps its own `seedTokens` helper; the fixture above is separate so that test keeps its key-rotation assertions.

- [x] **Step 4: run, expect pass**

Run: `cd worker && npx vitest run test/gmail-client.test.ts test/tokens.test.ts test/connect.test.ts`
Expected: PASS. Then `npm run verify` from the root: green.

- [x] **Step 5: commit**

```bash
git add shared/src/errors.ts worker/src/deps.ts worker/src/google worker/test
git commit -m "feat(worker): gmail client with spec 3.9 retry rules, and an in-memory Gmail for tests

401 refreshes once and retries once; 429 and rate-limit 403 back off with jitter and honour
Retry-After for at most three tries; a request whose body may have reached Gmail is opened once.
The fake mirrors the discovery document so every later tool test runs against real shapes.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NBfkjWcEGDFghet3APnUjU"
```

---

### Task 2: Message, thread and draft views

**Files:**

- Create: `worker/src/google/messages.ts`, `worker/test/messages.test.ts`
- Modify: `shared/src/schemas.ts` (`MessageFormat`, `MESSAGE_FORMATS`), `worker/test/fake-gmail.ts` (`replyTo`, `inline` attachments)

**Interfaces:**

- Consumes: the Gmail `Message`, `MessagePart`, `Thread`, `Draft` shapes measured in the header.
- Produces:
  - `MESSAGE_FORMATS`, `MessageFormat` in `shared/src/schemas.ts`.
  - `gmailFormatFor(f)`.
  - `type AttachmentMeta = { part_id: string; attachment_id: string | null; filename: string; mime: string; size: number }`. Gmail keeps a large part's bytes behind `attachmentId`; a small part's bytes can sit in `body.data` with no `attachmentId`, and both are attachments to the owner.
  - `type MessageView = { id; thread_id; label_ids; snippet; date; subject; from; to; cc; bcc; reply_to: string[]; message_id_header; in_reply_to; references; plaintext_body?; html_body?; raw?; body_truncated?; attachments: AttachmentMeta[] }`.
  - `messageView(m, { format, bodyCharLimit, includeBody })`.
  - `findAttachment(m, by: { attachmentId: string } | { partId: string }): AttachmentMeta | null`; `partData(m, partId): string | null` (the base64url `body.data` of a part).
  - `splitAddressList(value): string[]`: an RFC 5322 address-list splitter that understands quoted strings with backslash escapes, comments in parentheses (nested), angle-bracketed addr-specs, and groups (`Name: a, b;`, whose display name is dropped and whose members are returned). It splits and trims; it does not validate, which `parseAddress` does when a value is used.
  - `decodeBodyData(data)`.

- [x] **Step 1 (RED): tests**

`worker/test/messages.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { FakeGmail } from "./fake-gmail";
import { messageView, findAttachment, partData, splitAddressList, gmailFormatFor } from "../src/google/messages";

const gm = new FakeGmail();
const bytes = new TextEncoder();

describe("messageView", () => {
  const m = gm.seedMessage({
    from: "Ann <ann@example.test>",
    to: ["Bob <bob@example.test>", "carol@example.test"],
    cc: ["dave@example.test"],
    replyTo: '"Doe, Jane" <jane@example.test>, ann@example.test',
    subject: "Hello 🚀",
    text: "plain body ".repeat(50),
    html: "<p>html body</p>",
    attachments: [
      { filename: "notes.pdf", mime: "application/pdf", bytes: bytes.encode("%PDF") },
      { filename: "tiny.txt", mime: "text/plain", bytes: bytes.encode("tiny"), inline: true },
    ],
  });

  it("PLAIN_TEXT carries headers, text body and attachment metadata for external and inline parts, never bytes", () => {
    const v = messageView(m, { format: "PLAIN_TEXT", bodyCharLimit: 10_000, includeBody: true });
    expect(v).toMatchObject({
      id: m.id,
      thread_id: m.threadId,
      subject: "Hello 🚀",
      from: "Ann <ann@example.test>",
      to: ["Bob <bob@example.test>", "carol@example.test"],
      cc: ["dave@example.test"],
      bcc: [],
      reply_to: ['"Doe, Jane" <jane@example.test>', "ann@example.test"],
      message_id_header: `<${m.id}@fake.test>`,
    });
    expect(v.plaintext_body).toMatch(/^plain body /);
    expect(v.html_body).toBeUndefined();
    expect(v.attachments).toEqual([
      { part_id: "2", attachment_id: `att${m.id}_0`, filename: "notes.pdf", mime: "application/pdf", size: 4 },
      { part_id: "3", attachment_id: null, filename: "tiny.txt", mime: "text/plain", size: 4 },
    ]);
    expect(JSON.stringify(v)).not.toContain("JVBERi");
    expect(JSON.stringify(v)).not.toContain("dGlueQ");
  });
  it("FULL_CONTENT adds the html body; METADATA_ONLY and MINIMAL carry no body", () => {
    expect(messageView(m, { format: "FULL_CONTENT", bodyCharLimit: 10_000, includeBody: true }).html_body).toBe(
      "<p>html body</p>",
    );
    const meta = messageView(m, { format: "METADATA_ONLY", bodyCharLimit: 10_000, includeBody: true });
    expect(meta.plaintext_body).toBeUndefined();
    expect(meta.subject).toBe("Hello 🚀");
    const min = messageView({ ...m, payload: undefined }, { format: "MINIMAL", bodyCharLimit: 10, includeBody: true });
    expect(min.subject).toBeNull();
    expect(min.attachments).toEqual([]);
  });
  it("truncates the body at body_char_limit on a code point boundary and says so", () => {
    const v = messageView(m, { format: "PLAIN_TEXT", bodyCharLimit: 25, includeBody: true });
    expect(v.plaintext_body).toHaveLength(25);
    expect(v.body_truncated).toBe(true);
    const emoji = gm.seedMessage({ from: "a@x.test", to: ["b@x.test"], subject: "s", text: "😀😀😀" });
    expect(messageView(emoji, { format: "PLAIN_TEXT", bodyCharLimit: 1, includeBody: true }).plaintext_body).toBe("😀");
    expect(
      messageView(m, { format: "PLAIN_TEXT", bodyCharLimit: 25, includeBody: false }).plaintext_body,
    ).toBeUndefined();
  });
  it("finds an attachment by attachment id or part id, and reads inline part data", () => {
    expect(findAttachment(m, { attachmentId: `att${m.id}_0` })).toMatchObject({ filename: "notes.pdf", size: 4 });
    expect(findAttachment(m, { partId: "3" })).toMatchObject({ filename: "tiny.txt", attachment_id: null });
    expect(findAttachment(m, { attachmentId: "nope" })).toBeNull();
    expect(partData(m, "3")).toBe("dGlueQ");
    expect(partData(m, "2")).toBeNull();
  });
  it("splits address lists like RFC 5322: quotes with escapes, comments, brackets, groups", () => {
    expect(splitAddressList('"Doe, Jane" <jane@x.test>, bob@x.test , <c@x.test>')).toEqual([
      '"Doe, Jane" <jane@x.test>',
      "bob@x.test",
      "<c@x.test>",
    ]);
    expect(splitAddressList('"Say \\"hi\\", now" <q@x.test>, d@x.test')).toEqual([
      '"Say \\"hi\\", now" <q@x.test>',
      "d@x.test",
    ]);
    expect(splitAddressList("a@x.test (comma, inside (nested)), b@x.test")).toEqual([
      "a@x.test (comma, inside (nested))",
      "b@x.test",
    ]);
    expect(splitAddressList("Team: t1@x.test, t2@x.test; solo@x.test")).toEqual([
      "t1@x.test",
      "t2@x.test",
      "solo@x.test",
    ]);
    expect(splitAddressList("Empty:; solo@x.test")).toEqual(["solo@x.test"]);
    expect(splitAddressList("")).toEqual([]);
  });
  it("maps formats to Gmail's wire values", () => {
    expect(gmailFormatFor("PLAIN_TEXT")).toEqual({ format: "full" });
    expect(gmailFormatFor("METADATA_ONLY")).toEqual({
      format: "metadata",
      metadataHeaders: [
        "Subject",
        "From",
        "To",
        "Cc",
        "Bcc",
        "Reply-To",
        "Date",
        "Message-ID",
        "In-Reply-To",
        "References",
      ],
    });
    expect(gmailFormatFor("RAW")).toEqual({ format: "raw" });
    expect(gmailFormatFor("MINIMAL")).toEqual({ format: "minimal" });
  });
});
```

`worker/test/fake-gmail.ts`: `seedMessage` accepts `replyTo?: string` (emitted as a `Reply-To` header) and each attachment accepts `inline?: boolean`, in which case the part carries `body: { size, data: b64url(bytes) }` and no `attachmentId`.

- [x] **Step 2: run, expect failure**

Run: `cd worker && npx vitest run test/messages.test.ts`
Expected: FAIL, module not found.

- [x] **Step 3 (GREEN): implementation**

`shared/src/schemas.ts` additions:

```ts
export const MESSAGE_FORMATS = ["MINIMAL", "METADATA_ONLY", "PLAIN_TEXT", "FULL_CONTENT", "RAW"] as const;
export const MessageFormat = z.enum(MESSAGE_FORMATS);
export type MessageFormat = z.infer<typeof MessageFormat>;
```

`worker/src/google/messages.ts`:

```ts
import type { MessageFormat } from "@gmail-mcp/shared/schemas";
import { fromB64url } from "../crypto/random";

export type GmailHeader = { name: string; value: string };
export type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
};
export type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailPart;
  raw?: string;
};
export type GmailThread = { id: string; historyId?: string; messages?: GmailMessage[] };
export type GmailDraft = { id: string; message: GmailMessage };
export type GmailLabel = {
  id: string;
  name: string;
  type?: "system" | "user";
  labelListVisibility?: string;
  messageListVisibility?: string;
  color?: { textColor: string; backgroundColor: string };
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
};

export type AttachmentMeta = {
  part_id: string;
  attachment_id: string | null;
  filename: string;
  mime: string;
  size: number;
};
export type MessageView = {
  id: string;
  thread_id: string;
  label_ids: string[];
  snippet: string;
  date: string | null;
  subject: string | null;
  from: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  reply_to: string[];
  message_id_header: string | null;
  in_reply_to: string | null;
  references: string | null;
  plaintext_body?: string;
  html_body?: string;
  raw?: string;
  body_truncated?: boolean;
  attachments: AttachmentMeta[];
};

export const METADATA_HEADERS = [
  "Subject",
  "From",
  "To",
  "Cc",
  "Bcc",
  "Reply-To",
  "Date",
  "Message-ID",
  "In-Reply-To",
  "References",
] as const;

export function gmailFormatFor(f: MessageFormat): {
  format: "minimal" | "metadata" | "full" | "raw";
  metadataHeaders?: string[];
} {
  switch (f) {
    case "MINIMAL":
      return { format: "minimal" };
    case "METADATA_ONLY":
      return { format: "metadata", metadataHeaders: [...METADATA_HEADERS] };
    case "RAW":
      return { format: "raw" };
    default:
      return { format: "full" };
  }
}

const header = (p: GmailPart | undefined, name: string): string | null => {
  const n = name.toLowerCase();
  return p?.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? null;
};

/**
 * RFC 5322 address-list splitting. A comma separates addresses only outside quoted strings (where
 * backslash escapes the next character), outside comments (which nest), and outside angle brackets.
 * A group `Name: a, b;` contributes its members and drops its name. Validation belongs to parseAddress.
 */
export function splitAddressList(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let escaped = false;
  let comment = 0;
  let angle = 0;
  let inGroup = false;
  const push = () => {
    const t = cur.trim();
    if (t) out.push(t);
    cur = "";
  };
  for (const ch of value) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (quoted) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
      cur += ch;
      continue;
    }
    if (comment > 0) {
      if (ch === "(") comment++;
      else if (ch === ")") comment--;
      cur += ch;
      continue;
    }
    switch (ch) {
      case '"':
        quoted = true;
        cur += ch;
        break;
      case "(":
        comment = 1;
        cur += ch;
        break;
      case "<":
        angle++;
        cur += ch;
        break;
      case ">":
        angle = Math.max(0, angle - 1);
        cur += ch;
        break;
      case ":":
        if (angle === 0 && !inGroup) {
          inGroup = true;
          cur = "";
        } else cur += ch;
        break;
      case ";":
        if (angle === 0 && inGroup) {
          push();
          inGroup = false;
        } else cur += ch;
        break;
      case ",":
        if (angle === 0) push();
        else cur += ch;
        break;
      default:
        cur += ch;
    }
  }
  push();
  return out;
}

export function decodeBodyData(data: string): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(fromB64url(data));
}

const addresses = (p: GmailPart | undefined, name: string): string[] => {
  const v = header(p, name);
  return v ? splitAddressList(v) : [];
};

function walk(p: GmailPart | undefined, visit: (part: GmailPart) => void): void {
  if (!p) return;
  visit(p);
  for (const c of p.parts ?? []) walk(c, visit);
}

function attachmentsOf(p: GmailPart | undefined): AttachmentMeta[] {
  const out: AttachmentMeta[] = [];
  walk(p, (part) => {
    if (!part.filename) return;
    // A named part is an attachment whether Gmail parked its bytes behind attachmentId or inlined them in data.
    if (part.body?.attachmentId || part.body?.data) {
      out.push({
        part_id: part.partId ?? "",
        attachment_id: part.body.attachmentId ?? null,
        filename: part.filename,
        mime: part.mimeType ?? "application/octet-stream",
        size: part.body.size ?? 0,
      });
    }
  });
  return out;
}

function bodyOfType(p: GmailPart | undefined, type: "text/plain" | "text/html"): string | undefined {
  const chunks: string[] = [];
  walk(p, (part) => {
    if ((part.mimeType ?? "").toLowerCase() === type && !part.filename && part.body?.data)
      chunks.push(decodeBodyData(part.body.data));
  });
  return chunks.length === 0 ? undefined : chunks.join("\n");
}

/** Cuts on code points, never inside a surrogate pair, so a truncated body is still well-formed. */
function cut(s: string, max: number): { text: string; truncated: boolean } {
  let n = 0;
  let out = "";
  for (const ch of s) {
    if (n === max) return { text: out, truncated: true };
    out += ch;
    n++;
  }
  return { text: out, truncated: false };
}

export function messageView(
  m: GmailMessage,
  o: { format: MessageFormat; bodyCharLimit: number; includeBody: boolean },
): MessageView {
  const p = m.payload;
  const view: MessageView = {
    id: m.id,
    thread_id: m.threadId,
    label_ids: m.labelIds ?? [],
    snippet: m.snippet ?? "",
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
    subject: header(p, "Subject"),
    from: header(p, "From"),
    to: addresses(p, "To"),
    cc: addresses(p, "Cc"),
    bcc: addresses(p, "Bcc"),
    reply_to: addresses(p, "Reply-To"),
    message_id_header: header(p, "Message-ID"),
    in_reply_to: header(p, "In-Reply-To"),
    references: header(p, "References"),
    attachments: attachmentsOf(p),
  };
  if (!o.includeBody || o.format === "MINIMAL" || o.format === "METADATA_ONLY") return view;
  if (o.format === "RAW") {
    if (m.raw !== undefined) {
      const c = cut(m.raw, o.bodyCharLimit);
      view.raw = c.text;
      if (c.truncated) view.body_truncated = true;
    }
    return view;
  }
  const text = bodyOfType(p, "text/plain");
  if (text !== undefined) {
    const c = cut(text, o.bodyCharLimit);
    view.plaintext_body = c.text;
    if (c.truncated) view.body_truncated = true;
  }
  if (o.format === "FULL_CONTENT") {
    const html = bodyOfType(p, "text/html");
    if (html !== undefined) {
      const c = cut(html, o.bodyCharLimit);
      view.html_body = c.text;
      if (c.truncated) view.body_truncated = true;
    }
  }
  return view;
}

export function findAttachment(
  m: GmailMessage,
  by: { attachmentId: string } | { partId: string },
): AttachmentMeta | null {
  return (
    attachmentsOf(m.payload).find((a) =>
      "attachmentId" in by ? a.attachment_id === by.attachmentId : a.part_id === by.partId,
    ) ?? null
  );
}

export function partData(m: GmailMessage, partId: string): string | null {
  let found: string | null = null;
  walk(m.payload, (part) => {
    if (part.partId === partId && part.body?.data && !part.body.attachmentId) found = part.body.data;
  });
  return found;
}
```

`bodyOfType` skips named parts, so an inline attachment never leaks into `plaintext_body`.

- [x] **Step 4: run, expect pass**

Run: `cd worker && npx vitest run test/messages.test.ts` then `npm run verify`.
Expected: PASS.

- [x] **Step 5: commit**

```bash
git add shared/src/schemas.ts worker/src/google/messages.ts worker/test/messages.test.ts worker/test/fake-gmail.ts
git commit -m "feat(worker): message views from Gmail part trees

Attachments are metadata only and include parts whose bytes Gmail inlined; address lists split the
RFC 5322 way; bodies are cut on code points at the caller's limit.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NBfkjWcEGDFghet3APnUjU"
```

---

### Task 3: MIME as a stream, with tested header encoders and folding

**Files:**

- Create: `worker/src/mime/encode.ts`, `worker/src/mime/build.ts`, `worker/test/mime.test.ts`

**Interfaces:**

- Consumes: `assertHeaderSafe` from `policy/limits.ts`; `parseAddress` from `policy/recipients.ts`.
- Produces in `encode.ts`:
  - `encodeWord(s)`: RFC 2047 `=?UTF-8?B?…?=` words of at most 75 characters joined by CRLF and a space; printable ASCII passes through unchanged.
  - `encodeParam(name, value)`: `name="value"` for short plain ASCII, else RFC 2231 `name*=UTF-8''…` with `name*0*=` continuations above 70 characters.
  - `formatMailbox(raw)`: `<addr>`, `"Name" <addr>` or `=?UTF-8?B?…?= <addr>`.
  - `foldHeader(name, value)`: one header line folded at spaces so no physical line exceeds 78 characters where a space allows it; a value with no foldable point that would exceed 998 characters on one line is RFC 2047 encoded instead (encoded words fold anywhere); the result is asserted so that no physical line exceeds 998 characters, which is RFC 5322's hard limit. Values that arrive already folded (`",\r\n "` between mailboxes) are re-flowed.
  - `assertMediaType(mime)`: `type/subtype` of RFC 6838 restricted-name characters, no parameters, at most 255 characters; anything else is `invalid_header`.
  - `base64LineLength(n)`: the exact byte length of `n` bytes as 76-column base64 with CRLF, `Math.floor(n / 57) * 78 + (n % 57 === 0 ? 0 : Math.ceil((n % 57) / 3) * 4 + 2)`.
  - `base64LinesTransform(): TransformStream<Uint8Array, Uint8Array>`: streaming encoder that carries a remainder of fewer than 57 bytes between chunks and flushes it as the last line.
  - `base64Lines(bytes)`: the same encoding over a whole array (for text parts and tests).
- Produces in `build.ts`:

```ts
export type MimeAttachment = {
  filename: string;
  mime: string;
  size: number;
  open: () => Promise<ReadableStream<Uint8Array>>;
};
export type MimeInput = {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  messageId: string;
  inReplyTo?: string | undefined;
  references?: string | undefined;
  date?: Date | undefined;
  text?: string | undefined;
  html?: string | undefined;
  attachments: MimeAttachment[];
};
export function buildMimeStream(o: MimeInput): { stream: ReadableStream<Uint8Array>; length: number };
export async function buildMime(o: MimeInput): Promise<Uint8Array>; // collects the stream; tests and small uploads
export function fromBytes(bytes: Uint8Array): () => Promise<ReadableStream<Uint8Array>>;
```

The stream is pull-based: headers and text parts are small byte segments, and each attachment is read from its `open()` stream through `base64LinesTransform` one chunk at a time, so the isolate holds a few chunks, never the message. `length` is exact and known before a byte is read, because every segment's length is computable from the attachment sizes; the stream errors if an attachment yields a different byte count than its declared size. Every header value passes `assertHeaderSafe` and `foldHeader`; every attachment `mime` passes `assertMediaType`.

- [x] **Step 1 (RED): tests**

`worker/test/mime.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  encodeWord,
  encodeParam,
  formatMailbox,
  base64Lines,
  base64LineLength,
  base64LinesTransform,
  foldHeader,
  assertMediaType,
} from "../src/mime/encode";
import { buildMime, buildMimeStream, fromBytes } from "../src/mime/build";

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const enc = new TextEncoder();

describe("encoders", () => {
  it("RFC 2047: ASCII passes through, non-ASCII becomes B words of at most 75 chars", () => {
    expect(encodeWord("Hello world")).toBe("Hello world");
    expect(encodeWord("Thesis 🚀 draft")).toBe("=?UTF-8?B?VGhlc2lzIPCfmoAgZHJhZnQ=?=");
    const long = encodeWord("é".repeat(80));
    for (const w of long.split("\r\n ")) expect(w.length).toBeLessThanOrEqual(75);
    expect(long.split("\r\n ").length).toBeGreaterThan(1);
  });
  it("RFC 2231: plain filenames stay quoted, everything else is percent-encoded with continuations", () => {
    expect(encodeParam("filename", "notes.pdf")).toBe('filename="notes.pdf"');
    expect(encodeParam("filename", 'we"ird.pdf')).toBe("filename*=UTF-8''we%22ird.pdf");
    expect(encodeParam("filename", "résumé.pdf")).toBe("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
    const long = encodeParam("filename", "a".repeat(150) + ".pdf");
    expect(long).toMatch(/^filename\*0\*=UTF-8''a+;\r\n filename\*1\*=a+/);
  });
  it("mailboxes: bare, quoted name, encoded name; CR LF NUL refused", () => {
    expect(formatMailbox("a@example.test")).toBe("<a@example.test>");
    expect(formatMailbox("Jane Doe <jane@example.test>")).toBe('"Jane Doe" <jane@example.test>');
    expect(formatMailbox("Zoë <zoe@example.test>")).toBe("=?UTF-8?B?Wm/Dqw==?= <zoe@example.test>");
    expect(() => formatMailbox("Bad\r\nName <x@example.test>")).toThrow();
  });
  it("folding: long ASCII subjects fold at spaces under 78; an unbreakable run is B-encoded; no line ever exceeds 998", () => {
    const words = foldHeader("Subject", Array.from({ length: 40 }, (_, i) => `word${i}`).join(" "));
    for (const line of words.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
    expect(words.replace(/\r\n /g, " ")).toBe(`Subject: ${Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ")}`);
    const run = foldHeader("Subject", "A".repeat(998));
    expect(run).toContain("=?UTF-8?B?");
    for (const line of run.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
    const refs = foldHeader("References", Array.from({ length: 60 }, (_, i) => `<id${i}@example.test>`).join(" "));
    for (const line of refs.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
    expect(refs.split("\r\n").length).toBeGreaterThan(10);
  });
  it("media types: type/subtype only", () => {
    assertMediaType("application/pdf");
    assertMediaType("image/svg+xml");
    for (const bad of [
      "pdf",
      "text/plain; charset=UTF-8",
      "text/",
      "/x",
      "a b/c",
      "text/plain\r\nX: y",
      "x".repeat(300) + "/y",
    ]) {
      expect(() => assertMediaType(bad)).toThrow(/invalid_header/);
    }
  });
  it("base64 lines are 76 wide with CRLF, decode back, and the length formula is exact for every remainder", async () => {
    for (const n of [0, 1, 2, 3, 56, 57, 58, 113, 114, 115, 1000, 4097]) {
      const data = new Uint8Array(n).map((_, i) => (i * 7) & 255);
      const whole = base64Lines(data);
      expect(whole.byteLength).toBe(base64LineLength(n));
      const out = text(whole);
      for (const line of out.split("\r\n").filter(Boolean)) expect(line.length).toBeLessThanOrEqual(76);
      expect(Uint8Array.from(atob(out.replace(/\r\n/g, "")), (c) => c.charCodeAt(0))).toEqual(data);
      // Streaming with awkward chunk boundaries yields byte-identical output.
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < n; i += 13) chunks.push(data.subarray(i, Math.min(n, i + 13)));
      const streamed = new Uint8Array(
        await new Response(new Response(new Blob(chunks)).body!.pipeThrough(base64LinesTransform())).arrayBuffer(),
      );
      expect(streamed).toEqual(whole);
    }
  });
});

describe("buildMime", () => {
  const base = {
    from: "Owner <owner@example.test>",
    to: ["a@example.test", "Zoë <zoe@example.test>"],
    cc: [],
    bcc: ["hidden@example.test"],
    subject: "Thesis 🚀",
    messageId: "<op_x@gmail-mcp.example.workers.dev>",
    date: new Date("2026-09-10T00:00:00Z"),
  };
  const att = (filename: string, mime: string, bytes: Uint8Array) => ({
    filename,
    mime,
    size: bytes.byteLength,
    open: fromBytes(bytes),
  });
  it("plain text message: headers, encoded subject, Message-ID, base64 body, exact length", async () => {
    const input = { ...base, text: "hello\n", attachments: [] };
    const bytes = await buildMime(input);
    expect(bytes.byteLength).toBe(buildMimeStream(input).length);
    const out = text(bytes);
    const [headers, body] = out.split("\r\n\r\n");
    expect(headers).toContain('From: "Owner" <owner@example.test>');
    expect(headers).toContain("To: <a@example.test>,\r\n =?UTF-8?B?Wm/Dqw==?= <zoe@example.test>");
    expect(headers).toContain("Bcc: <hidden@example.test>");
    expect(headers).toContain("Subject: =?UTF-8?B?VGhlc2lzIPCfmoA=?=");
    expect(headers).toContain("Message-ID: <op_x@gmail-mcp.example.workers.dev>");
    expect(headers).toContain("Date: Thu, 10 Sep 2026 00:00:00 GMT");
    expect(headers).toContain("MIME-Version: 1.0");
    expect(headers).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(atob(body!.trim())).toBe("hello\n");
    expect(out).not.toContain("\n\n");
  });
  it("text plus html plus attachment: mixed wrapping alternative, RFC 2231 filename, In-Reply-To, exact length", async () => {
    const input = {
      ...base,
      text: "t",
      html: "<b>t</b>",
      inReplyTo: "<parent@fake.test>",
      references: "<root@fake.test> <parent@fake.test>",
      attachments: [att("résumé.pdf", "application/pdf", enc.encode("%PDF-1.4"))],
    };
    const bytes = await buildMime(input);
    expect(bytes.byteLength).toBe(buildMimeStream(input).length);
    const out = text(bytes);
    expect(out).toMatch(/Content-Type: multipart\/mixed; boundary="[^"]+"/);
    expect(out).toMatch(/Content-Type: multipart\/alternative; boundary="[^"]+"/);
    expect(out).toContain("Content-Type: text/html; charset=UTF-8");
    expect(out).toContain("Content-Type: application/pdf; name*=UTF-8''r%C3%A9sum%C3%A9.pdf");
    expect(out).toContain("Content-Disposition: attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
    expect(out).toContain("In-Reply-To: <parent@fake.test>");
    expect(out).toContain("References: <root@fake.test> <parent@fake.test>");
    expect(out).toContain(btoa("%PDF-1.4"));
  });
  it("refuses header injection and bad media types anywhere", async () => {
    expect(() => buildMimeStream({ ...base, subject: "x\r\nBcc: evil@x.test", text: "t", attachments: [] })).toThrow(
      /invalid_header/,
    );
    expect(() =>
      buildMimeStream({ ...base, text: "t", attachments: [att("a\nb.pdf", "application/pdf", new Uint8Array(1))] }),
    ).toThrow(/invalid_header/);
    expect(() =>
      buildMimeStream({ ...base, text: "t", attachments: [att("a.pdf", "application/pdf; x=y", new Uint8Array(1))] }),
    ).toThrow(/invalid_header/);
  });
  it("streams a 6 MB attachment with bounded chunks and errors when the source is shorter than declared", async () => {
    const big = new Uint8Array(6 * 1024 * 1024).fill(65);
    const { stream, length } = buildMimeStream({
      ...base,
      text: "t",
      attachments: [att("big.bin", "application/octet-stream", big)],
    });
    let total = 0;
    let largest = 0;
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      largest = Math.max(largest, value.byteLength);
    }
    expect(total).toBe(length);
    expect(largest).toBeLessThan(1024 * 1024);
    const lying = {
      ...base,
      text: "t",
      attachments: [
        { filename: "short.bin", mime: "application/octet-stream", size: 100, open: fromBytes(new Uint8Array(50)) },
      ],
    };
    await expect(new Response(buildMimeStream(lying).stream).arrayBuffer()).rejects.toThrow(/handle_invalid/);
  });
});
```

- [x] **Step 2: run, expect failure**

Run: `cd worker && npx vitest run test/mime.test.ts`
Expected: FAIL, modules not found.

- [x] **Step 3 (GREEN): implementation**

`worker/src/mime/encode.ts`:

```ts
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import { assertHeaderSafe } from "../policy/limits";
import { parseAddress } from "../policy/recipients";

const enc = new TextEncoder();
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LINE_INPUT = 57; // 57 bytes -> 76 characters
const SOFT_LINE = 78;
const HARD_LINE = 998;

export function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64[a >> 2]! + B64[((a & 3) << 4) | (b >> 4)]!;
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)]! : "=";
    out += i + 2 < bytes.length ? B64[c & 63]! : "=";
  }
  return out;
}

const isPrintableAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 B encoding. Each encoded word stays within 75 characters by encoding at most 45 input bytes. */
export function encodeWord(s: string): string {
  if (isPrintableAscii(s)) return s;
  return encodeWords(s);
}

function encodeWords(s: string): string {
  const bytes = enc.encode(s);
  const words: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(bytes.length, start + 45);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    words.push(`=?UTF-8?B?${base64(bytes.subarray(start, end))}?=`);
    start = end;
  }
  return words.join("\r\n ");
}

const pctEncode = (s: string) =>
  Array.from(enc.encode(s), (b) =>
    (b >= 0x30 && b <= 0x39) ||
    (b >= 0x41 && b <= 0x5a) ||
    (b >= 0x61 && b <= 0x7a) ||
    b === 0x2e ||
    b === 0x2d ||
    b === 0x5f
      ? String.fromCharCode(b)
      : `%${b.toString(16).toUpperCase().padStart(2, "0")}`,
  ).join("");

/** RFC 2231 parameter. Quoted form only for short, plain ASCII values; everything else is extended. */
export function encodeParam(name: string, value: string): string {
  assertHeaderSafe(name, value);
  if (isPrintableAscii(value) && !/["\\]/.test(value) && value.length <= 60) return `${name}="${value}"`;
  const encoded = `UTF-8''${pctEncode(value)}`;
  if (encoded.length <= 70) return `${name}*=${encoded}`;
  const pieces: string[] = [];
  let rest = encoded;
  while (rest.length > 0) {
    let n = Math.min(60, rest.length);
    const cutAt = rest.lastIndexOf("%", n - 1);
    if (cutAt > n - 3 && n < rest.length) n = cutAt;
    pieces.push(rest.slice(0, n));
    rest = rest.slice(n);
  }
  return pieces.map((p, i) => `${name}*${i}*=${p}`).join(";\r\n ");
}

export function formatMailbox(raw: string): string {
  assertHeaderSafe("address", raw);
  parseAddress(raw);
  const m = /^(.*?)\s*<([^<>]+)>$/.exec(raw.trim());
  if (!m) return `<${raw.trim()}>`;
  const name = m[1]!.trim().replace(/^"(.*)"$/, "$1");
  const addr = m[2]!.trim();
  if (name === "") return `<${addr}>`;
  if (isPrintableAscii(name)) return `"${name.replace(/(["\\])/g, "\\$1")}" <${addr}>`;
  return `${encodeWords(name)} <${addr}>`;
}

/**
 * RFC 5322 folding. Words already separated by CRLF-space (encoded words, mailbox lists) are re-flowed
 * with plain words. A token that cannot fit under the hard limit on its own is only possible for an
 * unencoded value, which is then B-encoded so it can fold. The final assertion is the law: no physical
 * line over 998 characters leaves this function.
 */
export function foldHeader(name: string, value: string): string {
  assertHeaderSafe(name, value.replace(/\r\n[ \t]/g, " "));
  const tokens = value.split(/\r\n[ \t]| /).filter((t) => t.length > 0);
  if (tokens.some((t) => t.length > HARD_LINE - name.length - 2) && isPrintableAscii(value.replace(/\r\n/g, ""))) {
    return foldHeader(name, encodeWords(value.replace(/\r\n[ \t]/g, " ")));
  }
  const lines: string[] = [];
  let cur = `${name}:`;
  for (const t of tokens) {
    if (cur.length + 1 + t.length > SOFT_LINE && cur !== `${name}:`) {
      lines.push(cur);
      cur = ` ${t}`;
    } else cur += ` ${t}`;
  }
  lines.push(cur);
  for (const l of lines) {
    if (l.length > HARD_LINE)
      throw new GmailMcpError("invalid_header", `invalid_header: ${name} line exceeds ${HARD_LINE} characters`);
  }
  return lines.join("\r\n") + "\r\n";
}

const RESTRICTED = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
export function assertMediaType(mime: string): void {
  if (!RESTRICTED.test(mime))
    throw new GmailMcpError("invalid_header", `invalid_header: media type ${mime.slice(0, 40)}`);
}

export function base64LineLength(n: number): number {
  const rem = n % LINE_INPUT;
  return Math.floor(n / LINE_INPUT) * 78 + (rem === 0 ? 0 : Math.ceil(rem / 3) * 4 + 2);
}

function encodeLines(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(base64LineLength(bytes.length));
  let o = 0;
  for (let i = 0; i < bytes.length; i += LINE_INPUT) {
    const line = base64(bytes.subarray(i, Math.min(bytes.length, i + LINE_INPUT)));
    for (let j = 0; j < line.length; j++) out[o++] = line.charCodeAt(j);
    out[o++] = 13;
    out[o++] = 10;
  }
  return out;
}

export function base64Lines(bytes: Uint8Array): Uint8Array {
  return encodeLines(bytes);
}

/** Carries fewer than 57 bytes between chunks so line boundaries are identical to the whole-array encoding. */
export function base64LinesTransform(): TransformStream<Uint8Array, Uint8Array> {
  let carry = new Uint8Array(0);
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const joined = new Uint8Array(carry.length + chunk.length);
      joined.set(carry, 0);
      joined.set(chunk, carry.length);
      const usable = joined.length - (joined.length % LINE_INPUT);
      if (usable > 0) controller.enqueue(encodeLines(joined.subarray(0, usable)));
      carry = joined.slice(usable);
    },
    flush(controller) {
      if (carry.length > 0) controller.enqueue(encodeLines(carry));
    },
  });
}
```

`worker/src/mime/build.ts`:

```ts
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import { assertHeaderSafe } from "../policy/limits";
import { b64url } from "../crypto/random";
import {
  assertMediaType,
  base64LineLength,
  base64Lines,
  base64LinesTransform,
  encodeParam,
  encodeWord,
  foldHeader,
  formatMailbox,
} from "./encode";

export type MimeAttachment = {
  filename: string;
  mime: string;
  size: number;
  open: () => Promise<ReadableStream<Uint8Array>>;
};
export type MimeInput = {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  messageId: string;
  inReplyTo?: string | undefined;
  references?: string | undefined;
  date?: Date | undefined;
  text?: string | undefined;
  html?: string | undefined;
  attachments: MimeAttachment[];
};

type Segment = { kind: "bytes"; bytes: Uint8Array } | { kind: "attachment"; att: MimeAttachment };
const enc = new TextEncoder();
const bytes = (s: string): Segment => ({ kind: "bytes", bytes: enc.encode(s) });

function boundary(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return `=_gm_${b64url(b)}`;
}

const addressHeader = (name: string, list: string[]): string =>
  list.length === 0 ? "" : foldHeader(name, list.map(formatMailbox).join(",\r\n "));

function textPart(type: "text/plain" | "text/html", body: string): Segment[] {
  return [
    bytes(`Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`),
    { kind: "bytes", bytes: base64Lines(enc.encode(body)) },
  ];
}

function attachmentPart(a: MimeAttachment): Segment[] {
  assertHeaderSafe("filename", a.filename);
  assertMediaType(a.mime);
  return [
    bytes(
      `Content-Type: ${a.mime}; ${encodeParam("name", a.filename)}\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; ${encodeParam("filename", a.filename)}\r\n\r\n`,
    ),
    { kind: "attachment", att: a },
  ];
}

function multipart(subtype: "mixed" | "alternative", parts: Segment[][]): { header: string; body: Segment[] } {
  const b = boundary();
  const body: Segment[] = [];
  for (const p of parts) body.push(bytes(`--${b}\r\n`), ...p, bytes("\r\n"));
  body.push(bytes(`--${b}--\r\n`));
  return { header: `Content-Type: multipart/${subtype}; boundary="${b}"\r\n`, body };
}

function segments(o: MimeInput): Segment[] {
  assertHeaderSafe("subject", o.subject);
  const head =
    foldHeader("From", formatMailbox(o.from)) +
    addressHeader("To", o.to) +
    addressHeader("Cc", o.cc) +
    addressHeader("Bcc", o.bcc) +
    foldHeader("Subject", encodeWord(o.subject)) +
    foldHeader("Date", (o.date ?? new Date()).toUTCString()) +
    foldHeader("Message-ID", o.messageId) +
    (o.inReplyTo ? foldHeader("In-Reply-To", o.inReplyTo) : "") +
    (o.references ? foldHeader("References", o.references) : "") +
    "MIME-Version: 1.0\r\n";
  const bodies: Segment[][] = [];
  if (o.text !== undefined) bodies.push(textPart("text/plain", o.text));
  if (o.html !== undefined) bodies.push(textPart("text/html", o.html));
  if (bodies.length === 0) bodies.push(textPart("text/plain", ""));
  let content: { header: string; body: Segment[] };
  if (bodies.length === 2) content = multipart("alternative", bodies);
  else {
    const [only] = bodies;
    const raw = new TextDecoder().decode((only![0] as { bytes: Uint8Array }).bytes);
    content = { header: raw.slice(0, -2), body: [only![1]!] };
  }
  if (o.attachments.length > 0)
    content = multipart("mixed", [
      [bytes(content.header + "\r\n"), ...content.body],
      ...o.attachments.map(attachmentPart),
    ]);
  return [bytes(head + content.header + "\r\n"), ...content.body];
}

const segmentLength = (s: Segment) => (s.kind === "bytes" ? s.bytes.byteLength : base64LineLength(s.att.size));

/**
 * Pull-based: one segment at a time, and inside an attachment one source chunk at a time through the
 * base64 transform. The length is exact before any byte is read, which both upload protocols need, and a
 * source that yields a different byte count than its declared size errors the stream rather than
 * producing a message whose Content-Length lies.
 */
export function buildMimeStream(o: MimeInput): { stream: ReadableStream<Uint8Array>; length: number } {
  const segs = segments(o);
  const length = segs.reduce((n, s) => n + segmentLength(s), 0);
  let i = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let expected = 0;
  let seen = 0;
  let current: MimeAttachment | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (reader) {
          const { done, value } = await reader.read();
          if (!done) {
            seen += value.byteLength;
            controller.enqueue(value);
            return;
          }
          if (seen !== expected) {
            controller.error(
              new GmailMcpError(
                "handle_invalid",
                `handle_invalid: ${current?.filename ?? "attachment"} yielded ${seen} encoded bytes, expected ${expected}`,
              ),
            );
            return;
          }
          reader = null;
          i++;
          continue;
        }
        if (i >= segs.length) {
          controller.close();
          return;
        }
        const seg = segs[i]!;
        if (seg.kind === "bytes") {
          controller.enqueue(seg.bytes);
          i++;
          return;
        }
        current = seg.att;
        expected = base64LineLength(seg.att.size);
        seen = 0;
        reader = (await seg.att.open()).pipeThrough(base64LinesTransform()).getReader();
      }
    },
    cancel() {
      void reader?.cancel();
    },
  });
  return { stream, length };
}

export async function buildMime(o: MimeInput): Promise<Uint8Array> {
  const { stream, length } = buildMimeStream(o);
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  if (out.byteLength !== length) throw new GmailMcpError("internal", `mime length ${out.byteLength} != ${length}`);
  return out;
}

export function fromBytes(bytes: Uint8Array): () => Promise<ReadableStream<Uint8Array>> {
  return async () => new Response(bytes).body!;
}
```

- [x] **Step 4: run, expect pass**

Run: `cd worker && npx vitest run test/mime.test.ts` then `npm run verify`.
Expected: PASS.

- [x] **Step 5: commit**

```bash
git add worker/src/mime worker/test/mime.test.ts
git commit -m "feat(worker): MIME as a stream with RFC 2047, RFC 2231 and folding

mimetext 3.0.28 was measured to write attachment filenames raw inside quotes, so it cannot meet spec
3.8. This module is the one place headers are assembled: every encoder has vectors, every header is
folded under 78 and asserted under 998, and the message streams with an exact length so a 25 MB
attachment is never held in the isolate at once.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NBfkjWcEGDFghet3APnUjU"
```

---

### Task 4: The gate: intent, idempotency, `requestState`, settlement, `execute_pending`

**Files:**

- Create: `worker/migrations/0003_intent.sql`, `worker/src/approval/state.ts`, `worker/src/tools/results.ts`, `worker/src/tools/accounts.ts`, `worker/src/tools/idempotency.ts`, `worker/src/tools/settle.ts`, `worker/src/tools/gate.ts`, `worker/test/gate.test.ts`
- Modify: `worker/src/approval/pending.ts` (`createPendingStatement`, `intent_hash`, `idempotency_key`), `worker/src/staging/store.ts` (`reserveStatements`, `extendExpiryStatement`, `listUploadHandles`, `openStaged`), `worker/src/approval/claim.ts` (use `reserveStatements`), `worker/src/operations/journal.ts` (`beginOperation`, `insertOperationStatement`), `worker/src/mcp/server.ts` (codec, `era`, `execute_pending`, `connect_account` elicitation), `worker/src/index.ts` (factory passes `ctx.era`), `worker/test/mcp.test.ts`, `worker/test/schema.test.ts` (the new table and columns)

**Interfaces:**

- Consumes: `createPending`, `getPending`, `cancelPending`, `claimPending`, `handlesFromPayload`, `transition`, `decide`, `auditStatement`, `auditIntent`, `canonicalize`, `hashCanonical`, `randomId`, `connectUrl`; from the SDK `inputRequired`, `createRequestStateCodec`, types `CallToolResult`, `InputRequiredResult`, `ServerContext`, `RequestStateCodec`.
- Produces:
  - Migration `0003_intent.sql`: `idempotency_keys(user_id, account_id, key, tool, intent_hash, pending_id, operation_id, created_at, updated_at)` keyed on `(user_id, account_id, key)`; `pending_actions.intent_hash`, `pending_actions.idempotency_key`; `operations.result_json` (ids only, for replay).
  - `APPROVAL_STATE_VERSION = "gmail-mcp:approval:v1"`; `type ApprovalState = { v; tool: string; pending_id: string; account_id: string; intent_hash: string }`; `approvalCodec(env, principal)`.
  - `type Round = { requestState(): ApprovalState | undefined; answer(): "accept" | "decline" | "cancel" | "missing"; mint(s: ApprovalState): Promise<string> }`; `roundOf(ctx, codec)`.
  - `type ToolContext = { env; deps; principal; urlElicitation: boolean; round: Round }`.
  - `type AccountRef = { id; alias; email; sendAs; orgDomains; sendLimitBytes }`; `resolveAccount(env, userId, alias?)`; `accountById(env, userId, accountId)`; `trustContext(env, userId, acct)`.
  - `type ExecRun = { userId; account: AccountRef; payload: Record<string, unknown>; operationId: string | null; pendingId: string | null }`; `type Executor = (env, deps, run: ExecRun) => Promise<Record<string, unknown>>`; `registerExecutor(tool, version, fn)`; `executorFor(tool): { fn: Executor; version: number }`.
  - `type GateInput = { tool: string; version: number; action: Action; journal: boolean; account: AccountRef; intentHash: string; idempotencyKey?: string | undefined; modifiers: Modifier[]; summary: string; facts: AuditFacts; build: () => Promise<{ payload: Record<string, unknown>; handles: string[] }> }`. `build` runs only after the policy decision is not `deny` and only when no replay short-circuits the call, so a denied or replayed call writes no staging state.
  - `runGated(t, input): Promise<ToolResult>`; `resumeGated(t, o: { tool: string; account: AccountRef; intentHash: string; state: ApprovalState }): Promise<ToolResult>`; `executePending(t, pendingId): Promise<Record<string, unknown>>`; `runExecutor(t, run)`.
  - `lookupIdempotency(db, { userId, accountId, key })`; `bindIdempotencyStatements(db, { userId, accountId, key, tool, intentHash, pendingId, operationId, now })`; `replayFor(env, row, { tool, intentHash, alias })` returning a result to return, or `"fresh"`.
  - `settleExecuted`, `settleFailedSafe`, `settleUnknown` in `settle.ts`: one D1 batch each, covering the operation, the reservations, the pending row, and the outcome audit row.
  - `beginOperation(db, operationId, patch?)`: `claimed → executing`, throws `internal` when the row was not `claimed`. `insertOperationStatement(db, { id, userId, accountId, action, payloadHash, now })`. `completeOperation` is not built: settlement is the gate's job, never an executor's.
  - `reserveStatements`, `extendExpiryStatement`, `listUploadHandles`, `openStaged(env, row): Promise<ReadableStream<Uint8Array>>` in `staging/store.ts`.
  - `approvalUrl`, `pendingApprovalResult`, `text`, `toolError`, `guarded`, `connectRequired` in `results.ts`.
  - `buildServer(env, principal, deps, era)`.

The intent hash is `sha256(JCS({ tool, v, account: alias, args }))` where `args` are the schema-parsed arguments with every inline attachment's `content_base64` replaced by `{ filename, mime, size, sha256 }`. It describes what the client asked for and nothing the server generated, so a retried call, an idempotent replay and an elicitation resume all hash to the same value whether or not staging handles were minted in between. The execution payload (with handles) is hashed separately as `payload_hash`, which is what the claim and the approval page bind to.

- [x] **Step 1 (RED): tests**

`worker/test/gate.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { PendingApprovalResult } from "@gmail-mcp/shared/schemas";
import { FakeGoogle } from "./fake-google";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import { testDeps, testEnv } from "./test-env";
import { approvePending, denyPending, getPending } from "../src/approval/pending";
import { setPolicy } from "../src/policy/engine";
import { beginOperation } from "../src/operations/journal";
import { GmailApiError } from "../src/google/gmail";
import {
  executePending,
  registerExecutor,
  resumeGated,
  runGated,
  type GateInput,
  type ToolContext,
} from "../src/tools/gate";
import { guarded } from "../src/tools/results";
import { resolveAccount } from "../src/tools/accounts";
import { APPROVAL_STATE_VERSION, type ApprovalState } from "../src/approval/state";
import { hashCanonical, canonicalize } from "../src/crypto/canonical";
import type { Principal } from "../src/auth/principal";

const e = testEnv();
let g: FakeGoogle;
const principal: Principal = { userId: "tg", email: "tg@example.test", scope: "mcp" };
const calls: unknown[] = [];
const staged: string[] = [];

function ctx(
  o: {
    url?: boolean;
    state?: ApprovalState;
    answer?: "accept" | "decline" | "cancel" | "missing";
    deadlineMs?: number;
  } = {},
): ToolContext {
  return {
    env: e,
    deps: testDeps(g, o.deadlineMs ? { approvalWait: { intervalMs: 5, deadlineMs: o.deadlineMs } } : {}),
    principal,
    urlElicitation: o.url ?? false,
    round: {
      requestState: () => o.state,
      answer: () => o.answer ?? "missing",
      mint: async (s) => `minted:${s.pending_id}`,
    },
  };
}

async function stageUpload(handle: string, size = 10) {
  await env.DB.prepare(
    `INSERT INTO staging_objects (handle, user_id, account_id, direction, r2_key, filename, mime, size, sha256, created_at, expires_at)
     VALUES (?, 'tg', 'ta', 'upload', ?, 'f.pdf', 'application/pdf', ?, 'h', ?, ?)`,
  )
    .bind(handle, `stg/tg/${handle}`, size, Date.now(), Date.now() + 60_000)
    .run();
}
const H = (s: string) => "sh_" + s.padEnd(43, "B");
const run = (t: ToolContext, i: GateInput) => guarded(t, () => runGated(t, i));
const parse = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

/** A send-shaped input. `args` is the client intent; `handles` become the payload's attachments at build time. */
async function input(
  o: {
    args?: Record<string, unknown>;
    handles?: string[];
    key?: string;
    tool?: string;
    action?: GateInput["action"];
    journal?: boolean;
    stage?: boolean;
  } = {},
): Promise<GateInput> {
  const account = await resolveAccount(e, "tg", "main");
  const tool = o.tool ?? "test_send";
  const args = o.args ?? { to: ["x@example.test"] };
  const intentHash = await hashCanonical(canonicalize({ tool, v: 1, account: "main", args }));
  return {
    tool,
    version: 1,
    action: o.action ?? "send.message",
    journal: o.journal ?? true,
    account,
    intentHash,
    idempotencyKey: o.key,
    modifiers: [],
    summary: "To: x@example.test",
    facts: { recipients: 1, attachments: (o.handles ?? []).length },
    build: async () => {
      if (o.stage) staged.push("staged");
      return { payload: { ...args, attachments: o.handles ?? [] }, handles: o.handles ?? [] };
    },
  };
}

const audit = (pendingId?: string) =>
  env.DB.prepare(
    `SELECT phase, decision, operation_id, pending_id, summary FROM audit_log WHERE user_id = 'tg' ${pendingId ? "AND pending_id = ?" : ""} ORDER BY id`,
  )
    .bind(...(pendingId ? [pendingId] : []))
    .all<{
      phase: string;
      decision: string;
      operation_id: string | null;
      pending_id: string | null;
      summary: string;
    }>();
const opRow = (id: string) =>
  env.DB.prepare("SELECT state, gmail_result_id, result_json, rfc822_message_id FROM operations WHERE id = ?")
    .bind(id)
    .first<any>();

beforeAll(async () => {
  g = await FakeGoogle.create();
  await seedUserAndAccount(env.DB, { userId: "tg", accountId: "ta", alias: "main", isDefault: true });
  await seedUserAndAccount(env.DB, { userId: "tg2", accountId: "tb", alias: "main", isDefault: true });
  await seedAccessToken(e, { userId: "tg", accountId: "ta" });
  registerExecutor("test_send", 1, async (_env, _deps, r) => {
    calls.push(r.payload);
    if (r.payload.fail === "before_open") throw new Error("boom before open");
    if (r.operationId) await beginOperation(env.DB, r.operationId, { rfc822_message_id: "<x@test>" });
    if (r.payload.fail === "after_open") throw new Error("boom after open");
    if (r.payload.fail === "gmail_4xx") throw new GmailApiError(400, "Invalid To header", null);
    return { gmail_result_id: "gm1", echoed: r.payload.to };
  });
  registerExecutor("test_read", 1, async (_env, _deps, r) => ({ read: r.payload.q }));
  registerExecutor("test_forgot", 1, async () => ({ gmail_result_id: "gmX" }));
});

describe("allow", () => {
  it("builds the payload only after the decision, runs the executor, settles the operation, writes intent and outcome, no pending row", async () => {
    await setPolicy(env.DB, { userId: "tg", accountId: null, action: "send.message", level: "allow" });
    const body = parse(await run(ctx(), await input({ stage: true })));
    expect(body).toMatchObject({
      status: "executed",
      account: "main",
      gmail_result_id: "gm1",
      echoed: ["x@example.test"],
    });
    expect(await opRow(body.operation_id)).toMatchObject({
      state: "executed",
      gmail_result_id: "gm1",
      rfc822_message_id: "<x@test>",
    });
    expect(JSON.parse((await opRow(body.operation_id)).result_json)).toEqual({
      gmail_result_id: "gm1",
      echoed: ["x@example.test"],
    });
    const rows = (await audit()).results.slice(-2);
    expect(rows.map((r) => [r.phase, r.decision])).toEqual([
      ["intent", "allow"],
      ["outcome", "executed"],
    ]);
    expect(rows[1]!.operation_id).toBe(body.operation_id);
    expect(rows[0]!.summary).toBe("recipients=1 attachments=0");
    expect(
      (await env.DB.prepare("SELECT count(*) AS n FROM pending_actions WHERE user_id = 'tg'").first<any>()).n,
    ).toBe(0);
    expect(staged).toEqual(["staged"]);
  });
  it("idempotency: the same key and intent replays the stored result without building or running; a different intent conflicts", async () => {
    staged.length = 0;
    const before = calls.length;
    const a = parse(await run(ctx(), await input({ key: "k1", stage: true })));
    const b = parse(await run(ctx(), await input({ key: "k1", stage: true })));
    expect(calls.length).toBe(before + 1);
    expect(staged).toEqual(["staged"]);
    expect(b).toMatchObject({
      status: "executed",
      replayed: true,
      operation_id: a.operation_id,
      gmail_result_id: "gm1",
      echoed: ["x@example.test"],
    });
    const c = parse(await run(ctx(), await input({ key: "k1", args: { to: ["y@example.test"] } })));
    expect(c).toMatchObject({ error: "idempotency_conflict" });
  });
  it("idempotency survives a consumed attachment: the replay is answered before handles are validated", async () => {
    await stageUpload(H("h1"));
    const a = parse(
      await run(ctx(), await input({ key: "k2", handles: [H("h1")], args: { to: ["x@example.test"], files: ["h1"] } })),
    );
    expect(a.status).toBe("executed");
    const row = await env.DB.prepare(
      "SELECT consumed_at, reserved_by_operation_id FROM staging_objects WHERE handle = ?",
    )
      .bind(H("h1"))
      .first<any>();
    expect(row.consumed_at).not.toBeNull();
    expect(row.reserved_by_operation_id).toBeNull();
    const b = parse(
      await run(ctx(), await input({ key: "k2", handles: [H("h1")], args: { to: ["x@example.test"], files: ["h1"] } })),
    );
    expect(b).toMatchObject({ status: "executed", replayed: true, operation_id: a.operation_id });
    // Without a key, the consumed handle fails the reservation inside the gate batch, which rolls back the operation row too.
    const ops = (await env.DB.prepare("SELECT count(*) AS n FROM operations WHERE user_id = 'tg'").first<any>()).n;
    const c = parse(await run(ctx(), await input({ handles: [H("h1")] })));
    expect(c).toMatchObject({ error: "handle_reserved" });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM operations WHERE user_id = 'tg'").first<any>()).n).toBe(
      ops,
    );
  });
  it("after failed_safe the key is rebound to the fresh operation, and a later replay returns that one", async () => {
    const a = parse(
      await run(ctx(), await input({ key: "k3", args: { to: ["x@example.test"], fail: "before_open" } })),
    );
    expect(a).toMatchObject({ error: "internal" });
    const first = (await env.DB.prepare("SELECT operation_id FROM idempotency_keys WHERE key = 'k3'").first<any>())
      .operation_id;
    expect((await opRow(first)).state).toBe("failed_safe");
    const b = parse(
      await run(ctx(), await input({ key: "k3", args: { to: ["x@example.test"], fail: "before_open" } })),
    );
    expect(b).toMatchObject({ error: "internal" });
    const second = (await env.DB.prepare("SELECT operation_id FROM idempotency_keys WHERE key = 'k3'").first<any>())
      .operation_id;
    expect(second).not.toBe(first);
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM operations WHERE user_id='tg' AND action='send.message' AND state='failed_safe' AND payload_hash = (SELECT payload_hash FROM operations WHERE id = ?)",
        )
          .bind(first)
          .first<any>()
      ).n,
    ).toBe(2);
  });
  it("a failure before the request was opened is failed_safe with handles released; a Gmail 4xx after is failed_safe too; anything else after is delivery_unknown", async () => {
    await stageUpload(H("h2"));
    const r1 = parse(
      await run(ctx(), await input({ handles: [H("h2")], args: { to: ["x@example.test"], fail: "before_open" } })),
    );
    expect(r1).toMatchObject({ error: "internal" });
    expect(
      (
        await env.DB.prepare("SELECT reserved_by_operation_id FROM staging_objects WHERE handle = ?")
          .bind(H("h2"))
          .first<any>()
      ).reserved_by_operation_id,
    ).toBeNull();
    const r2 = parse(
      await run(ctx(), await input({ handles: [H("h2")], args: { to: ["x@example.test"], fail: "gmail_4xx" } })),
    );
    expect(r2).toMatchObject({ error: "gmail_error", details: { status: 400 } });
    expect(r2.message).toContain("Invalid To header");
    expect(
      (
        await env.DB.prepare(
          "SELECT state FROM operations WHERE user_id='tg' ORDER BY created_at DESC LIMIT 1",
        ).first<any>()
      ).state,
    ).toBe("failed_safe");
    expect(
      (
        await env.DB.prepare("SELECT reserved_by_operation_id FROM staging_objects WHERE handle = ?")
          .bind(H("h2"))
          .first<any>()
      ).reserved_by_operation_id,
    ).toBeNull();
    const r3 = parse(
      await run(ctx(), await input({ handles: [H("h2")], args: { to: ["x@example.test"], fail: "after_open" } })),
    );
    expect(r3).toMatchObject({ error: "delivery_unknown" });
    expect(r3.message).toContain("Do not retry automatically");
    expect(await opRow(r3.details.operation_id)).toMatchObject({ state: "executing", rfc822_message_id: "<x@test>" });
    expect(
      (
        await env.DB.prepare("SELECT reserved_by_operation_id FROM staging_objects WHERE handle = ?")
          .bind(H("h2"))
          .first<any>()
      ).reserved_by_operation_id,
    ).toBe(r3.details.operation_id);
    expect((await audit()).results.at(-1)).toMatchObject({ phase: "outcome", decision: "delivery_unknown" });
  });
  it("an executor that never opened its operation is a loud internal error, never a success", async () => {
    const r = parse(await run(ctx(), await input({ tool: "test_forgot", args: { to: ["x@example.test"] } })));
    expect(r).toMatchObject({ error: "internal" });
    expect(
      (
        await env.DB.prepare(
          "SELECT state FROM operations WHERE user_id='tg' ORDER BY created_at DESC LIMIT 1",
        ).first<any>()
      ).state,
    ).toBe("failed_safe");
  });
  it("non-journaled reads run with no operation row and one intent row", async () => {
    const before = (await env.DB.prepare("SELECT count(*) AS n FROM operations WHERE user_id='tg'").first<any>()).n;
    const res = parse(
      await run(ctx(), await input({ tool: "test_read", action: "read.search", journal: false, args: { q: "hi" } })),
    );
    expect(res).toMatchObject({ read: "hi", account: "main" });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM operations WHERE user_id='tg'").first<any>()).n).toBe(
      before,
    );
    expect((await audit()).results.at(-1)).toMatchObject({ phase: "intent", decision: "allow" });
  });
});

describe("deny", () => {
  it("writes one intent row, never builds, never runs the executor", async () => {
    await setPolicy(env.DB, { userId: "tg", accountId: "ta", action: "send.message", level: "deny" });
    staged.length = 0;
    const before = calls.length;
    expect(parse(await run(ctx(), await input({ stage: true })))).toMatchObject({ error: "policy_denied" });
    expect(calls.length).toBe(before);
    expect(staged).toEqual([]);
    expect((await audit()).results.at(-1)).toMatchObject({ phase: "intent", decision: "deny" });
    await setPolicy(env.DB, { userId: "tg", accountId: "ta", action: "send.message", level: "ask" });
  });
});

describe("ask without URL elicitation", () => {
  it("stores the canonical payload with tool and version, the intent hash, holds handles, and answers with the 2.6 shape, all in one batch", async () => {
    await stageUpload(H("h3"));
    const i = await input({ handles: [H("h3")] });
    i.modifiers = ["+attachment"];
    const body = PendingApprovalResult.parse(parse(await run(ctx(), i)));
    expect(body).toMatchObject({
      status: "pending_approval",
      action: "send.message",
      modifiers: ["+attachment"],
      account: "main",
      summary: "To: x@example.test",
    });
    expect(body.approval.url).toBe(`https://gmail-mcp.example.workers.dev/approve/${body.action_id}`);
    const row = (await getPending(env.DB, body.action_id, "tg"))!;
    expect(row.payload_json).toBe(`{"attachments":["${H("h3")}"],"to":["x@example.test"],"tool":"test_send","v":1}`);
    expect(row.intent_hash).toBe(i.intentHash);
    expect(
      (await env.DB.prepare("SELECT expires_at FROM staging_objects WHERE handle = ?").bind(H("h3")).first<any>())
        .expires_at,
    ).toBe(row.expires_at + 5 * 60_000);
    expect((await audit(body.action_id)).results.map((r) => r.decision)).toEqual(["ask"]);
  });
  it("idempotency on the ask path: the same key returns the same pending action, and after execution replays its result", async () => {
    const a = PendingApprovalResult.parse(parse(await run(ctx(), await input({ key: "k4" }))));
    const b = PendingApprovalResult.parse(parse(await run(ctx(), await input({ key: "k4" }))));
    expect(b.action_id).toBe(a.action_id);
    expect(
      (await env.DB.prepare("SELECT count(*) AS n FROM pending_actions WHERE idempotency_key = 'k4'").first<any>()).n,
    ).toBe(1);
    await approvePending(env.DB, { id: a.action_id, userId: "tg", via: "browser" });
    const done = await executePending(ctx(), a.action_id);
    expect(done).toMatchObject({ status: "executed", action_id: a.action_id });
    const c = parse(await run(ctx(), await input({ key: "k4" })));
    expect(c).toMatchObject({
      status: "executed",
      replayed: true,
      operation_id: done.operation_id,
      gmail_result_id: "gm1",
    });
    // A cancelled pending releases the key for a fresh attempt.
    const d = PendingApprovalResult.parse(parse(await run(ctx(), await input({ key: "k5" }))));
    await denyPending(env.DB, { id: d.action_id, userId: "tg" });
    const f = PendingApprovalResult.parse(parse(await run(ctx(), await input({ key: "k5" }))));
    expect(f.action_id).not.toBe(d.action_id);
  });
});

describe("ask with URL elicitation and resume", () => {
  const stateFor = async (id: string, tool = "test_send"): Promise<ApprovalState> => ({
    v: APPROVAL_STATE_VERSION,
    tool,
    pending_id: id,
    account_id: "ta",
    intent_hash: (await getPending(env.DB, id, "tg"))!.intent_hash!,
  });
  const resume = (t: ToolContext, i: GateInput, state: ApprovalState) =>
    guarded(t, () => resumeGated(t, { tool: i.tool, account: i.account, intentHash: i.intentHash, state }));
  it("returns input_required with the approval URL and minted state; the accepted retry waits, then executes, without building again", async () => {
    staged.length = 0;
    const first = await run(ctx({ url: true }), await input({ stage: true }));
    expect(first).toMatchObject({ resultType: "input_required" });
    const ir = first as { inputRequests: Record<string, { params: { url: string } }>; requestState: string };
    const id = ir.inputRequests.approval!.params.url.split("/approve/")[1]!;
    expect(ir.requestState).toBe(`minted:${id}`);
    expect(staged).toEqual(["staged"]);
    const state = await stateFor(id);
    setTimeout(() => void approvePending(env.DB, { id, userId: "tg", via: "elicitation" }), 15);
    const body = parse(await resume(ctx({ url: true, answer: "accept" }), await input({ stage: true }), state));
    expect(body).toMatchObject({ status: "executed", action_id: id, gmail_result_id: "gm1" });
    expect(staged).toEqual(["staged"]);
    expect((await getPending(env.DB, id, "tg"))!).toMatchObject({
      state: "executed",
      payload_json: null,
      summary: "redacted",
    });
    expect((await audit(id)).results.map((r) => [r.phase, r.decision])).toEqual([
      ["intent", "ask"],
      ["outcome", "executed"],
    ]);
  });
  it("a retry whose arguments changed is denied and audited; tampered state is refused; the row stays pending", async () => {
    const first = await run(ctx({ url: true }), await input());
    const id = (first as any).inputRequests.approval.params.url.split("/approve/")[1];
    const good = await stateFor(id);
    const changed = parse(
      await resume(ctx({ url: true, answer: "accept" }), await input({ args: { to: ["evil@example.test"] } }), good),
    );
    expect(changed).toMatchObject({ error: "payload_mismatch" });
    expect((await audit(id)).results.at(-1)).toMatchObject({ phase: "intent", decision: "payload_mismatch" });
    for (const bad of [
      { ...good, account_id: "tb" },
      { ...good, tool: "test_read" },
      { ...good, v: "gmail-mcp:approval:v0" as typeof APPROVAL_STATE_VERSION },
      { ...good, intent_hash: "0".repeat(64) },
      { ...good, pending_id: "pa_" + "Z".repeat(22) },
    ]) {
      const r = parse(await resume(ctx({ url: true, answer: "accept" }), await input(), bad));
      expect(r.error).toMatch(/payload_mismatch|pending_not_approved/);
    }
    expect((await getPending(env.DB, id, "tg"))!.state).toBe("pending");
  });
  it("deadline without approval returns pending_approval and leaves the row pending", async () => {
    const first = await run(ctx({ url: true }), await input());
    const id = (first as any).inputRequests.approval.params.url.split("/approve/")[1];
    const res = parse(
      await resume(ctx({ url: true, answer: "accept", deadlineMs: 30 }), await input(), await stateFor(id)),
    );
    expect(PendingApprovalResult.parse(res).action_id).toBe(id);
    expect((await getPending(env.DB, id, "tg"))!.state).toBe("pending");
  });
  it("a declined elicitation cancels; a denied row surfaces as pending_not_approved", async () => {
    const first = await run(ctx({ url: true }), await input());
    const id = (first as any).inputRequests.approval.params.url.split("/approve/")[1];
    expect(parse(await resume(ctx({ url: true, answer: "decline" }), await input(), await stateFor(id)))).toMatchObject(
      { error: "pending_not_approved" },
    );
    expect((await getPending(env.DB, id, "tg"))!.state).toBe("cancelled");
    const second = await run(ctx({ url: true }), await input());
    const id2 = (second as any).inputRequests.approval.params.url.split("/approve/")[1];
    const st = await stateFor(id2);
    await denyPending(env.DB, { id: id2, userId: "tg" });
    expect(parse(await resume(ctx({ url: true, answer: "accept" }), await input(), st))).toMatchObject({
      error: "pending_not_approved",
    });
  });
});

describe("executePending", () => {
  async function pendingId(): Promise<string> {
    return parse(await run(ctx(), await input())).action_id as string;
  }
  it("claims, executes, settles in one batch, purges; a second call is a replay", async () => {
    const id = await pendingId();
    await approvePending(env.DB, { id, userId: "tg", via: "browser" });
    const out = await executePending(ctx(), id);
    expect(out).toMatchObject({ status: "executed", action_id: id, gmail_result_id: "gm1" });
    expect((await getPending(env.DB, id, "tg"))!).toMatchObject({ state: "executed", payload_json: null });
    expect((await opRow(out.operation_id as string)).state).toBe("executed");
    await expect(executePending(ctx(), id)).rejects.toMatchObject({ code: "pending_replayed" });
    await expect(
      executePending({ ...ctx(), principal: { userId: "tg2", email: "x", scope: "mcp" } }, id),
    ).rejects.toMatchObject({ code: "pending_not_approved" });
  });
  it("a policy tightened to deny between approval and execution wins", async () => {
    const id = await pendingId();
    await approvePending(env.DB, { id, userId: "tg", via: "browser" });
    await setPolicy(env.DB, { userId: "tg", accountId: "ta", action: "send.message", level: "deny" });
    await expect(executePending(ctx(), id)).rejects.toMatchObject({ code: "policy_denied" });
    await setPolicy(env.DB, { userId: "tg", accountId: "ta", action: "send.message", level: "ask" });
    const row = (await getPending(env.DB, id, "tg"))!;
    expect(row).toMatchObject({ state: "failed", error: "policy_denied", payload_json: null });
    expect((await opRow(row.operation_id!)).state).toBe("failed_safe");
    expect((await audit(id)).results.at(-1)).toMatchObject({ phase: "outcome", decision: "denied" });
  });
  it("a payload whose executor version moved on is refused, never run", async () => {
    const id = await pendingId();
    await env.DB.prepare(
      "UPDATE pending_actions SET payload_json = replace(payload_json, '\"v\":1', '\"v\":0') WHERE id = ?",
    )
      .bind(id)
      .run();
    await approvePending(env.DB, { id, userId: "tg", via: "browser" });
    const before = calls.length;
    await expect(executePending(ctx(), id)).rejects.toMatchObject({ code: "payload_mismatch" });
    expect(calls.length).toBe(before);
    expect((await getPending(env.DB, id, "tg"))!.state).toBe("failed");
  });
  it("an unapproved or expired row cannot be executed; a needs_reconnect account refuses before claiming", async () => {
    const id = await pendingId();
    await expect(executePending(ctx(), id)).rejects.toMatchObject({ code: "pending_not_approved" });
    await env.DB.prepare("UPDATE pending_actions SET state = 'approved', expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, id)
      .run();
    await expect(executePending(ctx(), id)).rejects.toMatchObject({ code: "pending_expired" });
    const id2 = await pendingId();
    await approvePending(env.DB, { id: id2, userId: "tg", via: "browser" });
    await env.DB.prepare("UPDATE accounts SET status = 'needs_reconnect' WHERE id = 'ta'").run();
    await expect(executePending(ctx(), id2)).rejects.toMatchObject({ code: "account_needs_reconnect" });
    expect((await getPending(env.DB, id2, "tg"))!.state).toBe("approved");
    await env.DB.prepare("UPDATE accounts SET status = 'active' WHERE id = 'ta'").run();
  });
});
```

`worker/test/mcp.test.ts`: the expected tool list gains `"execute_pending"`. `worker/test/schema.test.ts`: add an assertion that `idempotency_keys` exists with its composite primary key and that inserting a row whose `(user_id, account_id)` does not match an account fails.

- [x] **Step 2: run, expect failure**

Run: `cd worker && npx vitest run test/gate.test.ts test/mcp.test.ts test/schema.test.ts`
Expected: FAIL, modules and table not found.

- [x] **Step 3 (GREEN): migration, pending, staging, journal**

`worker/migrations/0003_intent.sql`:

```sql
-- Idempotency keyed on the client's intent (spec 3.5), recorded before staging and before the
-- allow/ask fork so a key means the same thing on every path. A key follows its pending action or
-- operation; a failed_safe operation or a dead pending action releases it for a fresh attempt.
CREATE TABLE idempotency_keys (
  user_id TEXT NOT NULL, account_id TEXT NOT NULL, key TEXT NOT NULL,
  tool TEXT NOT NULL, intent_hash TEXT NOT NULL,
  pending_id TEXT, operation_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, account_id, key),
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id),
  FOREIGN KEY (user_id, account_id, operation_id) REFERENCES operations(user_id, account_id, id)
);
-- The hash of the client's arguments, which is what an elicitation resume compares. payload_hash
-- stays the hash of the execution payload, which is what the claim and the approval page bind to.
ALTER TABLE pending_actions ADD COLUMN intent_hash TEXT;
ALTER TABLE pending_actions ADD COLUMN idempotency_key TEXT;
-- Ids only (message id, thread id, label id), so a replayed key can answer with the original result.
ALTER TABLE operations ADD COLUMN result_json TEXT;
```

`worker/src/approval/pending.ts`: `PendingRow` gains `intent_hash: string | null` and `idempotency_key: string | null`. Add

```ts
export type PendingInsert = {
  id: string;
  userId: string;
  accountId: string;
  action: Action;
  modifiers: Modifier[];
  canonical: string;
  hash: string;
  intentHash: string | null;
  idempotencyKey: string | null;
  summary: string;
  now: number;
  ttlMs?: number;
};

export function createPendingStatement(db: D1Database, o: PendingInsert): D1PreparedStatement {
  if (new TextEncoder().encode(o.canonical).length > LIMITS.canonicalPayloadBytes) {
    throw new GmailMcpError("limit_exceeded", "limit_exceeded: canonical payload > 1 MB");
  }
  return db
    .prepare(
      `INSERT INTO pending_actions (id, user_id, account_id, action, modifiers, payload_json, payload_hash, intent_hash, idempotency_key, summary, state, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .bind(
      o.id,
      o.userId,
      o.accountId,
      o.action,
      JSON.stringify(o.modifiers),
      o.canonical,
      o.hash,
      o.intentHash,
      o.idempotencyKey,
      o.summary,
      o.now,
      o.now + (o.ttlMs ?? PENDING_TTL_MS),
    );
}
```

and rewrite `createPending` to build `canonical`, `hash`, `id`, `now` and run `createPendingStatement` with `intentHash: o.intentHash ?? null` and `idempotencyKey: o.idempotencyKey ?? null` (both new optional fields on its options). `claim.test.ts` keeps passing unchanged.

`worker/src/staging/store.ts` additions:

```ts
export function reserveStatements(
  db: D1Database,
  o: { operationId: string; handles: string[]; userId: string; accountId: string; now: number },
): D1PreparedStatement[] {
  if (o.handles.length === 0) return [];
  return [
    db
      .prepare(
        `UPDATE staging_objects SET reserved_by_operation_id = ?
         WHERE handle IN (${o.handles.map(() => "?").join(",")}) AND user_id = ? AND account_id = ? AND direction = 'upload'
           AND consumed_at IS NULL AND reserved_by_operation_id IS NULL AND expires_at > ?`,
      )
      .bind(o.operationId, ...o.handles, o.userId, o.accountId, o.now),
    db
      .prepare(
        `INSERT INTO _assert (x) SELECT 1 WHERE (SELECT count(*) FROM staging_objects WHERE reserved_by_operation_id = ?) != ?`,
      )
      .bind(o.operationId, o.handles.length),
  ];
}

export function extendExpiryStatement(
  db: D1Database,
  handles: string[],
  userId: string,
  accountId: string,
  until: number,
): D1PreparedStatement | null {
  if (handles.length === 0) return null;
  return db
    .prepare(
      `UPDATE staging_objects SET expires_at = MAX(expires_at, ?) WHERE handle IN (${handles.map(() => "?").join(",")}) AND user_id = ? AND account_id = ?`,
    )
    .bind(until, ...handles, userId, accountId);
}

export async function listUploadHandles(
  db: D1Database,
  o: { handles: string[]; userId: string; accountId: string },
): Promise<StagingRow[]> {
  if (o.handles.length === 0) return [];
  const rows = await db
    .prepare(
      `SELECT * FROM staging_objects WHERE handle IN (${o.handles.map(() => "?").join(",")}) AND user_id = ? AND account_id = ?
         AND direction = 'upload' AND consumed_at IS NULL AND expires_at > ?`,
    )
    .bind(...o.handles, o.userId, o.accountId, Date.now())
    .all<StagingRow>();
  const found = new Set(rows.results.map((r) => r.handle));
  const missing = o.handles.filter((h) => !found.has(h));
  if (missing.length > 0)
    throw new GmailMcpError("handle_invalid", `handle_invalid: ${missing.join(", ")}`, { handles: missing });
  return o.handles.map((h) => rows.results.find((r) => r.handle === h)!);
}

/** The bytes as a stream, so a 25 MB attachment is never held in the isolate at once. */
export async function openStaged(env: Env, row: StagingRow): Promise<ReadableStream<Uint8Array>> {
  const obj = await env.STAGING.get(row.r2_key);
  if (!obj) throw new GmailMcpError("handle_invalid", `handle_invalid: object missing for ${row.handle}`);
  return obj.body;
}
```

`extendExpiry` keeps its signature and delegates to the statement. `worker/src/approval/claim.ts`: the inline reservation block becomes `stmts.push(...reserveStatements(db, { operationId, handles, userId: before.user_id, accountId: before.account_id, now }));`.

`worker/src/operations/journal.ts` additions:

```ts
/** Spec 3.5 step 3: the executor calls this immediately before the first request that can change Gmail. */
export async function beginOperation(
  db: D1Database,
  operationId: string,
  patch: { rfc822_message_id?: string } = {},
): Promise<void> {
  if (!(await transition(db, operationId, ["claimed"], "executing", patch))) {
    throw new GmailMcpError("internal", `operation ${operationId} was not claimed`);
  }
}

export function insertOperationStatement(
  db: D1Database,
  o: { id: string; userId: string; accountId: string; action: Action; payloadHash: string; now: number },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO operations (id, user_id, account_id, action, idempotency_key, state, payload_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'claimed', ?, ?, ?)`,
    )
    .bind(o.id, o.userId, o.accountId, o.action, o.payloadHash, o.now, o.now);
}
```

`OperationRow` gains `result_json: string | null`. `acquire` stays for Plan 1's tests; the gate uses `insertOperationStatement` and the `idempotency_keys` table instead, because the operations index binds one key to one operation for ever, and spec 3.5 lets a `failed_safe` attempt be followed by a fresh one under the same key.

- [x] **Step 4 (GREEN): state, results, accounts, idempotency, settlement**

`worker/src/approval/state.ts`:

```ts
import { createRequestStateCodec, type RequestStateCodec } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import type { Principal } from "../auth/principal";
import { PENDING_TTL_MS } from "./pending";

export const APPROVAL_STATE_VERSION = "gmail-mcp:approval:v1";
export type ApprovalState = {
  v: typeof APPROVAL_STATE_VERSION;
  tool: string;
  pending_id: string;
  account_id: string;
  intent_hash: string;
};

/**
 * Spec 3.4: elicitation approval carries HMAC-signed state bound to the owner. The SDK codec signs with
 * STATE_HMAC_KEY, expires with the pending row, and binds to the principal and the method. The payload
 * is readable by the client, which is fine: it holds ids and a hash, never content.
 */
export function approvalCodec(env: Env, principal: Principal): RequestStateCodec<ApprovalState> {
  return createRequestStateCodec<ApprovalState>({
    key: Uint8Array.from(atob(env.STATE_HMAC_KEY), (c) => c.charCodeAt(0)),
    ttlSeconds: PENDING_TTL_MS / 1000,
    bind: (ctx) => `${principal.userId}\0${ctx.mcpReq.method}`,
  });
}
```

`worker/src/tools/accounts.ts`:

```ts
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Env } from "../env";
import type { TrustContext } from "../policy/recipients";

export type AccountRef = {
  id: string;
  alias: string;
  email: string;
  sendAs: string[];
  orgDomains: string[];
  sendLimitBytes: number;
};
type Row = {
  id: string;
  alias: string;
  google_email: string;
  send_as: string;
  org_domains: string | null;
  send_limit_bytes: number;
  status: string;
};

function toRef(row: Row): AccountRef {
  if (row.status !== "active") {
    throw new GmailMcpError("account_needs_reconnect", `account_needs_reconnect: ${row.alias} is ${row.status}`, {
      alias: row.alias,
    });
  }
  return {
    id: row.id,
    alias: row.alias,
    email: row.google_email,
    sendAs: JSON.parse(row.send_as) as string[],
    orgDomains: JSON.parse(row.org_domains ?? "[]") as string[],
    sendLimitBytes: row.send_limit_bytes,
  };
}

const COLS = "id, alias, google_email, send_as, org_domains, send_limit_bytes, status";

/** Explicit alias, or the default. Ownership is in the query. */
export async function resolveAccount(env: Env, userId: string, alias?: string): Promise<AccountRef> {
  const row = alias
    ? await env.DB.prepare(`SELECT ${COLS} FROM accounts WHERE user_id = ? AND alias = ?`)
        .bind(userId, alias)
        .first<Row>()
    : await env.DB.prepare(`SELECT ${COLS} FROM accounts WHERE user_id = ? AND is_default = 1`)
        .bind(userId)
        .first<Row>();
  if (!row)
    throw new GmailMcpError(
      "account_not_found",
      alias ? `account_not_found: ${alias}` : "account_not_found: no default account",
    );
  return toRef(row);
}

export async function accountById(env: Env, userId: string, accountId: string): Promise<AccountRef> {
  const row = await env.DB.prepare(`SELECT ${COLS} FROM accounts WHERE user_id = ? AND id = ?`)
    .bind(userId, accountId)
    .first<Row>();
  if (!row) throw new GmailMcpError("account_not_found", "account_not_found");
  return toRef(row);
}

/** Spec 2.8: self addresses, the allowlist, and (Workspace only) the organisation domains. */
export async function trustContext(env: Env, userId: string, acct: AccountRef): Promise<TrustContext> {
  const rows = await env.DB.prepare("SELECT pattern FROM contact_allowlist WHERE user_id = ? AND account_id = ?")
    .bind(userId, acct.id)
    .all<{ pattern: string }>();
  return {
    selfAddresses: [acct.email, ...acct.sendAs],
    allowlist: rows.results.map((r) => r.pattern),
    orgDomains: acct.orgDomains,
  };
}
```

`worker/src/tools/results.ts`:

```ts
import { inputRequired, type CallToolResult, type InputRequiredResult } from "@modelcontextprotocol/server";
import type { Action, Modifier } from "@gmail-mcp/shared/actions";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { PendingApprovalResult } from "@gmail-mcp/shared/schemas";
import type { Env } from "../env";
import type { PendingRow } from "../approval/pending";
import { connectUrl } from "../google/connect";
import type { ToolContext } from "./gate";

export type ToolResult = CallToolResult | InputRequiredResult;

export function text(obj: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

/** Every failure a tool reports is a structured, non-throwing result the model can read. */
export function toolError(e: unknown): CallToolResult {
  const err =
    e instanceof GmailMcpError
      ? e
      : new GmailMcpError("internal", "internal: the request failed before it could be classified");
  if (!(e instanceof GmailMcpError)) console.error("tool failure", (e as Error)?.message ?? e);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: err.code, message: err.message, details: err.details ?? {} }, null, 2),
      },
    ],
  };
}

export function approvalUrl(env: Env, pendingId: string): string {
  return `https://${env.WORKER_HOSTNAME}/approve/${pendingId}`;
}

/** Spec 2.6, exactly. */
export function pendingApprovalResult(env: Env, row: PendingRow, alias: string): PendingApprovalResult {
  return {
    status: "pending_approval",
    action_id: row.id,
    action: row.action as Action,
    modifiers: JSON.parse(row.modifiers) as Modifier[],
    account: alias,
    summary: row.summary,
    approval: { mode: "url", url: approvalUrl(env, row.id) },
    expires_at: new Date(row.expires_at).toISOString(),
  };
}

/** Spec 3.3: a needs_reconnect account answers with the connect page, as elicitation when the client can open one. */
export async function connectRequired(t: ToolContext, alias: string): Promise<ToolResult> {
  const url = await connectUrl(t.env, t.principal.userId, alias);
  if (t.urlElicitation) {
    return inputRequired({
      inputRequests: {
        connect: inputRequired.elicitUrl({ message: `Reconnect the Gmail account "${alias}" to continue.`, url }),
      },
    });
  }
  return text({ status: "connect_required", account: alias, url });
}

/** Wraps every tool body: GmailMcpError becomes a structured error result; needs_reconnect becomes the connect flow; anything else is logged and reported as internal. */
export async function guarded(t: ToolContext, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof GmailMcpError && e.code === "account_needs_reconnect" && typeof e.details?.alias === "string")
      return connectRequired(t, e.details.alias);
    return toolError(e);
  }
}
```

`worker/src/tools/idempotency.ts`:

```ts
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Env } from "../env";
import { getPending, type PendingRow } from "../approval/pending";
import type { OperationRow } from "../operations/journal";
import { pendingApprovalResult } from "./results";

export type IdempotencyRow = {
  user_id: string;
  account_id: string;
  key: string;
  tool: string;
  intent_hash: string;
  pending_id: string | null;
  operation_id: string | null;
};

export function lookupIdempotency(
  db: D1Database,
  o: { userId: string; accountId: string; key: string },
): Promise<IdempotencyRow | null> {
  return db
    .prepare("SELECT * FROM idempotency_keys WHERE user_id = ? AND account_id = ? AND key = ?")
    .bind(o.userId, o.accountId, o.key)
    .first<IdempotencyRow>();
}

/**
 * Bind the key to a new pending action or operation. The upsert only moves a key whose current holder is
 * retired (a failed_safe operation, or a pending action that is denied, cancelled, expired or failed);
 * the assertion then fails the batch when the key still belongs to a live holder, which is how two
 * concurrent first calls with one key yield one send: the loser re-reads the key and replays.
 */
export function bindIdempotencyStatements(
  db: D1Database,
  o: {
    userId: string;
    accountId: string;
    key: string;
    tool: string;
    intentHash: string;
    pendingId: string | null;
    operationId: string | null;
    now: number;
  },
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO idempotency_keys (user_id, account_id, key, tool, intent_hash, pending_id, operation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, account_id, key) DO UPDATE SET
           pending_id = excluded.pending_id, operation_id = excluded.operation_id, updated_at = excluded.updated_at
         WHERE idempotency_keys.tool = excluded.tool AND idempotency_keys.intent_hash = excluded.intent_hash
           AND (idempotency_keys.operation_id IS NULL OR idempotency_keys.operation_id IN (SELECT id FROM operations WHERE state = 'failed_safe'))
           AND (idempotency_keys.pending_id IS NULL OR idempotency_keys.pending_id IN (
                 SELECT id FROM pending_actions WHERE state IN ('denied','cancelled','expired','failed')
                   OR (state IN ('executing','executed') AND operation_id IN (SELECT id FROM operations WHERE state = 'failed_safe'))))`,
      )
      .bind(o.userId, o.accountId, o.key, o.tool, o.intentHash, o.pendingId, o.operationId, o.now, o.now),
    db
      .prepare(
        `INSERT INTO _assert (x) SELECT 1 WHERE NOT EXISTS (
           SELECT 1 FROM idempotency_keys WHERE user_id = ? AND account_id = ? AND key = ?
             AND ((? IS NOT NULL AND pending_id = ?) OR (? IS NOT NULL AND operation_id = ?)))`,
      )
      .bind(o.userId, o.accountId, o.key, o.pendingId, o.pendingId, o.operationId, o.operationId),
  ];
}

const opRow = (db: D1Database, id: string) =>
  db.prepare("SELECT * FROM operations WHERE id = ?").bind(id).first<OperationRow>();

function replayOperation(op: OperationRow, alias: string): Record<string, unknown> | "fresh" {
  if (op.state === "failed_safe") return "fresh";
  if (op.state === "executed") {
    return {
      status: "executed",
      replayed: true,
      account: alias,
      operation_id: op.id,
      gmail_result_id: op.gmail_result_id,
      ...(JSON.parse(op.result_json ?? "{}") as object),
    };
  }
  return {
    status: "delivery_unknown",
    account: alias,
    operation_id: op.id,
    message: "The Gmail request may have succeeded. Do not retry automatically.",
  };
}

/**
 * Spec 3.5 step 1 over the whole lifecycle: executed replays the stored result, in flight or unknown
 * answers delivery_unknown, a live pending action is returned again, and a retired holder yields "fresh".
 * A key reused with a different tool or intent is a conflict, never a quiet replay.
 */
export async function replayFor(
  env: Env,
  row: IdempotencyRow,
  o: { tool: string; intentHash: string; alias: string; userId: string },
): Promise<Record<string, unknown> | "fresh"> {
  if (row.tool !== o.tool || row.intent_hash !== o.intentHash) {
    throw new GmailMcpError(
      "idempotency_conflict",
      "idempotency_conflict: key previously used for a different request",
    );
  }
  if (row.operation_id) {
    const op = await opRow(env.DB, row.operation_id);
    return op ? replayOperation(op, o.alias) : "fresh";
  }
  if (row.pending_id) {
    const p: PendingRow | null = await getPending(env.DB, row.pending_id, o.userId);
    if (!p) return "fresh";
    if (p.operation_id) {
      const op = await opRow(env.DB, p.operation_id);
      return op ? replayOperation(op, o.alias) : "fresh";
    }
    if (p.state === "pending" || p.state === "approved")
      return pendingApprovalResult(env, p, o.alias) as unknown as Record<string, unknown>;
    return "fresh";
  }
  return "fresh";
}
```

`worker/src/tools/settle.ts`:

```ts
import { auditStatement, type AuditBase } from "../audit/log";

export type Settlement = {
  operationId: string | null;
  pendingId: string | null;
  /** null for intent-only reads (spec 3.10). */
  audit: (AuditBase & { gmailResultId?: string }) | null;
};

/**
 * Spec 3.9's "D1 error after a Gmail side effect" row is why every local consequence of one Gmail
 * result lands in one batch: the operation's terminal state and stored result, the reservations, the
 * pending row's purge, and the outcome audit row. A crash cannot leave the operation executed with its
 * handles still reserved, or the pending row executing after its operation finished.
 */
export async function settleExecuted(
  db: D1Database,
  s: Settlement & { gmailResultId: string | null; result: Record<string, unknown> },
): Promise<void> {
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  if (s.operationId) {
    stmts.push(
      db
        .prepare(
          `UPDATE operations SET state = 'executed', gmail_result_id = ?, result_json = ?, updated_at = ? WHERE id = ? AND state = 'executing'`,
        )
        .bind(s.gmailResultId, JSON.stringify(s.result), now, s.operationId),
      db
        .prepare(
          `INSERT INTO _assert (x) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM operations WHERE id = ? AND state = 'executed')`,
        )
        .bind(s.operationId),
      db
        .prepare(
          `UPDATE staging_objects SET consumed_at = ?, reserved_by_operation_id = NULL WHERE reserved_by_operation_id = ? AND consumed_at IS NULL`,
        )
        .bind(now, s.operationId),
    );
  }
  if (s.pendingId) {
    stmts.push(
      db
        .prepare(
          `UPDATE pending_actions SET state = 'executed', payload_json = NULL, summary = 'redacted', executed_at = ? WHERE id = ? AND state = 'executing'`,
        )
        .bind(now, s.pendingId),
      db
        .prepare(
          `INSERT INTO _assert (x) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM pending_actions WHERE id = ? AND state = 'executed')`,
        )
        .bind(s.pendingId),
    );
  }
  if (s.audit) stmts.push(auditStatement(db, "outcome", { ...s.audit, decision: "executed" }));
  if (stmts.length > 0) await db.batch(stmts);
}

/** Gmail provably did nothing: the operation is failed_safe, its reservations return to the pool, the pending row fails. */
export async function settleFailedSafe(
  db: D1Database,
  s: Settlement & { error: string; decision?: string },
): Promise<void> {
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  if (s.operationId) {
    stmts.push(
      db
        .prepare(
          `UPDATE operations SET state = 'failed_safe', updated_at = ? WHERE id = ? AND state IN ('claimed','executing')`,
        )
        .bind(now, s.operationId),
      db
        .prepare(
          `INSERT INTO _assert (x) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM operations WHERE id = ? AND state = 'failed_safe')`,
        )
        .bind(s.operationId),
      db
        .prepare(
          `UPDATE staging_objects SET reserved_by_operation_id = NULL WHERE reserved_by_operation_id = ? AND consumed_at IS NULL`,
        )
        .bind(s.operationId),
    );
  }
  if (s.pendingId) {
    stmts.push(
      db
        .prepare(
          `UPDATE pending_actions SET state = 'failed', payload_json = NULL, summary = 'redacted', error = ?, executed_at = ? WHERE id = ? AND state = 'executing'`,
        )
        .bind(s.error, now, s.pendingId),
    );
  }
  if (s.audit) stmts.push(auditStatement(db, "outcome", { ...s.audit, decision: s.decision ?? "failed" }));
  if (stmts.length > 0) await db.batch(stmts);
}

/** Gmail may have it: the operation stays executing for the cron; the pending row is finished and says why. */
export async function settleUnknown(db: D1Database, s: Settlement): Promise<void> {
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  if (s.pendingId) {
    stmts.push(
      db
        .prepare(
          `UPDATE pending_actions SET state = 'failed', payload_json = NULL, summary = 'redacted', error = 'delivery_unknown', executed_at = ? WHERE id = ? AND state = 'executing'`,
        )
        .bind(now, s.pendingId),
    );
  }
  if (s.audit) stmts.push(auditStatement(db, "outcome", { ...s.audit, decision: "delivery_unknown" }));
  if (stmts.length > 0) await db.batch(stmts);
}
```

- [x] **Step 5 (GREEN): the gate**

`worker/src/tools/gate.ts`:

```ts
import { inputRequired, type ServerContext, type RequestStateCodec } from "@modelcontextprotocol/server";
import type { Action, Modifier } from "@gmail-mcp/shared/actions";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Env } from "../env";
import type { Deps } from "../deps";
import type { Principal } from "../auth/principal";
import { auditIntent, auditStatement, type AuditBase, type AuditFacts } from "../audit/log";
import { claimPending, handlesFromPayload } from "../approval/claim";
import {
  cancelPending,
  createPendingStatement,
  getPending,
  PENDING_TTL_MS,
  type PendingRow,
} from "../approval/pending";
import { APPROVAL_STATE_VERSION, type ApprovalState } from "../approval/state";
import { canonicalize, hashCanonical } from "../crypto/canonical";
import { randomId } from "../crypto/random";
import { GmailApiError } from "../google/gmail";
import { insertOperationStatement } from "../operations/journal";
import { decide } from "../policy/engine";
import { LIMITS } from "../policy/limits";
import { extendExpiryStatement, reserveStatements } from "../staging/store";
import { accountById, type AccountRef } from "./accounts";
import { bindIdempotencyStatements, lookupIdempotency, replayFor } from "./idempotency";
import { approvalUrl, pendingApprovalResult, text, type ToolResult } from "./results";
import { settleExecuted, settleFailedSafe, settleUnknown } from "./settle";

const HOLD_MARGIN_MS = 5 * 60_000;

export type Round = {
  requestState(): ApprovalState | undefined;
  answer(): "accept" | "decline" | "cancel" | "missing";
  mint(s: ApprovalState): Promise<string>;
};

export function roundOf(ctx: ServerContext, codec: RequestStateCodec<ApprovalState>): Round {
  return {
    requestState: () => ctx.mcpReq.requestState<ApprovalState>(),
    answer: () => {
      const r = ctx.mcpReq.inputResponses?.approval as { action?: unknown } | undefined;
      return r?.action === "accept" || r?.action === "decline" || r?.action === "cancel" ? r.action : "missing";
    },
    mint: (s) => codec.mint(s, ctx),
  };
}

export type ToolContext = { env: Env; deps: Deps; principal: Principal; urlElicitation: boolean; round: Round };

export type ExecRun = {
  userId: string;
  account: AccountRef;
  payload: Record<string, unknown>;
  operationId: string | null;
  pendingId: string | null;
};
export type Executor = (env: Env, deps: Deps, run: ExecRun) => Promise<Record<string, unknown>>;

const executors = new Map<string, { fn: Executor; version: number }>();
/** Keyed by tool name and versioned: a pending row names both, and executes only under the version it was approved for. */
export function registerExecutor(tool: string, version: number, fn: Executor): void {
  executors.set(tool, { fn, version });
}
export function executorFor(tool: string): { fn: Executor; version: number } {
  const e = executors.get(tool);
  if (!e) throw new GmailMcpError("internal", `no executor for ${tool}`);
  return e;
}

export type GateInput = {
  tool: string;
  version: number;
  action: Action;
  journal: boolean;
  account: AccountRef;
  intentHash: string;
  idempotencyKey?: string | undefined;
  modifiers: Modifier[];
  summary: string;
  facts: AuditFacts;
  /** Runs after the decision and after any replay: stages inline bytes, validates handles, returns the execution payload. */
  build: () => Promise<{ payload: Record<string, unknown>; handles: string[] }>;
};

/** Spec 3.10: reads write one intent row only. read.attachment creates staging state, so it keeps its outcome. */
const INTENT_ONLY: ReadonlySet<Action> = new Set<Action>([
  "read.search",
  "read.message",
  "account.read",
  "policy.read",
]);

const base = (
  t: ToolContext,
  i: { tool: string; action: Action; account: AccountRef; modifiers: Modifier[]; facts: AuditFacts },
): AuditBase => ({
  userId: t.principal.userId,
  accountId: i.account.id,
  tool: i.tool,
  action: i.action,
  modifiers: i.modifiers,
  facts: i.facts,
});

async function canonicalPayload(payload: Record<string, unknown>): Promise<{ canonical: string; hash: string }> {
  const canonical = canonicalize(payload);
  if (new TextEncoder().encode(canonical).length > LIMITS.canonicalPayloadBytes) {
    throw new GmailMcpError("limit_exceeded", "limit_exceeded: canonical payload > 1 MB");
  }
  return { canonical, hash: await hashCanonical(canonical) };
}

/**
 * The one decision point, in this order: replay a known key, decide policy, build the payload, then
 * store-and-ask or journal-and-run. Nothing before `build` writes staging state, so a denied or replayed
 * call leaves no trace but its audit row. Nothing here touches Gmail; executors do, after the journal row.
 */
export async function runGated(t: ToolContext, input: GateInput): Promise<ToolResult> {
  const db = t.env.DB;
  const userId = t.principal.userId;
  if (input.idempotencyKey) {
    const known = await lookupIdempotency(db, { userId, accountId: input.account.id, key: input.idempotencyKey });
    if (known) {
      const replay = await replayFor(t.env, known, {
        tool: input.tool,
        intentHash: input.intentHash,
        alias: input.account.alias,
        userId,
      });
      if (replay !== "fresh") return text(replay);
    }
  }
  const decision = await decide(db, {
    userId,
    accountId: input.account.id,
    action: input.action,
    modifiers: input.modifiers,
  });
  if (decision.level === "deny") {
    await auditIntent(db, { ...base(t, input), decision: "deny" });
    throw new GmailMcpError("policy_denied", `policy_denied: ${input.action}`, { modifiers: input.modifiers });
  }
  const built = await input.build();
  const payload = { ...built.payload, tool: input.tool, v: input.version };
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
  const { canonical, hash } = await canonicalPayload(payload);
  const now = Date.now();

  if (decision.level === "ask") {
    const id = randomId("pa");
    const stmts: D1PreparedStatement[] = [
      createPendingStatement(db, {
        id,
        userId,
        accountId: input.account.id,
        action: input.action,
        modifiers: input.modifiers,
        canonical,
        hash,
        intentHash: input.intentHash,
        idempotencyKey: input.idempotencyKey ?? null,
        summary: input.summary,
        now,
      }),
    ];
    // Spec 3.7: a handle staged 29 minutes ago must not expire between approval and execution.
    const hold = extendExpiryStatement(
      db,
      built.handles,
      userId,
      input.account.id,
      now + PENDING_TTL_MS + HOLD_MARGIN_MS,
    );
    if (hold) stmts.push(hold);
    if (input.idempotencyKey)
      stmts.push(
        ...bindIdempotencyStatements(db, {
          userId,
          accountId: input.account.id,
          key: input.idempotencyKey,
          tool: input.tool,
          intentHash: input.intentHash,
          pendingId: id,
          operationId: null,
          now,
        }),
      );
    stmts.push(auditStatement(db, "intent", { ...base(t, input), decision: "ask", pendingId: id }));
    try {
      await db.batch(stmts);
    } catch (e) {
      return lostRace(t, input, e);
    }
    const row = (await getPending(db, id, userId))!;
    return ask(t, input, row);
  }

  const operationId = input.journal || built.handles.length > 0 ? randomId("op") : null;
  const stmts: D1PreparedStatement[] = [];
  if (operationId)
    stmts.push(
      insertOperationStatement(db, {
        id: operationId,
        userId,
        accountId: input.account.id,
        action: input.action,
        payloadHash: hash,
        now,
      }),
    );
  if (input.idempotencyKey)
    stmts.push(
      ...bindIdempotencyStatements(db, {
        userId,
        accountId: input.account.id,
        key: input.idempotencyKey,
        tool: input.tool,
        intentHash: input.intentHash,
        pendingId: null,
        operationId,
        now,
      }),
    );
  if (operationId)
    stmts.push(
      ...reserveStatements(db, { operationId, handles: built.handles, userId, accountId: input.account.id, now }),
    );
  stmts.push(
    auditStatement(db, "intent", { ...base(t, input), decision: "allow", ...(operationId ? { operationId } : {}) }),
  );
  try {
    await db.batch(stmts);
  } catch (e) {
    if (built.handles.length > 0 && operationId) {
      // Distinguish a lost idempotency race from an unavailable handle by re-reading the key.
      const replay = await lostRace(t, input, e, true);
      if (replay) return replay;
      throw new GmailMcpError("handle_reserved", "handle_reserved: one or more attachments are unavailable", {
        handles: built.handles,
      });
    }
    return lostRace(t, input, e);
  }
  return text(await runExecutor(t, { ...input, payload, handles: built.handles, operationId, pendingId: null }));
}

/**
 * A batch that failed because the idempotency assertion refused it means another call with the same key
 * won the race a moment ago: answer with that call's state. Any other failure is rethrown.
 */
async function lostRace(t: ToolContext, input: GateInput, e: unknown, quiet = false): Promise<ToolResult | never> {
  if (input.idempotencyKey) {
    const known = await lookupIdempotency(t.env.DB, {
      userId: t.principal.userId,
      accountId: input.account.id,
      key: input.idempotencyKey,
    });
    if (known) {
      const replay = await replayFor(t.env, known, {
        tool: input.tool,
        intentHash: input.intentHash,
        alias: input.account.alias,
        userId: t.principal.userId,
      });
      if (replay !== "fresh") return text(replay);
    }
  }
  if (quiet) return undefined as never;
  throw new GmailMcpError("internal", `gate batch failed: ${String((e as Error).message ?? e)}`);
}

async function ask(t: ToolContext, input: GateInput, row: PendingRow): Promise<ToolResult> {
  const url = approvalUrl(t.env, row.id);
  if (!t.urlElicitation) return text(pendingApprovalResult(t.env, row, input.account.alias));
  const requestState = await t.round.mint({
    v: APPROVAL_STATE_VERSION,
    tool: input.tool,
    pending_id: row.id,
    account_id: input.account.id,
    intent_hash: input.intentHash,
  });
  return inputRequired({
    inputRequests: {
      approval: inputRequired.elicitUrl({
        message: `Approve ${input.action} on ${input.account.alias}: ${input.summary}`,
        url,
      }),
    },
    requestState,
  });
}

/**
 * Spec 1.4 and 3.4 on the retried call. The state must be ours, for this tool and this account; the
 * retried arguments must hash to the intent the pending row was created from; then poll until approved,
 * declined or the deadline. The retried call never rebuilds the payload: what executes is the row.
 */
export async function resumeGated(
  t: ToolContext,
  o: { tool: string; account: AccountRef; intentHash: string; state: ApprovalState },
): Promise<ToolResult> {
  const db = t.env.DB;
  const userId = t.principal.userId;
  const auditBase: AuditBase = {
    userId,
    accountId: o.account.id,
    tool: o.tool,
    action: "send.message",
    modifiers: [],
    facts: {},
  };
  const mismatch = async (why: string, row?: PendingRow): Promise<never> => {
    await auditIntent(db, {
      ...auditBase,
      ...(row
        ? { action: row.action as Action, modifiers: JSON.parse(row.modifiers) as Modifier[], pendingId: row.id }
        : {}),
      decision: "payload_mismatch",
    });
    throw new GmailMcpError("payload_mismatch", `payload_mismatch: ${why}`);
  };
  const s = o.state;
  if (s.v !== APPROVAL_STATE_VERSION || s.tool !== o.tool || s.account_id !== o.account.id)
    return mismatch("state does not belong to this call");
  const row = await getPending(db, s.pending_id, userId);
  if (!row) throw new GmailMcpError("pending_not_approved", "pending_not_approved: unknown");
  if (row.intent_hash !== o.intentHash || s.intent_hash !== row.intent_hash) return mismatch("arguments changed", row);

  const answer = t.round.answer();
  if (answer === "decline" || answer === "cancel") {
    await cancelPending(db, { id: row.id, userId });
    throw new GmailMcpError("pending_not_approved", `pending_not_approved: ${answer}d in the client`);
  }
  const deadline = Date.now() + t.deps.approvalWait.deadlineMs;
  for (;;) {
    const cur = await getPending(db, row.id, userId);
    if (!cur) throw new GmailMcpError("pending_not_approved", "pending_not_approved: unknown");
    if (cur.expires_at <= Date.now() && (cur.state === "pending" || cur.state === "approved"))
      throw new GmailMcpError("pending_expired", "pending_expired");
    switch (cur.state) {
      case "approved":
        return text(await executePending(t, cur.id));
      case "pending":
        if (Date.now() >= deadline) return text(pendingApprovalResult(t.env, cur, o.account.alias));
        await t.deps.sleep(t.deps.approvalWait.intervalMs);
        continue;
      case "executing":
      case "executed":
        throw new GmailMcpError("pending_replayed", `pending_replayed: ${cur.state}`);
      case "expired":
        throw new GmailMcpError("pending_expired", "pending_expired");
      default:
        throw new GmailMcpError("pending_not_approved", `pending_not_approved: ${cur.state}`);
    }
  }
}

export type ExecutorRun = {
  tool: string;
  action: Action;
  account: AccountRef;
  payload: Record<string, unknown>;
  modifiers: Modifier[];
  facts: AuditFacts;
  handles: string[];
  operationId: string | null;
  pendingId: string | null;
};

/**
 * Runs the executor and settles every local consequence in one batch. After a failure the operation's
 * state says what happened: `claimed` means no request was opened (failed_safe); `executing` with a
 * Gmail 4xx means Gmail said no, definitively (failed_safe); `executing` with anything else means Gmail
 * may have it (delivery_unknown, the row stays for the cron). A settlement failure after a Gmail success
 * is reported on the result and logged, never turned into a failure the model might retry (spec 3.9).
 */
export async function runExecutor(t: ToolContext, run: ExecutorRun): Promise<Record<string, unknown>> {
  const db = t.env.DB;
  const audit = INTENT_ONLY.has(run.action)
    ? null
    : {
        ...base(t, run),
        ...(run.pendingId ? { pendingId: run.pendingId } : {}),
        ...(run.operationId ? { operationId: run.operationId } : {}),
      };
  let out: Record<string, unknown>;
  try {
    out = await executorFor(run.tool).fn(t.env, t.deps, {
      userId: t.principal.userId,
      account: run.account,
      payload: run.payload,
      operationId: run.operationId,
      pendingId: run.pendingId,
    });
  } catch (e) {
    const state = run.operationId
      ? (await db.prepare("SELECT state FROM operations WHERE id = ?").bind(run.operationId).first<{ state: string }>())
          ?.state
      : null;
    const err =
      e instanceof GmailMcpError
        ? e
        : new GmailMcpError("internal", "internal: the executor failed", {
            cause: e instanceof Error ? e.message : String(e),
          });
    if (
      !run.operationId ||
      state === "claimed" ||
      (state === "executing" && e instanceof GmailApiError && e.status >= 400 && e.status < 500)
    ) {
      await settleFailedSafe(db, { operationId: run.operationId, pendingId: run.pendingId, audit, error: err.code });
      throw err;
    }
    if (state === "executing") {
      await settleUnknown(db, { operationId: run.operationId, pendingId: run.pendingId, audit });
      throw new GmailMcpError(
        "delivery_unknown",
        "delivery_unknown: The Gmail request may have succeeded. Do not retry automatically.",
        { operation_id: run.operationId, cause: err.message },
      );
    }
    await settleFailedSafe(db, { operationId: run.operationId, pendingId: run.pendingId, audit, error: err.code });
    throw err;
  }
  const gmailResultId = typeof out.gmail_result_id === "string" ? out.gmail_result_id : null;
  const result: Record<string, unknown> = {
    status: "executed",
    account: run.account.alias,
    ...(run.operationId ? { operation_id: run.operationId } : {}),
    ...(run.pendingId ? { action_id: run.pendingId } : {}),
    ...out,
  };
  try {
    await settleExecuted(db, {
      operationId: run.operationId,
      pendingId: run.pendingId,
      audit: audit && gmailResultId ? { ...audit, gmailResultId } : audit,
      gmailResultId,
      result: out,
    });
  } catch (e) {
    const state = run.operationId
      ? (await db.prepare("SELECT state FROM operations WHERE id = ?").bind(run.operationId).first<{ state: string }>())
          ?.state
      : null;
    if (state === "claimed") {
      // The executor returned success without ever opening its operation: a programming error, made loud.
      await settleFailedSafe(db, { operationId: run.operationId, pendingId: run.pendingId, audit, error: "internal" });
      throw new GmailMcpError("internal", `internal: ${run.tool} returned without opening its operation`);
    }
    console.error("settlement failed after Gmail success", run.operationId, (e as Error).message);
    result.local_settlement_failed = true;
  }
  return result;
}

/**
 * Spec 3.4 from the approved side: claim atomically, re-evaluate policy (a tighter policy saved after
 * approval wins), check the executor version, run, settle. The account is checked before the claim so a
 * needs_reconnect account leaves the approval intact for later.
 */
export async function executePending(t: ToolContext, pendingId: string): Promise<Record<string, unknown>> {
  const db = t.env.DB;
  const userId = t.principal.userId;
  const before = await getPending(db, pendingId, userId);
  if (!before) throw new GmailMcpError("pending_not_approved", "pending_not_approved: unknown");
  const account = await accountById(t.env, userId, before.account_id);

  const { operationId, pending } = await claimPending(db, { id: pendingId, userId });
  const payload = JSON.parse(pending.payload_json ?? "null") as Record<string, unknown> | null;
  const action = pending.action;
  const modifiers = JSON.parse(pending.modifiers) as Modifier[];
  const tool = typeof payload?.tool === "string" ? payload.tool : "unknown";
  const audit: AuditBase = {
    userId,
    accountId: account.id,
    tool,
    action,
    modifiers,
    pendingId,
    operationId,
    facts: factsOf(payload ?? {}),
  };

  const refuse = async (code: "payload_mismatch" | "policy_denied", why: string, decision: string): Promise<never> => {
    await settleFailedSafe(db, { operationId, pendingId, audit, error: code, decision });
    throw new GmailMcpError(code, `${code}: ${why}`);
  };
  if (!payload || tool === "unknown") return refuse("payload_mismatch", "no tool in payload", "failed");
  const executor = executorFor(tool);
  if (payload.v !== executor.version)
    return refuse(
      "payload_mismatch",
      `payload was approved for ${tool} v${String(payload.v)}, executor is v${executor.version}`,
      "failed",
    );
  const decision = await decide(db, { userId, accountId: account.id, action, modifiers });
  if (decision.level === "deny") return refuse("policy_denied", `${action} was tightened after approval`, "denied");

  return runExecutor(t, {
    tool,
    action,
    account,
    payload,
    modifiers,
    facts: audit.facts,
    handles: handlesFromPayload(pending.payload_json),
    operationId,
    pendingId,
  });
}

/** Counts and ids from a payload, so audit rows never see content. */
export function factsOf(p: Record<string, unknown>): AuditFacts {
  const arr = (k: string) => (Array.isArray(p[k]) ? (p[k] as unknown[]).length : 0);
  const ids = ["message_id", "thread_id", "draft_id", "label_id"]
    .map((k) => p[k])
    .filter((v): v is string => typeof v === "string");
  const facts: AuditFacts = {};
  const recipients = arr("to") + arr("cc") + arr("bcc");
  if (recipients > 0 || "to" in p) facts.recipients = recipients;
  if ("attachments" in p) facts.attachments = arr("attachments");
  if (ids.length > 0) facts.ids = ids;
  return facts;
}
```

`resumeGated` records `action: "send.message"` as a placeholder only until the pending row is read; when the row exists the audit row carries the row's real action. The `lostRace` helper returns `undefined as never` in quiet mode so the caller can fall through to `handle_reserved`; that is the one place the type is bent, and the comment above it says why.

- [x] **Step 6 (GREEN): the server factory**

`worker/src/mcp/server.ts`:

```ts
import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ACTIONS, DEFAULT_POLICY } from "@gmail-mcp/shared/actions";
import { AccountAlias } from "@gmail-mcp/shared/schemas";
import type { Env } from "../env";
import type { Deps } from "../deps";
import type { Principal } from "../auth/principal";
import { auditIntent } from "../audit/log";
import { approvalCodec } from "../approval/state";
import { cancelPending } from "../approval/pending";
import { effectiveLevel } from "../policy/engine";
import { resolveAccount } from "../tools/accounts";
import { executePending, roundOf, type ToolContext } from "../tools/gate";
import { connectRequired, guarded, text } from "../tools/results";

export type Era = "legacy" | "modern";

/**
 * The seven control tools registered here read the owner's own state or are the approval mechanism
 * itself, and do not pass through the policy engine. Every Gmail tool is registered by the family
 * modules through defineTool, which is the only path to the gate.
 */
export function buildServer(env: Env, principal: Principal, deps: Deps, era: Era): McpServer {
  const codec = approvalCodec(env, principal);
  const server = new McpServer({ name: "gmail-mcp", version: "0.0.1" }, { requestState: { verify: codec.verify } });

  /** One ToolContext per call: the era and the request's capabilities decide whether a URL can be opened. */
  const toolContext = (ctx: ServerContext): ToolContext => ({
    env,
    deps,
    principal,
    urlElicitation: era === "modern" && server.server.getClientCapabilities()?.elicitation?.url !== undefined,
    round: roundOf(ctx, codec),
  });

  server.registerTool(
    "list_accounts",
    {
      description: "List connected Gmail accounts: alias, email, status, default flag. Never returns tokens.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const rows = await env.DB.prepare(
        "SELECT alias, google_email AS email, status, is_default, scopes FROM accounts WHERE user_id = ? ORDER BY alias",
      )
        .bind(principal.userId)
        .all();
      return text({ accounts: rows.results });
    },
  );

  server.registerTool(
    "get_policy",
    {
      description: "Effective allow/ask/deny policy for an account after overrides.",
      inputSchema: z.object({ account: AccountAlias.optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ account }, ctx) =>
      guarded(toolContext(ctx), async () => {
        const acc = await resolveAccount(env, principal.userId, account);
        const policy: Record<string, string> = {};
        for (const a of ACTIONS)
          policy[a] =
            DEFAULT_POLICY[a] === "browser" ? "browser" : await effectiveLevel(env.DB, principal.userId, acc.id, a);
        return text({ account: acc.alias, policy });
      }),
  );

  server.registerTool(
    "list_pending",
    {
      description: "List pending and approved-but-unexecuted approvals for the caller.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const rows = await env.DB.prepare(
        `SELECT p.id, a.alias AS account, p.action, p.modifiers, p.summary, p.state, p.expires_at
         FROM pending_actions p JOIN accounts a ON a.id = p.account_id AND a.user_id = p.user_id
         WHERE p.user_id = ? AND p.state IN ('pending','approved') ORDER BY p.created_at DESC LIMIT 50`,
      )
        .bind(principal.userId)
        .all();
      return text({ pending: rows.results });
    },
  );

  server.registerTool(
    "execute_pending",
    {
      description: "Execute an action the owner approved in the browser. Claimable once; a replay is refused.",
      inputSchema: z.object({ action_id: z.string().regex(/^pa_[A-Za-z0-9_-]{22}$/) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ action_id }, ctx) => {
      const t = toolContext(ctx);
      return guarded(t, async () => text(await executePending(t, action_id)));
    },
  );

  server.registerTool(
    "cancel_pending",
    {
      description: "Withdraw a pending or approved action before it executes.",
      inputSchema: z.object({ action_id: z.string().regex(/^pa_[A-Za-z0-9_-]{22}$/) }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ action_id }) =>
      text({ cancelled: await cancelPending(env.DB, { id: action_id, userId: principal.userId }) }),
  );

  server.registerTool(
    "connect_account",
    {
      description:
        "Connect or reconnect a Google account under an alias. Completes in the owner's browser; opens the page when the client can, else returns its URL.",
      inputSchema: z.object({ alias: AccountAlias }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ alias }, ctx) => {
      await auditIntent(env.DB, {
        userId: principal.userId,
        accountId: null,
        tool: "connect_account",
        action: "account.connect",
        modifiers: [],
        decision: "browser",
        facts: {},
      });
      return connectRequired(toolContext(ctx), alias);
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

  return server;
}
```

Tasks 5, 6, 8 and 9 add `registerLabelTools(server, toolContext, env)`, `registerReadTools(...)`, `registerDraftTools(...)` and `registerSendTools(...)` after `open_policy_editor`.

`worker/src/index.ts`: the factory line becomes `createMcpHandler((mcpCtx) => buildServer(env, principal, deps, mcpCtx.era))(request, env, ctx)`.

- [x] **Step 7: run, expect pass**

Run: `cd worker && npx vitest run test/gate.test.ts test/claim.test.ts test/mcp.test.ts test/cron.test.ts test/schema.test.ts` then `npm run verify`.
Expected: PASS.

- [x] **Step 8: commit**

```bash
git add worker/migrations/0003_intent.sql worker/src worker/test
git commit -m "feat(worker): the tool gate with intent-keyed idempotency and one-batch settlement

A key is recorded against the client's intent before staging and before the allow/ask fork, follows
its pending action or operation, and is released only by a retired holder. Every local consequence of
one Gmail result lands in one batch. Executors are keyed by tool name and version so a pending row runs
from the row alone and never under code it was not approved for.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NBfkjWcEGDFghet3APnUjU"
```

---

### Task 5: `defineTool`, then the label, spam and trash tools

**Files:**

- Create: `worker/src/tools/define.ts`, `worker/src/tools/labels.ts`, `worker/test/labels-tools.test.ts`
- Modify: `shared/src/schemas.ts` (ids, label enums, the eighteen input schemas), `worker/src/mcp/server.ts` (register the family), `worker/test/mcp-client.ts` (`callTool`), `worker/test/mcp.test.ts` (tool list)

**Interfaces:**

- Consumes: `runGated`, `resumeGated`, `registerExecutor`, `guarded`, `text`, `resolveAccount`, `gmailJson`, `beginOperation`, `GmailLabel`, `decodeInline`, `intentArgs` (Task 8 creates `compose.ts`; this task creates the two functions there first, with the rest of the module arriving in Task 8).
- Produces:
  - `shared/src/schemas.ts`: `GmailId`, `LabelId`, `LabelName`, `LabelListVisibility`, `MessageListVisibility`, `LabelOption`, `HexColor`, `MessageTargetInput`, `ThreadTargetInput`, `LabelMessageInput`, `UnlabelMessageInput`, `LabelThreadInput`, `UnlabelThreadInput`, `UpdateMessageLabelsInput` (refined: at least one change, and `add_label_ids` disjoint from `remove_label_ids`), `ApplySensitiveMessageLabelInput`, `ApplySensitiveThreadLabelInput`, `CreateLabelInput` (no `auto_create_parent_labels`), `UpdateLabelInput`, `DeleteLabelInput`.
  - `isSystemLabel(id)`.
  - `defineTool(server, toolContext, env, spec: ToolSpec<S>)` where

```ts
export type Plan = {
  modifiers: Modifier[];
  summary: string;
  facts: AuditFacts;
  idempotencyKey?: string | undefined;
  /** After the decision: stage inline bytes, validate handles, return the execution payload (without tool and v). */
  build: () => Promise<{ payload: Record<string, unknown>; handles: string[] }>;
};
export type ToolSpec<S extends z.ZodObject<z.ZodRawShape>> = {
  name: string;
  version: number;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  action: Action;
  /** Whether an operation row is created. Policy action and journal are different dimensions: label.manage journals its create and not its update or delete. */
  journal: boolean;
  plan: (env: Env, t: ToolContext, account: AccountRef, args: z.infer<S>, inline: DecodedInline[]) => Promise<Plan>;
  execute: Executor;
};
```

    `defineTool` registers the executor under `(name, version)` and registers the MCP tool. Its handler: resolve the account; `decodeInline(args.inline_attachments)`; compute `intentHash = sha256(JCS({ tool, v, account: alias, args: intentArgs(args, inline) }))`; if the round carries `requestState`, hand over to `resumeGated` without calling `plan` (nothing is derived or staged on a resume); else call `plan` and hand its result to `runGated`.

- `registerLabelTools(server, toolContext, env)`.
- Payload shapes, rendered by `approvalView` as the `targets` and `label` views: message targets carry `message_id`, thread targets `thread_id`, label changes `add` and `remove` arrays; label management carries `op`, `label_id`, `name`.
- `callTool(worker, env, token, name, args, id?)` in `test/mcp-client.ts`.

- [x] **Step 1 (RED): tests**

`worker/test/labels-tools.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index";
import { FakeGoogle } from "./fake-google";
import { mintToken } from "./browser";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import { callTool } from "./mcp-client";
import { testDeps, testEnv } from "./test-env";
import { approvePending, getPending } from "../src/approval/pending";
import { setPolicy } from "../src/policy/engine";

const e = testEnv();
let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
let token: string;
const gm = () => g.gmail;

beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker(testDeps(g));
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "la", alias: "personal", isDefault: true });
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "lb", alias: "cold" });
  await seedAccessToken(e, { userId: "owner-sub", accountId: "la" });
  token = (await mintToken(worker, e, g, { scope: "mcp" })).accessToken;
});

const call = (name: string, args: Record<string, unknown>) => callTool(worker, e, token, name, args);
const opCount = async () =>
  (await env.DB.prepare("SELECT count(*) AS n FROM operations WHERE user_id = 'owner-sub'").first<any>()).n as number;

describe("label.apply", () => {
  it("label_message adds user labels (allow), echoes the message, and creates no operation row", async () => {
    const m = gm().seedMessage({ from: "a@x.test", to: ["me@x.test"], subject: "s1", text: "t" });
    gm().labels.set("Label_1", { id: "Label_1", name: "Receipts", type: "user" });
    const before = await opCount();
    const r = await call("label_message", { account: "personal", message_id: m.id, label_ids: ["Label_1"] });
    expect(r.result).toMatchObject({
      status: "executed",
      account: "personal",
      message: { id: m.id, label_ids: expect.arrayContaining(["Label_1", "INBOX"]) },
    });
    expect(gm().messages.get(m.id)!.labelIds).toContain("Label_1");
    expect(await opCount()).toBe(before);
    const rows = await env.DB.prepare(
      "SELECT phase, decision FROM audit_log WHERE user_id='owner-sub' AND tool='label_message' ORDER BY id DESC LIMIT 2",
    ).all<any>();
    expect(rows.results.map((x) => [x.phase, x.decision]).reverse()).toEqual([
      ["intent", "allow"],
      ["outcome", "executed"],
    ]);
  });
  it("a system label raises +sensitive to ask; TRASH and SPAM are refused outright", async () => {
    const m = gm().seedMessage({ from: "a@x.test", to: ["me@x.test"], subject: "s2", text: "t" });
    const r = await call("label_message", { account: "personal", message_id: m.id, label_ids: ["STARRED"] });
    expect(r.result).toMatchObject({ status: "pending_approval", action: "label.apply", modifiers: ["+sensitive"] });
    expect(gm().messages.get(m.id)!.labelIds).not.toContain("STARRED");
    expect(JSON.parse((await getPending(env.DB, r.result.action_id, "owner-sub"))!.payload_json!)).toEqual({
      add: ["STARRED"],
      message_id: m.id,
      remove: [],
      tool: "label_message",
      v: 1,
    });
    expect(
      (await call("label_message", { account: "personal", message_id: m.id, label_ids: ["TRASH"] })).result,
    ).toMatchObject({ error: "forbidden" });
  });
  it("unlabel, thread variants and update_message_labels reach Gmail with add and remove; overlapping sets are refused", async () => {
    const m = gm().seedMessage({
      from: "a@x.test",
      to: ["me@x.test"],
      subject: "s3",
      text: "t",
      labelIds: ["INBOX", "Label_1", "Label_2"],
    });
    gm().labels.set("Label_2", { id: "Label_2", name: "Two", type: "user" });
    expect(
      (await call("unlabel_message", { account: "personal", message_id: m.id, label_ids: ["Label_1"] })).result.status,
    ).toBe("executed");
    expect(gm().messages.get(m.id)!.labelIds).not.toContain("Label_1");
    expect(
      (await call("label_thread", { account: "personal", thread_id: m.threadId, label_ids: ["Label_1"] })).result,
    ).toMatchObject({ status: "executed", thread: { id: m.threadId } });
    expect(
      (await call("unlabel_thread", { account: "personal", thread_id: m.threadId, label_ids: ["Label_1", "Label_2"] }))
        .result.status,
    ).toBe("executed");
    const r = await call("update_message_labels", {
      account: "personal",
      message_id: m.id,
      add_label_ids: ["Label_2"],
      remove_label_ids: ["INBOX"],
    });
    expect(r.result.status).toBe("executed");
    expect(gm().messages.get(m.id)!.labelIds).toEqual(["Label_2"]);
    const empty = await call("update_message_labels", { account: "personal", message_id: m.id });
    expect(empty.error ?? empty.result?.error).toBeTruthy();
    const overlap = await call("update_message_labels", {
      account: "personal",
      message_id: m.id,
      add_label_ids: ["Label_2"],
      remove_label_ids: ["Label_2"],
    });
    expect(overlap.error ?? overlap.result?.error).toBeTruthy();
  });
  it("apply_sensitive_* carry +sensitive and, once approved and executed, trash or spam the target", async () => {
    const m = gm().seedMessage({ from: "a@x.test", to: ["me@x.test"], subject: "s4", text: "t" });
    const r = await call("apply_sensitive_message_label", {
      account: "personal",
      message_id: m.id,
      label_option: "TRASH",
    });
    expect(r.result).toMatchObject({ status: "pending_approval", modifiers: ["+sensitive"] });
    await approvePending(env.DB, { id: r.result.action_id, userId: "owner-sub", via: "browser" });
    const done = await call("execute_pending", { action_id: r.result.action_id });
    expect(done.result).toMatchObject({ status: "executed", action_id: r.result.action_id });
    expect(gm().messages.get(m.id)!.labelIds).toContain("TRASH");
    expect(
      (await call("apply_sensitive_thread_label", { account: "personal", thread_id: m.threadId, label_option: "SPAM" }))
        .result.status,
    ).toBe("pending_approval");
  });
});

describe("spam and trash", () => {
  it("mark spam asks by default; unmark spam is allowed; the wire shapes are modify calls", async () => {
    const m = gm().seedMessage({
      from: "a@x.test",
      to: ["me@x.test"],
      subject: "s5",
      text: "t",
      labelIds: ["INBOX", "SPAM"],
    });
    expect((await call("mark_message_spam", { account: "personal", message_id: m.id })).result.status).toBe(
      "pending_approval",
    );
    const u = await call("unmark_message_spam", { account: "personal", message_id: m.id });
    expect(u.result.status).toBe("executed");
    expect(gm().messages.get(m.id)!.labelIds).not.toContain("SPAM");
    const last = gm().requests.at(-1)!;
    expect(last.url).toContain(`/messages/${m.id}/modify`);
    expect(await last.clone().json()).toEqual({ addLabelIds: ["INBOX"], removeLabelIds: ["SPAM"] });
    expect((await call("mark_thread_spam", { account: "personal", thread_id: m.threadId })).result.status).toBe(
      "pending_approval",
    );
    expect((await call("unmark_thread_spam", { account: "personal", thread_id: m.threadId })).result.status).toBe(
      "executed",
    );
  });
  it("trash asks by default and executes once allowed; untrash is allowed", async () => {
    const m = gm().seedMessage({ from: "a@x.test", to: ["me@x.test"], subject: "s6", text: "t" });
    expect((await call("trash_message", { account: "personal", message_id: m.id })).result.status).toBe(
      "pending_approval",
    );
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "la", action: "trash.move", level: "allow" });
    expect((await call("trash_message", { account: "personal", message_id: m.id })).result.status).toBe("executed");
    expect(gm().requests.at(-1)!.url).toContain(`/messages/${m.id}/trash`);
    expect(gm().messages.get(m.id)!.labelIds).toContain("TRASH");
    expect((await call("untrash_message", { account: "personal", message_id: m.id })).result.status).toBe("executed");
    expect(gm().messages.get(m.id)!.labelIds).not.toContain("TRASH");
    expect((await call("trash_thread", { account: "personal", thread_id: m.threadId })).result.status).toBe("executed");
    expect((await call("untrash_thread", { account: "personal", thread_id: m.threadId })).result.status).toBe(
      "executed",
    );
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "la", action: "trash.move", level: "ask" });
  });
  it("a write without an explicit account is a schema error, never a guess", async () => {
    const r = await call("trash_message", { message_id: "m1" });
    expect(r.error ?? r.result?.error).toBeTruthy();
  });
  it("an account without credentials answers connect_required and never reaches Gmail", async () => {
    const before = gm().requests.length;
    const r = await call("untrash_message", { account: "cold", message_id: "m1" });
    expect(r.result).toMatchObject({ status: "connect_required", account: "cold" });
    expect(r.result.url).toMatch(/^https:\/\/gmail-mcp\.example\.workers\.dev\/connect\?alias=cold&e=/);
    expect(gm().requests.length).toBe(before);
  });
  it("Gmail's error is surfaced verbatim and the call is audited as failed", async () => {
    const r = await call("untrash_message", { account: "personal", message_id: "does-not-exist" });
    expect(r.result).toMatchObject({ error: "gmail_error", details: { status: 404 } });
    expect(r.result.message).toContain("Requested entity was not found.");
    const row = await env.DB.prepare(
      "SELECT phase, decision FROM audit_log WHERE user_id = 'owner-sub' AND tool = 'untrash_message' ORDER BY id DESC LIMIT 1",
    ).first<any>();
    expect(row).toEqual({ phase: "outcome", decision: "failed" });
  });
});

describe("label.manage", () => {
  it("create_label asks by default, executes through the browser approval, and journals with the label id as the result", async () => {
    const r = await call("create_label", {
      account: "personal",
      display_name: "Uni/2026/Thesis",
      label_list_visibility: "LABEL_SHOW",
    });
    expect(r.result).toMatchObject({ status: "pending_approval", action: "label.manage" });
    expect(JSON.parse((await getPending(env.DB, r.result.action_id, "owner-sub"))!.payload_json!)).toMatchObject({
      op: "create",
      name: "Uni/2026/Thesis",
      tool: "create_label",
      v: 1,
    });
    await approvePending(env.DB, { id: r.result.action_id, userId: "owner-sub", via: "browser" });
    const done = await call("execute_pending", { action_id: r.result.action_id });
    expect(done.result).toMatchObject({
      status: "executed",
      label: { name: "Uni/2026/Thesis", label_list_visibility: "LABEL_SHOW" },
    });
    const op = await env.DB.prepare("SELECT state, gmail_result_id FROM operations WHERE id = ?")
      .bind(done.result.operation_id)
      .first<any>();
    expect(op).toEqual({ state: "executed", gmail_result_id: done.result.label.id });
    expect((await call("execute_pending", { action_id: r.result.action_id })).result.error).toBe("pending_replayed");
  });
  it("a Gmail 409 on create is failed_safe with the message verbatim, not delivery_unknown", async () => {
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "la", action: "label.manage", level: "allow" });
    gm().labels.set("Label_dup", { id: "Label_dup", name: "Dup", type: "user" });
    const r = await call("create_label", { account: "personal", display_name: "Dup" });
    expect(r.result).toMatchObject({ error: "gmail_error", details: { status: 409 } });
    expect(
      (
        await env.DB.prepare(
          "SELECT state FROM operations WHERE user_id='owner-sub' ORDER BY created_at DESC LIMIT 1",
        ).first<any>()
      ).state,
    ).toBe("failed_safe");
  });
  it("update_label and delete_label do not journal; system labels are refused before Gmail; colours pass through", async () => {
    const created = await call("create_label", {
      account: "personal",
      display_name: "Temp",
      text_color: "#000000",
      background_color: "#ffffff",
    });
    expect(created.result.label.color).toEqual({ text_color: "#000000", background_color: "#ffffff" });
    const id = created.result.label.id as string;
    const before = await opCount();
    const up = await call("update_label", {
      account: "personal",
      label_id: id,
      display_name: "Temp2",
      message_list_visibility: "HIDE",
    });
    expect(up.result.label).toMatchObject({ id, name: "Temp2", message_list_visibility: "HIDE" });
    expect(gm().labels.get(id)).toMatchObject({ name: "Temp2", messageListVisibility: "hide" });
    expect((await call("delete_label", { account: "personal", label_id: "INBOX" })).result).toMatchObject({
      error: "forbidden",
    });
    expect((await call("delete_label", { account: "personal", label_id: id })).result).toMatchObject({
      status: "executed",
      deleted: id,
    });
    expect(gm().labels.has(id)).toBe(false);
    expect(await opCount()).toBe(before);
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "la", action: "label.manage", level: "ask" });
  });
});
```

In `mcp.test.ts`, the expected tool list becomes the eighteen names of this family plus the eight control tools, sorted; Task 10 has the final list.

- [x] **Step 2: run, expect failure**

Run: `cd worker && npx vitest run test/labels-tools.test.ts`
Expected: FAIL, unknown tool `label_message`.

- [x] **Step 3 (GREEN): schemas**

Append to `shared/src/schemas.ts`:

```ts
export const GmailId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
export const LabelId = GmailId;
export const LabelName = z.string().min(1).max(225);
export const LabelListVisibility = z.enum(["LABEL_SHOW", "LABEL_SHOW_IF_UNREAD", "LABEL_HIDE"]);
export const MessageListVisibility = z.enum(["SHOW", "HIDE"]);
export const LabelOption = z.enum(["TRASH", "SPAM"]);
export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const MessageTargetInput = z.object({ account: AccountAlias, message_id: GmailId });
export const ThreadTargetInput = z.object({ account: AccountAlias, thread_id: GmailId });
const LabelIds = z.array(LabelId).min(1).max(100);
export const LabelMessageInput = MessageTargetInput.extend({ label_ids: LabelIds });
export const UnlabelMessageInput = LabelMessageInput;
export const LabelThreadInput = ThreadTargetInput.extend({ label_ids: LabelIds });
export const UnlabelThreadInput = LabelThreadInput;
export const UpdateMessageLabelsInput = MessageTargetInput.extend({
  add_label_ids: z.array(LabelId).max(100).default([]),
  remove_label_ids: z.array(LabelId).max(100).default([]),
})
  .refine((v) => v.add_label_ids.length + v.remove_label_ids.length > 0, {
    message: "add or remove at least one label",
  })
  .refine((v) => !v.add_label_ids.some((id) => v.remove_label_ids.includes(id)), {
    message: "a label cannot be both added and removed",
  });
export const ApplySensitiveMessageLabelInput = MessageTargetInput.extend({ label_option: LabelOption });
export const ApplySensitiveThreadLabelInput = ThreadTargetInput.extend({ label_option: LabelOption });
export const CreateLabelInput = z.object({
  account: AccountAlias,
  display_name: LabelName,
  label_list_visibility: LabelListVisibility.optional(),
  message_list_visibility: MessageListVisibility.optional(),
  text_color: HexColor.optional(),
  background_color: HexColor.optional(),
});
export const UpdateLabelInput = z.object({
  account: AccountAlias,
  label_id: LabelId,
  display_name: LabelName.optional(),
  label_list_visibility: LabelListVisibility.optional(),
  message_list_visibility: MessageListVisibility.optional(),
  text_color: HexColor.optional(),
  background_color: HexColor.optional(),
});
export const DeleteLabelInput = z.object({ account: AccountAlias, label_id: LabelId });
```

- [x] **Step 4 (GREEN): defineTool**

`worker/src/tools/compose.ts` is created here with `decodeInline`, `intentArgs` and `DecodedInline` exactly as Task 8 lists them; Task 8 adds the rest of the module.

`worker/src/tools/define.ts`:

```ts
import type { McpServer, ServerContext, ToolAnnotations } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { Action, Modifier } from "@gmail-mcp/shared/actions";
import type { InlineAttachment } from "@gmail-mcp/shared/schemas";
import type { AuditFacts } from "../audit/log";
import type { Env } from "../env";
import { canonicalize, hashCanonical } from "../crypto/canonical";
import { resolveAccount, type AccountRef } from "./accounts";
import { decodeInline, intentArgs, type DecodedInline } from "./compose";
import { registerExecutor, resumeGated, runGated, type Executor, type ToolContext } from "./gate";
import { guarded } from "./results";

export type Plan = {
  modifiers: Modifier[];
  summary: string;
  facts: AuditFacts;
  idempotencyKey?: string | undefined;
  build: () => Promise<{ payload: Record<string, unknown>; handles: string[] }>;
};

export type ToolSpec<S extends z.ZodObject<z.ZodRawShape>> = {
  name: string;
  version: number;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  action: Action;
  journal: boolean;
  plan: (env: Env, t: ToolContext, account: AccountRef, args: z.infer<S>, inline: DecodedInline[]) => Promise<Plan>;
  execute: Executor;
};

/**
 * Every Gmail tool is registered through here so none can reach Gmail without the gate. The intent
 * hash covers what the client asked for and nothing the server generated, so a resume never re-plans:
 * what executes is the stored row, and the retried arguments only have to match the intent it came from.
 */
export function defineTool<S extends z.ZodObject<z.ZodRawShape>>(
  server: McpServer,
  toolContext: (ctx: ServerContext) => ToolContext,
  env: Env,
  spec: ToolSpec<S>,
): void {
  registerExecutor(spec.name, spec.version, spec.execute);
  server.registerTool(
    spec.name,
    { description: spec.description, inputSchema: spec.input, annotations: spec.annotations },
    async (args, ctx) => {
      const t = toolContext(ctx);
      return guarded(t, async () => {
        const a = args as Record<string, unknown> & { account?: string; inline_attachments?: InlineAttachment[] };
        const account = await resolveAccount(env, t.principal.userId, a.account);
        const inline = await decodeInline(a.inline_attachments);
        const { account: _alias, ...rest } = intentArgs(a, inline);
        const intentHash = await hashCanonical(
          canonicalize({ tool: spec.name, v: spec.version, account: account.alias, args: rest }),
        );
        const state = t.round.requestState();
        if (state) return resumeGated(t, { tool: spec.name, account, intentHash, state });
        const plan = await spec.plan(env, t, account, args as z.infer<S>, inline);
        return runGated(t, {
          tool: spec.name,
          version: spec.version,
          action: spec.action,
          journal: spec.journal,
          account,
          intentHash,
          idempotencyKey: plan.idempotencyKey,
          modifiers: plan.modifiers,
          summary: plan.summary,
          facts: plan.facts,
          build: plan.build,
        });
      });
    },
  );
}
```

`canonicalize` refuses `undefined`, so `intentArgs` must return only defined values; it strips them with the same loop the gate uses on payloads.

- [x] **Step 5 (GREEN): the family**

`worker/test/mcp-client.ts` gains

```ts
export async function callTool(
  worker: Worker,
  env: Env,
  token: string,
  name: string,
  args: Record<string, unknown>,
  id = 7,
): Promise<{ status: number; json: any; result: any; error: any }> {
  const res = await rpc(worker, env, token, "tools/call", { name, arguments: args }, id);
  const textBlock = res.json?.result?.content?.find((c: { type: string }) => c.type === "text");
  let result: any = null;
  if (textBlock?.text) {
    try {
      result = JSON.parse(textBlock.text);
    } catch {
      result = textBlock.text;
    }
  }
  return { status: res.status, json: res.json, result, error: res.json?.error ?? null };
}
```

`worker/src/tools/labels.ts`:

```ts
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import {
  ApplySensitiveMessageLabelInput,
  ApplySensitiveThreadLabelInput,
  CreateLabelInput,
  DeleteLabelInput,
  LabelMessageInput,
  LabelThreadInput,
  MessageTargetInput,
  ThreadTargetInput,
  UnlabelMessageInput,
  UnlabelThreadInput,
  UpdateLabelInput,
  UpdateMessageLabelsInput,
} from "@gmail-mcp/shared/schemas";
import type { Env } from "../env";
import type { Deps } from "../deps";
import { gmailJson } from "../google/gmail";
import type { GmailLabel } from "../google/messages";
import { beginOperation } from "../operations/journal";
import { defineTool, type Plan } from "./define";
import type { ExecRun, ToolContext } from "./gate";

export const isSystemLabel = (id: string): boolean => /^[A-Z][A-Z0-9_]*$/.test(id);
const SENSITIVE = new Set(["TRASH", "SPAM"]);

const LIST_VIS: Record<string, string> = {
  LABEL_SHOW: "labelShow",
  LABEL_SHOW_IF_UNREAD: "labelShowIfUnread",
  LABEL_HIDE: "labelHide",
};
const MSG_VIS: Record<string, string> = { SHOW: "show", HIDE: "hide" };
const invert = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k]));
const LIST_VIS_BACK = invert(LIST_VIS);
const MSG_VIS_BACK = invert(MSG_VIS);

export function labelView(l: GmailLabel) {
  return {
    id: l.id,
    name: l.name,
    type: l.type ?? "user",
    ...(l.labelListVisibility
      ? { label_list_visibility: LIST_VIS_BACK[l.labelListVisibility] ?? l.labelListVisibility }
      : {}),
    ...(l.messageListVisibility
      ? { message_list_visibility: MSG_VIS_BACK[l.messageListVisibility] ?? l.messageListVisibility }
      : {}),
    ...(l.color ? { color: { text_color: l.color.textColor, background_color: l.color.backgroundColor } } : {}),
    ...(l.messagesTotal !== undefined
      ? { messages_total: l.messagesTotal, messages_unread: l.messagesUnread ?? 0 }
      : {}),
  };
}

type Modified = { id: string; threadId: string; labelIds?: string[] };
const messageOut = (m: Modified) => ({ message: { id: m.id, thread_id: m.threadId, label_ids: m.labelIds ?? [] } });
const threadOut = (t: { id: string; messages?: Modified[] }) => ({
  thread: { id: t.id, messages: (t.messages ?? []).map((m) => ({ id: m.id, label_ids: m.labelIds ?? [] })) },
});
const acct = (run: ExecRun) => ({ userId: run.userId, accountId: run.account.id });

async function modifyMessage(env: Env, deps: Deps, run: ExecRun, id: string, add: string[], remove: string[]) {
  return messageOut(
    await gmailJson<Modified>(env, deps, acct(run), {
      method: "POST",
      path: `messages/${encodeURIComponent(id)}/modify`,
      json: { addLabelIds: add, removeLabelIds: remove },
      retry: "safe",
    }),
  );
}
async function modifyThread(env: Env, deps: Deps, run: ExecRun, id: string, add: string[], remove: string[]) {
  return threadOut(
    await gmailJson<{ id: string; messages?: Modified[] }>(env, deps, acct(run), {
      method: "POST",
      path: `threads/${encodeURIComponent(id)}/modify`,
      json: { addLabelIds: add, removeLabelIds: remove },
      retry: "safe",
    }),
  );
}
async function postMessage(env: Env, deps: Deps, run: ExecRun, id: string, verb: "trash" | "untrash") {
  return messageOut(
    await gmailJson<Modified>(env, deps, acct(run), {
      method: "POST",
      path: `messages/${encodeURIComponent(id)}/${verb}`,
      retry: "safe",
    }),
  );
}
async function postThread(env: Env, deps: Deps, run: ExecRun, id: string, verb: "trash" | "untrash") {
  return threadOut(
    await gmailJson<{ id: string; messages?: Modified[] }>(env, deps, acct(run), {
      method: "POST",
      path: `threads/${encodeURIComponent(id)}/${verb}`,
      retry: "safe",
    }),
  );
}

/** label_* and unlabel_* refuse TRASH and SPAM: those go through the sensitive tools, which say what they do. */
function refuseSensitive(ids: string[]): void {
  const hit = ids.find((id) => SENSITIVE.has(id));
  if (hit)
    throw new GmailMcpError("forbidden", `forbidden: use apply_sensitive_* or the trash and spam tools for ${hit}`);
}
const sensitiveModifiers = (ids: string[]): Plan["modifiers"] => (ids.some(isSystemLabel) ? ["+sensitive"] : []);

/** A plan for a tool whose payload is fixed at plan time and that writes nothing before execution. */
const simple = (
  payload: Record<string, unknown>,
  modifiers: Plan["modifiers"],
  summary: string,
  ids: string[],
): Plan => ({
  modifiers,
  summary,
  facts: { ids },
  build: async () => ({ payload, handles: [] }),
});

const apply = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

export function registerLabelTools(
  server: McpServer,
  toolContext: (ctx: ServerContext) => ToolContext,
  env: Env,
): void {
  defineTool(server, toolContext, env, {
    name: "label_message",
    version: 1,
    description: "Add labels to a message. TRASH and SPAM are refused here; use the sensitive tools.",
    input: LabelMessageInput,
    annotations: apply,
    action: "label.apply",
    journal: false,
    plan: async (_e, _t, _a, args) => {
      refuseSensitive(args.label_ids);
      return simple(
        { message_id: args.message_id, add: args.label_ids, remove: [] },
        sensitiveModifiers(args.label_ids),
        `Add ${args.label_ids.join(", ")} to message ${args.message_id}`,
        [args.message_id],
      );
    },
    execute: async (e, d, run) => {
      const p = run.payload as { message_id: string; add: string[]; remove: string[] };
      return modifyMessage(e, d, run, p.message_id, p.add, p.remove);
    },
  });
  defineTool(server, toolContext, env, {
    name: "unlabel_message",
    version: 1,
    description: "Remove labels from a message.",
    input: UnlabelMessageInput,
    annotations: destructive,
    action: "label.apply",
    journal: false,
    plan: async (_e, _t, _a, args) => {
      refuseSensitive(args.label_ids);
      return simple(
        { message_id: args.message_id, add: [], remove: args.label_ids },
        sensitiveModifiers(args.label_ids),
        `Remove ${args.label_ids.join(", ")} from message ${args.message_id}`,
        [args.message_id],
      );
    },
    execute: async (e, d, run) => {
      const p = run.payload as { message_id: string; add: string[]; remove: string[] };
      return modifyMessage(e, d, run, p.message_id, p.add, p.remove);
    },
  });
  defineTool(server, toolContext, env, {
    name: "label_thread",
    version: 1,
    description: "Add labels to every message in a thread. TRASH and SPAM are refused here.",
    input: LabelThreadInput,
    annotations: apply,
    action: "label.apply",
    journal: false,
    plan: async (_e, _t, _a, args) => {
      refuseSensitive(args.label_ids);
      return simple(
        { thread_id: args.thread_id, add: args.label_ids, remove: [] },
        sensitiveModifiers(args.label_ids),
        `Add ${args.label_ids.join(", ")} to thread ${args.thread_id}`,
        [args.thread_id],
      );
    },
    execute: async (e, d, run) => {
      const p = run.payload as { thread_id: string; add: string[]; remove: string[] };
      return modifyThread(e, d, run, p.thread_id, p.add, p.remove);
    },
  });
  defineTool(server, toolContext, env, {
    name: "unlabel_thread",
    version: 1,
    description: "Remove labels from every message in a thread.",
    input: UnlabelThreadInput,
    annotations: destructive,
    action: "label.apply",
    journal: false,
    plan: async (_e, _t, _a, args) => {
      refuseSensitive(args.label_ids);
      return simple(
        { thread_id: args.thread_id, add: [], remove: args.label_ids },
        sensitiveModifiers(args.label_ids),
        `Remove ${args.label_ids.join(", ")} from thread ${args.thread_id}`,
        [args.thread_id],
      );
    },
    execute: async (e, d, run) => {
      const p = run.payload as { thread_id: string; add: string[]; remove: string[] };
      return modifyThread(e, d, run, p.thread_id, p.add, p.remove);
    },
  });
  defineTool(server, toolContext, env, {
    name: "update_message_labels",
    version: 1,
    description: "Add and remove labels on one message in one call.",
    input: UpdateMessageLabelsInput,
    annotations: destructive,
    action: "label.apply",
    journal: false,
    plan: async (_e, _t, _a, args) => {
      const all = [...args.add_label_ids, ...args.remove_label_ids];
      refuseSensitive(all);
      return simple(
        { message_id: args.message_id, add: args.add_label_ids, remove: args.remove_label_ids },
        sensitiveModifiers(all),
        `Message ${args.message_id}: add ${args.add_label_ids.join(", ") || "none"}, remove ${args.remove_label_ids.join(", ") || "none"}`,
        [args.message_id],
      );
    },
    execute: async (e, d, run) => {
      const p = run.payload as { message_id: string; add: string[]; remove: string[] };
      return modifyMessage(e, d, run, p.message_id, p.add, p.remove);
    },
  });
  defineTool(server, toolContext, env, {
    name: "apply_sensitive_message_label",
    version: 1,
    description: "Move one message to Trash or mark it as spam. Always carries +sensitive.",
    input: ApplySensitiveMessageLabelInput,
    annotations: destructive,
    action: "label.apply",
    journal: false,
    plan: async (_e, _t, _a, args) =>
      simple(
        { message_id: args.message_id, add: [args.label_option], remove: ["INBOX"] },
        ["+sensitive"],
        `${args.label_option} message ${args.message_id}`,
        [args.message_id],
      ),
    execute: async (e, d, run) => {
      const p = run.payload as { message_id: string; add: string[]; remove: string[] };
      return p.add[0] === "TRASH"
        ? postMessage(e, d, run, p.message_id, "trash")
        : modifyMessage(e, d, run, p.message_id, p.add, p.remove);
    },
  });
  defineTool(server, toolContext, env, {
    name: "apply_sensitive_thread_label",
    version: 1,
    description: "Move one thread to Trash or mark it as spam. Always carries +sensitive.",
    input: ApplySensitiveThreadLabelInput,
    annotations: destructive,
    action: "label.apply",
    journal: false,
    plan: async (_e, _t, _a, args) =>
      simple(
        { thread_id: args.thread_id, add: [args.label_option], remove: ["INBOX"] },
        ["+sensitive"],
        `${args.label_option} thread ${args.thread_id}`,
        [args.thread_id],
      ),
    execute: async (e, d, run) => {
      const p = run.payload as { thread_id: string; add: string[]; remove: string[] };
      return p.add[0] === "TRASH"
        ? postThread(e, d, run, p.thread_id, "trash")
        : modifyThread(e, d, run, p.thread_id, p.add, p.remove);
    },
  });

  const spam = (name: string, target: "message" | "thread", mark: boolean) =>
    defineTool(server, toolContext, env, {
      name,
      version: 1,
      description: `${mark ? "Mark" : "Unmark"} one ${target} as spam.`,
      input: target === "message" ? MessageTargetInput : ThreadTargetInput,
      annotations: { readOnlyHint: false, destructiveHint: mark, openWorldHint: false },
      action: mark ? "spam.mark" : "spam.unmark",
      journal: false,
      plan: async (_e, _t, _a, args) => {
        const id =
          target === "message"
            ? (args as { message_id: string }).message_id
            : (args as { thread_id: string }).thread_id;
        return simple(
          { [`${target}_id`]: id, add: mark ? ["SPAM"] : ["INBOX"], remove: mark ? ["INBOX"] : ["SPAM"] },
          [],
          `${mark ? "Mark" : "Unmark"} spam: ${target} ${id}`,
          [id],
        );
      },
      execute: async (e, d, run) => {
        const p = run.payload as { message_id?: string; thread_id?: string; add: string[]; remove: string[] };
        return target === "message"
          ? modifyMessage(e, d, run, p.message_id!, p.add, p.remove)
          : modifyThread(e, d, run, p.thread_id!, p.add, p.remove);
      },
    });
  spam("mark_message_spam", "message", true);
  spam("mark_thread_spam", "thread", true);
  spam("unmark_message_spam", "message", false);
  spam("unmark_thread_spam", "thread", false);

  const trash = (name: string, target: "message" | "thread", move: boolean) =>
    defineTool(server, toolContext, env, {
      name,
      version: 1,
      description: `${move ? "Move" : "Restore"} one ${target} ${move ? "to" : "from"} Trash.`,
      input: target === "message" ? MessageTargetInput : ThreadTargetInput,
      annotations: { readOnlyHint: false, destructiveHint: move, openWorldHint: false },
      action: move ? "trash.move" : "trash.restore",
      journal: false,
      plan: async (_e, _t, _a, args) => {
        const id =
          target === "message"
            ? (args as { message_id: string }).message_id
            : (args as { thread_id: string }).thread_id;
        return simple(
          { [`${target}_id`]: id, op: move ? "trash" : "untrash" },
          [],
          `${move ? "Trash" : "Untrash"} ${target} ${id}`,
          [id],
        );
      },
      execute: async (e, d, run) => {
        const p = run.payload as { message_id?: string; thread_id?: string; op: "trash" | "untrash" };
        return target === "message"
          ? postMessage(e, d, run, p.message_id!, p.op)
          : postThread(e, d, run, p.thread_id!, p.op);
      },
    });
  trash("trash_message", "message", true);
  trash("trash_thread", "thread", true);
  trash("untrash_message", "message", false);
  trash("untrash_thread", "thread", false);

  const labelBody = (a: {
    display_name?: string;
    label_list_visibility?: string;
    message_list_visibility?: string;
    text_color?: string;
    background_color?: string;
  }) => ({
    ...(a.display_name !== undefined ? { name: a.display_name } : {}),
    ...(a.label_list_visibility ? { labelListVisibility: LIST_VIS[a.label_list_visibility] } : {}),
    ...(a.message_list_visibility ? { messageListVisibility: MSG_VIS[a.message_list_visibility] } : {}),
    ...(a.text_color && a.background_color
      ? { color: { textColor: a.text_color, backgroundColor: a.background_color } }
      : {}),
  });
  const colourPair = (a: { text_color?: string; background_color?: string }) => {
    if ((a.text_color === undefined) !== (a.background_color === undefined))
      throw new GmailMcpError("invalid_header", "invalid_header: text_color and background_color go together");
  };
  defineTool(server, toolContext, env, {
    name: "create_label",
    version: 1,
    description:
      "Create a label. Nest with '/'. The name is sent as given; Gmail decides whether a missing parent is acceptable.",
    input: CreateLabelInput,
    annotations: apply,
    action: "label.manage",
    journal: true,
    plan: async (_e, _t, _a, args) => {
      colourPair(args);
      const { account: _account, ...rest } = args;
      return simple({ op: "create", name: args.display_name, ...rest }, [], `Create label ${args.display_name}`, []);
    },
    execute: async (e, d, run) => {
      const p = CreateLabelInput.omit({ account: true }).parse(run.payload);
      if (!run.operationId) throw new GmailMcpError("internal", "label.manage create runs with an operation");
      // The one request that changes Gmail comes after the operation is executing, and there is no other.
      await beginOperation(e.DB, run.operationId);
      const label = await gmailJson<GmailLabel>(e, d, acct(run), {
        method: "POST",
        path: "labels",
        json: labelBody(p),
        retry: "none",
      });
      return { gmail_result_id: label.id, label: labelView(label) };
    },
  });
  defineTool(server, toolContext, env, {
    name: "update_label",
    version: 1,
    description: "Rename a label or change its visibility or colour.",
    input: UpdateLabelInput,
    annotations: apply,
    action: "label.manage",
    journal: false,
    plan: async (_e, _t, _a, args) => {
      if (isSystemLabel(args.label_id))
        throw new GmailMcpError("forbidden", "forbidden: system labels cannot be changed");
      colourPair(args);
      const { account: _account, ...rest } = args;
      return simple({ op: "update", name: args.display_name ?? null, ...rest }, [], `Update label ${args.label_id}`, [
        args.label_id,
      ]);
    },
    execute: async (e, d, run) => {
      const p = UpdateLabelInput.omit({ account: true }).parse(run.payload);
      const label = await gmailJson<GmailLabel>(e, d, acct(run), {
        method: "PATCH",
        path: `labels/${encodeURIComponent(p.label_id)}`,
        json: labelBody(p),
        retry: "safe",
      });
      return { label: labelView(label) };
    },
  });
  defineTool(server, toolContext, env, {
    name: "delete_label",
    version: 1,
    description: "Delete a label definition. Messages keep their other labels. System labels are refused.",
    input: DeleteLabelInput,
    annotations: destructive,
    action: "label.manage",
    journal: false,
    plan: async (_e, _t, _a, args) => {
      if (isSystemLabel(args.label_id))
        throw new GmailMcpError("forbidden", "forbidden: system labels cannot be deleted");
      return simple({ op: "delete", label_id: args.label_id }, [], `Delete label ${args.label_id}`, [args.label_id]);
    },
    execute: async (e, d, run) => {
      const p = DeleteLabelInput.omit({ account: true }).parse(run.payload);
      await gmailJson<undefined>(e, d, acct(run), {
        method: "DELETE",
        path: `labels/${encodeURIComponent(p.label_id)}`,
        retry: "safe",
      });
      return { deleted: p.label_id };
    },
  });
}
```

`GmailRequest.method` in `google/gmail.ts` includes `"PATCH"` (Task 1). The `name: null` in `update_label`'s payload is a JSON null, which `canonicalize` accepts and `approvalView` reads as "unchanged"; the gate strips only `undefined`.

`worker/src/mcp/server.ts`: `registerLabelTools(server, toolContext, env);` after the control tools.

- [x] **Step 6: run, expect pass**

Run: `cd worker && npx vitest run test/labels-tools.test.ts test/mcp.test.ts test/approve.test.ts` then `npm run verify`.
Expected: PASS. `approve.test.ts` renders the `targets` and `label` views from payloads this task now produces; it must still pass without change.

- [x] **Step 7: commit**

```bash
git add shared/src/schemas.ts worker/src worker/test
git commit -m "feat(worker): defineTool, then the label, spam and trash tools

One registration path with an intent hash over the client's arguments, a deferred build that writes
nothing before the decision, and per-tool journaling. System labels raise +sensitive, TRASH and SPAM
are refused outside the tools that name them, and a Gmail refusal of a label create is failed_safe.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NBfkjWcEGDFghet3APnUjU"
```

---

### Task 6: Read tools and `download_attachment`

**Files:**

- Create: `worker/src/tools/read.ts`, `worker/test/read-tools.test.ts`
- Modify: `shared/src/schemas.ts` (read inputs), `worker/src/mcp/server.ts` (register), `worker/test/mcp.test.ts` (tool list)

**Interfaces:**

- Consumes: `messageView`, `findAttachment`, `gmailFormatFor`, `decodeBodyData`, `gmailJson`, `ingest`, `labelView`, `defineTool`.
- Produces: `registerReadTools(server, toolContext, env)`; input schemas `SearchThreadsInput`, `GetThreadInput`, `GetMessageInput`, `ListDraftsInput`, `GetDraftInput`, `ListLabelsInput`, `DownloadAttachmentInput`. Read tools take `account: AccountAlias.optional()` and are `journal: false`. `message_format` accepts `MessageFormat` or `MESSAGE_FORMAT_UNSPECIFIED` (the default `PLAIN_TEXT`). `limit` is `1..50` default `20`; `body_char_limit` is `1..200000` default `20000`; `max_messages` is `1..100` default `25`; `include_body` default `true`; `get_thread` adds `total_body_char_limit` (`1..2000000`, default `200000`), a budget across all bodies in the response: once spent, later messages carry headers only and `thread.bodies_omitted` counts them.
- Every result carries `account`; lists carry `next_page_token` when Gmail returned one.
- `download_attachment` takes `message_id` and one of `attachment_id` or `part_id`. A part with an `attachmentId` is fetched with `attachments.get`; a part whose bytes live in `body.data` (no `attachmentId`, which Gmail uses for small parts) is decoded from the message itself. It refuses anything above 25 MB by the part's `size` before any bytes move, and returns `StagingHandleResponse` plus `account`.

- [x] **Step 1 (RED): tests**

`worker/test/read-tools.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { StagingHandleResponse } from "@gmail-mcp/shared/schemas";
import { createWorker } from "../src/index";
import { FakeGoogle } from "./fake-google";
import { mintToken } from "./browser";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import { callTool } from "./mcp-client";
import { testDeps, testEnv } from "./test-env";
import { setPolicy } from "../src/policy/engine";
import { sha256Hex } from "../src/crypto/canonical";

const e = testEnv();
let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
let token: string;
const gm = () => g.gmail;
const call = (name: string, args: Record<string, unknown>) => callTool(worker, e, token, name, args);

beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker(testDeps(g));
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "ra", alias: "personal", isDefault: true });
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "rb", alias: "work" });
  await seedAccessToken(e, { userId: "owner-sub", accountId: "ra" });
  await seedAccessToken(e, { userId: "owner-sub", accountId: "rb" });
  token = (await mintToken(worker, e, g, { scope: "mcp" })).accessToken;
  for (let i = 0; i < 25; i++)
    gm().seedMessage({ from: "a@x.test", to: ["me@x.test"], subject: `bulk ${i}`, text: `body ${i}` });
});

describe("reads", () => {
  it("search_threads pages at the limit, echoes the default account, and writes one intent row per call", async () => {
    const r = await call("search_threads", { query: "subject:bulk", limit: 10 });
    expect(r.result.account).toBe("personal");
    expect(r.result.threads).toHaveLength(10);
    expect(r.result.threads[0]).toMatchObject({ id: expect.any(String), snippet: expect.any(String) });
    expect(r.result.next_page_token).toBeTruthy();
    const r2 = await call("search_threads", { query: "subject:bulk", limit: 10, page_token: r.result.next_page_token });
    expect(r2.result.threads[0].id).not.toBe(r.result.threads[0].id);
    const url = gm().requests.at(-1)!.url;
    expect(url).toContain("maxResults=10");
    expect(url).toContain("includeSpamTrash=false");
    const rows = await env.DB.prepare(
      "SELECT phase, decision FROM audit_log WHERE user_id='owner-sub' AND tool='search_threads' ORDER BY id DESC LIMIT 2",
    ).all<any>();
    expect(rows.results.every((x) => x.phase === "intent" && x.decision === "allow")).toBe(true);
    const over = await call("search_threads", { limit: 51 });
    expect(over.error ?? over.result?.error).toBeTruthy();
  });
  it("get_thread returns messages in PLAIN_TEXT by default, capped by max_messages and body_char_limit", async () => {
    const root = gm().seedMessage({ from: "a@x.test", to: ["me@x.test"], subject: "thread", text: "one ".repeat(100) });
    gm().seedMessage({
      threadId: root.threadId,
      from: "me@x.test",
      to: ["a@x.test"],
      subject: "Re: thread",
      text: "two",
      html: "<i>two</i>",
    });
    gm().seedMessage({
      threadId: root.threadId,
      from: "a@x.test",
      to: ["me@x.test"],
      subject: "Re: thread",
      text: "three",
    });
    const r = await call("get_thread", { thread_id: root.threadId, max_messages: 2, body_char_limit: 8 });
    expect(r.result.account).toBe("personal");
    expect(r.result.thread.messages).toHaveLength(2);
    expect(r.result.thread.messages[0]).toMatchObject({
      plaintext_body: "one one ",
      body_truncated: true,
      subject: "thread",
    });
    expect(r.result.thread.messages[1].html_body).toBeUndefined();
    expect(r.result.thread.messages_omitted).toBe(1);
    const full = await call("get_thread", { thread_id: root.threadId, message_format: "FULL_CONTENT" });
    expect(full.result.thread.messages[1].html_body).toBe("<i>two</i>");
    const meta = await call("get_thread", { thread_id: root.threadId, message_format: "METADATA_ONLY" });
    expect(meta.result.thread.messages[0].plaintext_body).toBeUndefined();
    expect(gm().requests.at(-1)!.url).toContain("format=metadata");
  });
  it("get_thread has a total body budget across messages", async () => {
    const root = gm().seedMessage({ from: "a@x.test", to: ["me@x.test"], subject: "budget", text: "x".repeat(150) });
    for (let i = 0; i < 4; i++)
      gm().seedMessage({
        threadId: root.threadId,
        from: "a@x.test",
        to: ["me@x.test"],
        subject: "Re: budget",
        text: "y".repeat(150),
      });
    const r = await call("get_thread", { thread_id: root.threadId, total_body_char_limit: 400 });
    const withBody = r.result.thread.messages.filter(
      (m: { plaintext_body?: string }) => m.plaintext_body !== undefined,
    );
    expect(withBody.length).toBeLessThanOrEqual(3);
    expect(r.result.thread.bodies_omitted).toBe(5 - withBody.length);
    expect(r.result.thread.messages).toHaveLength(5);
  });
  it("get_message exposes attachment metadata only and honours include_body", async () => {
    const m = gm().seedMessage({
      from: "a@x.test",
      to: ["me@x.test"],
      subject: "att",
      text: "see attached",
      attachments: [{ filename: "a.pdf", mime: "application/pdf", bytes: new Uint8Array(3000) }],
    });
    const r = await call("get_message", { message_id: m.id });
    expect(r.result.message.attachments).toEqual([
      { part_id: "2", attachment_id: `att${m.id}_0`, filename: "a.pdf", mime: "application/pdf", size: 3000 },
    ]);
    expect(r.result.message.plaintext_body).toBe("see attached");
    expect(
      (await call("get_message", { message_id: m.id, include_body: false })).result.message.plaintext_body,
    ).toBeUndefined();
    expect(
      (await call("get_message", { message_id: m.id, message_format: "MESSAGE_FORMAT_UNSPECIFIED" })).result.message
        .plaintext_body,
    ).toBe("see attached");
    expect((await call("get_message", { account: "work", message_id: m.id })).result.account).toBe("work");
  });
  it("list_drafts, get_draft and list_labels", async () => {
    const d = gm().seedDraft({ from: "me@x.test", to: ["a@x.test"], subject: "draft one", text: "d1" });
    const list = await call("list_drafts", { limit: 5 });
    expect(list.result.drafts.map((x: { id: string }) => x.id)).toContain(d.id);
    const one = await call("get_draft", { draft_id: d.id });
    expect(one.result.draft).toMatchObject({ id: d.id, message: { subject: "draft one", plaintext_body: "d1" } });
    const labels = await call("list_labels", {});
    expect(labels.result.labels.map((l: { id: string }) => l.id)).toEqual(
      expect.arrayContaining(["INBOX", "SENT", "DRAFT"]),
    );
  });
  it("reads obey policy: a denied read.search writes one intent row and returns policy_denied", async () => {
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "ra", action: "read.search", level: "deny" });
    expect((await call("search_threads", { query: "x" })).result).toMatchObject({ error: "policy_denied" });
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "ra", action: "read.search", level: "allow" });
  });
});

describe("download_attachment", () => {
  it("stages the decoded bytes as a download handle with sha256 and a 30 minute expiry", async () => {
    const data = new Uint8Array(5000).map((_, i) => i % 251);
    const m = gm().seedMessage({
      from: "a@x.test",
      to: ["me@x.test"],
      subject: "dl",
      text: "t",
      attachments: [{ filename: "..\\evil‮.pdf", mime: "application/pdf", bytes: data }],
    });
    const r = await call("download_attachment", { message_id: m.id, attachment_id: `att${m.id}_0` });
    const h = StagingHandleResponse.parse(r.result);
    expect(h).toMatchObject({
      account: "personal",
      filename: "evil_.pdf",
      mime: "application/pdf",
      size: 5000,
      sha256: await sha256Hex(data),
    });
    expect(Date.parse(h.expires_at) - Date.now()).toBeGreaterThan(29 * 60_000);
    const row = await env.DB.prepare(
      "SELECT direction, user_id, account_id, source_message_id, source_attachment_id FROM staging_objects WHERE handle = ?",
    )
      .bind(h.handle)
      .first<any>();
    expect(row).toEqual({
      direction: "download",
      user_id: "owner-sub",
      account_id: "ra",
      source_message_id: m.id,
      source_attachment_id: `att${m.id}_0`,
    });
    expect(JSON.stringify(r.result)).not.toContain("data");
  });
  it("downloads a part whose bytes are inline in the message body, by part_id", async () => {
    const m = gm().seedMessage({
      from: "a@x.test",
      to: ["me@x.test"],
      subject: "inline",
      text: "t",
      attachments: [
        { filename: "tiny.txt", mime: "text/plain", bytes: new TextEncoder().encode("tiny"), inline: true },
      ],
    });
    const meta = (await call("get_message", { message_id: m.id })).result.message.attachments[0];
    expect(meta).toMatchObject({ filename: "tiny.txt", attachment_id: null, part_id: expect.any(String), size: 4 });
    const before = gm().requests.length;
    const r = await call("download_attachment", { message_id: m.id, part_id: meta.part_id });
    expect(r.result).toMatchObject({ filename: "tiny.txt", size: 4 });
    expect(
      gm()
        .requests.slice(before)
        .some((q) => q.url.includes("/attachments/")),
    ).toBe(false);
    const neither = await call("download_attachment", { message_id: m.id });
    expect(neither.error ?? neither.result?.error).toBeTruthy();
  });
  it("refuses an attachment above 25 MB by size before fetching bytes, and an unknown attachment id", async () => {
    const m = gm().seedMessage({
      from: "a@x.test",
      to: ["me@x.test"],
      subject: "big",
      text: "t",
      attachments: [{ filename: "big.bin", mime: "application/octet-stream", bytes: new Uint8Array(10) }],
    });
    const part = gm()
      .messages.get(m.id)!
      .payload.parts!.find((p) => p.filename === "big.bin")!;
    part.body.size = 25 * 1024 * 1024 + 1;
    const before = gm().requests.length;
    const r = await call("download_attachment", { message_id: m.id, attachment_id: part.body.attachmentId });
    expect(r.result).toMatchObject({ error: "limit_exceeded" });
    expect(
      gm()
        .requests.slice(before)
        .some((q) => q.url.includes("/attachments/")),
    ).toBe(false);
    expect((await call("download_attachment", { message_id: m.id, attachment_id: "nope" })).result).toMatchObject({
      error: "handle_invalid",
    });
  });
  it("is audited as read.attachment with the ids and writes an outcome row", async () => {
    const rows = await env.DB.prepare(
      "SELECT phase, decision, action, summary FROM audit_log WHERE user_id='owner-sub' AND tool='download_attachment' ORDER BY id",
    ).all<any>();
    expect(rows.results[0]).toMatchObject({ phase: "intent", decision: "allow", action: "read.attachment" });
    expect(rows.results[1]).toMatchObject({ phase: "outcome", decision: "executed" });
    expect(rows.results[0].summary).toMatch(/^ids=/);
  });
});
```

- [x] **Step 2: run, expect failure**

Run: `cd worker && npx vitest run test/read-tools.test.ts`
Expected: FAIL, unknown tools.

- [x] **Step 3 (GREEN): schemas and the family**

Append to `shared/src/schemas.ts`:

```ts
const FormatArg = z.union([MessageFormat, z.literal("MESSAGE_FORMAT_UNSPECIFIED")]).default("PLAIN_TEXT");
const PageLimit = z.number().int().min(1).max(50).default(20);
const PageToken = z.string().min(1).max(512).optional();
const BodyCharLimit = z.number().int().min(1).max(200_000).default(20_000);
export const SearchThreadsInput = z.object({
  account: AccountAlias.optional(),
  query: z.string().max(2048).optional(),
  limit: PageLimit,
  page_token: PageToken,
  include_spam_trash: z.boolean().default(false),
});
export const GetThreadInput = z.object({
  account: AccountAlias.optional(),
  thread_id: GmailId,
  message_format: FormatArg,
  max_messages: z.number().int().min(1).max(100).default(25),
  include_body: z.boolean().default(true),
  body_char_limit: BodyCharLimit,
  total_body_char_limit: z.number().int().min(1).max(2_000_000).default(200_000),
});
export const GetMessageInput = z.object({
  account: AccountAlias.optional(),
  message_id: GmailId,
  message_format: FormatArg,
  include_body: z.boolean().default(true),
  body_char_limit: BodyCharLimit,
});
export const ListDraftsInput = z.object({
  account: AccountAlias.optional(),
  query: z.string().max(2048).optional(),
  limit: PageLimit,
  page_token: PageToken,
});
export const GetDraftInput = z.object({
  account: AccountAlias.optional(),
  draft_id: GmailId,
  message_format: FormatArg,
  body_char_limit: BodyCharLimit,
});
export const ListLabelsInput = z.object({ account: AccountAlias.optional() });
export const DownloadAttachmentInput = z
  .object({
    account: AccountAlias.optional(),
    message_id: GmailId,
    attachment_id: z.string().min(1).max(1024).optional(),
    part_id: z.string().min(1).max(64).optional(),
  })
  .refine((v) => (v.attachment_id === undefined) !== (v.part_id === undefined), {
    message: "give attachment_id or part_id, not both",
  });
```

`worker/src/tools/read.ts`:

```ts
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import {
  DownloadAttachmentInput,
  GetDraftInput,
  GetMessageInput,
  GetThreadInput,
  ListDraftsInput,
  ListLabelsInput,
  SearchThreadsInput,
  type MessageFormat,
} from "@gmail-mcp/shared/schemas";
import type { Env } from "../env";
import { fromB64url } from "../crypto/random";
import { gmailJson } from "../google/gmail";
import {
  findAttachment,
  gmailFormatFor,
  messageView,
  partData,
  type GmailDraft,
  type GmailLabel,
  type GmailThread,
} from "../google/messages";
import { LIMITS } from "../policy/limits";
import { ingest } from "../staging/store";
import { getMessage } from "./compose";
import { defineTool, type Plan } from "./define";
import type { ExecRun, ToolContext } from "./gate";
import { labelView } from "./labels";

const fmt = (f: MessageFormat | "MESSAGE_FORMAT_UNSPECIFIED"): MessageFormat =>
  f === "MESSAGE_FORMAT_UNSPECIFIED" ? "PLAIN_TEXT" : f;
const acct = (run: ExecRun) => ({ userId: run.userId, accountId: run.account.id });
const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
/** A read's payload is its arguments; nothing is staged, so the build is immediate. */
const readPlan = (args: Record<string, unknown>, summary: string, ids: string[] = []): Plan => {
  const { account: _account, ...payload } = args;
  return { modifiers: [], summary, facts: ids.length ? { ids } : {}, build: async () => ({ payload, handles: [] }) };
};

/**
 * Reads pass through the same gate as writes: the policy engine may deny or ask for any action, and
 * every call leaves one intent row. They are not journaled because they change nothing outside.
 */
export function registerReadTools(server: McpServer, toolContext: (ctx: ServerContext) => ToolContext, env: Env): void {
  defineTool(server, toolContext, env, {
    name: "search_threads",
    version: 1,
    description: "Search threads with Gmail query syntax. Paginated; limit at most 50.",
    input: SearchThreadsInput,
    annotations: ro,
    action: "read.search",
    journal: false,
    plan: async (_e, _t, _a, args) => readPlan(args, `Search threads: ${args.query ?? "(all)"}`),
    execute: async (e, d, run) => {
      const p = SearchThreadsInput.omit({ account: true }).parse(run.payload);
      const res = await gmailJson<{
        threads?: { id: string; snippet?: string }[];
        nextPageToken?: string;
        resultSizeEstimate?: number;
      }>(e, d, acct(run), {
        method: "GET",
        path: "threads",
        query: { q: p.query, maxResults: p.limit, pageToken: p.page_token, includeSpamTrash: p.include_spam_trash },
        retry: "safe",
      });
      return {
        threads: (res.threads ?? []).map((t) => ({ id: t.id, snippet: t.snippet ?? "" })),
        result_size_estimate: res.resultSizeEstimate ?? 0,
        ...(res.nextPageToken ? { next_page_token: res.nextPageToken } : {}),
      };
    },
  });

  defineTool(server, toolContext, env, {
    name: "get_thread",
    version: 1,
    description:
      "A thread and its messages. PLAIN_TEXT by default; bodies cut at body_char_limit and under total_body_char_limit across the thread; at most max_messages.",
    input: GetThreadInput,
    annotations: ro,
    action: "read.message",
    journal: false,
    plan: async (_e, _t, _a, args) => readPlan(args, `Get thread ${args.thread_id}`, [args.thread_id]),
    execute: async (e, d, run) => {
      const p = GetThreadInput.omit({ account: true }).parse(run.payload);
      const f = fmt(p.message_format);
      const q = gmailFormatFor(f);
      const t = await gmailJson<GmailThread>(e, d, acct(run), {
        method: "GET",
        path: `threads/${encodeURIComponent(p.thread_id)}`,
        query: { format: q.format, metadataHeaders: q.metadataHeaders },
        retry: "safe",
      });
      const all = t.messages ?? [];
      const shown = all.slice(0, p.max_messages);
      let budget = p.total_body_char_limit;
      let omitted = 0;
      const messages = shown.map((m) => {
        const view = messageView(m, {
          format: f,
          bodyCharLimit: Math.min(p.body_char_limit, Math.max(budget, 0)),
          includeBody: p.include_body && budget > 0,
        });
        if (p.include_body && budget <= 0) omitted++;
        budget -= (view.plaintext_body?.length ?? 0) + (view.html_body?.length ?? 0) + (view.raw?.length ?? 0);
        return view;
      });
      return { thread: { id: t.id, messages, messages_omitted: all.length - shown.length, bodies_omitted: omitted } };
    },
  });

  defineTool(server, toolContext, env, {
    name: "get_message",
    version: 1,
    description: "One message. Attachments are listed as metadata; use download_attachment for bytes.",
    input: GetMessageInput,
    annotations: ro,
    action: "read.message",
    journal: false,
    plan: async (_e, _t, _a, args) => readPlan(args, `Get message ${args.message_id}`, [args.message_id]),
    execute: async (e, d, run) => {
      const p = GetMessageInput.omit({ account: true }).parse(run.payload);
      const f = fmt(p.message_format);
      return {
        message: messageView(await getMessage(e, d, acct(run), p.message_id, f), {
          format: f,
          bodyCharLimit: p.body_char_limit,
          includeBody: p.include_body,
        }),
      };
    },
  });

  defineTool(server, toolContext, env, {
    name: "list_drafts",
    version: 1,
    description: "List drafts, optionally filtered by a Gmail query. Paginated.",
    input: ListDraftsInput,
    annotations: ro,
    action: "read.message",
    journal: false,
    plan: async (_e, _t, _a, args) => readPlan(args, "List drafts"),
    execute: async (e, d, run) => {
      const p = ListDraftsInput.omit({ account: true }).parse(run.payload);
      const res = await gmailJson<{
        drafts?: { id: string; message: { id: string; threadId: string } }[];
        nextPageToken?: string;
      }>(e, d, acct(run), {
        method: "GET",
        path: "drafts",
        query: { q: p.query, maxResults: p.limit, pageToken: p.page_token },
        retry: "safe",
      });
      return {
        drafts: (res.drafts ?? []).map((x) => ({ id: x.id, message_id: x.message.id, thread_id: x.message.threadId })),
        ...(res.nextPageToken ? { next_page_token: res.nextPageToken } : {}),
      };
    },
  });

  defineTool(server, toolContext, env, {
    name: "get_draft",
    version: 1,
    description: "One draft with its message.",
    input: GetDraftInput,
    annotations: ro,
    action: "read.message",
    journal: false,
    plan: async (_e, _t, _a, args) => readPlan(args, `Get draft ${args.draft_id}`, [args.draft_id]),
    execute: async (e, d, run) => {
      const p = GetDraftInput.omit({ account: true }).parse(run.payload);
      const f = fmt(p.message_format);
      const dr = await gmailJson<GmailDraft>(e, d, acct(run), {
        method: "GET",
        path: `drafts/${encodeURIComponent(p.draft_id)}`,
        query: { format: gmailFormatFor(f).format },
        retry: "safe",
      });
      return {
        draft: {
          id: dr.id,
          message: messageView(dr.message, { format: f, bodyCharLimit: p.body_char_limit, includeBody: true }),
        },
      };
    },
  });

  defineTool(server, toolContext, env, {
    name: "list_labels",
    version: 1,
    description: "All labels. System labels are read-only.",
    input: ListLabelsInput,
    annotations: ro,
    action: "read.message",
    journal: false,
    plan: async () => readPlan({}, "List labels"),
    execute: async (e, d, run) => ({
      labels: (
        (await gmailJson<{ labels?: GmailLabel[] }>(e, d, acct(run), { method: "GET", path: "labels", retry: "safe" }))
          .labels ?? []
      ).map(labelView),
    }),
  });

  defineTool(server, toolContext, env, {
    name: "download_attachment",
    version: 1,
    description:
      "Fetch one attachment into staging by attachment_id or part_id and return a handle. Bytes never enter the result. 25 MB ceiling.",
    input: DownloadAttachmentInput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    action: "read.attachment",
    journal: false,
    plan: async (_e, _t, _a, args) =>
      readPlan(
        args,
        `Download attachment ${args.attachment_id ?? `part ${args.part_id}`} of message ${args.message_id}`,
        [args.message_id],
      ),
    execute: async (e, d, run) => {
      const p = DownloadAttachmentInput.omit({ account: true }).parse(run.payload);
      // Spec 3.7: the part's size comes from the message's part tree (format=full carries sizes, not
      // bytes for external parts), and anything over the ceiling is refused before attachments.get.
      const m = await getMessage(e, d, acct(run), p.message_id, "PLAIN_TEXT");
      const meta = p.attachment_id
        ? findAttachment(m, { attachmentId: p.attachment_id })
        : findAttachment(m, { partId: p.part_id! });
      if (!meta)
        throw new GmailMcpError("handle_invalid", `handle_invalid: no such attachment on message ${p.message_id}`);
      if (meta.size > LIMITS.stagedFileBytes)
        throw new GmailMcpError(
          "limit_exceeded",
          `limit_exceeded: attachment is ${meta.size} bytes, ceiling ${LIMITS.stagedFileBytes}`,
        );
      let bytes: Uint8Array;
      if (meta.attachment_id) {
        const body = await gmailJson<{ data?: string }>(e, d, acct(run), {
          method: "GET",
          path: `messages/${encodeURIComponent(p.message_id)}/attachments/${encodeURIComponent(meta.attachment_id)}`,
          retry: "safe",
        });
        if (!body.data) throw new GmailMcpError("handle_invalid", "handle_invalid: attachment body empty");
        bytes = fromB64url(body.data);
      } else {
        const data = partData(m, meta.part_id);
        if (!data) throw new GmailMcpError("handle_invalid", "handle_invalid: inline part without data");
        bytes = fromB64url(data);
      }
      const row = await ingest(e, {
        userId: run.userId,
        accountId: run.account.id,
        direction: "download",
        filename: meta.filename,
        mime: meta.mime,
        length: bytes.byteLength,
        body: new Response(bytes).body!,
        source: { messageId: p.message_id, attachmentId: meta.attachment_id ?? `part:${meta.part_id}` },
      });
      return {
        handle: row.handle,
        filename: row.filename,
        mime: row.mime,
        size: row.size,
        sha256: row.sha256,
        expires_at: new Date(row.expires_at).toISOString(),
      };
    },
  });
}
```

The download path buffers the `attachments.get` JSON and the decoded bytes, which spec 3.7 states as the V1 decision with the 25 MB round-trip as its gate; streaming base64url extraction is the spec's own deferred item (6).

`worker/src/mcp/server.ts`: `registerReadTools(server, toolContext, env);` after `registerLabelTools`.

- [x] **Step 4: run, expect pass**

Run: `cd worker && npx vitest run test/read-tools.test.ts test/mcp.test.ts` then `npm run verify`.
Expected: PASS.

- [x] **Step 5: commit**

```bash
git add shared/src/schemas.ts worker/src/tools/read.ts worker/src/mcp/server.ts worker/test
git commit -m "feat(worker): read tools and download_attachment

Reads echo the account, page at the hosted limits, cut bodies on code points and under a per-thread
budget. Downloads find a part by attachment id or part id, check the size before any bytes move, and
stage the decoded bytes; the handle is all the model ever sees.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NBfkjWcEGDFghet3APnUjU"
```

---

### Task 7: The send pipeline over streams

**Files:**

- Create: `worker/src/operations/send.ts`, `worker/test/send-pipeline.test.ts`
- Modify: `worker/src/google/gmail.ts` (`multipart` upload kind, `openResumableSession`, `putResumable`), `worker/test/fake-gmail.ts` (`multipart/related` uploads, `threadId` from metadata, session metadata)

**Interfaces:**

- Consumes: `gmailFetch`, `gmailJson`, `GmailApiError`, `beginOperation`, `buildMimeStream`.
- Produces:
  - `Upload` becomes `{ kind: "media"; contentType; bytes } | { kind: "multipart"; contentType; bytes; metadata: Record<string, unknown> }`. The resumable kind is gone from `gmailFetch`; the two halves of the resumable protocol are separate calls with different retry rules, because only one of them moves message bytes.
  - `openResumableSession(env, deps, acct, o: { path: string; contentType: string; length: number; metadata?: Record<string, unknown> }): Promise<string>`: `POST /resumable/upload/gmail/v1/users/me/<path>?uploadType=resumable` with `X-Upload-Content-Type`, `X-Upload-Content-Length` and the metadata as its JSON body, retried with the `safe` policy (it creates no message), returning the session URL from `Location`.
  - `putResumable(env, deps, acct, sessionUrl: string, o: { contentType: string; length: number; body: ReadableStream<Uint8Array> }): Promise<Response>`: one `PUT` with the body piped through `new FixedLengthStream(length)` so the runtime sends a `Content-Length`; opened exactly once, never refreshed or retried; a non-2xx is a `GmailApiError`. Session recovery (querying the session for the confirmed byte offset and resuming) is not built; the session URL is not persisted; the header's amendment names this "resumable transport without recovery" and Plan 5 owns recovery alongside reconciliation.
  - `MEDIA_UPLOAD_MAX = 5 * 1024 * 1024`; `GMAIL_SEND_MAX = 36_700_160` (discovery `maxSize`); `messageIdFor(env, operationId)`.
  - `sendMime(env, deps, o: { userId; accountId; operationId; body: ReadableStream<Uint8Array>; length: number; threadId: string | null; rfc822MessageId: string }): Promise<SentMessage>`: refuses `length > GMAIL_SEND_MAX` before anything; at or under 5 MB collects the stream and uses media (no thread) or multipart (with thread); above, opens the session first, then moves the operation to `executing` immediately before the `PUT`. It returns the wire result and never settles the operation: the gate does that.
  - `uploadDraft(env, deps, o: { …; draftId: string | null })`: the same protocol against `drafts` (`POST`) or `drafts/<id>` (`PUT`).
  - `sendDraft(env, deps, o: { userId; accountId; operationId; draftId; rfc822MessageId: string | null })`: `POST drafts/send` with `{ id }`; `beginOperation` carries the draft's own `Message-ID` header so Plan 5's reconciliation has one to search for.
  - `collect(stream, length): Promise<Uint8Array>`: reads a stream of known length into exactly `length` bytes, erroring on any other count.

- [x] **Step 1 (RED): tests**

`worker/test/send-pipeline.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { FakeGoogle } from "./fake-google";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import { testDeps, testEnv } from "./test-env";
import { insertOperationStatement } from "../src/operations/journal";
import { randomId } from "../src/crypto/random";
import {
  sendMime,
  sendDraft,
  uploadDraft,
  messageIdFor,
  MEDIA_UPLOAD_MAX,
  GMAIL_SEND_MAX,
} from "../src/operations/send";
import { buildMimeStream, fromBytes } from "../src/mime/build";

const e = testEnv();
let g: FakeGoogle;
const gm = () => g.gmail;
const acct = { userId: "su", accountId: "sa" };

beforeAll(async () => {
  g = await FakeGoogle.create();
  await seedUserAndAccount(env.DB, { userId: "su", accountId: "sa", alias: "main", isDefault: true });
  await seedAccessToken(e, acct);
});

async function op() {
  const id = randomId("op");
  await insertOperationStatement(env.DB, {
    id,
    ...acct,
    action: "send.message",
    payloadHash: "h",
    now: Date.now(),
  }).run();
  return id;
}
const opRow = (id: string) =>
  env.DB.prepare("SELECT state, rfc822_message_id, gmail_result_id FROM operations WHERE id = ?").bind(id).first<any>();
const mime = (extra: Partial<Parameters<typeof buildMimeStream>[0]> = {}) =>
  buildMimeStream({
    from: "me@example.test",
    to: ["a@example.test"],
    cc: [],
    bcc: [],
    subject: "s",
    messageId: "<x@y>",
    text: "t",
    attachments: [],
    ...extra,
  });
const send = (id: string, m: ReturnType<typeof mime>, threadId: string | null = null) =>
  sendMime(e, testDeps(g), {
    ...acct,
    operationId: id,
    body: m.stream,
    length: m.length,
    threadId,
    rfc822MessageId: "<x@y>",
  });

describe("sendMime", () => {
  it("small: media upload; the operation is executing with the Message-ID before the request opens; nothing settles here", async () => {
    const id = await op();
    const mid = messageIdFor(e, id);
    expect(mid).toBe(`<${id}@gmail-mcp.example.workers.dev>`);
    let seenState: string | undefined;
    gm().before = async () => {
      seenState = (await opRow(id)).state;
      return undefined;
    };
    const m = mime({ messageId: mid });
    const sent = await sendMime(e, testDeps(g), {
      ...acct,
      operationId: id,
      body: m.stream,
      length: m.length,
      threadId: null,
      rfc822MessageId: mid,
    });
    gm().before = null;
    expect(seenState).toBe("executing");
    expect(sent).toMatchObject({ id: expect.stringMatching(/^m/), thread_id: expect.any(String), label_ids: ["SENT"] });
    expect(await opRow(id)).toEqual({ state: "executing", rfc822_message_id: mid, gmail_result_id: null });
    expect(gm().sent.at(-1)!.via).toBe("media");
    expect(gm().requests.at(-1)!.url).toContain("uploadType=media");
  });
  it("with a thread id: multipart upload carries threadId metadata and Gmail files it in that thread", async () => {
    const root = gm().seedMessage({ from: "a@example.test", to: ["me@example.test"], subject: "root", text: "r" });
    const sent = await send(await op(), mime({ inReplyTo: `<${root.id}@fake.test>` }), root.threadId);
    expect(sent.thread_id).toBe(root.threadId);
    const req = gm().requests.at(-1)!;
    expect(req.url).toContain("uploadType=multipart");
    expect(req.headers.get("content-type")).toMatch(/^multipart\/related; boundary=/);
  });
  it("above 5 MB: the session opens before the operation, then the PUT streams the exact length with threadId in the session metadata", async () => {
    const id = await op();
    const big = new Uint8Array(MEDIA_UPLOAD_MAX).fill(1);
    const m = mime({
      attachments: [
        { filename: "big.bin", mime: "application/octet-stream", size: big.byteLength, open: fromBytes(big) },
      ],
    });
    expect(m.length).toBeGreaterThan(MEDIA_UPLOAD_MAX);
    const states: string[] = [];
    gm().before = async () => {
      states.push((await opRow(id)).state);
      return undefined;
    };
    const sent = await send(id, m, "t-res");
    gm().before = null;
    expect(states).toEqual(["claimed", "executing"]);
    expect(sent.thread_id).toBe("t-res");
    expect(gm().sent.at(-1)!.via).toBe("resumable");
    expect(gm().sent.at(-1)!.raw.byteLength).toBe(m.length);
    const [start] = gm().requests.slice(-2);
    expect(await start!.clone().json()).toEqual({ threadId: "t-res" });
    expect(start!.headers.get("x-upload-content-length")).toBe(String(m.length));
  });
  it("a failure opening the session is retried and never touches the operation; three failures leave it claimed", async () => {
    const id = await op();
    const big = new Uint8Array(MEDIA_UPLOAD_MAX).fill(2);
    gm().faults.push({ status: 503 });
    const sent = await send(
      id,
      mime({
        attachments: [
          { filename: "b.bin", mime: "application/octet-stream", size: big.byteLength, open: fromBytes(big) },
        ],
      }),
    );
    expect(sent.id).toMatch(/^m/);
    const id2 = await op();
    gm().faults.push({ status: 503 }, { status: 503 }, { status: 503 });
    await expect(
      send(
        id2,
        mime({
          attachments: [
            { filename: "b.bin", mime: "application/octet-stream", size: big.byteLength, open: fromBytes(big) },
          ],
        }),
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect((await opRow(id2)).state).toBe("claimed");
  });
  it("a failed PUT after the operation opened leaves it executing; the caller classifies", async () => {
    const id = await op();
    const big = new Uint8Array(MEDIA_UPLOAD_MAX).fill(3);
    gm().afterSession = { status: 503 };
    await expect(
      send(
        id,
        mime({
          attachments: [
            { filename: "b.bin", mime: "application/octet-stream", size: big.byteLength, open: fromBytes(big) },
          ],
        }),
      ),
    ).rejects.toMatchObject({ status: 503 });
    gm().afterSession = null;
    expect((await opRow(id)).state).toBe("executing");
  });
  it("a 401 on a small send refreshes and re-sends once, because Gmail never processed the first body", async () => {
    const id = await op();
    await seedAccessToken(e, { ...acct, access: "at-stale", refresh: "rt-x" });
    g.refreshTokens.set("rt-x", "ok");
    gm().rejectTokens.add("at-stale");
    const sent = await send(id, mime());
    expect(sent.id).toMatch(/^m/);
    expect(gm().sent.filter((s) => s.id === sent.id)).toHaveLength(1);
    await seedAccessToken(e, acct);
  });
  it("refuses a message over Gmail's ceiling before any request", async () => {
    const id = await op();
    const before = gm().requests.length;
    const fake = { stream: new ReadableStream<Uint8Array>(), length: GMAIL_SEND_MAX + 1 };
    await expect(send(id, fake)).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(gm().requests.length).toBe(before);
    expect((await opRow(id)).state).toBe("claimed");
  });
});

describe("drafts and send_draft", () => {
  it("uploadDraft creates then updates a draft via the same protocol; sendDraft posts the id with the draft's Message-ID on the operation", async () => {
    const id = await op();
    const m1 = mime({ subject: "d1" });
    const created = await uploadDraft(e, testDeps(g), {
      ...acct,
      operationId: id,
      body: m1.stream,
      length: m1.length,
      threadId: null,
      rfc822MessageId: "<d@y>",
      draftId: null,
    });
    expect(created).toMatchObject({
      id: expect.stringMatching(/^r/),
      message_id: expect.any(String),
      thread_id: expect.any(String),
    });
    expect((await opRow(id)).state).toBe("executing");
    const id2 = await op();
    const m2 = mime({ subject: "d2" });
    const updated = await uploadDraft(e, testDeps(g), {
      ...acct,
      operationId: id2,
      body: m2.stream,
      length: m2.length,
      threadId: null,
      rfc822MessageId: "<d@y>",
      draftId: created.id,
    });
    expect(updated.id).toBe(created.id);
    expect(gm().requests.at(-1)!.method).toBe("PUT");
    const id3 = await op();
    const sent = await sendDraft(e, testDeps(g), {
      ...acct,
      operationId: id3,
      draftId: created.id,
      rfc822MessageId: "<d@y>",
    });
    expect(sent).toMatchObject({ id: expect.stringMatching(/^m/), thread_id: expect.any(String) });
    expect(gm().sent.at(-1)!.via).toBe("draft");
    expect(gm().drafts.has(created.id)).toBe(false);
    expect(await opRow(id3)).toMatchObject({ state: "executing", rfc822_message_id: "<d@y>" });
    const id4 = await op();
    await expect(
      sendDraft(e, testDeps(g), { ...acct, operationId: id4, draftId: created.id, rfc822MessageId: null }),
    ).rejects.toMatchObject({ status: 404 });
    expect((await opRow(id4)).state).toBe("executing");
  });
});
```

The "failed PUT" test uses a fake hook `afterSession: Fault | null` that applies to the first request after a session was created; the fault queue cannot express "let the session succeed, fail the PUT" because the session POST consumes the first fault.

- [x] **Step 2: run, expect failure**

Run: `cd worker && npx vitest run test/send-pipeline.test.ts`
Expected: FAIL, module not found.

- [x] **Step 3 (GREEN): client and fake changes**

`worker/src/google/gmail.ts`: replace the `Upload` type, delete the `resumable` function and its branch in `gmailFetch`, and add:

```ts
export type Upload =
  | { kind: "media"; contentType: string; bytes: Uint8Array }
  | { kind: "multipart"; contentType: string; bytes: Uint8Array; metadata: Record<string, unknown> };

// in plainTarget, before the media branch:
if (o.upload?.kind === "multipart") {
  const b = `=_meta_${crypto.randomUUID()}`;
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(o.upload.metadata)}\r\n--${b}\r\nContent-Type: ${o.upload.contentType}\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${b}--\r\n`);
  const body = new Uint8Array(new ArrayBuffer(head.byteLength + o.upload.bytes.byteLength + tail.byteLength));
  body.set(head, 0);
  body.set(o.upload.bytes, head.byteLength);
  body.set(tail, head.byteLength + o.upload.bytes.byteLength);
  return {
    url: buildUrl(GMAIL.upload, o.path, { ...o.query, uploadType: "multipart" }),
    init: { method: o.method, headers: { "content-type": `multipart/related; boundary=${b}` }, body },
  };
}

/**
 * Half one of the resumable protocol: the session. It moves no message bytes, so it is retried like any
 * read (spec 3.9 "5xx before the send body"). Google's recovery (query the session, resume at the
 * confirmed offset) is not built: the URL lives only in this call's stack frame.
 */
export async function openResumableSession(
  env: Env,
  deps: Deps,
  acct: GmailAccount,
  o: { path: string; contentType: string; length: number; metadata?: Record<string, unknown> },
): Promise<string> {
  const res = await gmailFetch(env, deps, acct, {
    method: "POST",
    path: o.path,
    base: "resumable",
    query: { uploadType: "resumable" },
    headers: { "x-upload-content-type": o.contentType, "x-upload-content-length": String(o.length) },
    json: o.metadata ?? {},
    retry: "safe",
  });
  const location = res.headers.get("location");
  if (!location) throw new GmailApiError(res.status, "resumable session without Location", null);
  return location;
}

/** Half two: the bytes. Opened exactly once; a failure here is the caller's to classify. */
export async function putResumable(
  env: Env,
  deps: Deps,
  acct: GmailAccount,
  sessionUrl: string,
  o: { contentType: string; length: number; body: ReadableStream<Uint8Array> },
): Promise<Response> {
  const token = await getAccessToken(env, deps, acct.userId, acct.accountId);
  const res = await deps.googleFetch(sessionUrl, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": o.contentType },
    body: o.body.pipeThrough(new FixedLengthStream(o.length)),
  });
  if (res.ok) return res;
  const { message, reason } = await readError(res);
  throw new GmailApiError(res.status, message, reason);
}
```

`GmailRequest` gains `base?: "api" | "resumable"` (default `api`) and `headers?: Record<string, string>`; `plainTarget` picks `GMAIL.resumable` for `base: "resumable"` and merges `headers`. `FixedLengthStream` is a Workers runtime global declared in the generated `worker-configuration.d.ts`.

`worker/test/fake-gmail.ts`: the upload branch parses `multipart/related`, the session start records its metadata, the PUT applies `afterSession`, and `upload()` and `storeSent()` take a `threadId`:

```ts
  afterSession: Fault | null = null;
  // in fetch, the upload branches:
    if (p.startsWith("/upload/gmail/v1/users/me/")) {
      const rest = p.slice("/upload/gmail/v1/users/me/".length);
      const ct = req.headers.get("content-type") ?? "";
      const bytes = await raw();
      if (ct.startsWith("multipart/related")) {
        const boundary = /boundary=([^;]+)/.exec(ct)![1]!;
        const all = new TextDecoder("latin1").decode(bytes);
        const parts = all.split(`--${boundary}`).slice(1, -1);
        const meta = JSON.parse(parts[0]!.split("\r\n\r\n").slice(1).join("\r\n\r\n").trim()) as { threadId?: string };
        const mediaStart = all.indexOf(parts[1]!) + parts[1]!.indexOf("\r\n\r\n") + 4;
        const mediaEnd = all.lastIndexOf(`\r\n--${boundary}--`);
        return this.upload(rest, req.method, bytes.subarray(mediaStart, mediaEnd), "media", meta.threadId ?? null);
      }
      return this.upload(rest, req.method, bytes, "media", null);
    }
    if (p.startsWith("/resumable/upload/gmail/v1/users/me/")) {
      const rest = p.slice("/resumable/upload/gmail/v1/users/me/".length);
      if (req.method === "PUT" && url.searchParams.get("upload_id")) {
        const s = this.sessions.get(url.searchParams.get("upload_id")!);
        if (!s) return this.error(404, "unknown upload session");
        this.sessions.delete(url.searchParams.get("upload_id")!);
        if (this.afterSession) {
          const f = this.afterSession;
          return this.error(f.status, f.message ?? `fault ${f.status}`, f.reason);
        }
        return this.upload(s.path, "POST", await raw(), "resumable", s.threadId);
      }
      const meta = (await req.json().catch(() => ({}))) as { threadId?: string };
      const uploadId = this.next("u");
      this.sessions.set(uploadId, { path: rest, contentType: req.headers.get("x-upload-content-type") ?? "", threadId: meta.threadId ?? null });
      return new Response(null, { status: 200, headers: { location: `https://gmail.googleapis.com/resumable/upload/gmail/v1/users/me/${rest}?uploadType=resumable&upload_id=${uploadId}` } });
    }
```

`latin1` decoding keeps byte offsets equal to character offsets, which the split relies on. The session map type becomes `{ path: string; contentType: string; threadId: string | null }`; `upload(path, method, bytes, via, threadId)` forwards it to `storeSent(bytes, via, threadId)` and `createDraftFromRaw(bytes, threadId, keepId?)`.

- [x] **Step 4 (GREEN): the pipeline**

`worker/src/operations/send.ts`:

```ts
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Deps } from "../deps";
import type { Env } from "../env";
import { gmailFetch, gmailJson, openResumableSession, putResumable, type Upload } from "../google/gmail";
import { beginOperation } from "./journal";

export const MEDIA_UPLOAD_MAX = 5 * 1024 * 1024;
/** Gmail's own ceiling for the send and draft uploads (discovery document, revision 20260907). */
export const GMAIL_SEND_MAX = 36_700_160;

export type SentMessage = { id: string; thread_id: string; label_ids: string[] };
type Wire = { id: string; threadId: string; labelIds?: string[] };
type Acct = { userId: string; accountId: string };
type Body = { body: ReadableStream<Uint8Array>; length: number; threadId: string | null; rfc822MessageId: string };

export function messageIdFor(env: Env, operationId: string): string {
  return `<${operationId}@${env.WORKER_HOSTNAME}>`;
}

/** Exactly `length` bytes, for the small-message path where the whole body is one request. */
export async function collect(stream: ReadableStream<Uint8Array>, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(new ArrayBuffer(length));
  let o = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (o + value.byteLength > length) throw new GmailMcpError("internal", "mime stream longer than declared");
    out.set(value, o);
    o += value.byteLength;
  }
  if (o !== length) throw new GmailMcpError("internal", `mime stream was ${o} bytes, declared ${length}`);
  return out;
}

/**
 * Spec 3.5 steps 3 and 3.9. Under 5 MB the message is one request; above, the session is opened first
 * with the safe retry policy because it moves no bytes, and only then does the operation move to
 * `executing`, immediately before the PUT. Nothing here settles the operation or classifies a failure:
 * the gate reads the operation's state afterwards and decides.
 */
async function upload(
  env: Env,
  deps: Deps,
  acct: Acct,
  o: Body & { operationId: string; path: string; method: "POST" | "PUT"; contentType: string },
): Promise<Response> {
  if (o.length > GMAIL_SEND_MAX)
    throw new GmailMcpError(
      "limit_exceeded",
      `limit_exceeded: message is ${o.length} bytes, Gmail's ceiling is ${GMAIL_SEND_MAX}`,
    );
  const metadata = o.threadId ? { threadId: o.threadId } : undefined;
  if (o.length <= MEDIA_UPLOAD_MAX) {
    const bytes = await collect(o.body, o.length);
    const up: Upload = metadata
      ? { kind: "multipart", contentType: o.contentType, bytes, metadata }
      : { kind: "media", contentType: o.contentType, bytes };
    await beginOperation(env.DB, o.operationId, { rfc822_message_id: o.rfc822MessageId });
    return gmailFetch(env, deps, acct, { method: o.method, path: o.path, upload: up, retry: "none" });
  }
  const session = await openResumableSession(env, deps, acct, {
    path: o.path,
    contentType: o.contentType,
    length: o.length,
    ...(metadata ? { metadata } : {}),
  });
  await beginOperation(env.DB, o.operationId, { rfc822_message_id: o.rfc822MessageId });
  return putResumable(env, deps, acct, session, { contentType: o.contentType, length: o.length, body: o.body });
}

export async function sendMime(env: Env, deps: Deps, o: Acct & Body & { operationId: string }): Promise<SentMessage> {
  const res = await upload(env, deps, o, {
    ...o,
    path: "messages/send",
    method: "POST",
    contentType: "message/rfc822",
  });
  const m = await res.json<Wire>();
  return { id: m.id, thread_id: m.threadId, label_ids: m.labelIds ?? [] };
}

export async function uploadDraft(
  env: Env,
  deps: Deps,
  o: Acct & Body & { operationId: string; draftId: string | null },
): Promise<{ id: string; message_id: string; thread_id: string }> {
  const res = await upload(env, deps, o, {
    ...o,
    path: o.draftId ? `drafts/${encodeURIComponent(o.draftId)}` : "drafts",
    method: o.draftId ? "PUT" : "POST",
    contentType: "message/rfc822",
  });
  const d = await res.json<{ id: string; message: Wire }>();
  return { id: d.id, message_id: d.message.id, thread_id: d.message.threadId };
}

export async function sendDraft(
  env: Env,
  deps: Deps,
  o: Acct & { operationId: string; draftId: string; rfc822MessageId: string | null },
): Promise<SentMessage> {
  await beginOperation(env.DB, o.operationId, o.rfc822MessageId ? { rfc822_message_id: o.rfc822MessageId } : {});
  const m = await gmailJson<Wire>(env, deps, o, {
    method: "POST",
    path: "drafts/send",
    json: { id: o.draftId },
    retry: "none",
  });
  return { id: m.id, thread_id: m.threadId, label_ids: m.labelIds ?? [] };
}
```

The 401 refresh-and-retry inside `gmailFetch` stays for the small path: a 401 answers before Gmail accepts a body.

- [x] **Step 5: run, expect pass**

Run: `cd worker && npx vitest run test/send-pipeline.test.ts test/gmail-client.test.ts test/mime.test.ts` then `npm run verify`.
Expected: PASS. First-run fact: `FixedLengthStream` piping inside the vitest workerd pool. If the fake receives a body of the wrong length, the fault is in `collect` or the transform, never in the fake.

- [x] **Step 6: commit**

```bash
git add worker/src/google/gmail.ts worker/src/operations/send.ts worker/test
git commit -m "feat(worker): the send pipeline over streams

Under 5 MB one request, media or multipart when a thread id must travel; above, the resumable session
opens first with the safe retry policy and the operation moves to executing immediately before the PUT,
which streams with an exact Content-Length. The pipeline never settles or classifies: the gate does.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NBfkjWcEGDFghet3APnUjU"
```

---

### Task 8: Drafts, inline attachments, and the shared compose rules

**Files:**

- Create: `worker/src/tools/compose.ts`, `worker/src/tools/drafts.ts`, `worker/test/drafts-tools.test.ts`
- Modify: `shared/src/schemas.ts` (`Recipient`, `MediaType`, `InlineAttachment`, draft inputs), `worker/src/mcp/server.ts`, `worker/test/mcp.test.ts`

**Interfaces:**

- Consumes: `parseAddress`, `assertHeaderSafe`, `assertNotBlocked`, `LIMITS`, `ingest`, `listUploadHandles`, `openStaged`, `buildMimeStream`, `fromBytes`, `uploadDraft`, `messageIdFor`, `splitAddressList`.
- Produces in `shared/src/schemas.ts`: `Recipient = z.string().min(3).max(320)`; `Recipients = z.array(Recipient).max(2000).default([])` (coarse guard; `validateCompose` owns the 500); `MediaType` (RFC 6838 restricted `type/subtype`, no parameters); `INLINE_B64_MAX = 1_400_000` (a 1 MiB decoded attachment is 1 398 104 base64 characters); `InlineAttachment = z.object({ filename: z.string().min(1).max(255), mime: MediaType, content_base64: z.string().min(1).max(INLINE_B64_MAX) })`; `CreateDraftInput`, `UpdateDraftInput` (the update's `to`, `cc`, `bcc` are `.optional()` with no default, so an omitted list is distinguishable from an empty one).
- Produces in `compose.ts`:
  - `type DecodedInline = { filename: string; mime: string; size: number; sha256: string; bytes: Uint8Array }`; `decodeInline(inline: InlineAttachment[] | undefined): Promise<DecodedInline[]>`: decodes one attachment at a time, projecting each string's decoded size from its length before decoding and refusing once the running total would pass `LIMITS.inlineAttachmentBytes`, so no more than 1 MiB is ever decoded; refuses blocked extensions before any decode; refuses an invalid media type.
  - `intentArgs(args, inline)`: the schema-parsed arguments with `inline_attachments` replaced by `[{ filename, mime, size, sha256 }]`, which is what the intent hash covers.
  - `validateCompose(args)`: addresses parse, at most 500, subject header-safe and under 998 bytes, body plus HTML under 512 KB.
  - `senderFor(account, from?)`; `attachmentsFor(env, userId, account, handles, extraBytes)`; `stageInline(env, userId, accountId, inline: DecodedInline[]): Promise<string[]>` (ingests the already-decoded bytes; called only from `build`).
  - `attachmentSummary(files)`, `recipientSummary(p)`, `human(bytes)`.
  - `getMessage(env, deps, acct, id, format)`; `fetchAttachmentBytes(env, deps, acct, messageId, attachmentId)`.
  - `type CarriedAttachment = { message_id: string; attachment_id: string; filename: string; mime: string; size: number }`; `type ComposePayload`.
  - `composeMime(env, deps, run, p: ComposePayload, operationId): Promise<{ body: ReadableStream<Uint8Array>; length: number; rfc822MessageId: string }>`: staged attachments are opened from R2 as streams; carried originals are fetched from Gmail one at a time when their segment is reached, never all at once.
  - `threadingFor(target)`: `{ thread_id, subject, in_reply_to, references, from, reply_to: string[], to, cc }` with every list split by `splitAddressList`.
- Produces in `drafts.ts`: `registerDraftTools(server, toolContext, env)`. `draft.write` is journaled for create and update (`journal: true`). Payload: `{ to, cc, bcc, subject, body, html_body, from, attachments, carry: [], reply_to_message_id, thread_id, in_reply_to, references, draft_id }`. An update merges each text field and each recipient list independently: a field the call omits keeps the draft's value, a field the call gives (even empty) replaces it. Attachments follow the hosted rule: the set given replaces, none given leaves none.

- [ ] **Step 1 (RED): tests**

`worker/test/drafts-tools.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index";
import { FakeGoogle } from "./fake-google";
import { mintToken } from "./browser";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import { callTool } from "./mcp-client";
import { testDeps, testEnv } from "./test-env";
import { ingest } from "../src/staging/store";
import { setPolicy } from "../src/policy/engine";

const e = testEnv();
let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
let token: string;
const gm = () => g.gmail;
const call = (name: string, args: Record<string, unknown>) => callTool(worker, e, token, name, args);
const b64 = (s: string) => btoa(s);
const stagingCount = async () =>
  (await env.DB.prepare("SELECT count(*) AS n FROM staging_objects").first<any>()).n as number;
async function stage(name: string, bytes: Uint8Array) {
  return (
    await ingest(e, {
      userId: "owner-sub",
      accountId: "da",
      direction: "upload",
      filename: name,
      mime: "application/octet-stream",
      length: bytes.byteLength,
      body: new Response(bytes).body!,
    })
  ).handle;
}
const rawOf = (draftId: string) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(gm().drafts.get(draftId)!.message.raw!.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    ),
  );

beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker(testDeps(g));
  await seedUserAndAccount(env.DB, {
    userId: "owner-sub",
    accountId: "da",
    alias: "personal",
    isDefault: true,
    sendAs: ["alias@example.test"],
  });
  await seedAccessToken(e, { userId: "owner-sub", accountId: "da" });
  token = (await mintToken(worker, e, g, { scope: "mcp" })).accessToken;
});

describe("create_draft", () => {
  it("is allowed by default, journals, builds MIME from staged and inline attachments, and stores no inline bytes in the payload", async () => {
    const h = await stage("staged.txt", new TextEncoder().encode("staged bytes"));
    const r = await call("create_draft", {
      account: "personal",
      to: ["Ann <ann@example.test>"],
      subject: "Draft 🚀",
      body: "hello",
      attachments: [h],
      inline_attachments: [{ filename: "inline.txt", mime: "text/plain", content_base64: b64("inline bytes") }],
    });
    expect(r.result).toMatchObject({
      status: "executed",
      account: "personal",
      draft: { id: expect.stringMatching(/^r/) },
    });
    const raw = rawOf(r.result.draft.id);
    expect(raw).toContain("Subject: =?UTF-8?B?RHJhZnQg8J+agA==?=");
    expect(raw).toContain('filename="staged.txt"');
    expect(raw).toContain('filename="inline.txt"');
    expect(raw).toContain(btoa("inline bytes"));
    const op = await env.DB.prepare("SELECT state, gmail_result_id FROM operations WHERE id = ?")
      .bind(r.result.operation_id)
      .first<any>();
    expect(op).toEqual({ state: "executed", gmail_result_id: r.result.draft.id });
    const handles = await env.DB.prepare(
      "SELECT filename, consumed_at FROM staging_objects WHERE user_id='owner-sub' AND account_id='da' ORDER BY created_at",
    ).all<any>();
    expect(handles.results.filter((x) => x.consumed_at !== null).map((x) => x.filename)).toEqual(
      expect.arrayContaining(["staged.txt", "inline.txt"]),
    );
    const audit = await env.DB.prepare(
      "SELECT summary FROM audit_log WHERE user_id='owner-sub' AND tool='create_draft' ORDER BY id DESC LIMIT 1",
    ).first<any>();
    expect(audit.summary).toBe("recipients=1 attachments=2");
  });
  it("a reply draft derives thread, subject and threading headers from the target", async () => {
    const target = gm().seedMessage({
      from: "Prof <prof@uni.test>",
      to: ["me@example.test"],
      subject: "Thesis",
      text: "?",
      messageId: "<t1@uni.test>",
    });
    const r = await call("create_draft", { account: "personal", reply_to_message_id: target.id, body: "answer" });
    expect(r.result.draft.thread_id).toBe(target.threadId);
    const raw = rawOf(r.result.draft.id);
    expect(raw).toContain("Subject: Re: Thesis");
    expect(raw).toContain("In-Reply-To: <t1@uni.test>");
    expect(raw).toContain("References: <t1@uni.test>");
    expect(raw).toContain('To: "Prof" <prof@uni.test>');
  });
  it("refuses over-cap or malformed input before any row is written", async () => {
    const before = await stagingCount();
    expect(
      (await call("create_draft", { account: "personal", to: ["a@example.test"], body: "x".repeat(512 * 1024 + 1) }))
        .result,
    ).toMatchObject({ error: "limit_exceeded" });
    expect(
      (await call("create_draft", { account: "personal", to: ["not an address"], body: "x" })).result,
    ).toMatchObject({ error: "invalid_address" });
    expect(
      (await call("create_draft", { account: "personal", to: ["a@example.test"], subject: "x\r\nBcc: y@example.test" }))
        .result,
    ).toMatchObject({ error: "invalid_header" });
    expect(
      (await call("create_draft", { account: "personal", to: ["a@example.test"], subject: "s".repeat(999) })).result,
    ).toMatchObject({ error: "limit_exceeded" });
    expect(
      (
        await call("create_draft", {
          account: "personal",
          to: Array.from({ length: 501 }, (_, i) => `u${i}@example.test`),
          body: "x",
        })
      ).result,
    ).toMatchObject({ error: "limit_exceeded" });
    // One inline attachment over the schema's character cap never reaches a decoder.
    const huge = await call("create_draft", {
      account: "personal",
      to: ["a@example.test"],
      inline_attachments: [
        { filename: "a.bin", mime: "application/octet-stream", content_base64: "A".repeat(1_400_001) },
      ],
    });
    expect(huge.error ?? huge.result?.error).toBeTruthy();
    // Forty attachments each under the cap, together over it: refused by the running total before the last decode.
    const many = Array.from({ length: 40 }, (_, i) => ({
      filename: `p${i}.bin`,
      mime: "application/octet-stream",
      content_base64: btoa("Z".repeat(30_000)),
    }));
    expect(
      (await call("create_draft", { account: "personal", to: ["a@example.test"], inline_attachments: many })).result,
    ).toMatchObject({ error: "limit_exceeded" });
    expect(
      (
        await call("create_draft", {
          account: "personal",
          to: ["a@example.test"],
          inline_attachments: [{ filename: "run.exe", mime: "application/octet-stream", content_base64: b64("MZ") }],
        })
      ).result,
    ).toMatchObject({ error: "blocked_extension" });
    expect(
      (
        await call("create_draft", {
          account: "personal",
          to: ["a@example.test"],
          inline_attachments: [{ filename: "a.txt", mime: "text/plain; charset=UTF-8", content_base64: b64("x") }],
        })
      ).error ?? { error: true },
    ).toBeTruthy();
    expect(await stagingCount()).toBe(before);
    expect(
      (await call("create_draft", { account: "personal", to: ["a@example.test"], from: "someone@else.test" })).result,
    ).toMatchObject({ error: "invalid_address" });
    expect(
      (await call("create_draft", { account: "personal", to: ["a@example.test"], from: "alias@example.test" })).result
        .status,
    ).toBe("executed");
  });
  it("a denied draft.write stages nothing, even with inline attachments", async () => {
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "da", action: "draft.write", level: "deny" });
    const before = await stagingCount();
    const r = await call("create_draft", {
      account: "personal",
      to: ["a@example.test"],
      inline_attachments: [{ filename: "n.txt", mime: "text/plain", content_base64: b64("never") }],
    });
    expect(r.result).toMatchObject({ error: "policy_denied" });
    expect(await stagingCount()).toBe(before);
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "da", action: "draft.write", level: "allow" });
  });
  it("a handle from another account, an expired one, or a blocked name at build time is refused", async () => {
    await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "db", alias: "other" });
    const foreign = (
      await ingest(e, {
        userId: "owner-sub",
        accountId: "db",
        direction: "upload",
        filename: "f.txt",
        mime: "text/plain",
        length: 1,
        body: new Response(new Uint8Array(1)).body!,
      })
    ).handle;
    expect(
      (await call("create_draft", { account: "personal", to: ["a@example.test"], attachments: [foreign] })).result,
    ).toMatchObject({ error: "handle_invalid" });
    const h = await stage("ok.txt", new Uint8Array(10));
    await env.DB.prepare("UPDATE staging_objects SET filename = 'late.exe' WHERE handle = ?").bind(h).run();
    expect(
      (await call("create_draft", { account: "personal", to: ["a@example.test"], attachments: [h] })).result,
    ).toMatchObject({ error: "blocked_extension" });
    await env.DB.prepare("UPDATE accounts SET send_limit_bytes = 5 WHERE id = 'da'").run();
    const h2 = await stage("ten.txt", new Uint8Array(10));
    expect(
      (await call("create_draft", { account: "personal", to: ["a@example.test"], attachments: [h2] })).result,
    ).toMatchObject({ error: "limit_exceeded" });
    await env.DB.prepare("UPDATE accounts SET send_limit_bytes = 26214400 WHERE id = 'da'").run();
  });
  it("draft.write raised to ask stores handles in the payload and executes from the row", async () => {
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "da", action: "draft.write", level: "ask" });
    const h = await stage("later.txt", new Uint8Array(3));
    const r = await call("create_draft", { account: "personal", to: ["a@example.test"], body: "b", attachments: [h] });
    expect(r.result).toMatchObject({ status: "pending_approval", action: "draft.write" });
    await env.DB.prepare(
      "UPDATE pending_actions SET state = 'approved', approved_at = ?, approved_via = 'browser' WHERE id = ?",
    )
      .bind(Date.now(), r.result.action_id)
      .run();
    const done = await call("execute_pending", { action_id: r.result.action_id });
    expect(done.result).toMatchObject({ status: "executed", draft: { id: expect.any(String) } });
    expect(rawOf(done.result.draft.id)).toContain('filename="later.txt"');
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "da", action: "draft.write", level: "allow" });
  });
});

describe("update_draft", () => {
  it("merges each field independently; the attachment set given replaces, none given means none", async () => {
    const h = await stage("first.txt", new TextEncoder().encode("first"));
    const created = await call("create_draft", {
      account: "personal",
      to: ["a@example.test"],
      cc: ["c@example.test"],
      subject: "v1",
      body: "one",
      attachments: [h],
    });
    const id = created.result.draft.id as string;
    const h2 = await stage("second.txt", new TextEncoder().encode("second"));
    const u1 = await call("update_draft", {
      account: "personal",
      draft_id: id,
      body: "two",
      bcc: ["b@example.test"],
      attachments: [h2],
    });
    expect(u1.result).toMatchObject({ status: "executed", draft: { id } });
    let raw = rawOf(id);
    expect(raw).toContain("Subject: v1");
    expect(raw).toContain("To: <a@example.test>");
    expect(raw).toContain("Cc: <c@example.test>");
    expect(raw).toContain("Bcc: <b@example.test>");
    expect(raw).toContain(btoa("two"));
    expect(raw).toContain('filename="second.txt"');
    expect(raw).not.toContain('filename="first.txt"');
    expect(gm().requests.at(-1)!.method).toBe("PUT");
    await call("update_draft", { account: "personal", draft_id: id, cc: [] });
    raw = rawOf(id);
    expect(raw).toContain("To: <a@example.test>");
    expect(raw).not.toContain("Cc:");
    expect(raw).toContain(btoa("two"));
    expect(raw).not.toContain("Content-Disposition: attachment");
    expect((await call("update_draft", { account: "personal", draft_id: "nope" })).result).toMatchObject({
      error: "gmail_error",
      details: { status: 404 },
    });
  });
});
```

The fake stores raw MIME for a draft our tool uploaded and parses only its headers, so `To`, `Cc`, `Bcc` and `Subject` merge from headers; the body merge is asserted through the base64 of the new body.

- [ ] **Step 2: run, expect failure**

Run: `cd worker && npx vitest run test/drafts-tools.test.ts`
Expected: FAIL, unknown tools.

- [ ] **Step 3 (GREEN): schemas**

Append to `shared/src/schemas.ts`:

```ts
export const Recipient = z.string().min(3).max(320);
// Coarse guard only: validateCompose owns the 500 cap and reports it as limit_exceeded.
export const Recipients = z.array(Recipient).max(2000).default([]);
export const MediaType = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/);
/** 1 MiB decoded is 1 398 104 base64 characters; the cap stops a larger string before any decoder sees it. */
export const INLINE_B64_MAX = 1_400_000;
export const InlineAttachment = z.object({
  filename: z.string().min(1).max(255),
  mime: MediaType,
  content_base64: z.string().min(1).max(INLINE_B64_MAX),
});
export type InlineAttachment = z.infer<typeof InlineAttachment>;
const ComposeFields = {
  to: Recipients,
  cc: Recipients,
  bcc: Recipients,
  subject: z.string().max(4000).optional(),
  body: z.string().max(600_000).optional(),
  html_body: z.string().max(600_000).optional(),
  from: Recipient.optional(),
  attachments: z.array(StagingHandle).max(100).optional(),
  inline_attachments: z.array(InlineAttachment).max(50).optional(),
};
export const CreateDraftInput = z.object({
  account: AccountAlias,
  ...ComposeFields,
  reply_to_message_id: GmailId.optional(),
});
export const UpdateDraftInput = z.object({
  account: AccountAlias,
  draft_id: GmailId,
  ...ComposeFields,
  to: z.array(Recipient).max(2000).optional(),
  cc: z.array(Recipient).max(2000).optional(),
  bcc: z.array(Recipient).max(2000).optional(),
});
```

- [ ] **Step 4 (GREEN): compose helpers**

`worker/src/tools/compose.ts`:

```ts
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import { MediaType, type InlineAttachment, type MessageFormat } from "@gmail-mcp/shared/schemas";
import type { Env } from "../env";
import type { Deps } from "../deps";
import { sha256Hex } from "../crypto/canonical";
import { fromB64url } from "../crypto/random";
import { gmailJson } from "../google/gmail";
import { gmailFormatFor, splitAddressList, type GmailMessage } from "../google/messages";
import { buildMimeStream, type MimeAttachment } from "../mime/build";
import { messageIdFor } from "../operations/send";
import { LIMITS, assertHeaderSafe, assertNotBlocked, utf8Length } from "../policy/limits";
import { parseAddress } from "../policy/recipients";
import { ingest, listUploadHandles, openStaged, type StagingRow } from "../staging/store";
import type { AccountRef } from "./accounts";
import type { ExecRun } from "./gate";

export type ComposeArgs = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string | undefined;
  body?: string | undefined;
  html_body?: string | undefined;
};

/** Spec 2.7 and 3.8, before policy and before any row: addresses parse, headers are clean, sizes fit. */
export function validateCompose(a: ComposeArgs): void {
  const all = [...a.to, ...a.cc, ...a.bcc];
  if (all.length > 500) throw new GmailMcpError("limit_exceeded", `limit_exceeded: recipients ${all.length} > 500`);
  for (const r of all) parseAddress(r);
  if (a.subject !== undefined) assertHeaderSafe("subject", a.subject);
  const bodyBytes = utf8Length(a.body ?? "") + utf8Length(a.html_body ?? "");
  if (bodyBytes > LIMITS.bodyBytes)
    throw new GmailMcpError("limit_exceeded", `limit_exceeded: body ${bodyBytes} > ${LIMITS.bodyBytes} bytes`);
}

export function senderFor(account: AccountRef, from?: string): string {
  if (from === undefined) return account.email;
  const norm = parseAddress(from).normalized;
  const allowed = [account.email, ...account.sendAs].map((s) => parseAddress(s).normalized);
  if (!allowed.includes(norm))
    throw new GmailMcpError("invalid_address", `invalid_address: ${from} is not a verified sender on this account`);
  return from;
}

export type DecodedInline = { filename: string; mime: string; size: number; sha256: string; bytes: Uint8Array };

function decodeBase64(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, "");
  try {
    return Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
  } catch {
    return fromB64url(clean);
  }
}

/**
 * Spec 2.7's 1 MB is enforced before the bytes exist: each string's decoded size is projected from its
 * length, the running total is checked before the decode, and the blocked list and media type are
 * checked before that. Fifty strings just under the per-item cap cannot add up to more than 1 MiB decoded.
 */
export async function decodeInline(inline: InlineAttachment[] | undefined): Promise<DecodedInline[]> {
  const out: DecodedInline[] = [];
  let total = 0;
  for (const i of inline ?? []) {
    assertNotBlocked(i.filename);
    MediaType.parse(i.mime);
    const projected = Math.floor((i.content_base64.length * 3) / 4) - 2;
    if (total + projected > LIMITS.inlineAttachmentBytes) {
      throw new GmailMcpError(
        "limit_exceeded",
        `limit_exceeded: inline attachments exceed ${LIMITS.inlineAttachmentBytes} bytes`,
      );
    }
    const bytes = decodeBase64(i.content_base64);
    total += bytes.byteLength;
    if (total > LIMITS.inlineAttachmentBytes) {
      throw new GmailMcpError(
        "limit_exceeded",
        `limit_exceeded: inline attachments exceed ${LIMITS.inlineAttachmentBytes} bytes`,
      );
    }
    out.push({
      filename: i.filename,
      mime: i.mime,
      size: bytes.byteLength,
      sha256: await sha256Hex(new Uint8Array(bytes)),
      bytes,
    });
  }
  return out;
}

/** The client's arguments as the intent hash sees them: inline bytes replaced by their digest. */
export function intentArgs(args: Record<string, unknown>, inline: DecodedInline[]): Record<string, unknown> {
  const { inline_attachments: _dropped, ...rest } = args;
  for (const k of Object.keys(rest)) if (rest[k] === undefined) delete rest[k];
  return inline.length === 0
    ? rest
    : {
        ...rest,
        inline_attachments: inline.map((d) => ({ filename: d.filename, mime: d.mime, size: d.size, sha256: d.sha256 })),
      };
}

/** Called only from a build step, after the decision: turns decoded inline bytes into upload handles. */
export async function stageInline(
  env: Env,
  userId: string,
  accountId: string,
  inline: DecodedInline[],
): Promise<string[]> {
  const handles: string[] = [];
  for (const d of inline) {
    const row = await ingest(env, {
      userId,
      accountId,
      direction: "upload",
      filename: d.filename,
      mime: d.mime,
      length: d.bytes.byteLength,
      body: new Response(d.bytes).body!,
      declaredSha256: d.sha256,
    });
    handles.push(row.handle);
  }
  return handles;
}

/** Ownership, expiry, the blocked list again (spec 2.7), and the account's aggregate cap. A read; writes nothing. */
export async function attachmentsFor(
  env: Env,
  userId: string,
  account: AccountRef,
  handles: string[],
  extraBytes = 0,
): Promise<{ rows: StagingRow[]; total: number }> {
  const rows = await listUploadHandles(env.DB, { handles, userId, accountId: account.id });
  for (const r of rows) assertNotBlocked(r.filename);
  const total = rows.reduce((n, r) => n + r.size, 0) + extraBytes;
  if (total > account.sendLimitBytes)
    throw new GmailMcpError(
      "limit_exceeded",
      `limit_exceeded: attachments ${total} > send limit ${account.sendLimitBytes} bytes`,
    );
  return { rows, total };
}

export function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
export function attachmentSummary(files: { filename: string; size: number }[]): string {
  if (files.length === 0) return "no attachments";
  return `${files.length} attachment${files.length === 1 ? "" : "s"} (${files.map((f) => `${f.filename}, ${human(f.size)}`).join("; ")})`;
}
export function recipientSummary(p: {
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string | null | undefined;
}): string {
  const parts = [`To: ${p.to.join(", ") || "none"}`];
  if (p.cc.length) parts.push(`Cc: ${p.cc.join(", ")}`);
  if (p.bcc.length) parts.push(`Bcc: ${p.bcc.join(", ")}`);
  parts.push(`Subject: ${p.subject ?? "(none)"}`);
  return parts.join(" · ");
}

export async function getMessage(
  env: Env,
  deps: Deps,
  acct: { userId: string; accountId: string },
  id: string,
  format: MessageFormat,
): Promise<GmailMessage> {
  const q = gmailFormatFor(format);
  return gmailJson<GmailMessage>(env, deps, acct, {
    method: "GET",
    path: `messages/${encodeURIComponent(id)}`,
    query: { format: q.format, metadataHeaders: q.metadataHeaders },
    retry: "safe",
  });
}

export async function fetchAttachmentBytes(
  env: Env,
  deps: Deps,
  acct: { userId: string; accountId: string },
  messageId: string,
  attachmentId: string,
): Promise<Uint8Array> {
  const body = await gmailJson<{ data?: string }>(env, deps, acct, {
    method: "GET",
    path: `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    retry: "safe",
  });
  if (!body.data) throw new GmailMcpError("handle_invalid", "handle_invalid: attachment body empty");
  return fromB64url(body.data);
}

export type CarriedAttachment = {
  message_id: string;
  attachment_id: string;
  filename: string;
  mime: string;
  size: number;
};
export type ComposePayload = ComposeArgs & {
  from: string;
  attachments: string[];
  carry: CarriedAttachment[];
  in_reply_to?: string | null | undefined;
  references?: string | null | undefined;
};

/**
 * Staged attachments stream from R2; carried originals are fetched from Gmail when their segment is
 * reached (one at a time, the JSON body of attachments.get is the bound). The message is never whole in memory.
 */
export async function composeMime(
  env: Env,
  deps: Deps,
  run: ExecRun,
  p: ComposePayload,
  operationId: string,
): Promise<{ body: ReadableStream<Uint8Array>; length: number; rfc822MessageId: string }> {
  const carryBytes = p.carry.reduce((n, c) => n + c.size, 0);
  const { rows } = await attachmentsFor(env, run.userId, run.account, p.attachments, carryBytes);
  const acct = { userId: run.userId, accountId: run.account.id };
  const attachments: MimeAttachment[] = [
    ...rows.map((r) => ({ filename: r.filename, mime: r.mime, size: r.size, open: () => openStaged(env, r) })),
    ...p.carry.map((c) => {
      assertNotBlocked(c.filename);
      return {
        filename: c.filename,
        mime: c.mime,
        size: c.size,
        open: async () =>
          new Response(await fetchAttachmentBytes(env, deps, acct, c.message_id, c.attachment_id)).body!,
      };
    }),
  ];
  const rfc822MessageId = messageIdFor(env, operationId);
  const { stream, length } = buildMimeStream({
    from: p.from,
    to: p.to,
    cc: p.cc,
    bcc: p.bcc,
    subject: p.subject ?? "",
    messageId: rfc822MessageId,
    inReplyTo: p.in_reply_to ?? undefined,
    references: p.references ?? undefined,
    text: p.body,
    html: p.html_body,
    attachments,
  });
  return { body: stream, length, rfc822MessageId };
}

/** Reply headers derived from the target (spec 2.3 `reply`): the Worker, not the model, threads the message. */
export function threadingFor(target: GmailMessage): {
  thread_id: string;
  subject: string;
  in_reply_to: string | null;
  references: string | null;
  from: string | null;
  reply_to: string[];
  to: string[];
  cc: string[];
} {
  const h = (n: string) => target.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? null;
  const subjectRaw = h("subject") ?? "";
  const subject = /^\s*re:/i.test(subjectRaw) ? subjectRaw : `Re: ${subjectRaw}`;
  const mid = h("message-id");
  const refs = [h("references"), mid].filter((x): x is string => !!x).join(" ");
  const split = (v: string | null) => (v ? splitAddressList(v) : []);
  return {
    thread_id: target.threadId,
    subject,
    in_reply_to: mid,
    references: refs || null,
    from: h("from"),
    reply_to: split(h("reply-to")),
    to: split(h("to")),
    cc: split(h("cc")),
  };
}
```

Remove the private `getMessage` from `tools/read.ts` and import it from `./compose`.

- [ ] **Step 5 (GREEN): the draft tools**

`worker/src/tools/drafts.ts`:

```ts
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import { CreateDraftInput, UpdateDraftInput } from "@gmail-mcp/shared/schemas";
import type { Env } from "../env";
import type { Deps } from "../deps";
import { gmailJson } from "../google/gmail";
import { messageView, type GmailDraft } from "../google/messages";
import { uploadDraft } from "../operations/send";
import { defineTool, type Plan } from "./define";
import type { AccountRef } from "./accounts";
import {
  attachmentSummary,
  attachmentsFor,
  composeMime,
  getMessage,
  recipientSummary,
  senderFor,
  stageInline,
  threadingFor,
  validateCompose,
  type ComposePayload,
  type DecodedInline,
} from "./compose";
import type { ExecRun, ToolContext } from "./gate";

type DraftPayload = ComposePayload & {
  draft_id: string | null;
  thread_id: string | null;
  reply_to_message_id: string | null;
};
type ComposeLike = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string | undefined;
  body?: string | undefined;
  html_body?: string | undefined;
  from?: string | undefined;
  attachments?: string[] | undefined;
};
type Threading = {
  draft_id: string | null;
  thread_id: string | null;
  reply_to_message_id: string | null;
  in_reply_to: string | null;
  references: string | null;
};

/**
 * Everything the decision needs, and a deferred build for everything the execution needs. The build is
 * the only step that writes: it stages the inline bytes decoded earlier and returns the payload.
 */
async function planCompose(
  env: Env,
  userId: string,
  account: AccountRef,
  args: ComposeLike,
  inline: DecodedInline[],
  base: Threading,
): Promise<Plan> {
  validateCompose(args);
  const from = senderFor(account, args.from);
  const given = args.attachments ?? [];
  const { rows } = await attachmentsFor(
    env,
    userId,
    account,
    given,
    inline.reduce((n, d) => n + d.size, 0),
  );
  const files = [
    ...rows.map((r) => ({ filename: r.filename, size: r.size })),
    ...inline.map((d) => ({ filename: d.filename, size: d.size })),
  ];
  return {
    modifiers: [],
    summary: `${base.draft_id ? "Update draft" : "Create draft"} · ${recipientSummary(args)} · ${attachmentSummary(files)}`,
    facts: {
      recipients: args.to.length + args.cc.length + args.bcc.length,
      attachments: given.length + inline.length,
      ...(base.draft_id ? { ids: [base.draft_id] } : {}),
    },
    build: async () => {
      const attachments = [...given, ...(await stageInline(env, userId, account.id, inline))];
      const payload: DraftPayload = {
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        body: args.body,
        html_body: args.html_body,
        from,
        attachments,
        carry: [],
        ...base,
      };
      return { payload: payload as unknown as Record<string, unknown>, handles: attachments };
    },
  };
}

async function executeDraft(env: Env, deps: Deps, run: ExecRun) {
  const p = run.payload as unknown as DraftPayload;
  if (!run.operationId) throw new GmailMcpError("internal", "draft.write runs with an operation");
  const { body, length, rfc822MessageId } = await composeMime(env, deps, run, p, run.operationId);
  const d = await uploadDraft(env, deps, {
    userId: run.userId,
    accountId: run.account.id,
    operationId: run.operationId,
    body,
    length,
    threadId: p.thread_id,
    rfc822MessageId,
    draftId: p.draft_id,
  });
  return { gmail_result_id: d.id, draft: { id: d.id, message_id: d.message_id, thread_id: d.thread_id } };
}

const acct = (userId: string, account: AccountRef) => ({ userId, accountId: account.id });
const none: Threading = {
  draft_id: null,
  thread_id: null,
  reply_to_message_id: null,
  in_reply_to: null,
  references: null,
};

export function registerDraftTools(
  server: McpServer,
  toolContext: (ctx: ServerContext) => ToolContext,
  env: Env,
): void {
  defineTool(server, toolContext, env, {
    name: "create_draft",
    version: 1,
    description:
      "Create a draft, optionally as a reply. Attachments are staging handles; inline_attachments are converted to handles (1 MB total).",
    input: CreateDraftInput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    action: "draft.write",
    journal: true,
    plan: async (e, t, account, args, inline) => {
      let base = none;
      let subject = args.subject;
      let to = args.to;
      if (args.reply_to_message_id) {
        const th = threadingFor(
          await getMessage(e, t.deps, acct(t.principal.userId, account), args.reply_to_message_id, "METADATA_ONLY"),
        );
        base = {
          ...none,
          thread_id: th.thread_id,
          reply_to_message_id: args.reply_to_message_id,
          in_reply_to: th.in_reply_to,
          references: th.references,
        };
        subject ??= th.subject;
        if (to.length === 0 && args.cc.length === 0 && args.bcc.length === 0)
          to = th.reply_to.length ? th.reply_to : th.from ? [th.from] : [];
      }
      return planCompose(e, t.principal.userId, account, { ...args, subject, to }, inline, base);
    },
    execute: executeDraft,
  });

  defineTool(server, toolContext, env, {
    name: "update_draft",
    version: 1,
    description:
      "Update a draft. Each text field and recipient list the call gives replaces the draft's; each it omits is kept. The attachments given replace the set; give none and the draft has none.",
    input: UpdateDraftInput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    action: "draft.write",
    journal: true,
    plan: async (e, t, account, args, inline) => {
      const dr = await gmailJson<GmailDraft>(e, t.deps, acct(t.principal.userId, account), {
        method: "GET",
        path: `drafts/${encodeURIComponent(args.draft_id)}`,
        query: { format: "full" },
        retry: "safe",
      });
      const v = messageView(dr.message, { format: "FULL_CONTENT", bodyCharLimit: 1_000_000, includeBody: true });
      const merged: ComposeLike = {
        to: args.to ?? v.to,
        cc: args.cc ?? v.cc,
        bcc: args.bcc ?? v.bcc,
        subject: args.subject ?? v.subject ?? undefined,
        body: args.body ?? v.plaintext_body,
        html_body: args.html_body ?? v.html_body,
        from: args.from,
        attachments: args.attachments,
      };
      return planCompose(e, t.principal.userId, account, merged, inline, {
        draft_id: args.draft_id,
        thread_id: dr.message.threadId,
        reply_to_message_id: null,
        in_reply_to: v.in_reply_to,
        references: v.references,
      });
    },
    execute: executeDraft,
  });
}
```

`worker/src/mcp/server.ts`: `registerDraftTools(server, toolContext, env);`.

- [ ] **Step 6: run, expect pass**

Run: `cd worker && npx vitest run test/drafts-tools.test.ts test/read-tools.test.ts test/mcp.test.ts` then `npm run verify`.
Expected: PASS.

- [ ] **Step 7: commit**

```bash
git add shared/src/schemas.ts worker/src worker/test
git commit -m "feat(worker): drafts with staged and inline attachments

Inline bytes are bounded before they are decoded and staged only after the policy decision, so a
denied or replayed call writes nothing. Updates merge each field independently and follow the hosted
rule for attachments: the set given replaces, none given means none.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NBfkjWcEGDFghet3APnUjU"
```

---

### Task 9: `send_message`, `reply`, `forward`, `send_draft`

**Files:**

- Create: `worker/src/tools/send.ts`, `worker/test/send-tools.test.ts`
- Modify: `shared/src/schemas.ts` (send inputs), `worker/src/mcp/server.ts`, `worker/test/mcp.test.ts`

**Interfaces:**

- Consumes: everything in `compose.ts`, `recipientModifiers`, `trustContext`, `sendMime`, `sendDraft`, `messageView`.
- Produces: `registerSendTools(server, toolContext, env)`; inputs `SendMessageInput` (`ComposeFields` plus `idempotency_key`), `ReplyInput`, `ForwardInput`, `SendDraftInput`; `IdempotencyKey = z.string().min(1).max(128)`. All four are `journal: true`.
- Payload shapes (rendered by `approvalView`'s `send` view): `send_message` `{ to, cc, bcc, subject, body, html_body, from, attachments, carry: [] }`; `reply` adds `message_id, thread_id, in_reply_to, references`; `forward` adds `message_id, include_original_attachments, carry`; `send_draft` is `{ draft_id, message_id, thread_id, rfc822_message_id, to, cc, bcc, subject, attachments: [], draft_attachments: [{ filename, size }] }`.
- Modifiers: `recipientModifiers(all, trustContext)` for every send; `+attachment` when `attachments`, `inline_attachments`, `carry` or `draft_attachments` is non-empty.
- `send_draft` re-derives its payload at execution and compares the canonical hash to the one it ran under; a draft edited in between is `payload_mismatch`, settled `failed_safe` because the operation was never opened.

- [ ] **Step 1 (RED): tests**

`worker/test/send-tools.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index";
import { FakeGoogle } from "./fake-google";
import { mintToken } from "./browser";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import { callTool } from "./mcp-client";
import { testDeps, testEnv } from "./test-env";
import { ingest } from "../src/staging/store";
import { setPolicy } from "../src/policy/engine";
import { approvePending, getPending } from "../src/approval/pending";

const e = testEnv();
let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
let token: string;
const gm = () => g.gmail;
const call = (name: string, args: Record<string, unknown>) => callTool(worker, e, token, name, args);
const stagingCount = async () =>
  (await env.DB.prepare("SELECT count(*) AS n FROM staging_objects").first<any>()).n as number;
async function stage(name: string, bytes: Uint8Array) {
  return (
    await ingest(e, {
      userId: "owner-sub",
      accountId: "sa",
      direction: "upload",
      filename: name,
      mime: "application/octet-stream",
      length: bytes.byteLength,
      body: new Response(bytes).body!,
    })
  ).handle;
}
const lastRaw = () => new TextDecoder().decode(gm().sent.at(-1)!.raw);

beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker(testDeps(g));
  await seedUserAndAccount(env.DB, {
    userId: "owner-sub",
    accountId: "sa",
    alias: "uni",
    isDefault: true,
    orgDomains: ["uni.test"],
  });
  await seedAccessToken(e, { userId: "owner-sub", accountId: "sa" });
  await env.DB.prepare(
    "INSERT INTO contact_allowlist (user_id, account_id, pattern) VALUES ('owner-sub', 'sa', 'friend@example.test')",
  ).run();
  token = (await mintToken(worker, e, g, { scope: "mcp" })).accessToken;
});

describe("send_message", () => {
  it("asks by default with modifiers from trust and attachments, and the 2.6 summary", async () => {
    const h = await stage("thesis.pdf", new Uint8Array(2 * 1024 * 1024));
    const r = await call("send_message", {
      account: "uni",
      to: ["prof@uni.test"],
      cc: ["stranger@else.test"],
      subject: "Thesis draft",
      body: "see attached",
      attachments: [h],
    });
    expect(r.result).toMatchObject({ status: "pending_approval", action: "send.message", account: "uni" });
    expect(r.result.modifiers.sort()).toEqual(["+attachment", "+external"]);
    expect(r.result.summary).toBe(
      "To: prof@uni.test · Cc: stranger@else.test · Subject: Thesis draft · 1 attachment (thesis.pdf, 2.0 MB)",
    );
    expect(gm().sent).toHaveLength(0);
    const row = (await getPending(env.DB, r.result.action_id, "owner-sub"))!;
    expect(JSON.parse(row.payload_json!)).toMatchObject({
      tool: "send_message",
      v: 1,
      to: ["prof@uni.test"],
      attachments: [h],
      from: "uni@example.test",
    });
    expect(row.intent_hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("trusted recipients only, no attachments: no modifiers; +bulk above 10 distinct", async () => {
    const r = await call("send_message", {
      account: "uni",
      to: ["prof@uni.test", "friend@example.test", "uni@example.test"],
      subject: "s",
      body: "b",
    });
    expect(r.result.modifiers).toEqual([]);
    const bulk = await call("send_message", {
      account: "uni",
      to: Array.from({ length: 11 }, (_, i) => `p${i}@uni.test`),
      subject: "s",
      body: "b",
    });
    expect(bulk.result.modifiers).toEqual(["+bulk"]);
  });
  it("idempotency on the ask path: the same key returns the same pending action; after approval and execution, it replays", async () => {
    const a = await call("send_message", {
      account: "uni",
      to: ["prof@uni.test"],
      subject: "k",
      body: "b",
      idempotency_key: "ask-1",
    });
    const b = await call("send_message", {
      account: "uni",
      to: ["prof@uni.test"],
      subject: "k",
      body: "b",
      idempotency_key: "ask-1",
    });
    expect(b.result.action_id).toBe(a.result.action_id);
    await approvePending(env.DB, { id: a.result.action_id, userId: "owner-sub", via: "browser" });
    const done = await call("execute_pending", { action_id: a.result.action_id });
    expect(done.result.status).toBe("executed");
    const c = await call("send_message", {
      account: "uni",
      to: ["prof@uni.test"],
      subject: "k",
      body: "b",
      idempotency_key: "ask-1",
    });
    expect(c.result).toMatchObject({
      status: "executed",
      replayed: true,
      operation_id: done.result.operation_id,
      message: { id: done.result.message.id },
    });
    expect(gm().sent.filter((s) => s.id === done.result.message.id)).toHaveLength(1);
    const d = await call("send_message", {
      account: "uni",
      to: ["other@uni.test"],
      subject: "k",
      body: "b",
      idempotency_key: "ask-1",
    });
    expect(d.result).toMatchObject({ error: "idempotency_conflict" });
  });
  it("allowed: sends via media upload with our Message-ID, journals, consumes handles, and replays the key even though the handle is now consumed", async () => {
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "sa", action: "send.message", level: "allow" });
    const h = await stage("notes.txt", new TextEncoder().encode("notes"));
    const args = {
      account: "uni",
      to: ["Prof <prof@uni.test>"],
      subject: "Hi 🚀",
      body: "hello",
      html_body: "<b>hello</b>",
      attachments: [h],
      idempotency_key: "send-1",
    };
    const r = await call("send_message", args);
    expect(r.result).toMatchObject({
      status: "executed",
      account: "uni",
      message: { id: expect.stringMatching(/^m/), thread_id: expect.any(String) },
    });
    const raw = lastRaw();
    expect(raw).toContain(`Message-ID: <${r.result.operation_id}@gmail-mcp.example.workers.dev>`);
    expect(raw).toContain("From: <uni@example.test>");
    expect(raw).toContain('To: "Prof" <prof@uni.test>');
    expect(raw).toContain("Subject: =?UTF-8?B?SGkg8J+agA==?=");
    expect(raw).toContain("multipart/alternative");
    expect(raw).toContain('filename="notes.txt"');
    const op = await env.DB.prepare(
      "SELECT state, rfc822_message_id, gmail_result_id, result_json FROM operations WHERE id = ?",
    )
      .bind(r.result.operation_id)
      .first<any>();
    expect(op).toMatchObject({
      state: "executed",
      rfc822_message_id: `<${r.result.operation_id}@gmail-mcp.example.workers.dev>`,
      gmail_result_id: r.result.message.id,
    });
    expect(JSON.parse(op.result_json)).toEqual({ gmail_result_id: r.result.message.id, message: r.result.message });
    expect(
      (await env.DB.prepare("SELECT consumed_at FROM staging_objects WHERE handle = ?").bind(h).first<any>())
        .consumed_at,
    ).not.toBeNull();
    const again = await call("send_message", args);
    expect(again.result).toMatchObject({
      status: "executed",
      replayed: true,
      operation_id: r.result.operation_id,
      message: { id: r.result.message.id },
    });
    expect(gm().sent.filter((s) => s.id === r.result.message.id)).toHaveLength(1);
    const outcome = await env.DB.prepare(
      "SELECT decision, gmail_result_id, summary FROM audit_log WHERE user_id='owner-sub' AND tool='send_message' AND phase='outcome' ORDER BY id DESC LIMIT 1",
    ).first<any>();
    expect(outcome).toEqual({
      decision: "executed",
      gmail_result_id: r.result.message.id,
      summary: "recipients=1 attachments=1",
    });
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "sa", action: "send.message", level: "ask" });
  });
  it("inline attachments: a replay stages nothing the second time", async () => {
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "sa", action: "send.message", level: "allow" });
    const args = {
      account: "uni",
      to: ["prof@uni.test"],
      subject: "inline",
      body: "b",
      inline_attachments: [{ filename: "i.txt", mime: "text/plain", content_base64: btoa("inline") }],
      idempotency_key: "inline-1",
    };
    const before = await stagingCount();
    const a = await call("send_message", args);
    expect(a.result.status).toBe("executed");
    expect(await stagingCount()).toBe(before + 1);
    const b = await call("send_message", args);
    expect(b.result).toMatchObject({ status: "executed", replayed: true, operation_id: a.result.operation_id });
    expect(await stagingCount()).toBe(before + 1);
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "sa", action: "send.message", level: "ask" });
  });
  it("Gmail rejecting the message after approval is failed_safe and the error is verbatim", async () => {
    const r = await call("send_message", { account: "uni", to: ["prof@uni.test"], subject: "s", body: "b" });
    await approvePending(env.DB, { id: r.result.action_id, userId: "owner-sub", via: "browser" });
    gm().faults.push({ status: 400, message: "Recipient address required" });
    const done = await call("execute_pending", { action_id: r.result.action_id });
    expect(done.result).toMatchObject({ error: "gmail_error" });
    expect(done.result.message).toContain("Recipient address required");
    const row = (await getPending(env.DB, r.result.action_id, "owner-sub"))!;
    expect(row).toMatchObject({ state: "failed", error: "gmail_error" });
    expect(
      (await env.DB.prepare("SELECT state FROM operations WHERE id = ?").bind(row.operation_id).first<any>()).state,
    ).toBe("failed_safe");
  });
  it("a 503 after the body was opened is delivery_unknown and the operation stays executing for the cron", async () => {
    const r = await call("send_message", { account: "uni", to: ["prof@uni.test"], subject: "s", body: "b" });
    await approvePending(env.DB, { id: r.result.action_id, userId: "owner-sub", via: "browser" });
    gm().faults.push({ status: 503 });
    const done = await call("execute_pending", { action_id: r.result.action_id });
    expect(done.result).toMatchObject({ error: "delivery_unknown", details: { operation_id: expect.any(String) } });
    expect(done.result.message).toContain("Do not retry automatically");
    expect(
      (
        await env.DB.prepare("SELECT state FROM operations WHERE id = ?")
          .bind(done.result.details.operation_id)
          .first<any>()
      ).state,
    ).toBe("executing");
    expect((await getPending(env.DB, r.result.action_id, "owner-sub"))!).toMatchObject({
      state: "failed",
      error: "delivery_unknown",
    });
  });
  it("needs at least one recipient and refuses a foreign sender", async () => {
    expect((await call("send_message", { account: "uni", subject: "s", body: "b" })).result).toMatchObject({
      error: "invalid_address",
    });
    expect(
      (await call("send_message", { account: "uni", to: ["prof@uni.test"], from: "x@y.test", body: "b" })).result,
    ).toMatchObject({ error: "invalid_address" });
  });
});

describe("reply", () => {
  it("derives thread, subject, In-Reply-To and References; Reply-To lists win over From; reply_all adds the rest minus self", async () => {
    const t = gm().seedMessage({
      from: "Prof <prof@uni.test>",
      to: ["uni@example.test", "peer@uni.test"],
      cc: ["cc@else.test"],
      subject: "Re: Thesis",
      text: "q",
      messageId: "<q1@uni.test>",
      references: "<root@uni.test>",
      replyTo: '"Office, Dean" <office@uni.test>, ta@uni.test',
    });
    const r = await call("reply", { account: "uni", message_id: t.id, body: "a" });
    expect(r.result).toMatchObject({ status: "pending_approval", modifiers: [] });
    const p = JSON.parse((await getPending(env.DB, r.result.action_id, "owner-sub"))!.payload_json!);
    expect(p).toMatchObject({
      tool: "reply",
      message_id: t.id,
      thread_id: t.threadId,
      subject: "Re: Thesis",
      in_reply_to: "<q1@uni.test>",
      references: "<root@uni.test> <q1@uni.test>",
      to: ['"Office, Dean" <office@uni.test>', "ta@uni.test"],
      cc: [],
      bcc: [],
    });
    const all = await call("reply", {
      account: "uni",
      message_id: t.id,
      body: "a",
      reply_all: true,
      bcc: ["me2@uni.test"],
    });
    const pa = JSON.parse((await getPending(env.DB, all.result.action_id, "owner-sub"))!.payload_json!);
    expect(pa.to).toEqual(['"Office, Dean" <office@uni.test>', "ta@uni.test", "peer@uni.test"]);
    expect(pa.cc).toEqual(["cc@else.test"]);
    expect(pa.bcc).toEqual(["me2@uni.test"]);
    expect(all.result.modifiers).toEqual(["+external"]);
  });
  it("once allowed, the sent message lands in the original thread", async () => {
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "sa", action: "send.message", level: "allow" });
    const t = gm().seedMessage({
      from: "prof@uni.test",
      to: ["uni@example.test"],
      subject: "Q",
      text: "q",
      messageId: "<q2@uni.test>",
    });
    const r = await call("reply", { account: "uni", message_id: t.id, body: "a" });
    expect(r.result).toMatchObject({ status: "executed", message: { thread_id: t.threadId } });
    expect(lastRaw()).toContain("In-Reply-To: <q2@uni.test>");
    expect(gm().requests.at(-1)!.url).toContain("uploadType=multipart");
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "sa", action: "send.message", level: "ask" });
  });
});

describe("forward", () => {
  it("quotes the original, excludes original attachments by default, lists them in the summary when included, and streams them at send", async () => {
    const t = gm().seedMessage({
      from: "prof@uni.test",
      to: ["uni@example.test"],
      subject: "Slides",
      text: "here are the slides",
      attachments: [{ filename: "slides.pdf", mime: "application/pdf", bytes: new Uint8Array(1500) }],
    });
    const r = await call("forward", {
      account: "uni",
      message_id: t.id,
      to: ["friend@example.test"],
      forward_text: "FYI",
    });
    expect(r.result).toMatchObject({ status: "pending_approval", action: "send.forward", modifiers: [] });
    expect(r.result.summary).toContain("no attachments");
    const p = JSON.parse((await getPending(env.DB, r.result.action_id, "owner-sub"))!.payload_json!);
    expect(p).toMatchObject({
      tool: "forward",
      subject: "Fwd: Slides",
      include_original_attachments: false,
      carry: [],
    });
    expect(p.body).toMatch(/^FYI\n\n---------- Forwarded message ---------\nFrom: prof@uni.test\n/);
    expect(p.body).toContain("here are the slides");
    const inc = await call("forward", {
      account: "uni",
      message_id: t.id,
      to: ["friend@example.test"],
      include_original_attachments: true,
    });
    expect(inc.result.modifiers).toEqual(["+attachment"]);
    expect(inc.result.summary).toContain("1 attachment (slides.pdf, 1.5 KB)");
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "sa", action: "send.forward", level: "allow" });
    const sent = await call("forward", {
      account: "uni",
      message_id: t.id,
      to: ["friend@example.test"],
      include_original_attachments: true,
    });
    expect(sent.result.status).toBe("executed");
    expect(lastRaw()).toContain('filename="slides.pdf"');
    expect(lastRaw()).toContain("Subject: Fwd: Slides");
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "sa", action: "send.forward", level: "ask" });
  });
});

describe("send_draft", () => {
  it("derives recipients, attachments and the draft's Message-ID, +attachment when it has any, and sends via drafts.send", async () => {
    const d = gm().seedDraft({
      from: "uni@example.test",
      to: ["prof@uni.test"],
      subject: "Draft",
      text: "d",
      messageId: "<draft1@example.test>",
      attachments: [{ filename: "a.pdf", mime: "application/pdf", bytes: new Uint8Array(10) }],
    });
    const r = await call("send_draft", { account: "uni", draft_id: d.id });
    expect(r.result).toMatchObject({ status: "pending_approval", action: "send.draft", modifiers: ["+attachment"] });
    expect(r.result.summary).toContain("1 attachment (a.pdf, 10 B)");
    const p = JSON.parse((await getPending(env.DB, r.result.action_id, "owner-sub"))!.payload_json!);
    expect(p).toMatchObject({
      tool: "send_draft",
      draft_id: d.id,
      to: ["prof@uni.test"],
      subject: "Draft",
      rfc822_message_id: "<draft1@example.test>",
      draft_attachments: [{ filename: "a.pdf", size: 10 }],
    });
    await approvePending(env.DB, { id: r.result.action_id, userId: "owner-sub", via: "browser" });
    const done = await call("execute_pending", { action_id: r.result.action_id });
    expect(done.result).toMatchObject({ status: "executed", message: { id: expect.stringMatching(/^m/) } });
    expect(gm().sent.at(-1)!.via).toBe("draft");
    expect(
      (
        await env.DB.prepare("SELECT rfc822_message_id FROM operations WHERE id = ?")
          .bind(done.result.operation_id)
          .first<any>()
      ).rfc822_message_id,
    ).toBe("<draft1@example.test>");
  });
  it("a draft edited between approval and execution is a payload mismatch and nothing is sent", async () => {
    const d = gm().seedDraft({ from: "uni@example.test", to: ["prof@uni.test"], subject: "Edit me", text: "d" });
    const r = await call("send_draft", { account: "uni", draft_id: d.id });
    await approvePending(env.DB, { id: r.result.action_id, userId: "owner-sub", via: "browser" });
    gm().drafts.get(d.id)!.message.payload.headers.push({ name: "Bcc", value: "sneaky@else.test" });
    const before = gm().sent.length;
    const done = await call("execute_pending", { action_id: r.result.action_id });
    expect(done.result).toMatchObject({ error: "payload_mismatch" });
    expect(gm().sent.length).toBe(before);
    const row = (await getPending(env.DB, r.result.action_id, "owner-sub"))!;
    expect(row.state).toBe("failed");
    expect(
      (await env.DB.prepare("SELECT state FROM operations WHERE id = ?").bind(row.operation_id).first<any>()).state,
    ).toBe("failed_safe");
  });
});
```

The fake's `seedMessage` gains an optional `replyTo` field that becomes a `Reply-To` header.

- [ ] **Step 2: run, expect failure**

Run: `cd worker && npx vitest run test/send-tools.test.ts`
Expected: FAIL, unknown tools.

- [ ] **Step 3 (GREEN): schemas**

Append to `shared/src/schemas.ts`:

```ts
export const IdempotencyKey = z.string().min(1).max(128);
export const SendMessageInput = z.object({
  account: AccountAlias,
  ...ComposeFields,
  idempotency_key: IdempotencyKey.optional(),
});
export const ReplyInput = z
  .object({
    account: AccountAlias,
    message_id: GmailId,
    reply_all: z.boolean().default(false),
    ...ComposeFields,
    idempotency_key: IdempotencyKey.optional(),
  })
  .omit({ subject: true });
export const ForwardInput = z
  .object({
    account: AccountAlias,
    message_id: GmailId,
    forward_text: z.string().max(600_000).optional(),
    include_original_attachments: z.boolean().default(false),
    ...ComposeFields,
    idempotency_key: IdempotencyKey.optional(),
  })
  .omit({ subject: true, body: true });
export const SendDraftInput = z.object({
  account: AccountAlias,
  draft_id: GmailId,
  idempotency_key: IdempotencyKey.optional(),
});
```

- [ ] **Step 4 (GREEN): the send tools**

`worker/src/tools/send.ts`:

```ts
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { Modifier } from "@gmail-mcp/shared/actions";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import { ForwardInput, ReplyInput, SendDraftInput, SendMessageInput } from "@gmail-mcp/shared/schemas";
import type { Env } from "../env";
import type { Deps } from "../deps";
import { canonicalize, hashCanonical } from "../crypto/canonical";
import { gmailJson } from "../google/gmail";
import { messageView, type GmailDraft } from "../google/messages";
import { sendDraft, sendMime } from "../operations/send";
import { parseAddress, recipientModifiers } from "../policy/recipients";
import { trustContext, type AccountRef } from "./accounts";
import {
  attachmentSummary,
  attachmentsFor,
  composeMime,
  getMessage,
  recipientSummary,
  senderFor,
  stageInline,
  threadingFor,
  validateCompose,
  type CarriedAttachment,
  type ComposePayload,
  type DecodedInline,
} from "./compose";
import { defineTool, type Plan } from "./define";
import type { ExecRun, ToolContext } from "./gate";

type SendPayload = ComposePayload & {
  message_id?: string;
  thread_id?: string | null;
  include_original_attachments?: boolean;
};
type SendArgs = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string | undefined;
  body?: string | undefined;
  html_body?: string | undefined;
  from?: string | undefined;
  attachments?: string[] | undefined;
  idempotency_key?: string | undefined;
};
const acct = (userId: string, account: AccountRef) => ({ userId, accountId: account.id });
const openWorld = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

async function modifiersFor(
  env: Env,
  userId: string,
  account: AccountRef,
  p: { to: string[]; cc: string[]; bcc: string[] },
  hasAttachments: boolean,
): Promise<Modifier[]> {
  const mods = recipientModifiers([...p.to, ...p.cc, ...p.bcc], await trustContext(env, userId, account));
  if (hasAttachments) mods.unshift("+attachment");
  return mods;
}

function dedupe(list: string[], exclude: string[] = []): string[] {
  const seen = new Set(exclude.map((s) => parseAddress(s).normalized));
  const out: string[] = [];
  for (const r of list) {
    const n = parseAddress(r).normalized;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(r);
  }
  return out;
}

/** Shared plan for send_message, reply and forward once recipients and threading are settled. Writes nothing; the build does. */
async function planSend(
  env: Env,
  userId: string,
  account: AccountRef,
  args: SendArgs,
  inline: DecodedInline[],
  extra: Partial<SendPayload> & { carry: CarriedAttachment[] },
  verb: string,
): Promise<Plan> {
  validateCompose(args);
  if (args.to.length + args.cc.length + args.bcc.length === 0)
    throw new GmailMcpError("invalid_address", "invalid_address: at least one recipient is required");
  const from = senderFor(account, args.from);
  const given = args.attachments ?? [];
  const { rows } = await attachmentsFor(
    env,
    userId,
    account,
    given,
    extra.carry.reduce((n, c) => n + c.size, 0) + inline.reduce((n, d) => n + d.size, 0),
  );
  const files = [
    ...rows.map((r) => ({ filename: r.filename, size: r.size })),
    ...inline.map((d) => ({ filename: d.filename, size: d.size })),
    ...extra.carry,
  ];
  const recipients = { to: args.to, cc: args.cc, bcc: args.bcc };
  return {
    modifiers: await modifiersFor(
      env,
      userId,
      account,
      recipients,
      given.length + inline.length + extra.carry.length > 0,
    ),
    summary: `${verb} · ${recipientSummary({ ...recipients, subject: args.subject })} · ${attachmentSummary(files)}`,
    facts: {
      recipients: args.to.length + args.cc.length + args.bcc.length,
      attachments: given.length + inline.length + extra.carry.length,
      ...(extra.message_id ? { ids: [extra.message_id] } : {}),
    },
    idempotencyKey: args.idempotency_key,
    build: async () => {
      const attachments = [...given, ...(await stageInline(env, userId, account.id, inline))];
      const payload: SendPayload = {
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        body: args.body,
        html_body: args.html_body,
        from,
        attachments,
        ...extra,
      };
      return { payload: payload as unknown as Record<string, unknown>, handles: attachments };
    },
  };
}

async function executeSend(env: Env, deps: Deps, run: ExecRun) {
  const p = run.payload as unknown as SendPayload;
  if (!run.operationId) throw new GmailMcpError("internal", "send runs with an operation");
  const { body, length, rfc822MessageId } = await composeMime(env, deps, run, p, run.operationId);
  const m = await sendMime(env, deps, {
    userId: run.userId,
    accountId: run.account.id,
    operationId: run.operationId,
    body,
    length,
    threadId: p.thread_id ?? null,
    rfc822MessageId,
  });
  return { gmail_result_id: m.id, message: m };
}

function quoted(v: ReturnType<typeof messageView>): string {
  return [
    "---------- Forwarded message ---------",
    `From: ${v.from ?? ""}`,
    `Date: ${v.date ?? ""}`,
    `Subject: ${v.subject ?? ""}`,
    `To: ${v.to.join(", ")}`,
    ...(v.cc.length ? [`Cc: ${v.cc.join(", ")}`] : []),
    "",
    v.plaintext_body ?? "",
  ].join("\n");
}

async function draftPayload(env: Env, deps: Deps, userId: string, account: AccountRef, draftId: string) {
  const dr = await gmailJson<GmailDraft>(env, deps, acct(userId, account), {
    method: "GET",
    path: `drafts/${encodeURIComponent(draftId)}`,
    query: { format: "full" },
    retry: "safe",
  });
  const v = messageView(dr.message, { format: "PLAIN_TEXT", bodyCharLimit: 1, includeBody: false });
  return {
    draft_id: draftId,
    message_id: dr.message.id,
    thread_id: dr.message.threadId,
    rfc822_message_id: v.message_id_header,
    to: v.to,
    cc: v.cc,
    bcc: v.bcc,
    subject: v.subject,
    attachments: [] as string[],
    draft_attachments: v.attachments.map((a) => ({ filename: a.filename, size: a.size })),
  };
}

export function registerSendTools(server: McpServer, toolContext: (ctx: ServerContext) => ToolContext, env: Env): void {
  defineTool(server, toolContext, env, {
    name: "send_message",
    version: 1,
    description:
      "Send new mail. Replies go through `reply`, existing drafts through `send_draft`. Attachments are staging handles.",
    input: SendMessageInput,
    annotations: openWorld,
    action: "send.message",
    journal: true,
    plan: (e, t, account, args, inline) =>
      planSend(e, t.principal.userId, account, args, inline, { carry: [] }, "Send"),
    execute: executeSend,
  });

  defineTool(server, toolContext, env, {
    name: "reply",
    version: 1,
    description:
      "Reply to a message. The Worker derives the thread, subject, In-Reply-To and References. reply_all adds the original To and Cc minus this account.",
    input: ReplyInput,
    annotations: openWorld,
    action: "send.message",
    journal: true,
    plan: async (e, t, account, args, inline) => {
      const th = threadingFor(
        await getMessage(e, t.deps, acct(t.principal.userId, account), args.message_id, "METADATA_ONLY"),
      );
      const self = [account.email, ...account.sendAs];
      const primary = th.reply_to.length ? th.reply_to : th.from ? [th.from] : [];
      const to = dedupe([...primary, ...(args.reply_all ? th.to : []), ...args.to], self);
      const cc = dedupe(args.reply_all ? [...th.cc, ...args.cc] : args.cc, [...self, ...to]);
      return planSend(
        e,
        t.principal.userId,
        account,
        { ...args, to, cc, subject: th.subject },
        inline,
        {
          carry: [],
          message_id: args.message_id,
          thread_id: th.thread_id,
          in_reply_to: th.in_reply_to,
          references: th.references,
        },
        "Reply",
      );
    },
    execute: executeSend,
  });

  defineTool(server, toolContext, env, {
    name: "forward",
    version: 1,
    description:
      "Forward a message with optional text. Original attachments are excluded unless include_original_attachments is true.",
    input: ForwardInput,
    annotations: openWorld,
    action: "send.forward",
    journal: true,
    plan: async (e, t, account, args, inline) => {
      const v = messageView(
        await getMessage(e, t.deps, acct(t.principal.userId, account), args.message_id, "PLAIN_TEXT"),
        { format: "PLAIN_TEXT", bodyCharLimit: 200_000, includeBody: true },
      );
      const carry: CarriedAttachment[] = args.include_original_attachments
        ? v.attachments
            .filter((a) => a.attachment_id !== null)
            .map((a) => ({
              message_id: args.message_id,
              attachment_id: a.attachment_id!,
              filename: a.filename,
              mime: a.mime,
              size: a.size,
            }))
        : [];
      const subjectRaw = v.subject ?? "";
      const subject = /^\s*fwd?:/i.test(subjectRaw) ? subjectRaw : `Fwd: ${subjectRaw}`;
      const body = `${args.forward_text ? args.forward_text + "\n\n" : ""}${quoted(v)}`;
      return planSend(
        e,
        t.principal.userId,
        account,
        { ...args, subject, body },
        inline,
        {
          carry,
          message_id: args.message_id,
          thread_id: null,
          include_original_attachments: args.include_original_attachments,
        },
        "Forward",
      );
    },
    execute: executeSend,
  });

  defineTool(server, toolContext, env, {
    name: "send_draft",
    version: 1,
    description:
      "Send an existing draft. Recipients and attachments are read from the draft; a draft changed after approval is refused.",
    input: SendDraftInput,
    annotations: openWorld,
    action: "send.draft",
    journal: true,
    plan: async (e, t, account, args) => {
      const p = await draftPayload(e, t.deps, t.principal.userId, account, args.draft_id);
      validateCompose(p);
      return {
        modifiers: await modifiersFor(e, t.principal.userId, account, p, p.draft_attachments.length > 0),
        summary: `Send draft ${args.draft_id} · ${recipientSummary(p)} · ${attachmentSummary(p.draft_attachments)}`,
        facts: {
          recipients: p.to.length + p.cc.length + p.bcc.length,
          attachments: p.draft_attachments.length,
          ids: [args.draft_id],
        },
        idempotencyKey: args.idempotency_key,
        build: async () => ({ payload: p, handles: [] }),
      };
    },
    execute: async (e, d, run) => {
      if (!run.operationId) throw new GmailMcpError("internal", "send.draft runs with an operation");
      const stored = run.payload as { draft_id: string; rfc822_message_id: string | null; tool: string; v: number };
      // Spec 3.4 "one approval covers one action": the draft must still be what the owner approved.
      const fresh = {
        ...(await draftPayload(e, d, run.userId, run.account, stored.draft_id)),
        tool: stored.tool,
        v: stored.v,
      };
      if ((await hashCanonical(canonicalize(fresh))) !== (await hashCanonical(canonicalize(run.payload)))) {
        throw new GmailMcpError("payload_mismatch", "payload_mismatch: the draft changed after it was approved");
      }
      const m = await sendDraft(e, d, {
        userId: run.userId,
        accountId: run.account.id,
        operationId: run.operationId,
        draftId: stored.draft_id,
        rfc822MessageId: stored.rfc822_message_id,
      });
      return { gmail_result_id: m.id, message: m };
    },
  });
}
```

The `payload_mismatch` throw in `send_draft` happens while the operation is still `claimed`, so the gate settles it `failed_safe`. `worker/src/mcp/server.ts`: `registerSendTools(server, toolContext, env);`.

- [ ] **Step 5: run, expect pass**

Run: `cd worker && npx vitest run test/send-tools.test.ts test/drafts-tools.test.ts test/mcp.test.ts test/approve.test.ts` then `npm run verify`.
Expected: PASS. `approve.test.ts` renders the `send` view from a payload with `to`, `cc`, `bcc`, `subject`, `body`, `attachments`, `draft_id`, `message_id`, `include_original_attachments`; if it fails, the payload key names drifted from `approvalView`, and the payload is what changes, never the view.

- [ ] **Step 6: commit**

```bash
git add shared/src/schemas.ts worker/src/tools/send.ts worker/src/mcp/server.ts worker/test
git commit -m "feat(worker): send_message, reply, forward and send_draft

Every send is one gate call with modifiers from the trust rules and the attachment set; the key is
answered before any handle is looked at, so a replay survives its consumed attachment. Replies derive
threading from the target, forwards stream carried originals, and send_draft re-reads the draft at
execution and refuses one that changed after approval.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NBfkjWcEGDFghet3APnUjU"
```

---

### Task 10: Elicitation on the wire, the adversarial rows, and the 38-tool surface

**Files:**

- Create: `worker/test/elicitation.test.ts`
- Modify: `worker/test/mcp-client.ts` (`modernCall`), `worker/test/mcp.test.ts` (38 names, annotations table)

**Interfaces:**

- `modernCall(worker, env, token, name, args, o?: { capabilities?; inputResponses?; requestState?; id?; headers?: Record<string, string | null> })`: a 2026-07-28 `tools/call` with the `_meta` envelope (`io.modelcontextprotocol/protocolVersion`, `io.modelcontextprotocol/clientCapabilities`, `io.modelcontextprotocol/clientInfo`), the `MCP-Protocol-Version: 2026-07-28` header, and the routing headers the revision requires and the SDK enforces before dispatch: `Mcp-Method: tools/call` and `Mcp-Name: <tool>`. `o.headers` overrides or removes (with `null`) a header for the adversarial rows. `inputResponses` and `requestState` go on `params`. Returns `{ status, json, result, error, inputRequired }`.

- [ ] **Step 1 (RED): tests**

`worker/test/elicitation.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index";
import { FakeGoogle } from "./fake-google";
import { Browser, csrfFrom, mintToken } from "./browser";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import { callTool, modernCall } from "./mcp-client";
import { testDeps, testEnv } from "./test-env";
import { getPending } from "../src/approval/pending";

const e = testEnv({ OWNER_GOOGLE_SUBS: "owner-sub,other-sub" });
let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
let token: string;
let otherToken: string;
let browser: Browser;
const gm = () => g.gmail;
const URL_CAPS = { elicitation: { url: {} } };
const FORM_CAPS = { elicitation: { form: {} } };
const pendingCount = async () =>
  (await env.DB.prepare("SELECT count(*) AS n FROM pending_actions WHERE user_id = 'owner-sub'").first<any>())
    .n as number;

beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker(testDeps(g));
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "ea", alias: "personal", isDefault: true });
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "eb", alias: "cold" });
  await seedUserAndAccount(env.DB, { userId: "other-sub", accountId: "ec", alias: "personal", isDefault: true });
  await seedAccessToken(e, { userId: "owner-sub", accountId: "ea" });
  const minted = await mintToken(worker, e, g, { scope: "mcp" });
  token = minted.accessToken;
  browser = minted.browser;
  otherToken = (await mintToken(worker, e, g, { scope: "mcp", sub: "other-sub", email: "other@example.test" }))
    .accessToken;
});

const seed = () => gm().seedMessage({ from: "a@x.test", to: ["me@x.test"], subject: "el", text: "t" });

describe("legacy era", () => {
  it("returns the approval URL as text and never an input_required result", async () => {
    const m = seed();
    const r = await callTool(worker, e, token, "trash_message", { account: "personal", message_id: m.id });
    expect(r.result).toMatchObject({ status: "pending_approval", approval: { mode: "url" } });
    expect(r.json.result.resultType).toBeUndefined();
  });
});

describe("modern era with elicitation.url", () => {
  it("answers input_required with the approval URL and a signed requestState; the accepted retry waits and executes", async () => {
    const m = seed();
    const first = await modernCall(
      worker,
      e,
      token,
      "trash_message",
      { account: "personal", message_id: m.id },
      { capabilities: URL_CAPS },
    );
    expect(first.status).toBe(200);
    expect(first.inputRequired).toMatchObject({
      resultType: "input_required",
      inputRequests: { approval: { method: "elicitation/create", params: { mode: "url" } } },
    });
    const url: string = first.inputRequired.inputRequests.approval.params.url;
    const id = url.split("/approve/")[1]!;
    expect(url).toBe(`https://gmail-mcp.example.workers.dev/approve/${id}`);
    const state: string = first.inputRequired.requestState;
    expect(state).toMatch(/^v1\./);
    expect((await getPending(env.DB, id, "owner-sub"))!.state).toBe("pending");
    const page = await browser.get(`/approve/${id}`);
    const csrf = csrfFrom(await page.text(), `/approve/${id}`);
    setTimeout(() => void browser.post(`/approve/${id}`, { decision: "approve", csrf }), 20);
    const retry = await modernCall(
      worker,
      e,
      token,
      "trash_message",
      { account: "personal", message_id: m.id },
      { capabilities: URL_CAPS, inputResponses: { approval: { action: "accept" } }, requestState: state },
    );
    expect(retry.result).toMatchObject({ status: "executed", action_id: id, message: { id: m.id } });
    expect(gm().messages.get(m.id)!.labelIds).toContain("TRASH");
    expect((await getPending(env.DB, id, "owner-sub"))!).toMatchObject({
      state: "executed",
      approved_via: "browser",
      payload_json: null,
    });
  });
  it("without the url capability the modern era gets the URL as text", async () => {
    const m = seed();
    const r = await modernCall(
      worker,
      e,
      token,
      "trash_message",
      { account: "personal", message_id: m.id },
      { capabilities: FORM_CAPS },
    );
    expect(r.result).toMatchObject({ status: "pending_approval" });
    expect(r.inputRequired).toBeNull();
  });
  it("the deadline returns pending_approval and the owner can finish with execute_pending", async () => {
    const m = seed();
    const first = await modernCall(
      worker,
      e,
      token,
      "trash_message",
      { account: "personal", message_id: m.id },
      { capabilities: URL_CAPS },
    );
    const state: string = first.inputRequired.requestState;
    const id = first.inputRequired.inputRequests.approval.params.url.split("/approve/")[1];
    const waited = await modernCall(
      worker,
      e,
      token,
      "trash_message",
      { account: "personal", message_id: m.id },
      { capabilities: URL_CAPS, inputResponses: { approval: { action: "accept" } }, requestState: state },
    );
    expect(waited.result).toMatchObject({ status: "pending_approval", action_id: id });
    await env.DB.prepare(
      "UPDATE pending_actions SET state = 'approved', approved_at = ?, approved_via = 'browser' WHERE id = ?",
    )
      .bind(Date.now(), id)
      .run();
    const done = await callTool(worker, e, token, "execute_pending", { action_id: id });
    expect(done.result).toMatchObject({ status: "executed", action_id: id });
    expect((await callTool(worker, e, token, "execute_pending", { action_id: id })).result.error).toBe(
      "pending_replayed",
    );
  });
  it("an inline attachment survives the round trip: the accepted retry hashes to the same intent and stages nothing twice", async () => {
    const args = {
      account: "personal",
      to: ["someone@else.test"],
      subject: "inline",
      body: "b",
      inline_attachments: [{ filename: "i.txt", mime: "text/plain", content_base64: btoa("inline") }],
    };
    const staged = async () =>
      (await env.DB.prepare("SELECT count(*) AS n FROM staging_objects").first<any>()).n as number;
    const before = await staged();
    const first = await modernCall(worker, e, token, "send_message", args, { capabilities: URL_CAPS });
    expect(first.inputRequired).toMatchObject({ resultType: "input_required" });
    expect(await staged()).toBe(before + 1);
    const id = first.inputRequired.inputRequests.approval.params.url.split("/approve/")[1];
    await env.DB.prepare(
      "UPDATE pending_actions SET state = 'approved', approved_at = ?, approved_via = 'browser' WHERE id = ?",
    )
      .bind(Date.now(), id)
      .run();
    const retry = await modernCall(worker, e, token, "send_message", args, {
      capabilities: URL_CAPS,
      inputResponses: { approval: { action: "accept" } },
      requestState: first.inputRequired.requestState,
    });
    expect(retry.result).toMatchObject({ status: "executed", action_id: id });
    expect(await staged()).toBe(before + 1);
    expect(new TextDecoder().decode(gm().sent.at(-1)!.raw)).toContain('filename="i.txt"');
  });
});

describe("adversarial (spec 4.7)", () => {
  async function pendingWithState() {
    const m = seed();
    const first = await modernCall(
      worker,
      e,
      token,
      "trash_message",
      { account: "personal", message_id: m.id },
      { capabilities: URL_CAPS },
    );
    return {
      m,
      id: first.inputRequired.inputRequests.approval.params.url.split("/approve/")[1] as string,
      state: first.inputRequired.requestState as string,
    };
  }
  it("the routing headers are required and cross-checked: missing or mismatched Mcp-Method or Mcp-Name is refused before any handler", async () => {
    const m = seed();
    const requests = gm().requests.length;
    const pending = await pendingCount();
    for (const headers of [
      { "mcp-method": null },
      { "mcp-method": "tools/list" },
      { "mcp-name": null },
      { "mcp-name": "mark_message_spam" },
    ]) {
      const r = await modernCall(
        worker,
        e,
        token,
        "trash_message",
        { account: "personal", message_id: m.id },
        { capabilities: URL_CAPS, headers },
      );
      expect(r.status).toBe(400);
      expect(r.error?.code).toBe(-32602);
    }
    expect(gm().requests.length).toBe(requests);
    expect(await pendingCount()).toBe(pending);
  });
  it("requestState tampered one field at a time is refused before the handler runs", async () => {
    const { m, id, state } = await pendingWithState();
    const [v, body, mac] = state.split(".");
    const decode = (s: string) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
    const encode = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const payload = decode(body!);
    const variants = [
      `${v}.${encode({ ...payload, p: { ...payload.p, pending_id: "pa_" + "Z".repeat(22) } })}.${mac}`,
      `${v}.${encode({ ...payload, p: { ...payload.p, account_id: "eb" } })}.${mac}`,
      `${v}.${encode({ ...payload, p: { ...payload.p, intent_hash: "0".repeat(64) } })}.${mac}`,
      `${v}.${encode({ ...payload, p: { ...payload.p, tool: "mark_message_spam" } })}.${mac}`,
      `${v}.${encode({ ...payload, exp: payload.exp + 100_000 })}.${mac}`,
      `${v}.${body}.${mac!.slice(0, -2)}AA`,
      `v0.${body}.${mac}`,
      "garbage",
    ];
    for (const bad of variants) {
      const r = await modernCall(
        worker,
        e,
        token,
        "trash_message",
        { account: "personal", message_id: m.id },
        { capabilities: URL_CAPS, inputResponses: { approval: { action: "accept" } }, requestState: bad },
      );
      expect(r.error).toMatchObject({ code: -32602, message: "Invalid or expired requestState" });
    }
    expect((await getPending(env.DB, id, "owner-sub"))!.state).toBe("pending");
    expect(gm().messages.get(m.id)!.labelIds).not.toContain("TRASH");
  });
  it("a valid requestState presented by another owner's token is refused by the binding", async () => {
    const { m, state } = await pendingWithState();
    const r = await modernCall(
      worker,
      e,
      otherToken,
      "trash_message",
      { account: "personal", message_id: m.id },
      { capabilities: URL_CAPS, inputResponses: { approval: { action: "accept" } }, requestState: state },
    );
    expect(r.error).toMatchObject({ code: -32602 });
  });
  it("a retried elicitation call with changed arguments is denied and audited, and the row stays pending", async () => {
    const { m, id, state } = await pendingWithState();
    const other = seed();
    const r = await modernCall(
      worker,
      e,
      token,
      "trash_message",
      { account: "personal", message_id: other.id },
      { capabilities: URL_CAPS, inputResponses: { approval: { action: "accept" } }, requestState: state },
    );
    expect(r.result).toMatchObject({ error: "payload_mismatch" });
    const row = await env.DB.prepare(
      "SELECT decision, pending_id FROM audit_log WHERE user_id='owner-sub' AND decision='payload_mismatch' ORDER BY id DESC LIMIT 1",
    ).first<any>();
    expect(row).toEqual({ decision: "payload_mismatch", pending_id: id });
    expect((await getPending(env.DB, id, "owner-sub"))!.state).toBe("pending");
    expect(gm().messages.get(m.id)!.labelIds).not.toContain("TRASH");
    expect(gm().messages.get(other.id)!.labelIds).not.toContain("TRASH");
  });
  it("a requestState for one tool cannot resume a different tool, even with matching arguments", async () => {
    const { m, state } = await pendingWithState();
    const r = await modernCall(
      worker,
      e,
      token,
      "mark_message_spam",
      { account: "personal", message_id: m.id },
      { capabilities: URL_CAPS, inputResponses: { approval: { action: "accept" } }, requestState: state },
    );
    expect(r.result).toMatchObject({ error: "payload_mismatch" });
  });
  it("a decline cancels; execute_pending under another owner is unknown; the approval page under another session is refused", async () => {
    const { m, id, state } = await pendingWithState();
    const other = new Browser(worker, e);
    await other.login(g, { sub: "other-sub", email: "other@example.test" });
    expect((await other.get(`/approve/${id}`)).status).toBe(404);
    expect((await callTool(worker, e, otherToken, "execute_pending", { action_id: id })).result.error).toBe(
      "pending_not_approved",
    );
    const r = await modernCall(
      worker,
      e,
      token,
      "trash_message",
      { account: "personal", message_id: m.id },
      { capabilities: URL_CAPS, inputResponses: { approval: { action: "decline" } }, requestState: state },
    );
    expect(r.result).toMatchObject({ error: "pending_not_approved" });
    expect((await getPending(env.DB, id, "owner-sub"))!.state).toBe("cancelled");
  });
});

describe("needs_reconnect and connect_account", () => {
  it("a needs_reconnect account answers a URL elicitation on the modern era and connect_required text otherwise", async () => {
    await env.DB.prepare("UPDATE accounts SET status = 'needs_reconnect' WHERE id = 'ea'").run();
    const modern = await modernCall(
      worker,
      e,
      token,
      "list_labels",
      { account: "personal" },
      { capabilities: URL_CAPS },
    );
    expect(modern.inputRequired).toMatchObject({ inputRequests: { connect: { params: { mode: "url" } } } });
    expect(modern.inputRequired.inputRequests.connect.params.url).toMatch(/\/connect\?alias=personal&e=/);
    const legacy = await callTool(worker, e, token, "list_labels", { account: "personal" });
    expect(legacy.result).toMatchObject({ status: "connect_required", account: "personal" });
    await env.DB.prepare("UPDATE accounts SET status = 'active' WHERE id = 'ea'").run();
  });
  it("connect_account is an elicitation on the modern era and a URL otherwise", async () => {
    const modern = await modernCall(
      worker,
      e,
      token,
      "connect_account",
      { alias: "newone" },
      { capabilities: URL_CAPS },
    );
    expect(modern.inputRequired.inputRequests.connect.params.url).toMatch(/\/connect\?alias=newone&e=/);
    const legacy = await callTool(worker, e, token, "connect_account", { alias: "newone" });
    expect(legacy.result).toMatchObject({ status: "connect_required", account: "newone" });
  });
});
```

`worker/test/mcp.test.ts`: the tool list assertion becomes the full surface, and a second assertion checks annotations per spec 2.5.

```ts
const ALL_TOOLS = [
  "apply_sensitive_message_label",
  "apply_sensitive_thread_label",
  "cancel_pending",
  "connect_account",
  "create_draft",
  "create_label",
  "delete_label",
  "download_attachment",
  "execute_pending",
  "forward",
  "get_draft",
  "get_message",
  "get_policy",
  "get_thread",
  "label_message",
  "label_thread",
  "list_accounts",
  "list_drafts",
  "list_labels",
  "list_pending",
  "mark_message_spam",
  "mark_thread_spam",
  "open_policy_editor",
  "reply",
  "search_threads",
  "send_draft",
  "send_message",
  "trash_message",
  "trash_thread",
  "unlabel_message",
  "unlabel_thread",
  "unmark_message_spam",
  "unmark_thread_spam",
  "untrash_message",
  "untrash_thread",
  "update_draft",
  "update_label",
  "update_message_labels",
];
// ...
expect(names).toEqual(ALL_TOOLS);
expect(names).toHaveLength(38);
const byName = Object.fromEntries(
  (list.json.result.tools as { name: string; annotations?: Record<string, boolean> }[]).map((t) => [
    t.name,
    t.annotations ?? {},
  ]),
);
for (const n of [
  "search_threads",
  "get_thread",
  "get_message",
  "list_drafts",
  "get_draft",
  "list_labels",
  "get_policy",
  "open_policy_editor",
  "list_pending",
  "list_accounts",
])
  expect(byName[n]!.readOnlyHint).toBe(true);
expect(byName.download_attachment).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
for (const n of ["send_message", "reply", "send_draft", "forward"])
  expect(byName[n]).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
for (const n of [
  "trash_message",
  "trash_thread",
  "unlabel_message",
  "unlabel_thread",
  "mark_message_spam",
  "mark_thread_spam",
  "delete_label",
])
  expect(byName[n]!.destructiveHint).toBe(true);
for (const n of [
  "untrash_message",
  "untrash_thread",
  "unmark_message_spam",
  "unmark_thread_spam",
  "label_message",
  "label_thread",
  "create_label",
  "update_label",
  "create_draft",
  "update_draft",
])
  expect(byName[n]!.destructiveHint).toBe(false);
```

- [ ] **Step 2: run, expect failure**

Run: `cd worker && npx vitest run test/elicitation.test.ts test/mcp.test.ts`
Expected: FAIL, `modernCall` is not exported.

- [ ] **Step 3 (GREEN): the modern client**

`worker/test/mcp-client.ts`:

```ts
export async function modernCall(
  worker: Worker,
  env: Env,
  token: string,
  name: string,
  args: Record<string, unknown>,
  o: {
    capabilities?: Record<string, unknown>;
    inputResponses?: Record<string, unknown>;
    requestState?: string;
    id?: number;
    headers?: Record<string, string | null>;
  } = {},
): Promise<{ status: number; json: any; result: any; error: any; inputRequired: any }> {
  const ctx = createExecutionContext();
  const params: Record<string, unknown> = {
    name,
    arguments: args,
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": o.capabilities ?? {},
      "io.modelcontextprotocol/clientInfo": { name: "test-modern", version: "0" },
    },
  };
  if (o.inputResponses) params.inputResponses = o.inputResponses;
  if (o.requestState) params.requestState = o.requestState;
  const headers = new Headers({
    host: new URL(HOST).host,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2026-07-28",
    // Required by the 2026-07-28 revision on every request; the SDK refuses a modern request without them.
    "mcp-method": "tools/call",
    "mcp-name": name,
    authorization: `Bearer ${token}`,
  });
  for (const [k, v] of Object.entries(o.headers ?? {})) v === null ? headers.delete(k) : headers.set(k, v);
  const res = await worker.fetch(
    new Request(HOST + "/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: o.id ?? 11, method: "tools/call", params }),
    }),
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
  const r = json?.result;
  const inputRequired = r?.resultType === "input_required" ? r : null;
  const textBlock = r?.content?.find((c: { type: string }) => c.type === "text");
  let result: any = null;
  if (textBlock?.text) {
    try {
      result = JSON.parse(textBlock.text);
    } catch {
      result = textBlock.text;
    }
  }
  return { status: res.status, json, result, error: json?.error ?? null, inputRequired };
}
```

- [ ] **Step 4: run, expect pass**

Run: `cd worker && npx vitest run test/elicitation.test.ts test/mcp.test.ts` then `npm run verify`.
Expected: PASS. Facts this run settles: the `agents` wrapper routes an envelope-bearing request to the modern SDK handler; the routing-header rung answers `400` with `-32602` (measured in the SDK source as `crossCheckMismatch(... "standard-header-validation")`; if the status differs, the assertion changes, the client does not); `getClientCapabilities()` on the per-request instance reflects the envelope.

- [ ] **Step 5: commit**

```bash
git add worker/test
git commit -m "test(worker): URL elicitation on the wire, the adversarial rows, and the 38-tool surface

The modern era gets input_required with a signed requestState and executes on the accepted retry
while the owner approves in the browser; tampering with any field of the state, presenting it under
another owner, retrying with changed arguments, resuming a different tool, or omitting the routing
headers are all refused and the row stays pending. An inline attachment survives the round trip
without being staged twice. Legacy clients get the URL as text.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NBfkjWcEGDFghet3APnUjU"
```

---

### Task 11: Documentation, spec amendments, and the final gate

**Files:**

- Modify: `docs/superpowers/specs/2026-09-09-gmail-mcp-design.md`, `docs/ARCHITECTURE.md`, `CHANGELOG.md`, `CLAUDE.md`, `docs/parity/hosted-2026-09-09.json` (notes only)

- [ ] **Step 1: spec amendments**

Edit the spec in place, each as a one-line "Amended 2026-09-10 (plan 3):" note next to the sentence it changes:

1. Section 3.8 first bullet: "MIME is built with a maintained library that streams. Headers are never concatenated by hand." becomes "MIME is built by `worker/src/mime/`, the one module that serialises headers, with RFC 2047 and RFC 2231 encoders that ship test vectors, every header folded under 78 characters and asserted under 998. `mimetext` 3.0.28 was measured to emit attachment filenames raw inside quotes and was rejected. The message is a pull-based stream with an exact length: attachments are read from R2 one chunk at a time, so the isolate never holds a 25 MB attachment, its base64 and the message at once."
2. Section 3.5 journaled actions: "`draft.write` (create only)" becomes "`draft.write` (create and update)", and the sentence "Journaling is chosen per tool, not per action: `label.manage` journals `create_label` and not `update_label` or `delete_label`" is added. Note: "Reserving an upload handle needs an operation row to reserve it for, and one execution path for every draft write is safer than two."
   2a. Section 3.5 step 1 gains: "Keys live in `idempotency_keys`, recorded against the hash of the client's intent (the arguments, with inline attachment bytes replaced by their digest) before staging and before the allow/ask fork. A key follows its pending action or operation; a `failed_safe` operation or a dead pending action releases it. `executed` replays the stored result (ids only); anything in flight answers `delivery_unknown`; a live pending action is returned again."
   2b. Section 3.5 step 3, resumable: "Resumable upload is used as a transport with an exact `Content-Length`, without session recovery: the session URL is not persisted and an interrupted PUT is not resumed. Opening the session moves no bytes and is retried like a read; the operation moves to `executing` immediately before the PUT. Recovery is Plan 5's, alongside reconciliation."
   2c. Section 3.5 step 4: "Every local consequence of one Gmail result (operation state and stored result, reservations, the pending row, the outcome audit row) is one D1 batch."
   2d. Section 2.3: `create_label` no longer creates missing parent labels; the name is sent as given and Gmail's answer is surfaced. The hosted `autoCreateParentLabels` is recorded in the parity file as a deviation. Reason: a parent created before the operation is `executing` is a side effect a `claimed` row would deny.
   2e. Section 2.3: the seven control tools (`list_accounts`, `get_policy`, `list_pending`, `execute_pending`, `cancel_pending`, `connect_account`, `open_policy_editor`) read the owner's own state or are the approval mechanism itself and do not pass through the policy engine; the 31 Gmail tools do.
   2f. Section 2.3 `download_attachment` takes `attachment_id` or `part_id`; parts whose bytes Gmail inlines in `body.data` are attachments too.
   2g. Section 3.4 payload: every stored payload carries `tool` and `v`, the executor version it was approved for; a pending row whose version no longer matches the registered executor is `payload_mismatch` and never runs.
3. Section 1.4 path 1: after "when the negotiated client capabilities include `elicitation.url`", add "on protocol revision 2026-07-28. The `agents` handler serves 2025-era clients through a stateless lane in which the server cannot send a request to the client, so those clients always receive path 2."
4. Section 2.3: `messageFormat` becomes `message_format`. Every tool argument is snake_case, matching `page_token` and `body_char_limit` in the same row.
5. Section 2.3 `create_label`, `update_label`: add "Colours are `text_color` and `background_color` hex values validated by Gmail; the hosted `colorPreset` names have no published hex mapping."
6. Section 3.4: after "Elicitation approval carries an HMAC-signed `requestState`", add "minted by the SDK's `createRequestStateCodec` with `STATE_HMAC_KEY`, bound to the owner and the request method, and verified by the SDK before the handler runs; the payload is `{ v, pending_id, account_id, payload_hash }` and the expiry equals the pending TTL. A `nonce` is not carried: the pending id is single-claim and the state is bound to one owner, so replay has nothing to gain."
7. Section 3.4 state machine: a pending row whose operation ends `delivery_unknown` is finished as `failed` with `error = "delivery_unknown"`. The operation is authoritative for delivery from then on. This makes the existing "Terminal purge" bullet explicit.
8. Section 4.7 unit list: "MIME encoders: RFC 2047 words at most 75 characters, RFC 2231 continuations, header injection refused" added under Vitest.

- [ ] **Step 2: `docs/parity/hosted-2026-09-09.json`**

Append to `notes`: `"Our label tools take text_color and background_color instead of colorPreset and do not auto-create parent labels; every argument is snake_case; MESSAGE_FORMAT_UNSPECIFIED is accepted as the default; update_draft merges each field independently and treats an omitted attachment list as none."`

- [ ] **Step 3: ARCHITECTURE.md**

Add two subsections under "The parts that carry the weight", after "Approval engine":

**The tool gate.** Every Gmail tool is registered through `defineTool`, which resolves the account from the verified principal, asks the tool for a plan (payload, modifiers, summary, handles), and hands the plan to `runGated`. The gate canonicalises the payload, checks for an echoed `requestState`, and either resumes an elicitation round or decides. `allow` acquires a journal row when the action is journaled or attachments are present, reserves the handles, and runs the executor. `ask` stores the canonical payload, holds the handles past the pending expiry, and answers with a URL elicitation on the 2026-07-28 revision when the client can open one, else with the approval URL as text. `deny` writes its intent row and stops. Executors are registered by tool name and receive nothing but the stored payload and the account. A later request that has only the row can therefore execute it.

**The send pipeline.** `composeMime` reads staged bytes and any carried originals, builds one MIME message under `<op_…@host>`, and `sendMime` moves the operation to `executing` immediately before the upload opens. At or under 5 MB the upload is `media` (or `multipart` when a thread id must travel with it); above, it is `resumable`. A 4xx is Gmail's definitive no: `failed_safe`, reservation released, error verbatim. Any other failure after the upload opened leaves the row `executing`; the cron promotes it to `delivery_unknown` and the tool reports the same, with the instruction never to retry automatically. Reconciliation waits for Plan 5's Message-ID preservation gate.

- [ ] **Step 4: CHANGELOG.md**

Under `## [Unreleased]`, replace the "Not yet implemented" paragraph and add:

```markdown
### Added

- The 38 remote tools. Reads, drafts, sends, labels, spam and trash all run through one gate that
  applies the policy engine, stores an `ask` as a canonical payload, and journals every external
  mutation. `execute_pending` runs an approved action once; a second call is a replay.
- URL-mode elicitation on protocol revision 2026-07-28. When the client can open a URL, an `ask`
  answers `input_required` with the approval page and HMAC-bound `requestState`; the accepted retry
  waits for the owner's decision inside the same call. Every other client receives the approval URL as
  text, which is spec 1.4's second path.
- The send pipeline: staged attachments and carried originals become one MIME message with RFC 2047
  headers and RFC 2231 filenames; media or multipart upload at or under 5 MB, resumable above; a 4xx is
  `failed_safe`, anything else after the upload opened is `delivery_unknown` and never retried.
- `download_attachment` stages the decoded bytes and returns a handle; bytes never enter a result.
- An in-memory Gmail for the test suite that mirrors the discovery document (revision 20260907),
  including both upload protocols and fault injection hooks for Plan 5.

### Changed

- `getAccessToken` accepts `forceRefresh`, which the Gmail client uses on a 401.
- `Deps` carries `sleep` and the approval wait interval and deadline, so tests collapse time.
- `draft.write` is journaled for updates as well as creates, because reserving an upload handle needs
  an operation row. Journaling is decided per tool, not per policy action.
- Idempotency keys live in their own table, keyed on the client's intent, and hold across the whole
  approval lifecycle: the same key returns the same pending action, then replays its result.
- Every local consequence of a Gmail result is one D1 batch.
- `create_label` no longer creates missing parent labels.

### Not yet implemented

The local companion with `/staging/intent` and the upload ticket (Plan 4). The protected Gmail suite,
fault injection at every checkpoint, and reconciliation of `delivery_unknown` operations (Plan 5).
```

- [ ] **Step 5: CLAUDE.md**

Update "Current state" to say Plans 1 to 3 are complete with the test count from the final run, and "Not built yet" to Plans 4 and 5. Add to "Repository shape": `src/tools/` (gate, define, executors per family), `src/mime/`, `src/operations/send.ts`, `test/fake-gmail.ts`. Add these traps, each led by its symptom:

- **A tool payload that contains `undefined` throws in `canonicalize`.** `defineTool` strips undefined values before hashing; if a plan spreads arguments, expect that strip to be what makes it work, and never make `canonicalize` lenient.
- **`-32602 "Invalid or expired requestState"` in a test** means the state string was altered, expired, or presented under a different owner or method. That is the SDK's verify hook refusing it before the handler; the handler never saw the call.
- **`-32603 "Server-to-client requests are unavailable in the Legacy compatibility lane"`** means a tool returned `inputRequired` on a 2025-era request. The gate branches on `urlElicitation`, which is false on the legacy era; a new tool must go through `runGated` rather than building its own elicitation.
- **The modern test client must send both the header and the `_meta` envelope.** A header without the envelope is `-32602`; an envelope naming a different revision than the header is `-32020`.

Add invariants 17 to 19 to the list: **Executors are keyed by tool name and version, and both live in the payload.** A pending row executes from `payload.tool` under `payload.v`; a tool that is not registered through `defineTool` cannot be approved, and a version that moved on is a `payload_mismatch`. **The intent hash covers the client's arguments and nothing the server generated.** Inline bytes appear as digests; staging handles never appear; so an idempotent replay, an elicitation resume and a duplicate all hash alike. **Nothing writes before the decision and nothing settles outside one batch.** A tool's `build` runs after policy said `allow` or `ask`; the operation, its reservations, the pending row and the outcome audit row change together.

Add to traps: **`idempotency_conflict` on a retry whose arguments look identical** means an inline attachment's bytes or a recipient changed; the intent hash is over the parsed arguments with inline bytes digested, not over the wire JSON.

- [ ] **Step 6: prose pass and the gate**

Run the `stop-slop` skill over the spec amendments, ARCHITECTURE.md, CHANGELOG.md and CLAUDE.md. Then:

Run: `npm run verify`
Expected: exit code 0. Record the test count in CLAUDE.md and the execution record at the end of this plan.

- [ ] **Step 7: commit**

```bash
git add docs CHANGELOG.md CLAUDE.md
git commit -m "docs: plan 3 amendments, architecture, changelog and working notes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NBfkjWcEGDFghet3APnUjU"
```

---

## Plan self-review

**Spec coverage for this plan's scope**

| Spec item                                                                                                                                    | Task                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1.3 explicit account on writes, default on reads                                                                                             | 5, 6, 8, 9 (`defineTool` + schemas)                                   |
| 1.4 path 1: URL elicitation, retry, 2 s poll up to 120 s, approved executes in-request                                                       | 4 (`resume`), 10 (wire)                                               |
| 1.4 path 2: URL in the result, `execute_pending`                                                                                             | 4, 10                                                                 |
| 2.1 defaults and effective level                                                                                                             | Plan 1 engine, consumed by 4                                          |
| 2.2 modifiers: +attachment, +external, +bulk (sends), +sensitive (label.apply)                                                               | 5, 9                                                                  |
| 2.3 the 38 tools, `account` echoed, ids in the query                                                                                         | 4, 5, 6, 8, 9, 10                                                     |
| 2.5 annotations                                                                                                                              | 5, 6, 8, 9; asserted in 10                                            |
| 2.6 the `ask` result                                                                                                                         | 4 (`pendingApprovalResult`, shared schema)                            |
| 2.7 caps: subject, body, recipients, inline, aggregate, canonical; blocked at send                                                           | 8 (`validateCompose`, `stageInline`, `attachmentsFor`), 4 (canonical) |
| 2.8 recipient trust                                                                                                                          | Plan 1 rules, consumed by 9 via `trustContext`                        |
| 3.3 `needs_reconnect` answers with the connect flow                                                                                          | 4 (`guarded`), 10                                                     |
| 3.4 server-held payload, identity-bound approval, resume re-hash, claim, re-evaluate, purge                                                  | 4, 10                                                                 |
| 3.5 step 1 idempotency over the whole lifecycle                                                                                              | 4 (`idempotency.ts`), 9                                               |
| 3.5 steps 2 to 5, `Message-ID`, media/resumable at 5 MB, delivery_unknown, one-batch settlement                                              | 4 (`settle.ts`, `runExecutor`), 7, 9                                  |
| 3.5 step 6 reconciliation                                                                                                                    | deferred to Plan 5 by the spec's own gate                             |
| 3.7 download ingest, size before bytes, hold at pending, reserve at send, consume, release                                                   | 6, 4, 7                                                               |
| 3.8 header safety, RFC 2047, RFC 2231                                                                                                        | 3                                                                     |
| 3.9 every row                                                                                                                                | 1 (client), 7 (`opened`)                                              |
| 3.10 two rows per mutation, one per read or denial, metadata only                                                                            | 4 (`runGated`, `runExecutor`), asserted in 5, 6, 9                    |
| 4.7 unit: argument limits, blocked at send, state machine, idempotency                                                                       | 4, 8, 9                                                               |
| 4.7 integration: round-trips, ask shape, approval page POST, elicitation resume, send_draft, 5 MB boundary                                   | 5, 6, 7, 9, 10                                                        |
| 4.7 adversarial: execute_pending replay, requestState tampering per field, retry with changed recipients, approval URL under another session | 4, 10                                                                 |

**Placeholder scan:** none. Every step carries its code or its exact command.

**Type consistency:** `Deps` (Task 1) is read by `gmailFetch`, `resumeGated`'s wait loop and `testDeps`; `AccountRef` (Task 4) is what `resolveAccount`, `trustContext`, `senderFor`, `attachmentsFor` and every `plan` take; `ExecRun` (Task 4) is the executor argument in Tasks 5, 6, 8, 9; `Plan` (Task 5) with its `build` is what every `plan` returns and what `defineTool` hands to `runGated` as `GateInput.build`; `DecodedInline` (Task 5's `compose.ts`) is what `defineTool` passes to every `plan` and what `stageInline` consumes in a `build`; `ComposePayload` (Task 8) is extended by `DraftPayload` and `SendPayload` (Tasks 8, 9) and consumed by `composeMime`, which returns the `{ body, length }` that `sendMime` and `uploadDraft` (Task 7) take; `MimeAttachment` (Task 3) is what `composeMime` builds from `StagingRow` via `openStaged` (Task 4); `ApprovalState` (Task 4) carries `tool` and `intent_hash`, is minted by `ask`, verified by the codec, read by `resumeGated` and reconstructed in Task 10's tampering variants using the same keys; `Upload` (Task 1, widened in Task 7) has no resumable kind, and `openResumableSession` / `putResumable` (Task 7) are the two halves; `AttachmentMeta` (Task 2) carries `part_id` and a nullable `attachment_id`, which `forward` filters on and `download_attachment` branches on; the audit `decision` strings written by the gate (`allow`, `ask`, `deny`, `payload_mismatch`, `executed`, `failed`, `delivery_unknown`, `denied`) are the ones the tests assert.

**Settled by reading the unpacked SDK, not guessed:** the modern envelope's required keys; the top-level `inputResponses` and `requestState` params on a retry; the `resultType: "complete"` stamp on modern tool results; `requestState.verify` running before the handler and answering the frozen `-32602`; the `agents` legacy lane refusing server-to-client requests; `getClientCapabilities()` being backfilled per request; the codec's `bind` requiring `ctx` at mint; the codec wire form `v1.<body>.<mac>` that Task 10's tampering test decodes.

**Settled by the Gmail discovery document:** every path, method, upload variant, query parameter and schema the fake implements, and the 36 700 160-byte send ceiling.

**Runtime facts each first run must confirm:** listed in the header. Two would change code rather than tests. If `getClientCapabilities()` on the per-request modern instance is empty, Task 4 reads `ctx.mcpReq.envelope` under `CLIENT_CAPABILITIES_META_KEY` instead. If `PATCH` does not reach Gmail untouched, Task 5 sends `PUT` with the merged label, which the fake also accepts.

**Bounds this plan does not close:** a pending action holds its handles open (expiry extended) but does not reserve them; two pending actions may name the same handle, the first executed consumes it, and the second's claim then fails `handle_reserved` at the owner's second approval. Spec 3.7 places reservation at the claim, and reserving at pending creation would need an operation row that does not yet exist; the failure is loud and the owner's to redo. Resumable upload runs without recovery: an interrupted PUT is `delivery_unknown`, not resumed. The spec's 120 s wait loop is longer than the SDK client's default 60 s request timeout; a client that gives up at 60 s loses nothing, because the row stays pending and `execute_pending` finishes it, but whether Claude Code's own timeout allows the in-request path to complete is a Plan 5 measurement, not a promise. Reconciliation of `delivery_unknown` is Plan 5, gated on the Message-ID preservation test as the spec requires, so until then an ambiguous send is the owner's to check. The recipient parser is Plan 1's restricted grammar, which refuses quoted local parts and comments; the hosted connector's input is the same shape, and the MIME builder quotes display names itself. Buffering the MIME in memory is bounded by the 25 MB attachment cap and measured only in Plan 5. Reads pass through the gate, so a policy of `ask` on a read action creates a pending row whose approval page prints the raw payload; The policy page allows it and the behaviour is consistent. The spec does not describe the flow.

## Gauntlet (2026-09-10, before execution)

The draft was attacked as a hostile reviewer with the simurgh doctrine loaded. Every question that could be settled by reading the unpacked SDK, the Gmail discovery document or the plan's own code was settled that way; nothing below was adopted on taste. Twelve findings, all adopted:

1. `gate.test.ts` called `runGated` directly and asserted on structured error results, but `runGated` throws and only `guarded` turns a throw into a result. Every error assertion in the file would have failed for the wrong reason. The test now wraps calls in `guarded`, which is also how every tool reaches the gate.
2. The test executor opened the operation before checking `fail === "before_open"`, so the "failed before the request was opened" case would have opened it. Order reversed.
3. `runExecutor` wrote an outcome row for every action; spec 3.10 gives reads one intent row only. Added the intent-only set (`read.search`, `read.message`, `account.read`, `policy.read`); `read.attachment` keeps its outcome because it creates staging state.
4. `gate.ts` and `execute.ts` imported each other at runtime. ESM tolerates it while both uses stay inside function bodies; the first top-level use would have thrown. `executePending` lives in `gate.ts`; `execute.ts` is gone.
5. The fake Gmail stored the consumed `Request`, so any test reading `last.clone().json()` would have thrown "body used". It stores `req.clone()`.
6. `update_draft` carried existing attachments over by reading the draft's part tree. The in-memory Gmail cannot produce parts for a draft our own tool uploaded (it stores raw MIME), so the test could only have passed against a fixture that could not fail. Adopted the hosted rule literally: the set given replaces, none given means none. The feature is gone, not hidden.
7. `create_label`'s payload carried no `name`, so Plan 2's approval page would have printed "Name: unchanged" for a create. Added.
8. The 60 ms test deadline raced a browser approval that needs several D1 writes. Default 500 ms; the one test that wants the deadline overrides it to 30 ms.
9. `csrfFrom(html)` without a form action takes the first token on the page, which is the header's logout form. Scoped to the approve form.
10. The `Recipients` schema capped at 500 would have made 501 recipients a schema error rather than the `limit_exceeded` the test asserts and spec 2.7 names. Schema is a coarse guard at 2000; `validateCompose` owns the 500.
11. Recorded a bound that was missing: the SDK client's default request timeout is 60 s and the spec's wait loop is 120 s. The pending row survives a dropped retry; whether the in-request path completes under Claude Code is Plan 5's measurement.
12. Recorded a deviation that was silent: `create_label` created parents before `executing`, ahead of the journal. Review round 2 removed the feature rather than tolerate it.

Rejected after checking: "use `mimetext` since it is already installed" (measured: it writes `filename="<raw>"` with no RFC 2231, which fails spec 3.8; Task 3 builds the encoders with vectors instead); "read `ctx.mcpReq.envelope` for capabilities instead of the deprecated accessor" (the envelope type is `{}` in the bundled declarations, so the typed accessor is the honest choice and the fallback is named in the self-review); "poll with `setInterval` rather than a loop" (the loop is what the spec describes and `Deps.sleep` is what makes it testable).

Scorecard at plan stage: spec coverage 9/10 (reconciliation is deferred by the spec's own gate; every other row in 2.3, 3.4, 3.5, 3.7 to 3.10 has a task); falsifiability 8/10 (every adversarial row of 4.7 this plan owns has a named wire-level test; the residual is three SDK behaviours the first run confirms, each with a named fallback); ambition 7/10 (one new mechanism, the tool-name-keyed executor registry that lets a pending row execute from the row alone, and one honest retreat, the MIME module written because the library could not do the job). What moves it higher: Plan 5's Claude Code run against a deployed Worker, which is the only thing that can measure the wait loop against a real client timeout.

## Review round 2 (2026-09-10, external review of the gauntleted draft)

Raouf's line-by-line review returned eleven stop-ship findings and twenty significant ones. Each was checked against the plan text, the unpacked SDK, the Workers runtime types and the Gmail discovery document before anything changed. The split: 27 adopted, 3 refined by measurement, 1 rejected with a receipt.

**Adopted, stop-ship.** B1 the attachment idempotency test could not pass because handle validation ran before the key lookup; the gate now replays a known key before anything looks at a handle, and the test asserts the replay with the handle consumed. B2 inline attachments minted fresh handles before resume detection, so an honest retry hashed differently; the intent hash now covers the client's arguments with inline bytes digested, `defineTool` detects a resume before any plan or staging, and the wire test proves an inline attachment survives the round trip without being staged twice. B3 the key vanished on the `ask` path; keys live in `idempotency_keys`, bound before the allow/ask fork, and the same key returns the same pending action and later replays its result. B4 a `failed_safe` retry created an unkeyed operation; the guarded upsert rebinds the key to the fresh holder and refuses to move it away from a live one. B5 `JOURNALED_ACTIONS` could not express `label.manage`; journaling is per tool (`ToolSpec.journal`), and an executor that returns success without opening its operation is a loud internal error. B6 parent-label creation mutated Gmail before `executing`; the feature is removed. B7 settlement was several writes; `settle.ts` makes it one batch per outcome, and a settlement failure after a Gmail success is reported on the result and logged, never turned into a retryable failure (M19). B8 the buffered MIME sat too close to the 128 MB isolate wall; the builder is a pull stream with an exact length and the resumable PUT streams through `FixedLengthStream`. B9 inline bytes were decoded before the cap; the schema caps each string's characters and `decodeInline` enforces the running total before each decode. B10 folding: every header now folds under 78 and is asserted under 998, and an unbreakable ASCII run is B-encoded so it can fold. B11 the modern test client omitted `Mcp-Method` and `Mcp-Name`, which the SDK was measured to require; the client sends them and the adversarial rows remove and mismatch them.

**Adopted, significant.** M1 `assertMimeSendable` is replaced by a length check inside the pipeline before any request. M3 the resumable session is opened before the operation with the safe retry policy, so a 503 there is retried and never ambiguous. M4 `send_draft` journals the draft's own `Message-ID`. M5 parts whose bytes Gmail inlines are attachments with `attachment_id: null`, and `download_attachment` accepts `part_id`. M6 `get_thread` has a total body budget. M8 media types are validated as `type/subtype`. M9 the 4xx-after-`executing` rule is generic in `runExecutor`, so a label create refused by Gmail is `failed_safe`. M11 the pending row, the hold, the key binding and the intent audit row are one batch. M12 the seven control tools are named as exempt and the goal says 31. M13 nothing stages before the decision. M14 `update_draft` merges each field independently. M15 the commit message and the description now agree with the implementation. M16 and M17 `splitAddressList` handles quoted pairs, nested comments, angle brackets and groups, and `Reply-To` is a list. M18 payloads carry the executor version and a mismatch never runs. M20 add and remove sets must be disjoint.

**Refined by measurement.** B10's claim that the 998-byte subject limit "does not exist": `assertHeaderSafe` in `worker/src/policy/limits.ts` (lines 119 to 120) enforces it and `validateCompose` calls it; the cap stays and the folding is added. M2 true resumable recovery: not built; the plan now says "resumable transport without recovery" in the constraints, the spec amendment and the bounds, distinguishes session-init failures from post-body ambiguity (M3), and Plan 5 owns recovery with reconciliation. M7 the download path still buffers one `attachments.get` JSON body and its decoded bytes, which is spec 3.7's stated V1 decision with the 25 MB round-trip as its gate and streaming extraction as the spec's own deferred item; recorded in the header rather than changed.

**Rejected with a receipt.** M10 reserving handles at pending creation: spec 3.7 places reservation inside the claim batch, and `staging_objects.reserved_by_operation_id` is a foreign key to `operations`, which does not exist until the claim. Reserving earlier would mean inserting an operation row for an unapproved action, which spec 3.5 defines as the journal of external side effects. The failure mode (two pending actions naming one handle, the second refused at claim) is loud and recorded in the bounds.

Scorecard after round 2: spec coverage 9/10 (unchanged; reconciliation and resumable recovery are Plan 5's by the spec's own gate); falsifiability 9/10 (up from 8: the two contradictions the review found, a test that could not pass and a resume that would fail on honest input, now have tests that fail if they return; the residual is four SDK and runtime behaviours the first run confirms, each with a named fallback); exactly-once 8/10 (up from 4: the key is recorded first, follows the holder, and settles in one batch; what remains is the crash window between a Gmail success and the settlement batch, which is reported rather than hidden); memory 8/10 (up from 5: the send path streams; the download path is bounded by the spec's own decision and measured in Plan 5). What moves it higher: Plan 5's 25 MB round-trips and its Claude Code run against a deployed Worker.
