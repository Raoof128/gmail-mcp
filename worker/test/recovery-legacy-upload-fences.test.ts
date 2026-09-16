import { expect, it } from "vitest";
import { legacyWriterCorpus } from "./fixtures/legacy-writer-corpus";
import { seedRecovery } from "./recovery-fixtures";
import { testEnv } from "./test-env";
import { settleDirect } from "../src/operations/recovery-state";
const cases = [
  ["transfers", "499"],
  ["recovery", "39"],
  ["upload", "154"],
  ["upload", "218"],
  ["upload", "273"],
  ["transfers", "414"],
  ["transfers", "504"],
  ["recovery", "44"],
  ["upload", "226"],
  ["upload", "282"],
] as const;
for (const [file, line] of cases) {
  for (const phase of ["before", "after"] as const) {
    it(`checks original upload writer ${file}:${line} against send settlement ${phase} a winner`, async () => {
      const e = testEnv(),
        id = `upload-fence-${file}-${line}-${phase}`,
        now = Date.now();
      await seedRecovery(e, id, { linked: true });
      if (phase === "after")
        await settleDirect(e, id, {
          gmail_result_id: "winner",
          message: { id: "winner", thread_id: "thread", label_ids: ["SENT"] },
        });
      const snapshot = async () => ({
        operation: await e.DB.prepare("SELECT * FROM operations WHERE id=?").bind(id).first(),
        pending: await e.DB.prepare("SELECT * FROM pending_actions WHERE id=?").bind(`${id}-pending`).first(),
        key: await e.DB.prepare("SELECT * FROM idempotency_keys WHERE user_id=?").bind(id).first(),
        storage: await e.DB.prepare("SELECT * FROM staging_objects WHERE user_id=?").bind(id).first(),
        audit: (await e.DB.prepare("SELECT * FROM audit_log WHERE operation_id=? ORDER BY id").bind(id).all()).results,
      });
      const initial = await snapshot();
      const site = legacyWriterCorpus.find((s) => s.file === `worker/src/staging/${file}.ts` && s.line === line)!;
      const binds =
        line === "414"
          ? [id, now, `${id}-pending`, id, now]
          : line === "504"
            ? ["failed", "fixture", `${id}-pending`]
            : line === "44"
              ? [`${id}-pending`]
              : line === "226"
                ? [now, `${id}-pending`, id]
                : line === "282"
                  ? [`${id}-pending`, id]
                  : [now, id];
      const statement = e.DB.prepare(site.sql).bind(...binds);
      if (phase === "before" && ["226", "282"].includes(line))
        await expect(statement.run()).rejects.toThrow("pending settlement permit required");
      else expect((await statement.run()).meta.changes).toBe(0);
      expect(await snapshot()).toEqual(initial);
    });
  }
}
