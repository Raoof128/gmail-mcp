import { env } from "cloudflare:test";
import { beforeAll, describe, it, expect } from "vitest";
import { seedUserAndAccount, insertOperation } from "./fixtures";
import { ingest, openForRead } from "../src/staging/store";
import { acknowledgeDownload } from "../src/staging/downloads";

const USER = "dl-race-owner";
const ACCOUNT = "dl-race-account";
const TEXT = "download race payload";

beforeAll(async () => {
  await seedUserAndAccount(env.DB, { userId: USER, accountId: ACCOUNT, alias: "work" });
});

const create = (name: string) =>
  ingest(env, {
    userId: USER,
    accountId: ACCOUNT,
    direction: "download",
    filename: `${name}.txt`,
    mime: "text/plain",
    length: TEXT.length,
    body: new Response(TEXT).body!,
  });

/** The download tuple: R2, every row the read touches, and what the caller could observe. */
async function evidence(handle: string, r2Key: string) {
  const one = async <T>(sql: string, ...binds: unknown[]) =>
    await env.DB.prepare(sql)
      .bind(...binds)
      .first<T>();
  return {
    object: (await env.STAGING.head(r2Key)) !== null,
    row: await one<{
      consumed_at: number | null;
      cleanup_state: string;
      download_lease_until: number | null;
      reserved_by_operation_id: string | null;
    }>(
      "SELECT consumed_at,cleanup_state,download_lease_until,reserved_by_operation_id FROM staging_objects WHERE handle=?",
      handle,
    ),
    streams: await one<number>("SELECT count(*) n FROM download_streams WHERE handle=?", handle).then(
      (r) => (r as unknown as { n: number } | null)?.n ?? 0,
    ),
    admissions: await one<number>("SELECT count(*) n FROM download_admissions WHERE handle=?", handle).then(
      (r) => (r as unknown as { n: number } | null)?.n ?? 0,
    ),
    acks: await one<number>("SELECT count(*) n FROM staging_acknowledgements WHERE handle=?", handle).then(
      (r) => (r as unknown as { n: number } | null)?.n ?? 0,
    ),
    permits: await one<number>("SELECT count(*) n FROM settlement_permits").then(
      (r) => (r as unknown as { n: number } | null)?.n ?? 0,
    ),
  };
}
const leaseLive = (v: number | null) => v !== null && v > Date.now();

