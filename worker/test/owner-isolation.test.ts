import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedUserAndAccount } from "./fixtures";
import { accountById, resolveAccount, trustContext } from "../src/tools/accounts";
import { assertAccount, decide, effectiveLevel, setPolicy } from "../src/policy/engine";
import { cancelPending } from "../src/approval/pending";
import { GmailMcpError } from "@gmail-mcp/shared/errors";

// Owner A and owner B each hold an account. Every case below is owner A reaching for something that
// belongs to owner B, or for one of their own rows through the wrong door. The point is that the
// refusal comes from the query or a constraint, not from a check a caller has to remember.
const A = "owner-a";
const B = "owner-b";

beforeAll(async () => {
  await seedUserAndAccount(env.DB, { userId: A, accountId: "acc-a", alias: "personal", isDefault: true });
  await seedUserAndAccount(env.DB, { userId: A, accountId: "acc-a2", alias: "work" });
  await seedUserAndAccount(env.DB, { userId: B, accountId: "acc-b", alias: "personal", isDefault: true });
  await env.DB.prepare(
    "INSERT INTO accounts (id,user_id,alias,google_sub,google_email,send_as,org_domains,scopes,status,is_default,created_at) VALUES ('acc-rev',?,'revoked','sub-rev','rev@example.test','[]',NULL,'gmail.modify','revoked',0,?)",
  )
    .bind(A, Date.now())
    .run();
});

const code = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
    return "NO ERROR";
  } catch (e) {
    return e instanceof GmailMcpError ? e.code : `other:${(e as Error).message}`;
  }
};

