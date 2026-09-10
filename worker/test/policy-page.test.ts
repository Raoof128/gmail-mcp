import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index";
import { Browser, csrfFrom } from "./browser";
import { FakeGoogle } from "./fake-google";
import { testEnv, testDeps } from "./test-env";
import { seedUserAndAccount } from "./fixtures";
import { applyPolicyEdit, effectiveLevel } from "../src/policy/engine";
import type { Level } from "@gmail-mcp/shared/actions";

let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker(testDeps(g));
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
