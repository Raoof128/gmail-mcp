import { LegacyCoverage } from "./legacy-coverage";
import { afterAll, expect, it } from "vitest";
import { legacyWriterCorpus } from "./fixtures/legacy-writer-corpus";
import { seedRecovery } from "./recovery-fixtures";
import { testEnv } from "./test-env";
import { settleDirect } from "../src/operations/recovery-state";
function captured(file: string, line: string) {
  const site = legacyWriterCorpus.find((s) => s.file === `worker/src/${file}.ts` && s.line === line);
  if (!site) throw new Error("missing captured site");
  return site.sql;
}
for (const line of ["54", "163", "175", "182", "195"]) {
  it(`executes captured pending site ${line} on matched legacy fixtures`, async () => {
    const e = testEnv(),
      id = `pending-${line}`,
      now = Date.now();
    await seedRecovery(e, id, { linked: true, protocol: 1 });
    const pending = `${id}-pending`;
    let binds: unknown[];
    if (line === "54")
      binds = [`${id}-new`, id, id, "send.message", "[]", "{}", "hash", "intent", "key", "fixture", now, now + 60000];
    else if (line === "163") binds = ["executed", null, now, pending];
    else {
      if (line === "195")
        await expect(e.DB.prepare(captured("approval/pending", line)).bind(pending, now).run()).rejects.toThrow(
          "CHECK constraint failed",
        );
      await e.DB.prepare("UPDATE pending_actions SET state='pending' WHERE id=?").bind(pending).run();
      binds =
        line === "175" ? [now, "browser", pending, id, now] : line === "182" ? [pending, id, now] : [pending, now];
    }
    const result = await e.DB.prepare(captured("approval/pending", line))
      .bind(...binds)
      .run();
    expect(result.success).toBe(true);
    if (line !== "195") expect(result.meta.changes).toBe(1);
    const row = await e.DB.prepare("SELECT state,payload_json FROM pending_actions WHERE id=?")
      .bind(line === "54" ? `${id}-new` : pending)
      .first();
    expect(row).toMatchObject({
      state:
        line === "54" || line === "195"
          ? "pending"
          : line === "163"
            ? "executed"
            : line === "175"
              ? "approved"
              : "denied",
    });
    if (line === "163" || line === "182") expect(row?.payload_json).toBeNull();
    coverage.record(legacyWriterCorpus.find((s) => s.file === "worker/src/approval/pending.ts" && s.line === line)!);
  });
}
for (const variant of ["approve", "deny", "cancel"] as const) {
  it(`executes the original dynamic pending ${variant} expansion`, async () => {
    const e = testEnv(),
      id = `pending-dynamic-${variant}`,
      now = Date.now();
    await seedRecovery(e, id, { linked: true, protocol: 1 });
    await e.DB.prepare("UPDATE pending_actions SET state='pending' WHERE id=?").bind(`${id}-pending`).run();
    const from = variant === "cancel" ? ["pending", "approved"] : ["pending"];
    const extra =
      variant === "approve" ? ", approved_at = ?, approved_via = ?" : ", payload_json = NULL, summary = 'redacted'";
    const sql = captured("approval/pending", "123")
      .replace("${extra}", extra)
      .replace('${from.map(() => "?").join(",")}', from.map(() => "?").join(","));
    const to = variant === "approve" ? "approved" : variant === "deny" ? "denied" : "cancelled";
    const params = [to, ...(variant === "approve" ? [now, "browser"] : []), `${id}-pending`, id, ...from, now];
    expect(
      (
        await e.DB.prepare(sql)
          .bind(...params)
          .run()
      ).meta.changes,
    ).toBe(1);
    expect(
      await e.DB.prepare("SELECT state FROM pending_actions WHERE id=?").bind(`${id}-pending`).first("state"),
    ).toBe(to);
    expect(
      (
        await e.DB.prepare(sql)
          .bind(...params)
          .run()
      ).meta.changes,
    ).toBe(0);
    coverage.record(legacyWriterCorpus.find((s) => s.file === "worker/src/approval/pending.ts" && s.line === "123")!);
  });
}
it("executes every original claim statement and its reservation batch", async () => {
  const e = testEnv(),
    id = "claim-original",
    now = Date.now(),
    next = `${id}-next`;
  await seedRecovery(e, id, { linked: true, protocol: 1 });
  await e.DB.prepare("UPDATE pending_actions SET state='approved',operation_id=NULL WHERE id=?")
    .bind(`${id}-pending`)
    .run();
  await e.DB.prepare("UPDATE staging_objects SET reserved_by_operation_id=NULL WHERE user_id=?").bind(id).run();
  const handle = await e.DB.prepare("SELECT handle FROM staging_objects WHERE user_id=?")
    .bind(id)
    .first<string>("handle");
  await expect(e.DB.prepare(captured("approval/claim", "57")).bind(`${id}-pending`, next).run()).rejects.toThrow(
    "CHECK constraint failed",
  );
  const batch = [
    e.DB.prepare(captured("approval/claim", "45")).bind(
      next,
      id,
      id,
      "send.message",
      `${id}-pending`,
      "hash",
      now,
      now,
    ),
    e.DB.prepare(captured("approval/claim", "51")).bind(next, now, `${id}-pending`, id, now),
    e.DB.prepare(captured("approval/claim", "57")).bind(`${id}-pending`, next),
    e.DB.prepare(captured("staging/store", "217").replace('${o.handles.map(() => "?").join(",")}', "?")).bind(
      next,
      handle,
      id,
      id,
      now,
    ),
    e.DB.prepare(captured("staging/store", "224")).bind(next, 1),
  ];
  const results = await e.DB.batch(batch);
  expect(results.map((r) => r.meta.changes)).toEqual([1, 1, 0, 1, 0]);
  expect(
    await e.DB.prepare("SELECT operation_id,state FROM pending_actions WHERE id=?").bind(`${id}-pending`).first(),
  ).toEqual({ operation_id: next, state: "executing" });
  expect(
    await e.DB.prepare("SELECT reserved_by_operation_id FROM staging_objects WHERE handle=?")
      .bind(handle)
      .first("reserved_by_operation_id"),
  ).toBe(next);
  await expect(e.DB.prepare(captured("staging/store", "224")).bind(next, 2).run()).rejects.toThrow(
    "CHECK constraint failed",
  );
  for (const site of legacyWriterCorpus.filter((s) => s.file === "worker/src/approval/claim.ts")) coverage.record(site);
});
for (const phase of ["before", "after"] as const) {
  it(`preserves enrolled pending and idempotency state ${phase} a winner`, async () => {
    const e = testEnv(),
      id = `pending-fence-${phase}`,
      now = Date.now();
    await seedRecovery(e, id, { linked: true });
    if (phase === "after")
      await settleDirect(e, id, {
        gmail_result_id: "winner",
        message: { id: "winner", thread_id: "thread", label_ids: ["SENT"] },
      });
    const pending = await e.DB.prepare("SELECT * FROM pending_actions WHERE id=?").bind(`${id}-pending`).first();
    const key = await e.DB.prepare("SELECT * FROM idempotency_keys WHERE user_id=?").bind(id).first();
    const finish = e.DB.prepare(captured("approval/pending", "163")).bind("failed", "legacy", now, `${id}-pending`);
    if (phase === "before") await expect(finish.run()).rejects.toThrow("pending settlement permit required");
    else expect((await finish.run()).meta.changes).toBe(0);
    const rebind = e.DB.prepare(captured("tools/idempotency", "49")).bind(
      id,
      id,
      id,
      "send_message",
      "i",
      null,
      id,
      now,
      now,
    );
    expect((await rebind.run()).meta.changes).toBe(0);
    expect(await e.DB.prepare("SELECT * FROM pending_actions WHERE id=?").bind(`${id}-pending`).first()).toEqual(
      pending,
    );
    expect(await e.DB.prepare("SELECT * FROM idempotency_keys WHERE user_id=?").bind(id).first()).toEqual(key);
  });
}
it("executes original key binding and assertion with matched positive and negative controls", async () => {
  const e = testEnv(),
    id = "legacy-key-control",
    now = Date.now();
  await seedRecovery(e, id, { linked: true, protocol: 1 });
  const assertion = captured("tools/idempotency", "62");
  const binds = [id, id, "new-key", `${id}-pending`, `${id}-pending`, null, null];
  await expect(
    e.DB.prepare(assertion)
      .bind(...binds)
      .run(),
  ).rejects.toThrow("CHECK constraint failed");
  const insert = e.DB.prepare(captured("tools/idempotency", "49")).bind(
    id,
    id,
    "new-key",
    "send_message",
    "intent",
    `${id}-pending`,
    null,
    now,
    now,
  );
  expect((await insert.run()).meta.changes).toBe(1);
  await e.DB.prepare(assertion)
    .bind(...binds)
    .run();
  expect(
    await e.DB.prepare("SELECT pending_id,operation_id FROM idempotency_keys WHERE user_id=? AND key='new-key'")
      .bind(id)
      .first(),
  ).toEqual({ pending_id: `${id}-pending`, operation_id: null });
  for (const site of legacyWriterCorpus.filter((s) => s.file === "worker/src/tools/idempotency.ts"))
    coverage.record(site);
});

const coverage = new LegacyCoverage("approval");
afterAll(() => coverage.verify());
