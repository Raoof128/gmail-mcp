import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedUserAndAccount, insertOperation } from "./fixtures";
import { ingest, openForRead, ack, purgeExpired, extendExpiry, consume, release } from "../src/staging/store";
import { sha256Hex } from "../src/crypto/canonical";

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
const stream = (b: Uint8Array) => new Response(b).body!;
const up = (name: string, data: Uint8Array, extra: Record<string, unknown> = {}) =>
  ingest(env, { userId: "su", accountId: "sa", direction: "upload", filename: name, mime: "application/octet-stream", length: data.byteLength, body: stream(data), ...extra });
const down = (name: string, data: Uint8Array) =>
  ingest(env, { userId: "su", accountId: "sa", direction: "download", filename: name, mime: "application/octet-stream", length: data.byteLength, body: stream(data) });

beforeAll(async () => {
  await seedUserAndAccount(env.DB, { userId: "su", accountId: "sa", alias: "main" });
  await seedUserAndAccount(env.DB, { userId: "su2", accountId: "sb", alias: "main" });
});

describe("ingest", () => {
  it("stores bytes, computes sha256, sanitises the filename, sets 30 min ttl", async () => {
    const data = bytes(1000);
    const row = await down("../x‮.pdf", data);
    expect(row.handle).toMatch(/^sh_[A-Za-z0-9_-]{43}$/);
    expect(row.filename).toBe("x_.pdf");
    expect(row.size).toBe(1000);
    expect(row.sha256).toBe(await sha256Hex(data));
    expect(row.expires_at - row.created_at).toBe(30 * 60_000);
    expect((await (await env.STAGING.get(row.r2_key))!.arrayBuffer()).byteLength).toBe(1000);
  });
  it("blocks dangerous extensions on upload only", async () => {
    await expect(up("run.exe", bytes(1))).rejects.toThrow(/blocked_extension/);
    const d = await down("run.exe", bytes(1));
    expect(d.filename).toBe("run.exe");
  });
  it("rejects over-cap lengths before reading any bytes", async () => {
    await expect(up("big.bin", bytes(1), { length: 25 * 1024 * 1024 + 1 })).rejects.toThrow(/limit_exceeded/);
  });
  it("rejects a body whose byte count differs from length, leaving no R2 object or row", async () => {
    await expect(up("short.bin", bytes(3), { length: 5 })).rejects.toThrow();
    await expect(up("long.bin", bytes(7), { length: 5 })).rejects.toThrow();
    expect((await env.DB.prepare("SELECT count(*) AS c FROM staging_objects WHERE filename IN ('short.bin','long.bin')").first<{ c: number }>())?.c).toBe(0);
    const listed = await env.STAGING.list({ prefix: "stg/su/" });
    expect(listed.objects.filter((o) => o.size === 3 || o.size === 7 || o.size === 5)).toHaveLength(0);
  });
  it("rejects a declared sha256 that does not match and leaves no row", async () => {
    await expect(up("a.txt", bytes(5), { declaredSha256: "0".repeat(64) })).rejects.toThrow(/handle_invalid/);
    expect((await env.DB.prepare("SELECT count(*) AS c FROM staging_objects WHERE filename = 'a.txt'").first<{ c: number }>())?.c).toBe(0);
  });
  it("deletes the R2 object when the D1 insert fails", async () => {
    const before = (await env.STAGING.list({ prefix: "stg/ghost/" })).objects.length;
    await expect(ingest(env, { userId: "ghost", accountId: "nope", direction: "upload", filename: "g.bin", mime: "x", length: 2, body: stream(bytes(2)) })).rejects.toThrow();
    expect((await env.STAGING.list({ prefix: "stg/ghost/" })).objects.length).toBe(before);
  });
});

