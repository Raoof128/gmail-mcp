import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

describe("worker smoke", () => {
  it("returns 404 for an unknown path", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://x.test/nope"), { ...env }, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });

  it("has the D1, R2 and KV bindings", () => {
    expect(env.DB).toBeDefined();
    expect(env.STAGING).toBeDefined();
    expect(env.OAUTH_KV).toBeDefined();
  });
});
