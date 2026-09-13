import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { seedUserAndAccount } from "./fixtures";
beforeAll(async () => {
  await seedUserAndAccount(env.DB, { userId: "transfer-owner", accountId: "transfer-account", alias: "work" });
  await seedUserAndAccount(env.DB, { userId: "other-owner", accountId: "other-account", alias: "work" });
});
describe("transfer persistence", () => {
  it("enforces owner/account pairing in the database", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO upload_transfers (user_id,id,account_id,account_alias,metadata_json,intent_hash,state,created_at,authority_until,retain_until) VALUES (?,?,?,?,?,?,'authorized',0,100,200)",
      )
        .bind("transfer-owner", "tr_bad", "other-account", "work", "{}", "hash")
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });
  it("allows only one active generation per transfer", async () => {
    await env.DB.prepare(
      "INSERT INTO upload_transfers (user_id,id,account_id,account_alias,metadata_json,intent_hash,state,created_at,authority_until,retain_until) VALUES (?,?,?,?,?,?,'authorized',0,100,200)",
    )
      .bind("transfer-owner", "tr_one", "transfer-account", "work", "{}", "hash")
      .run();
    const add = (n: number) =>
      env.DB.prepare(
        "INSERT INTO upload_generations (user_id,transfer_id,account_id,generation,ticket_id,state,issued_until,r2_key,reserved_bytes,created_at) VALUES (?,?,?,?,?,'issued',100,?,0,0)",
      )
        .bind("transfer-owner", "tr_one", "transfer-account", n, `ticket_${n}`, `stg/test/${n}`)
        .run();
    await add(1);
    await expect(add(2)).rejects.toThrow(/UNIQUE/);
    await env.DB.prepare("UPDATE upload_generations SET state='expired' WHERE transfer_id='tr_one'").run();
    await add(2);
  });
});
