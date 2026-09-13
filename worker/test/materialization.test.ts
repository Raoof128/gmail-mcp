import { env } from "cloudflare:test";
import { it, expect } from "vitest";
import { withMaterialization } from "../src/staging/materialization";
it("uses one shared materialization slot across independent callers", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = withMaterialization(env, async () => {
    entered();
    await blocked;
    return 1;
  });
  await started;
  // eslint-disable-next-line @typescript-eslint/require-await -- This test double implements an async interface.
  await expect(withMaterialization(env, async () => 2)).rejects.toThrow(/limit_exceeded/);
  release();
  expect(await first).toBe(1);
  // eslint-disable-next-line @typescript-eslint/require-await -- This test double implements an async interface.
  expect(await withMaterialization(env, async () => 3)).toBe(3);
});
it("reserves retained-byte capacity before downloading Gmail attachment data", async () => {
  const { seedUserAndAccount } = await import("./fixtures");
  await seedUserAndAccount(env.DB, { userId: "quota-owner", accountId: "quota-account", alias: "work" });
  await env.DB.prepare(
    "INSERT INTO staging_objects(handle,user_id,account_id,direction,r2_key,filename,mime,size,sha256,created_at,expires_at) VALUES('quota-handle','quota-owner','quota-account','download','quota-key','f','text/plain',262144000,'hash',1,9999999999999)",
  ).run();
  let called = false;
  await expect(
    withMaterialization(
      env,
      () => {
        called = true;
        return Promise.resolve(1);
      },
      { userId: "quota-owner", accountId: "quota-account", bytes: 25 * 1024 * 1024 },
    ),
  ).rejects.toThrow(/limit_exceeded/);
  expect(called).toBe(false);
});
