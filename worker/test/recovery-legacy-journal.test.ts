import { LegacyCoverage } from "./legacy-coverage";
import { afterAll, expect, it } from "vitest";
import { legacyWriterCorpus } from "./fixtures/legacy-writer-corpus";
import { seedRecovery } from "./recovery-fixtures";
import { testEnv } from "./test-env";
import { settleDirect } from "../src/operations/recovery-state";
import { seedUserAndAccount } from "./fixtures";

const sites = legacyWriterCorpus.filter((s) => s.file === "worker/src/operations/journal.ts");
for (const site of sites.filter((s) => s.verb.startsWith("INSERT"))) {
  it(`executes captured journal insertion at line ${site.line} with legacy protocol defaults`, async () => {
    const e = testEnv(),
      id = `journal-${site.line}`,
      now = Date.now();
    await seedUserAndAccount(e.DB, { userId: id, accountId: id, alias: "journal" });
    const bindings = [id, id, id, "send.message", ...(site.line === "44" ? ["key"] : []), "payload", now, now];
    const statement = e.DB.prepare(site.sql).bind(...bindings);
    expect((await statement.run()).meta.changes).toBe(1);
    expect(
      await e.DB.prepare(
        "SELECT settlement_protocol,byte_admitted,state,payload_hash,idempotency_key FROM operations WHERE id=?",
      )
        .bind(id)
        .first(),
    ).toEqual({
      settlement_protocol: 1,
      byte_admitted: 0,
      state: "claimed",
      payload_hash: "payload",
      idempotency_key: site.line === "44" ? "key" : null,
    });
    if (site.line === "44") {
      expect((await statement.run()).meta.changes).toBe(0);
      expect(await e.DB.prepare("SELECT count(*) n FROM operations WHERE user_id=?").bind(id).first("n")).toBe(1);
    }
    coverage.record(site);
  });
}
const transition = sites.find((s) => s.line === "73")!;
// Exactly the dynamic placeholder expansion used by the pinned transition implementation.
function sql(from: string[]) {
  return transition.sql.replace('${from.map(() => "?").join(",")}', from.map(() => "?").join(","));
}
for (const from of [["executing"], ["claimed", "executing"]]) {
  for (const protocol of [1, 2] as const) {
    it(`executes captured journal transition with ${from.length} predicates on protocol ${protocol}`, async () => {
      const e = testEnv(),
        id = `journal-transition-${protocol}-${from.length}`;
      await seedRecovery(e, id, { linked: true, protocol });
      const before = await e.DB.prepare("SELECT * FROM operations WHERE id=?").bind(id).first();
      const statement = e.DB.prepare(sql(from)).bind(
        "delivery_unknown",
        Date.now(),
        "provider-id",
        "rfc-id",
        id,
        ...from,
      );
      if (protocol === 2) {
        await expect(statement.run()).rejects.toThrow("settlement transition permit required");
        expect(await e.DB.prepare("SELECT * FROM operations WHERE id=?").bind(id).first()).toEqual(before);
        await settleDirect(e, id, {
          gmail_result_id: "winner",
          message: { id: "winner", thread_id: "thread", label_ids: ["SENT"] },
        });
        const winner = await e.DB.prepare("SELECT * FROM operations WHERE id=?").bind(id).first();
        expect((await statement.run()).meta.changes).toBe(0);
        await expect(
          e.DB.prepare(sql(["executed"]))
            .bind("delivery_unknown", Date.now(), "replacement", null, id, "executed")
            .run(),
        ).rejects.toThrow("settlement transition permit required");
        expect(await e.DB.prepare("SELECT * FROM operations WHERE id=?").bind(id).first()).toEqual(winner);
      } else {
        expect((await statement.run()).meta.changes).toBe(1);
        expect(
          await e.DB.prepare("SELECT state,gmail_result_id,rfc822_message_id FROM operations WHERE id=?")
            .bind(id)
            .first(),
        ).toEqual({ state: "delivery_unknown", gmail_result_id: "provider-id", rfc822_message_id: "rfc-id" });
      }
      coverage.record(transition);
    });
  }
}
it("preserves both independently captured duplicate insertion sites", () => {
  expect(sites.map((s) => s.line)).toEqual(["35", "44", "73", "99"]);
  expect(sites.find((s) => s.line === "35")!.sha256).toBe(sites.find((s) => s.line === "99")!.sha256);
});

const coverage = new LegacyCoverage("journal");
afterAll(() => coverage.verify());
