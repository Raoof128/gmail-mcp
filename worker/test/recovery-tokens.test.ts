import { expect, it } from "vitest";
import { getAccessTokenPinned } from "../src/google/tokens";
import { seedAccessToken, seedUserAndAccount } from "./fixtures";
import { testEnv } from "./test-env";
import { defaultDeps } from "../src/deps";
const e = testEnv();
async function account(id: string) {
  await seedUserAndAccount(e.DB, { userId: id, accountId: id, alias: "pinned" });
  await seedAccessToken(e, { userId: id, accountId: id });
}
it("uses the same grant epoch across normal refresh", async () => {
  await account("pinned-refresh");
  const deps = {
    ...defaultDeps,
    googleFetch: () =>
      Promise.resolve().then(() => Response.json({ access_token: "fresh", expires_in: 3600, token_type: "Bearer" })),
  };
  expect(
    await getAccessTokenPinned(e, deps, "pinned-refresh", "pinned-refresh", { expectedVersion: 0, forceRefresh: true }),
  ).toBe("fresh");
  expect(
    await e.DB.prepare("SELECT credential_version FROM accounts WHERE id='pinned-refresh'").first("credential_version"),
  ).toBe(0);
});
it("refuses a changed grant before cached-token return or refresh", async () => {
  await account("pinned-new");
  await e.DB.prepare("UPDATE accounts SET credential_version=1 WHERE id='pinned-new'").run();
  let calls = 0;
  const deps = {
    ...defaultDeps,
    googleFetch: () => {
      calls++;
      return Promise.resolve(Response.json({}));
    },
  };
  for (const forceRefresh of [false, true])
    await expect(
      getAccessTokenPinned(e, deps, "pinned-new", "pinned-new", { expectedVersion: 0, forceRefresh }),
    ).rejects.toMatchObject({ code: "account_needs_reconnect" });
  expect(calls).toBe(0);
});
it("discards refresh response if the grant changes while in flight", async () => {
  await account("pinned-race");
  const deps = {
    ...defaultDeps,
    googleFetch: async () => {
      await e.DB.prepare("UPDATE accounts SET credential_version=1 WHERE id='pinned-race'").run();
      return Response.json({ access_token: "discard", expires_in: 3600, token_type: "Bearer" });
    },
  };
  await expect(
    getAccessTokenPinned(e, deps, "pinned-race", "pinned-race", { expectedVersion: 0, forceRefresh: true }),
  ).rejects.toMatchObject({ code: "account_needs_reconnect" });
});