describe("read and ack", () => {
  it("streams downloads to the owner only, allows re-read before ack, blocks after ack and after expiry", async () => {
    const row = await down("r.txt", bytes(3, 9));
    const first = await openForRead(env, { handle: row.handle, userId: "su" });
    expect(new Uint8Array(await new Response(first.body).arrayBuffer())).toEqual(bytes(3, 9));
    await expect(openForRead(env, { handle: row.handle, userId: "su2" })).rejects.toThrow(/handle_invalid/);
    await openForRead(env, { handle: row.handle, userId: "su" });
    expect(await ack(env, { handle: row.handle, userId: "su" })).toBe(true);
    expect(await ack(env, { handle: row.handle, userId: "su" })).toBe(false);
    await expect(openForRead(env, { handle: row.handle, userId: "su" })).rejects.toThrow(/handle_invalid/);
    const stale = await down("stale.txt", bytes(1));
    await env.DB.prepare("UPDATE staging_objects SET expires_at = 1 WHERE handle = ?").bind(stale.handle).run();
    expect(await ack(env, { handle: stale.handle, userId: "su" })).toBe(false);
    await expect(openForRead(env, { handle: stale.handle, userId: "su" })).rejects.toThrow(/handle_expired/);
  });
  it("never serves upload handles through the read path", async () => {
    const u = await up("u.bin", bytes(2));
    await expect(openForRead(env, { handle: u.handle, userId: "su" })).rejects.toThrow(/handle_invalid/);
  });
});

describe("hold, reserve, consume, release, purge", () => {
  it("consume clears the reservation so purge can collect the object", async () => {
    const c = await up("c.bin", bytes(2));
    await insertOperation(env.DB, "op_c", "su", "sa", "executing");
    await env.DB.prepare("UPDATE staging_objects SET reserved_by_operation_id = 'op_c' WHERE handle = ?").bind(c.handle).run();
    await consume(env.DB, "op_c");
    const row = await env.DB.prepare("SELECT consumed_at AS ca, reserved_by_operation_id AS r FROM staging_objects WHERE handle = ?").bind(c.handle).first<{ ca: number | null; r: string | null }>();
    expect(row?.ca).not.toBeNull();
    expect(row?.r).toBeNull();
    await purgeExpired(env, Date.now());
    expect(await env.DB.prepare("SELECT 1 FROM staging_objects WHERE handle = ?").bind(c.handle).first()).toBeNull();
    expect(await env.STAGING.get(c.r2_key)).toBeNull();
  });
  it("release clears an unconsumed reservation", async () => {
    const d = await up("d.bin", bytes(2));
    await insertOperation(env.DB, "op_d", "su", "sa", "claimed");
    await env.DB.prepare("UPDATE staging_objects SET reserved_by_operation_id = 'op_d' WHERE handle = ?").bind(d.handle).run();
    await release(env.DB, "op_d");
    expect((await env.DB.prepare("SELECT reserved_by_operation_id AS r FROM staging_objects WHERE handle = ?").bind(d.handle).first<{ r: string | null }>())?.r).toBeNull();
  });
  it("purge removes expired unreserved objects in one pass and keeps reserved ones", async () => {
    const a = await up("a.bin", bytes(2));
    const b = await up("b.bin", bytes(2));
    await env.DB.prepare("UPDATE staging_objects SET expires_at = 1 WHERE handle IN (?, ?)").bind(a.handle, b.handle).run();
    await insertOperation(env.DB, "op_x", "su", "sa", "delivery_unknown");
    await env.DB.prepare("UPDATE staging_objects SET reserved_by_operation_id = 'op_x' WHERE handle = ?").bind(b.handle).run();
    const r = await purgeExpired(env, Date.now());
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    expect(await env.STAGING.get(a.r2_key)).toBeNull();
    expect(await env.STAGING.get(b.r2_key)).not.toBeNull();
  });
  it("extendExpiry only raises", async () => {
    const e = await up("e.bin", bytes(2));
    await extendExpiry(env.DB, [e.handle], "su", "sa", e.expires_at + 99_000);
    await extendExpiry(env.DB, [e.handle], "su", "sa", 1);
    expect((await env.DB.prepare("SELECT expires_at AS x FROM staging_objects WHERE handle = ?").bind(e.handle).first<{ x: number }>())?.x).toBe(e.expires_at + 99_000);
  });
});
