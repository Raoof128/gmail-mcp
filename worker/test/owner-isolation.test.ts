import type { Modifier } from "@gmail-mcp/shared/actions";
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedUserAndAccount } from "./fixtures";
import { accountById, resolveAccount, trustContext } from "../src/tools/accounts";
import { assertAccount, decide, effectiveLevel, setPolicy } from "../src/policy/engine";
import { cancelPending } from "../src/approval/pending";
import { claimPending } from "../src/approval/claim";
import { ack, extendExpiry, listUploadHandles } from "../src/staging/store";
import { leasedDownload } from "../src/staging/downloads";
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
    const ms = ["+attachment", "+external", "+bulk", "+sensitive"] as const;
    const combos = [[], ...ms.map((m) => [m]), [...ms]] as Modifier[][];
    const rank = { allow: 0, ask: 1, deny: 2 } as const;
    let checked = 0;
    // A default: modifiers raise label.apply's allow to ask.
    for (const modifiers of combos) {
      const d = await decide(env.DB, { userId: A, accountId: "acc-a2", action: "label.apply", modifiers });
      expect(d.level).toBe(modifiers.length > 0 ? "ask" : "allow");
      checked++;
    }
    // An owner's choice: final, and never lowered.
    for (const level of ["allow", "ask", "deny"] as const) {
      await setPolicy(env.DB, { userId: A, accountId: "acc-a2", action: "label.apply", level });
      for (const modifiers of combos) {
        const d = await decide(env.DB, { userId: A, accountId: "acc-a2", action: "label.apply", modifiers });
        expect(d.base).toBe(level);
        expect(rank[d.level]).toBeGreaterThanOrEqual(rank[level]);
        expect(d.level).toBe(level);
        checked++;
      }
    }
    expect(checked).toBe(combos.length * 4);
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

  // Each case below asserts twice: that the reach is refused, and that nothing adjacent moved. The
  // second assertion is the one that catches "refused eventually, but already touched something".
  describe("a refused reach leaves no trace", () => {
    const counts = async () => ({
      audit: (await env.DB.prepare("SELECT count(*) AS n FROM audit_log").first<{ n: number }>())!.n,
      operations: (await env.DB.prepare("SELECT count(*) AS n FROM operations").first<{ n: number }>())!.n,
      admissions: (await env.DB.prepare("SELECT count(*) AS n FROM download_admissions").first<{ n: number }>())!.n,
      streams: (await env.DB.prepare("SELECT count(*) AS n FROM download_streams").first<{ n: number }>())!.n,
      reserved: (await env.DB.prepare(
        "SELECT count(*) AS n FROM staging_objects WHERE reserved_by_operation_id IS NOT NULL",
      ).first<{ n: number }>())!.n,
      consumed: (await env.DB.prepare("SELECT count(*) AS n FROM staging_objects WHERE consumed_at IS NOT NULL").first<{
        n: number;
      }>())!.n,
    });

    const seedStaged = async (handle: string, userId: string, accountId: string, direction: string) => {
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO staging_objects (handle,user_id,account_id,direction,filename,mime,size,sha256,r2_key,created_at,expires_at,cleanup_state)
         VALUES (?,?,?,?,'f.txt','text/plain',3,'${"a".repeat(64)}',?,?,?,'available')`,
      )
        .bind(handle, userId, accountId, direction, `k/${handle}`, now, now + 3_600_000)
        .run();
    };

    it("owner A cannot claim owner B's approved pending action, and B's action stays approved", async () => {
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO pending_actions (id,user_id,account_id,action,modifiers,summary,payload_json,payload_hash,state,created_at,expires_at)
         VALUES ('pa_claimTargetBBBBBBBB',?,'acc-b','send.message','[]','s','{}','h','approved',?,?)`,
      )
        .bind(B, now, now + 600_000)
        .run();
      const before = await counts();
      expect(await code(() => claimPending(env.DB, { id: "pa_claimTargetBBBBBBBB", userId: A }))).toBe(
        "pending_not_approved",
      );
      expect(await counts()).toEqual(before);
      const row = await env.DB.prepare("SELECT state FROM pending_actions WHERE id=?")
        .bind("pa_claimTargetBBBBBBBB")
        .first<{ state: string }>();
      expect(row?.state).toBe("approved");
    });

    it("owner A cannot list owner B's upload handle, and nothing is reserved or consumed", async () => {
      await seedStaged("sh_" + "B".repeat(43), B, "acc-b", "upload");
      const before = await counts();
      expect(
        await code(() =>
          listUploadHandles(env.DB, { handles: ["sh_" + "B".repeat(43)], userId: A, accountId: "acc-a" }),
        ),
      ).toBe("handle_invalid");
      expect(await counts()).toEqual(before);
    });

    it("owner A cannot extend the expiry of owner B's handle", async () => {
      const handle = "sh_" + "C".repeat(43);
      await seedStaged(handle, B, "acc-b", "upload");
      const original = (await env.DB.prepare("SELECT expires_at AS e FROM staging_objects WHERE handle=?")
        .bind(handle)
        .first<{ e: number }>())!.e;
      await extendExpiry(env.DB, [handle], A, "acc-a", original + 86_400_000);
      const after = (await env.DB.prepare("SELECT expires_at AS e FROM staging_objects WHERE handle=?")
        .bind(handle)
        .first<{ e: number }>())!.e;
      expect(after).toBe(original);
    });

    it("owner A cannot lease owner B's download, and no admission row is created", async () => {
      const handle = "sh_" + "D".repeat(43);
      await seedStaged(handle, B, "acc-b", "download");
      const before = await counts();
      expect(await code(() => leasedDownload(env, A, handle))).toBe("handle_invalid");
      expect(await counts()).toEqual(before);
      const forA = await env.DB.prepare(
        "SELECT (SELECT count(*) FROM download_admissions WHERE user_id=?) AS adm, (SELECT count(*) FROM download_streams WHERE user_id=?) AS str",
      )
        .bind(A, A)
        .first<{ adm: number; str: number }>();
      expect(forA).toEqual({ adm: 0, str: 0 });
    });

    it("owner A cannot acknowledge owner B's download, and the object stays unconsumed", async () => {
      const handle = "sh_" + "E".repeat(43);
      await seedStaged(handle, B, "acc-b", "download");
      const before = await counts();
      expect(await ack(env, { handle, userId: A })).toBe(false);
      expect(await counts()).toEqual(before);
      const row = await env.DB.prepare("SELECT consumed_at FROM staging_objects WHERE handle=?")
        .bind(handle)
        .first<{ consumed_at: number | null }>();
      expect(row?.consumed_at).toBeNull();
    });
  });
});
