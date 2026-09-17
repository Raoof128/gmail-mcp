import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index";
import { Browser } from "./browser";
import { FakeGoogle } from "./fake-google";
import { testEnv, testDeps } from "./test-env";
import { seedUserAndAccount } from "./fixtures";
import { auditIntent } from "../src/audit/log";

let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker(testDeps(g));
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
    // Scope the leak check to the rendered table. Searching the whole document matches the random
    // base64url of a CSRF token that happens to contain the account id as a substring, which made
    // this assertion fail roughly once in a few thousand runs for no real reason.
    const table = all.slice(all.indexOf("<table"), all.indexOf("</table>"));
    expect(all).toContain("send_message");
    expect(all).toContain("trash_message");
    expect(all).toContain("recipients=2");
    expect(table).not.toContain("au3");
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
    worker.scheduled({ scheduledTime: Date.now(), cron: "*/5 * * * *", noRetry() {} }, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM oauth_states WHERE id = 'st_old'").first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });
});
