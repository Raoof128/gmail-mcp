import { env } from "cloudflare:test";
import { beforeAll, it, expect } from "vitest";
import { seedUserAndAccount } from "./fixtures";
import { ingest, openForRead, purgeExpired } from "../src/staging/store";
import { acknowledgeDownload } from "../src/staging/downloads";
beforeAll(async () => {
  await seedUserAndAccount(env.DB, { userId: "download-owner", accountId: "download-account", alias: "work" });
});
const create = () =>
  ingest(env, {
    userId: "download-owner",
    accountId: "download-account",
    direction: "download",
    filename: "file.txt",
    mime: "text/plain",
    length: 3,
    body: new Response("abc").body!,
  });
it("records ACK across response loss, row cleanup and replay", async () => {
  const row = await create();
  const read = await openForRead(env, { userId: row.user_id, handle: row.handle });
  await new Response(read.body).text();
  expect(await acknowledgeDownload(env, row.user_id, row.handle)).toEqual({ acknowledged: true, replayed: false });
  await purgeExpired(env, Date.now() + 60_000);
  expect(await acknowledgeDownload(env, row.user_id, row.handle)).toEqual({ acknowledged: true, replayed: true });
  expect(await acknowledgeDownload(env, "foreign", row.handle)).toBeNull();
});
it("protects an admitted read from purge and accepts its ACK after original TTL", async () => {
  const row = await create();
  const read = await openForRead(env, { userId: row.user_id, handle: row.handle });
  await env.DB.prepare("UPDATE staging_objects SET expires_at=1 WHERE handle=?").bind(row.handle).run();
  await purgeExpired(env, Date.now());
  expect(await env.STAGING.get(row.r2_key)).not.toBeNull();
  await new Response(read.body).text();
  expect((await acknowledgeDownload(env, row.user_id, row.handle))?.acknowledged).toBe(true);
});

it("holds at most two concurrent downloads for one owner", async () => {
  const row = await create();
  const one = await openForRead(env, { userId: row.user_id, handle: row.handle });
  const two = await openForRead(env, { userId: row.user_id, handle: row.handle });
  try {
    await expect(openForRead(env, { userId: row.user_id, handle: row.handle })).rejects.toThrow(/handle_invalid/);
  } finally {
    await one.body.cancel();
    await two.body.cancel();
  }
  const after = await openForRead(env, { userId: row.user_id, handle: row.handle });
  await after.body.cancel();
});
it("refuses a new read when recovery capacity is reserved, before creating an admission", async () => {
  const row = await create();
  await env.DB.prepare(
    "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<500) INSERT INTO staging_recovery_slots SELECT 'download-owner','test:'||x,2,9999999999999 FROM n",
  ).run();
  await expect(openForRead(env, { userId: row.user_id, handle: row.handle })).rejects.toThrow(/handle_invalid/);
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM download_admissions WHERE handle=?").bind(row.handle).first(),
  ).toEqual({ n: 0 });
});
