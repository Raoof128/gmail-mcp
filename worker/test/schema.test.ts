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
