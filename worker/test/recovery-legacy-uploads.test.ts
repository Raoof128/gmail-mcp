import { LegacyCoverage } from "./legacy-coverage";
import { afterAll, expect, it } from "vitest";
import { legacyWriterCorpus } from "./fixtures/legacy-writer-corpus";
import { testEnv } from "./test-env";
import { seedUserAndAccount } from "./fixtures";
const files = ["staging/transfers", "staging/upload", "staging/recovery"];
const sites = legacyWriterCorpus.filter((s) => files.some((f) => s.file === `worker/src/${f}.ts`));
for (const site of sites) {
  it(`executes captured upload writer ${site.file}:${site.line} with matched transfer context`, async () => {
    const e = testEnv(),
      id = `upload-${site.file.split("/").at(-1)!.replace(".ts", "")}-${site.line}`,
      now = Date.now();
    const file = site.file.split("/").at(-1)!,
      line = site.line;
    await seedUserAndAccount(e.DB, { userId: id, accountId: id, alias: "upload" });
    await e.DB.prepare(
      "INSERT INTO operations(id,user_id,account_id,action,state,payload_hash,created_at,updated_at) VALUES(?,?,?,'attachment.stage_upload','claimed','hash',?,?)",
    )
      .bind(id, id, id, now, now)
      .run();
    await e.DB.prepare(
      "INSERT INTO pending_actions(id,user_id,account_id,action,modifiers,payload_json,payload_hash,summary,state,operation_id,created_at,expires_at) VALUES(?,?,?,'attachment.stage_upload','[]','{}','hash','fixture','executing',?,?,?)",
    )
      .bind(`${id}-pending`, id, id, id, now, now + 60000)
      .run();
    const transferId = id;
    await e.DB.prepare(
      "INSERT INTO upload_transfers(user_id,id,account_id,account_alias,metadata_json,intent_hash,state,pending_id,operation_id,active_generation,created_at,authority_until,retain_until) VALUES(?,?,?,'upload','{}','hash','in_progress',?,?,1,?,?,?)",
    )
      .bind(id, transferId, id, `${id}-pending`, id, now, now + 60000, now + 120000)
      .run();
    await e.DB.prepare(
      "INSERT INTO upload_generations(user_id,transfer_id,account_id,generation,ticket_id,state,issued_until,lease_until,r2_key,reserved_bytes,created_at) VALUES(?,?,?,1,?,'issued',?,?,?,1,?)",
    )
      .bind(id, transferId, id, id, now + 60000, now + 60000, `fixture/${id}`, now)
      .run();
    const generation = async (state: string, cleanup = "reserved", stopped = 0) => {
      await e.DB.prepare("UPDATE upload_generations SET state=?,cleanup_state=?,writer_stopped=? WHERE ticket_id=?")
        .bind(state, cleanup, stopped, id)
        .run();
    };
    let sql: string = site.sql,
      binds: unknown[],
      table: string = site.table;
    let where =
      table === "upload_generations" ? "ticket_id=?" : table === "upload_transfers" ? "user_id=? AND id=?" : "id=?";
    let match: unknown[] = table === "upload_transfers" ? [id, transferId] : [id];
    let expected: Record<string, unknown> = {};
    if (file === "transfers.ts") {
      switch (line) {
        case "53":
          sql = sql.replace(
            "${condition}",
            "EXISTS(SELECT 1 FROM accounts WHERE user_id=? AND id=? AND status='active')",
          );
          await expect(e.DB.prepare(sql).bind(id, "missing").run()).rejects.toThrow("CHECK constraint failed");
          binds = [id, id];
          table = "accounts";
          break;
        case "203":
          binds = [id, `${id}-new`, id, "upload", "{}", "hash", "authorized", null, now, now + 60000, now + 120000];
          match = [id, `${id}-new`];
          expected = { state: "authorized" };
          break;
        case "247":
          binds = [id, id, now];
          expected = { state: "expired", error: "pending_expired" };
          break;
        case "293":
          binds = [id, id, 1];
          expected = { state: "expired", cleanup_state: "released", writer_stopped: 1 };
          break;
        case "297":
          binds = [id, id];
          expected = { state: "awaiting_approval" };
          break;
        case "305":
          binds = ["fixture-error", id, id];
          expected = { state: "failed", error: "fixture-error" };
          break;
        case "336":
          binds = [`${id}-pending`, id, id];
          expected = { state: "awaiting_approval", pending_id: `${id}-pending` };
          break;
        case "378":
          await e.DB.prepare("UPDATE upload_generations SET issued_until=0 WHERE ticket_id=?").bind(id).run();
          binds = [id, id, 1, now];
          expected = { state: "expired", cleanup_state: "released" };
          break;
        case "406":
          binds = [`${id}-new`, id, id, "fixture-key", "hash", now, now];
          match = [`${id}-new`];
          expected = { state: "claimed", action: "attachment.stage_upload", settlement_protocol: 1 };
          break;
        case "414":
          await e.DB.prepare("UPDATE pending_actions SET state='approved' WHERE id=?").bind(`${id}-pending`).run();
          binds = [id, now, `${id}-pending`, id, now];
          match = [`${id}-pending`];
          expected = { state: "executing", operation_id: id };
          break;
        case "428":
          await generation("expired", "released", 1);
          binds = [id, id, id, 2, `${id}-next`, now + 60000, `fixture/${id}-next`, 1, now];
          match = [`${id}-next`];
          expected = { state: "issued", generation: 2 };
          break;
        case "445":
          await e.DB.prepare(
            "UPDATE upload_transfers SET state='authorized',operation_id=NULL,active_generation=0 WHERE user_id=? AND id=?",
          )
            .bind(id, id)
            .run();
          binds = [id, 1, id, id];
          expected = { state: "in_progress", operation_id: id, active_generation: 1 };
          break;
        case "452":
          binds = [id, id, "retry", 0, 1];
          where = "user_id=? AND transfer_id=? AND retry_id=?";
          match = [id, id, "retry"];
          expected = { expected_generation: 0, result_generation: 1 };
          break;
        case "491":
          binds = [id, id];
          expected = { state: "failed", cleanup_state: "released", writer_stopped: 1 };
          break;
        case "495":
          binds = ["denied", "fixture-error", id, id];
          expected = { state: "denied", error: "fixture-error" };
          break;
        case "499":
          binds = [now, id];
          expected = { state: "failed_safe" };
          break;
        case "504":
          binds = ["denied", "fixture-error", `${id}-pending`];
          match = [`${id}-pending`];
          expected = { state: "denied", payload_json: null };
          break;
        default:
          throw new Error("unmapped transfer site");
      }
    } else if (file === "upload.ts") {
      switch (line) {
        case "107":
          await e.DB.prepare("UPDATE upload_generations SET issued_until=0 WHERE ticket_id=?").bind(id).run();
          binds = [id];
          expected = { state: "expired", cleanup_state: "released", writer_stopped: 1 };
          break;
        case "112":
          binds = [id, id];
          expected = { state: "awaiting_approval" };
          break;
        case "145":
          binds = [now, now + 60000, 0, id, now];
          expected = { state: "uploading", credential_version: 0, admitted_at: now };
          break;
        case "154":
          binds = [now, id];
          expected = { state: "executing" };
          break;
        case "181":
          await generation("uploading");
          binds = [id, now];
          expected = { state: "stored" };
          break;
        case "204":
          binds = [
            id,
            id,
            id,
            `fixture/${id}`,
            "fixture.bin",
            "application/octet-stream",
            1,
            "a".repeat(64),
            now,
            now + 60000,
          ];
          where = "handle=?";
          expected = { direction: "upload", size: 1 };
          break;
        case "209":
          await generation("stored");
          binds = [id];
          expected = { state: "completed", cleanup_state: "published", writer_stopped: 1 };
          break;
        case "214":
          binds = ["fixture-handle", now + 60000, now + 120000, id, id];
          expected = { state: "completed", handle: "fixture-handle" };
          break;
        case "218":
          await e.DB.prepare("UPDATE operations SET state='executing' WHERE id=?").bind(id).run();
          binds = [now, id];
          expected = { state: "executed" };
          break;
        case "226":
          binds = [now, `${id}-pending`, id];
          match = [`${id}-pending`];
          expected = { state: "executed", payload_json: null };
          break;
        case "261":
          await generation("uploading");
          binds = ["failed", 0, id];
          expected = { state: "failed", cleanup_state: "debt", writer_stopped: 0 };
          break;
        case "268":
          binds = [id, id];
          expected = { state: "failed", error: "upload_failed" };
          break;
        case "273":
          await e.DB.prepare("UPDATE operations SET state='executing' WHERE id=?").bind(id).run();
          binds = [now, id];
          expected = { state: "failed_safe" };
          break;
        case "282":
          binds = [`${id}-pending`, id];
          match = [`${id}-pending`];
          expected = { state: "failed", payload_json: null };
          break;
        case "296":
          await generation("failed", "debt", 1);
          binds = [id];
          expected = { cleanup_state: "released" };
          break;
        default:
          throw new Error("unmapped upload site");
      }
    } else {
      switch (line) {
        case "11":
          await e.DB.prepare("UPDATE upload_generations SET issued_until=0 WHERE ticket_id=?").bind(id).run();
          binds = [1, 200];
          expected = { state: "expired", cleanup_state: "released", writer_stopped: 1 };
          break;
        case "16":
          await generation("uploading");
          await e.DB.prepare("UPDATE upload_generations SET lease_until=0 WHERE ticket_id=?").bind(id).run();
          binds = [1, 200];
          expected = { state: "abandoned", cleanup_state: "debt" };
          break;
        case "35":
          binds = [id, id];
          expected = { state: "expired", error: "pending_expired" };
          break;
        case "39":
          binds = [now, id];
          expected = { state: "failed_safe" };
          break;
        case "44":
          binds = [`${id}-pending`];
          match = [`${id}-pending`];
          expected = { state: "expired", payload_json: null };
          break;
        case "68":
          await generation("failed", "debt", 1);
          binds = [id];
          expected = { cleanup_state: "released" };
          break;
        case "73":
        case "82":
        case "88":
          await e.DB.prepare(
            "INSERT INTO staging_ingests(id,user_id,account_id,r2_key,reserved_bytes,lease_until,state,writer_stopped) VALUES(?,?,?,?,1,0,?,1)",
          )
            .bind(id, id, id, `ingest/${id}`, line === "73" ? "active" : line === "82" ? "debt" : "released")
            .run();
          binds = line === "73" ? [1] : line === "82" ? [id] : [];
          expected = { state: line === "73" ? "debt" : "released" };
          break;
        case "93":
          await e.DB.prepare("INSERT INTO staging_recovery_slots VALUES(?,?,1,0)").bind(id, "fixture").run();
          binds = [1];
          where = "user_id=? AND key='fixture'";
          break;
        case "97":
          await e.DB.prepare("INSERT INTO staging_materializations VALUES(?,0,?,?,1)").bind(id, id, id).run();
          binds = [1];
          break;
        case "99":
        case "107":
          await e.DB.prepare("INSERT INTO download_admissions VALUES(?,?,?,0,0,0)").bind(id, id, id).run();
          if (line === "99") await e.DB.prepare("INSERT INTO download_streams VALUES(?,?,?,0)").bind(id, id, id).run();
          else {
            where = "user_id=? AND handle=?";
            match = [id, id];
          }
          binds = [1];
          break;
        case "102":
          await e.DB.prepare("INSERT INTO staging_acknowledgements VALUES(?,?,?,0,0)").bind(id, id, id).run();
          binds = [1];
          where = "user_id=? AND handle=?";
          match = [id, id];
          break;
        case "112":
        case "117":
        case "122":
          await generation("completed", "released", 1);
          await e.DB.prepare("UPDATE upload_transfers SET state='completed',retain_until=0 WHERE user_id=? AND id=?")
            .bind(id, id)
            .run();
          if (line === "112") {
            await e.DB.prepare("INSERT INTO upload_retry_requests VALUES(?,?,?,0,1)").bind(id, id, "retry").run();
            where = "user_id=? AND transfer_id=?";
            match = [id, id];
          }
          if (line === "122") await e.DB.prepare("DELETE FROM upload_generations WHERE ticket_id=?").bind(id).run();
          binds = [1];
          break;
        default:
          throw new Error("unmapped recovery site");
      }
    }
    const result = await e.DB.prepare(sql)
      .bind(...binds)
      .run();
    expect(result.success).toBe(true);
    if (site.table === "_assert") expect(result.meta.changes).toBe(0);
    else expect(result.meta.changes).toBeGreaterThan(0);
    const row = await e.DB.prepare(`SELECT * FROM ${table} WHERE ${where}`)
      .bind(...match)
      .first();
    if (site.verb === "DELETE FROM") expect(row).toBeNull();
    else {
      expect(row).not.toBeNull();
      expect(row).toMatchObject(expected);
    }
    coverage.record(site);
  });
}

const coverage = new LegacyCoverage("uploads");
afterAll(() => coverage.verify());
