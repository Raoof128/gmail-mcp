import { LegacyCoverage } from "./legacy-coverage";
import { afterAll, expect, it } from "vitest";
import { legacyWriterCorpus } from "./fixtures/legacy-writer-corpus";
import { seedRecovery } from "./recovery-fixtures";
import { testEnv } from "./test-env";
import { settleDirect } from "../src/operations/recovery-state";
const files = ["staging/store", "staging/downloads", "staging/materialization", "staging/budgets"];
const sites = legacyWriterCorpus.filter((s) => files.some((f) => s.file === `worker/src/${f}.ts`));
function expand(sql: string) {
  return sql.replace('${o.handles.map(() => "?").join(",")}', "?").replace('${handles.map(() => "?").join(",")}', "?");
}
for (const site of sites) {
  it(`executes captured staging site ${site.file}:${site.line} with matched rows`, async () => {
    const e = testEnv(),
      id = `staging-${site.file.split("/").at(-1)!.replace(".ts", "")}-${site.line}`,
      now = Date.now();
    await seedRecovery(e, id, { linked: true, protocol: 1 });
    const handle = await e.DB.prepare("SELECT handle FROM staging_objects WHERE user_id=?")
      .bind(id)
      .first<string>("handle");
    let binds: unknown[], table: string, where: string, match: unknown[];
    if (site.file.endsWith("budgets.ts")) {
      binds = [id, "budget", 2, now + 60000];
      table = "staging_recovery_slots";
      where = "user_id=? AND key=?";
      match = [id, "budget"];
    } else if (site.file.endsWith("materialization.ts")) {
      if (site.line === "43")
        await e.DB.prepare("INSERT INTO staging_materializations VALUES(?,?,?,?,?)")
          .bind(id, now + 60000, id, id, 1)
          .run();
      binds = site.line === "29" ? [id, now + 60000, id, id, 1] : [id];
      table = "staging_materializations";
      where = "id=?";
      match = [id];
    } else if (site.file.endsWith("downloads.ts")) {
      await e.DB.prepare(
        "UPDATE staging_objects SET direction='download',download_lease_until=?,reserved_by_operation_id=NULL WHERE handle=?",
      )
        .bind(now + 30000, handle)
        .run();
      if (["47", "59", "62"].includes(site.line))
        await e.DB.prepare("INSERT INTO download_admissions VALUES(?,?,?,?,?,?)")
          .bind(id, handle, id, now, now + 60000, now + 120000)
          .run();
      if (["59", "62"].includes(site.line))
        await e.DB.prepare("INSERT INTO download_streams VALUES(?,?,?,?)")
          .bind(id, id, handle, now + 60000)
          .run();
      if (site.line === "44") {
        binds = [id, handle, id, now, now + 60000, now + 120000];
        table = "download_admissions";
        where = "user_id=? AND handle=?";
        match = [id, handle];
      } else if (site.line === "47" || site.line === "59") {
        binds = site.line === "47" ? [id, id, handle, now + 60000] : [id];
        table = "download_streams";
        where = "id=?";
        match = [id];
      } else if (site.line === "134") {
        binds = [id, handle, id, now, now + 60000];
        table = "staging_acknowledgements";
        where = "user_id=? AND handle=?";
        match = [id, handle];
      } else {
        binds =
          site.line === "50"
            ? [now + 60000, handle, id]
            : site.line === "62"
              ? [handle, id, handle, id]
              : [now, handle, id];
        table = "staging_objects";
        where = "handle=?";
        match = [handle];
      }
    } else {
      table = "staging_objects";
      where = "handle=?";
      match = [handle];
      if (site.line === "99") {
        await e.DB.prepare("INSERT INTO staging_materializations VALUES(?,?,?,?,?)")
          .bind(id, now + 60000, id, id, 1)
          .run();
        binds = [id];
        table = "staging_materializations";
        where = "id=?";
        match = [id];
      } else if (["107", "165", "171", "177"].includes(site.line)) {
        if (site.line !== "107")
          await e.DB.prepare(
            "INSERT INTO staging_ingests(id,user_id,account_id,r2_key,reserved_bytes,lease_until,state,writer_stopped) VALUES(?,?,?,?,?,?,?,?)",
          )
            .bind(
              id,
              id,
              id,
              `fixture/${id}`,
              1,
              now + 60000,
              site.line === "177" ? "debt" : "active",
              site.line === "177" ? 1 : 0,
            )
            .run();
        binds =
          site.line === "107" ? [id, id, id, `fixture/${id}`, 1, now + 60000] : site.line === "171" ? [1, id] : [id];
        table = "staging_ingests";
        where = "id=?";
        match = [id];
      } else if (site.line === "147") {
        binds = [
          `${id}-new`,
          id,
          id,
          "upload",
          `fixture/${id}`,
          "fixture.bin",
          "application/octet-stream",
          1,
          "a".repeat(64),
          null,
          null,
          now,
          now + 60000,
        ];
        match = [`${id}-new`];
      } else if (site.line === "217") {
        await e.DB.prepare("UPDATE staging_objects SET reserved_by_operation_id=NULL WHERE handle=?")
          .bind(handle)
          .run();
        binds = [id, handle, id, id, now];
      } else if (site.line === "224") {
        await expect(e.DB.prepare(site.sql).bind(id, 2).run()).rejects.toThrow("CHECK constraint failed");
        binds = [id, 1];
      } else if (site.line === "240") binds = [now + 86400000, handle, id, id];
      else if (site.line === "275") binds = [now, id];
      else if (site.line === "285") binds = [id];
      else {
        await e.DB.prepare(
          "UPDATE staging_objects SET reserved_by_operation_id=NULL,expires_at=0,cleanup_state=? WHERE handle=?",
        )
          .bind(site.line === "307" ? "deleting" : "available", handle)
          .run();
        binds = site.line === "301" ? [handle, now, now] : [handle];
      }
    }
    const result = await e.DB.prepare(expand(site.sql))
      .bind(...binds)
      .run();
    expect(result.success).toBe(true);
    expect(result.meta.changes).toBe(site.table === "_assert" ? 0 : 1);
    const row = await e.DB.prepare(`SELECT * FROM ${table} WHERE ${where}`)
      .bind(...match)
      .first();
    if (site.verb === "DELETE FROM") expect(row).toBeNull();
    else {
      expect(row).not.toBeNull();
      if (site.file.endsWith("store.ts")) {
        if (site.line === "99") expect(row).toMatchObject({ reserved_bytes: 0 });
        if (["107", "165", "171", "177"].includes(site.line))
          expect(row).toMatchObject({
            state:
              site.line === "107"
                ? "active"
                : site.line === "165"
                  ? "published"
                  : site.line === "171"
                    ? "debt"
                    : "released",
          });
        if (site.line === "217") expect(row).toMatchObject({ reserved_by_operation_id: id });
        if (site.line === "275" || site.line === "285")
          expect(row).toMatchObject({ reserved_by_operation_id: null, consumed_at: site.line === "275" ? now : null });
        if (site.line === "301") expect(row).toMatchObject({ cleanup_state: "deleting" });
        if (site.line === "240") expect(row).toMatchObject({ expires_at: now + 86400000 });
      }
      if (site.file.endsWith("downloads.ts") && ["50", "62"].includes(site.line))
        expect(row).toMatchObject({ download_lease_until: now + 60000 });
      if (site.file.endsWith("downloads.ts") && site.line === "138") expect(row).toMatchObject({ consumed_at: now });
    }
    coverage.record(site);
    // The fixture exercises publication without leaving a live global materializer for the next test.
    if (table === "staging_materializations" && row !== null)
      await e.DB.prepare("DELETE FROM staging_materializations WHERE id=?").bind(id).run();
  });
}
for (const line of ["240", "275", "285", "301"]) {
  for (const phase of ["before", "after"] as const) {
    it(`preserves protocol-2 storage against captured site ${line} ${phase} a winner`, async () => {
      const e = testEnv(),
        id = `staging-fence-${line}-${phase}`,
        now = Date.now();
      await seedRecovery(e, id, { linked: true });
      if (phase === "after")
        await settleDirect(e, id, {
          gmail_result_id: "winner",
          message: { id: "winner", thread_id: "thread", label_ids: ["SENT"] },
        });
      const initial = await e.DB.prepare("SELECT * FROM staging_objects WHERE user_id=?").bind(id).first();
      const handle = initial!.handle;
      const site = sites.find((s) => s.file.endsWith("store.ts") && s.line === line)!;
      const binds =
        line === "240"
          ? [now + 86400000, handle, id, id]
          : line === "275"
            ? [now, id]
            : line === "285"
              ? [id]
              : [handle, now, now];
      const statement = e.DB.prepare(expand(site.sql)).bind(...binds);
      if ((line === "301" && phase === "before") || (["275", "285"].includes(line) && phase === "after"))
        expect((await statement.run()).meta.changes).toBe(0);
      else await expect(statement.run()).rejects.toThrow("staging settlement permit required");
      expect(await e.DB.prepare("SELECT * FROM staging_objects WHERE user_id=?").bind(id).first()).toEqual(initial);
    });
  }
}
for (const phase of ["before", "after"] as const) {
  it(`refuses late reservation and download lease edits ${phase} a winner`, async () => {
    const e = testEnv(),
      id = `late-storage-${phase}`,
      now = Date.now();
    await seedRecovery(e, id, { linked: true });
    if (phase === "after")
      await settleDirect(e, id, {
        gmail_result_id: "winner",
        message: { id: "winner", thread_id: "thread", label_ids: ["SENT"] },
      });
    const initial = await e.DB.prepare("SELECT * FROM staging_objects WHERE user_id=?").bind(id).first();
    const handle = initial!.handle;
    for (const line of ["50", "62"]) {
      const site = sites.find((s) => s.file.endsWith("downloads.ts") && s.line === line)!;
      const params = line === "50" ? [now + 60000, handle, id] : [handle, id, handle, id];
      await expect(
        e.DB.prepare(site.sql)
          .bind(...params)
          .run(),
      ).rejects.toThrow("staging settlement permit required");
    }
    const ack = sites.find((s) => s.file.endsWith("downloads.ts") && s.line === "138")!;
    expect((await e.DB.prepare(ack.sql).bind(now, handle, id).run()).meta.changes).toBe(0);
    expect(await e.DB.prepare("SELECT * FROM staging_objects WHERE user_id=?").bind(id).first()).toEqual(initial);
    const extra = `${id}-unreserved`;
    const insert = sites.find((s) => s.file.endsWith("store.ts") && s.line === "147")!;
    await e.DB.prepare(insert.sql)
      .bind(
        extra,
        id,
        id,
        "upload",
        `fixture/${extra}`,
        "fixture.bin",
        "application/octet-stream",
        1,
        "a".repeat(64),
        null,
        null,
        now,
        now + 60000,
      )
      .run();
    const reserve = sites.find((s) => s.file.endsWith("store.ts") && s.line === "217")!;
    await expect(e.DB.prepare(expand(reserve.sql)).bind(id, extra, id, id, now).run()).rejects.toThrow(
      "staging settlement permit required",
    );
    expect(
      await e.DB.prepare("SELECT reserved_by_operation_id FROM staging_objects WHERE handle=?")
        .bind(extra)
        .first("reserved_by_operation_id"),
    ).toBeNull();
  });
}
it("refuses captured deletion after legitimate protocol-2 cleanup admission", async () => {
  const e = testEnv(),
    id = "legacy-storage-delete";
  await seedRecovery(e, id, { linked: true });
  await settleDirect(e, id, {
    gmail_result_id: "winner",
    message: { id: "winner", thread_id: "thread", label_ids: ["SENT"] },
  });
  const handle = await e.DB.prepare("SELECT handle FROM staging_objects WHERE user_id=?")
    .bind(id)
    .first<string>("handle");
  await e.DB.batch([
    e.DB.prepare("INSERT INTO settlement_permits(operation_id,token,purpose) VALUES(?,?,'storage')").bind(id, id),
    e.DB.prepare("UPDATE staging_objects SET cleanup_state='deleting' WHERE handle=?").bind(handle),
    e.DB.prepare("DELETE FROM settlement_permits WHERE operation_id=?").bind(id),
  ]);
  const initial = await e.DB.prepare("SELECT * FROM staging_objects WHERE handle=?").bind(handle).first();
  const site = sites.find((s) => s.file.endsWith("store.ts") && s.line === "307")!;
  await expect(e.DB.prepare(site.sql).bind(handle).run()).rejects.toThrow("storage cleanup permit required");
  expect(await e.DB.prepare("SELECT * FROM staging_objects WHERE handle=?").bind(handle).first()).toEqual(initial);
});

const coverage = new LegacyCoverage("staging");
afterAll(() => coverage.verify());