describe("owner and account isolation", () => {
  it("owner A cannot reach owner B's account by id", async () => {
    expect(await code(() => accountById(env, A, "acc-b"))).toBe("account_not_found");
    expect((await accountById(env, B, "acc-b")).alias).toBe("personal");
  });

  it("owner A cannot reach owner B's account by alias, even though the alias matches their own", async () => {
    const mine = await resolveAccount(env, A, "personal");
    expect(mine.id).toBe("acc-a");
    const theirs = await resolveAccount(env, B, "personal");
    expect(theirs.id).toBe("acc-b");
    expect(mine.id).not.toBe(theirs.id);
  });

  it("assertAccount refuses a foreign account id", async () => {
    expect(await code(() => assertAccount(env.DB, A, "acc-b"))).toBe("account_not_found");
    await expect(assertAccount(env.DB, A, "acc-a")).resolves.toBeUndefined();
  });

  it("a default-account read never crosses to another owner", async () => {
    expect((await resolveAccount(env, A)).id).toBe("acc-a");
    expect((await resolveAccount(env, B)).id).toBe("acc-b");
  });

  // The status filter is not in the WHERE clause, so this proves the refusal really is on every path
  // that returns an account rather than on the ones that happened to spell it out.
  it("a revoked account is refused through explicit alias and through id", async () => {
    expect(await code(() => resolveAccount(env, A, "revoked"))).toBe("account_needs_reconnect");
    expect(await code(() => accountById(env, A, "acc-rev"))).toBe("account_needs_reconnect");
  });

  it("policy written for one account does not leak to another account of the same owner", async () => {
    await setPolicy(env.DB, { userId: A, accountId: "acc-a", action: "send.message", level: "deny" });
    expect(await effectiveLevel(env.DB, A, "acc-a", "send.message")).toBe("deny");
    expect(await effectiveLevel(env.DB, A, "acc-a2", "send.message")).toBe("ask");
    expect(await effectiveLevel(env.DB, B, "acc-b", "send.message")).toBe("ask");
  });

  it("an owner-wide policy applies to the owner's accounts and to nobody else's", async () => {
    await setPolicy(env.DB, { userId: A, accountId: null, action: "trash.move", level: "deny" });
    expect(await effectiveLevel(env.DB, A, "acc-a2", "trash.move")).toBe("deny");
    expect(await effectiveLevel(env.DB, B, "acc-b", "trash.move")).toBe("ask");
  });

  it("an account row beats the owner-wide row for the same action", async () => {
    await setPolicy(env.DB, { userId: A, accountId: null, action: "label.manage", level: "deny" });
    await setPolicy(env.DB, { userId: A, accountId: "acc-a", action: "label.manage", level: "allow" });
    expect(await effectiveLevel(env.DB, A, "acc-a", "label.manage")).toBe("allow");
    expect(await effectiveLevel(env.DB, A, "acc-a2", "label.manage")).toBe("deny");
  });

  it("setPolicy refuses to write a per-account row for a foreign account", async () => {
    expect(
      await code(() => setPolicy(env.DB, { userId: A, accountId: "acc-b", action: "send.message", level: "allow" })),
    ).toBe("account_not_found");
  });

  it("no modifier combination lowers a level for any owner", async () => {
    await setPolicy(env.DB, { userId: A, accountId: "acc-a2", action: "label.apply", level: "allow" });
    const plain = await decide(env.DB, { userId: A, accountId: "acc-a2", action: "label.apply", modifiers: [] });
    const raised = await decide(env.DB, {
      userId: A,
      accountId: "acc-a2",
      action: "label.apply",
      modifiers: ["+sensitive"],
    });
    expect(plain.level).toBe("allow");
    expect(raised.level).toBe("ask");
    expect(raised.base).toBe("allow");
  });

  it("cancel_pending cannot withdraw another owner's pending action", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO pending_actions (id,user_id,account_id,action,modifiers,summary,payload_json,payload_hash,state,created_at,expires_at)
       VALUES ('pa_isolationBBBBBBBBBB',?,'acc-b','send.message','[]','s','{}','h','pending',?,?)`,
    )
      .bind(B, now, now + 600_000)
      .run();
    expect(await cancelPending(env.DB, { id: "pa_isolationBBBBBBBBBB", userId: A })).toBe(false);
    const still = await env.DB.prepare("SELECT state FROM pending_actions WHERE id=?")
      .bind("pa_isolationBBBBBBBBBB")
      .first<{ state: string }>();
    expect(still?.state).toBe("pending");
    expect(await cancelPending(env.DB, { id: "pa_isolationBBBBBBBBBB", userId: B })).toBe(true);
  });

  it("the trust context of one account never includes another account's allowlist", async () => {
    await env.DB.prepare("INSERT INTO contact_allowlist (user_id,account_id,pattern) VALUES (?,?,?)")
      .bind(A, "acc-a", "@trusted-a.test")
      .run();
    await env.DB.prepare("INSERT INTO contact_allowlist (user_id,account_id,pattern) VALUES (?,?,?)")
      .bind(B, "acc-b", "@trusted-b.test")
      .run();
    const a = await trustContext(env, A, await accountById(env, A, "acc-a"));
    expect(a.allowlist).toEqual(["@trusted-a.test"]);
    const b = await trustContext(env, B, await accountById(env, B, "acc-b"));
    expect(b.allowlist).toEqual(["@trusted-b.test"]);
  });

  it("the database refuses an allowlist entry for a foreign account", async () => {
    const result = await code(() =>
      env.DB.prepare("INSERT INTO contact_allowlist (user_id,account_id,pattern) VALUES (?,?,?)")
        .bind(A, "acc-b", "@stolen.test")
        .run(),
    );
    expect(result).toMatch(/FOREIGN KEY|constraint/i);
  });

  // A composite foreign key, not a WHERE clause somebody remembered.
  it("the database itself refuses a pending action pointing at a foreign account", async () => {
    const now = Date.now();
    const result = await code(() =>
      env.DB.prepare(
        `INSERT INTO pending_actions (id,user_id,account_id,action,modifiers,summary,payload_json,payload_hash,state,created_at,expires_at)
         VALUES ('pa_crossOwnerAAAAAAAAA',?,'acc-b','send.message','[]','s','{}','h','pending',?,?)`,
      )
        .bind(A, now, now + 600_000)
        .run(),
    );
    expect(result).toMatch(/FOREIGN KEY|constraint/i);
  });
});
