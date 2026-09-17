import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { putState, consumeState, purgeStates } from "../src/web/state";

const GRACE_MS = 3_600_000;
const count = async () => (await env.DB.prepare("SELECT count(*) AS n FROM oauth_states").first<{ n: number }>())!.n;

async function seedExpired(n: number, now: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await env.DB.prepare("INSERT INTO oauth_states (id, kind, payload, created_at, expires_at) VALUES (?,?,?,?,?)")
      .bind(`old_${i}_${now}`, "login", "{}", now - GRACE_MS * 3, now - GRACE_MS * 2)
      .run();
  }
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM oauth_states").run();
});

describe("oauth state growth is self-limiting", () => {
  // An unauthenticated GET /login inserts one row. If inserting never collects, a request rate above
  // the cron's 200-rows-per-five-minutes drain grows this table without bound, and D1 is the same
  // store that holds sessions, operations, policy and audit.
  it("each insert collects expired rows, so the table cannot outgrow the fill rate", async () => {
    const now = Date.now();
    await seedExpired(20, now);
    expect(await count()).toBe(20);
    for (let i = 0; i < 5; i++)
      await putState(env.DB, "login", `st_new${String(i).padStart(19, "0")}`, { nonce: "n", returnTo: "/" }, 600_000);
    const after = await count();
    expect(after).toBeLessThan(25);
    expect(after).toBeLessThanOrEqual(20);
  });

  it("never collects a state that is still usable", async () => {
    const now = Date.now();
    await seedExpired(12, now);
    await putState(env.DB, "login", "st_LIVE000000000000000000", { nonce: "n", returnTo: "/accounts" }, 600_000);
    for (let i = 0; i < 6; i++)
      await putState(env.DB, "login", `st_fil${String(i).padStart(19, "0")}`, { nonce: "n", returnTo: "/" }, 600_000);
    expect(await consumeState<{ returnTo: string }>(env.DB, "login", "st_LIVE000000000000000000")).toEqual({
      nonce: "n",
      returnTo: "/accounts",
    });
  });

  it("the cron purge still drains a backlog on its own", async () => {
    const now = Date.now();
    await seedExpired(30, now);
    expect(await purgeStates(env.DB, now, 200)).toBe(30);
    expect(await count()).toBe(0);
  });
});
