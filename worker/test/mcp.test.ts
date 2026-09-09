import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedUserAndAccount } from "./fixtures";
import { rpc } from "./mcp-client";

// A plain copy, never Object.create(env): the test env is a Proxy, and assigning onto a child
// delegates through the prototype chain and would mutate the real env for later assertions.
// Build every env explicitly. Never Object.create(env): the test env is a Proxy, and assigning onto
// a child delegates through the prototype chain and would mutate the real env. Never assume the
// ambient env lacks the dev secrets either: a developer .dev.vars file puts them there.
function envWithout(...keys: string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...env };
  for (const k of keys) delete copy[k];
  return copy;
}
const bareEnv = envWithout("DEV_STATIC_TOKEN", "DEV_STATIC_USER");
const devEnv = { ...bareEnv, DEV_STATIC_TOKEN: "dev-token", DEV_STATIC_USER: "mu" };
const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } };

beforeAll(async () => {
  await seedUserAndAccount(env.DB, { userId: "mu", accountId: "ma", alias: "personal", isDefault: true });
});

describe("/mcp auth gate", () => {
  it("401 without a bearer, with a wrong bearer, and when the dev path is not fully configured", async () => {
    expect((await rpc(devEnv, null, "initialize", INIT)).status).toBe(401);
    expect((await rpc(devEnv, "nope", "initialize", INIT)).status).toBe(401);
    expect((await rpc(bareEnv, "dev-token", "initialize", INIT)).status).toBe(401);
    const tokenOnly = { ...bareEnv, DEV_STATIC_TOKEN: "dev-token" };
    expect((await rpc(tokenOnly, "dev-token", "initialize", INIT)).status).toBe(401);
  });
});

describe("protocol", () => {
  it("initialize then tools/list returns the four control tools", async () => {
    const init = await rpc(devEnv, "dev-token", "initialize", INIT, 1);
    expect(init.status).toBe(200);
    expect(init.json?.result?.serverInfo?.name).toBe("gmail-mcp");
    const list = await rpc(devEnv, "dev-token", "tools/list", {}, 2);
    const names = (list.json?.result?.tools ?? []).map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["cancel_pending", "get_policy", "list_accounts", "list_pending"]);
  });
  it("get_policy resolves the default account and reports browser-only actions", async () => {
    const call = await rpc(devEnv, "dev-token", "tools/call", { name: "get_policy", arguments: {} }, 3);
    const text = call.json?.result?.content?.[0]?.text as string;
    const parsed = JSON.parse(text);
    expect(parsed.account).toBe("personal");
    expect(parsed.policy["send.message"]).toBe("ask");
    expect(parsed.policy["policy.edit"]).toBe("browser");
  });
});
