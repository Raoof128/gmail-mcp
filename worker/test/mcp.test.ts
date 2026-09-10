import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index";
import { seedUserAndAccount } from "./fixtures";
import { rpc } from "./mcp-client";
import { FakeGoogle } from "./fake-google";
import { mintToken } from "./browser";
import { testEnv, testDeps } from "./test-env";

const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } };
let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
let token: string;

beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker(testDeps(g));
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "ma", alias: "personal", isDefault: true });
  token = (await mintToken(worker, testEnv(), g, { scope: "mcp" })).accessToken;
});

describe("/mcp auth gate", () => {
  it("401 with a resource_metadata challenge and no session leakage without a bearer", async () => {
    const res = await rpc(worker, testEnv(), null, "initialize", INIT);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource/mcp");
    expect((await rpc(worker, testEnv(), "not-a-token", "initialize", INIT)).status).toBe(401);
  });
});

describe("protocol", () => {
  it("initialize then tools/list returns the control tools", async () => {
    const init = await rpc(worker, testEnv(), token, "initialize", INIT, 1);
    expect(init.status).toBe(200);
    expect(init.json?.result?.serverInfo?.name).toBe("gmail-mcp");
    const list = await rpc(worker, testEnv(), token, "tools/list", {}, 2);
    const names = (list.json?.result?.tools ?? []).map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      "cancel_pending",
      "connect_account",
      "get_policy",
      "list_accounts",
      "list_pending",
      "open_policy_editor",
    ]);
  });
  it("get_policy resolves the default account of the token's owner", async () => {
    const call = await rpc(worker, testEnv(), token, "tools/call", { name: "get_policy", arguments: {} }, 3);
    const parsed = JSON.parse(call.json?.result?.content?.[0]?.text as string);
    expect(parsed.account).toBe("personal");
    expect(parsed.policy["send.message"]).toBe("ask");
    expect(parsed.policy["policy.edit"]).toBe("browser");
  });
});
