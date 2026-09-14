import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { insertOperation, seedUserAndAccount } from "./fixtures";

async function operation(id: string) {
  await seedUserAndAccount(env.DB, { userId: id, accountId: id, alias: "recovery" });
  await insertOperation(env.DB, id, id, id, "claimed");
}

function permit(id: string, purpose: string) {
  return env.DB.prepare("INSERT INTO settlement_permits(operation_id,token,purpose) VALUES(?,?,?)").bind(
    id,
    id,
    purpose,
  );
}
async function mark(id: string) {
  await env.DB.batch([
    permit(id, "begin"),
    env.DB.prepare("UPDATE operations SET settlement_protocol=2,state='executing',byte_admitted=1 WHERE id=?").bind(id),
    env.DB.prepare("DELETE FROM settlement_permits WHERE operation_id=?").bind(id),
  ]);
}

it("installs protocol columns without enrolling legacy operations", async () => {
  await operation("legacy");
  expect(
    await env.DB.prepare("SELECT settlement_protocol,byte_admitted FROM operations WHERE id='legacy'").first(),
  ).toEqual({ settlement_protocol: 1, byte_admitted: 0 });
});

it("refuses old updates and outcome inserts on marked operations", async () => {
  await operation("marked");
  await mark("marked");
  await expect(env.DB.prepare("UPDATE operations SET state='executed' WHERE id='marked'").run()).rejects.toThrow();
  await expect(
    env.DB.prepare(
      "INSERT INTO audit_log(ts,user_id,account_id,phase,decision,operation_id) VALUES(0,'marked','marked','outcome','executed','marked')",
    ).run(),
  ).rejects.toThrow();
  expect(await env.DB.prepare("SELECT state FROM operations WHERE id='marked'").first("state")).toBe("executing");
});

it("rolls back the permit and all effects when a later statement fails", async () => {
  await operation("rollback");
  await expect(
    env.DB.batch([
      permit("rollback", "begin"),
      env.DB.prepare(
        "UPDATE operations SET settlement_protocol=2,state='executing',byte_admitted=1 WHERE id='rollback'",
      ),
      env.DB.prepare("INSERT INTO _assert VALUES(1)"),
    ]),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT settlement_protocol FROM operations WHERE id='rollback'").first("settlement_protocol"),
  ).toBe(1);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM settlement_permits").first("n")).toBe(0);
});

it("allows one success and prevents a second audit under the same permit", async () => {
  await operation("winner");
  await mark("winner");
  const audit = () =>
    env.DB.prepare(
      "INSERT INTO audit_log(ts,user_id,account_id,phase,decision,operation_id) VALUES(0,'winner','winner','outcome','executed','winner')",
    );
  await expect(
    env.DB.batch([
      permit("winner", "success"),
      env.DB.prepare("UPDATE operations SET state='executed' WHERE id='winner'"),
      audit(),
      audit(),
      env.DB.prepare("DELETE FROM settlement_permits WHERE operation_id='winner'"),
    ]),
  ).rejects.toThrow();
  expect(await env.DB.prepare("SELECT state FROM operations WHERE id='winner'").first("state")).toBe("executing");
  await env.DB.batch([
    permit("winner", "success"),
    env.DB.prepare("UPDATE operations SET state='executed' WHERE id='winner'"),
    audit(),
    env.DB.prepare("DELETE FROM settlement_permits WHERE operation_id='winner'"),
  ]);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE operation_id='winner'").first("n")).toBe(1);
});