describe("download races between the stream, the acknowledgement and the lease", () => {
  it("consumes exactly once when a read completes and is acknowledged", async () => {
    const row = await create("clean");
    const read = await openForRead(env, { userId: USER, handle: row.handle });
    expect(await new Response(read.body).text()).toBe(TEXT);
    expect(await acknowledgeDownload(env, USER, row.handle)).toEqual({ acknowledged: true, replayed: false });

    const ev = await evidence(row.handle, row.r2_key);
    expect(ev.object).toBe(true);
    expect(ev.row?.consumed_at).not.toBeNull();
    expect(ev.streams).toBe(0);
    expect(ev.acks).toBe(1);
    expect(leaseLive(ev.row?.download_lease_until ?? null)).toBe(false);
    expect(ev.permits).toBe(0);
  });

  it("releases the lease and leaves the handle usable when a stream dies mid-body", async () => {
    const row = await create("aborted");
    const read = await openForRead(env, { userId: USER, handle: row.handle });
    const reader = read.body.getReader();
    await reader.read();
    await reader.cancel("client vanished");

    // The slot is returned and nothing was consumed, so the bytes are still owed to the caller.
    const ev = await evidence(row.handle, row.r2_key);
    expect(ev.streams).toBe(0);
    expect(ev.row?.consumed_at).toBeNull();
    expect(leaseLive(ev.row?.download_lease_until ?? null)).toBe(false);
    expect(ev.object).toBe(true);
    expect(ev.permits).toBe(0);

    // And the retry gets the whole object, not a partial one.
    const again = await openForRead(env, { userId: USER, handle: row.handle });
    expect(await new Response(again.body).text()).toBe(TEXT);
    expect(await acknowledgeDownload(env, USER, row.handle)).toMatchObject({ replayed: false });
  });

  it("keeps a second reader's lease alive when the first one finishes", async () => {
    const row = await create("concurrent");
    const first = await openForRead(env, { userId: USER, handle: row.handle });
    const second = await openForRead(env, { userId: USER, handle: row.handle });
    expect((await evidence(row.handle, row.r2_key)).streams).toBe(2);

    await new Response(first.body).text();
    const midway = await evidence(row.handle, row.r2_key);
    // One slot returned, and the survivor's lease is untouched: release recomputes from the remaining
    // streams rather than clearing the column.
    expect(midway.streams).toBe(1);
    expect(leaseLive(midway.row?.download_lease_until ?? null)).toBe(true);

    await new Response(second.body).text();
    const after = await evidence(row.handle, row.r2_key);
    expect(after.streams).toBe(0);
    expect(leaseLive(after.row?.download_lease_until ?? null)).toBe(false);
    expect(after.permits).toBe(0);
  });

  it("lets an in-flight stream finish its bytes when the acknowledgement lands first", async () => {
    const row = await create("ack-midflight");
    const read = await openForRead(env, { userId: USER, handle: row.handle });
    const reader = read.body.getReader();
    await reader.read();

    // The acknowledgement arrives while the stream is still open.
    expect(await acknowledgeDownload(env, USER, row.handle)).toMatchObject({ acknowledged: true, replayed: false });
    expect((await evidence(row.handle, row.r2_key)).row?.consumed_at).not.toBeNull();

    // The open stream is served from the object it already holds and is not torn out from under it.
    const rest = [];
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      rest.push(part.value);
    }
    await reader.cancel();

    // A new read is refused, because the handle is consumed.
    await expect(openForRead(env, { userId: USER, handle: row.handle })).rejects.toThrow(/handle_invalid/);
    const ev = await evidence(row.handle, row.r2_key);
    expect(ev.streams).toBe(0);
    expect(ev.acks).toBe(1);
    expect(ev.permits).toBe(0);
  });

  it("will not let an acknowledgement consume a handle an operation has reserved", async () => {
    const row = await create("reserved");
    await insertOperation(env.DB, "dl-race-op", USER, ACCOUNT, "claimed");
    await env.DB.prepare("UPDATE staging_objects SET reserved_by_operation_id=? WHERE handle=?")
      .bind("dl-race-op", row.handle)
      .run();

    const result = await acknowledgeDownload(env, USER, row.handle);
    const ev = await evidence(row.handle, row.r2_key);

    // Whatever the caller is told, the reservation is what decides: the bytes stay owed to the
    // operation and the row is not marked consumed by a reader's acknowledgement.
    expect(ev.row?.consumed_at).toBeNull();
    expect(ev.row?.reserved_by_operation_id).toBe("dl-race-op");
    expect(ev.permits).toBe(0);
    expect(result).toBeNull();
  });

  it("still refuses to consume when the reservation lands after the read was admitted", async () => {
    const row = await create("reserved-after-admission");
    // Read it first, so an admission row exists and the acknowledgement path can no longer be turned
    // away by the staging_objects predicate alone. This is the ordering the simpler case cannot reach.
    const read = await openForRead(env, { userId: USER, handle: row.handle });
    await new Response(read.body).text();
    expect((await evidence(row.handle, row.r2_key)).admissions).toBe(1);

    await insertOperation(env.DB, "dl-race-op-late", USER, ACCOUNT, "claimed");
    await env.DB.prepare("UPDATE staging_objects SET reserved_by_operation_id=? WHERE handle=?")
      .bind("dl-race-op-late", row.handle)
      .run();

    const result = await acknowledgeDownload(env, USER, row.handle);
    const ev = await evidence(row.handle, row.r2_key);

    // The acknowledgement is recorded, because the reader did genuinely receive the bytes, but the
    // consumption is refused: the reservation outranks it and the operation's claim on the object
    // survives. Telling the reader otherwise would be fine; releasing the bytes would not.
    expect(result).toMatchObject({ acknowledged: true });
    expect(ev.acks).toBe(1);
    expect(ev.row?.consumed_at).toBeNull();
    expect(ev.row?.reserved_by_operation_id).toBe("dl-race-op-late");
    expect(ev.object).toBe(true);
    expect(ev.permits).toBe(0);
  });

  it("refuses a foreign owner at the stream and at the acknowledgement", async () => {
    const row = await create("foreign");
    await expect(openForRead(env, { userId: "intruder", handle: row.handle })).rejects.toThrow(/handle_invalid/);
    expect(await acknowledgeDownload(env, "intruder", row.handle)).toBeNull();
    const ev = await evidence(row.handle, row.r2_key);
    expect(ev.row?.consumed_at).toBeNull();
    expect(ev.streams).toBe(0);
    expect(ev.acks).toBe(0);
    expect(ev.admissions).toBe(0);
  });
});
