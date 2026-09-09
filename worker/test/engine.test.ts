import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { seedUserAndAccount } from "./fixtures";
import { decide, effectiveLevel, setPolicy } from "../src/policy/engine";

describe("effectiveLevel", () => {
  it("falls back to spec defaults", async () => {
    await seedUserAndAccount(env.DB, { userId: "e1", accountId: "e1a", alias: "personal" });
    expect(await effectiveLevel(env.DB, "e1", "e1a", "send.message")).toBe("ask");
    expect(await effectiveLevel(env.DB, "e1", "e1a", "read.search")).toBe("allow");
  });
  it("global override beats default, account override beats global", async () => {
    await seedUserAndAccount(env.DB, { userId: "e2", accountId: "e2a", alias: "personal" });
    await seedUserAndAccount(env.DB, { userId: "e2", accountId: "e2b", alias: "uni" });
    await setPolicy(env.DB, { userId: "e2", accountId: null, action: "send.message", level: "allow" });
    expect(await effectiveLevel(env.DB, "e2", "e2a", "send.message")).toBe("allow");
    await setPolicy(env.DB, { userId: "e2", accountId: "e2b", action: "send.message", level: "deny" });
    expect(await effectiveLevel(env.DB, "e2", "e2b", "send.message")).toBe("deny");
    expect(await effectiveLevel(env.DB, "e2", "e2a", "send.message")).toBe("allow");
  });
  it("refuses browser-only actions", async () => {
    await seedUserAndAccount(env.DB, { userId: "e3", accountId: "e3a", alias: "p" });
    await expect(effectiveLevel(env.DB, "e3", "e3a", "policy.edit")).rejects.toThrow(/browser/);
  });
  it("refuses unknown and foreign accounts before evaluating policy", async () => {
    await seedUserAndAccount(env.DB, { userId: "e4", accountId: "e4a", alias: "p" });
    await seedUserAndAccount(env.DB, { userId: "e5", accountId: "e5a", alias: "p" });
    await expect(effectiveLevel(env.DB, "e4", "nope", "read.search")).rejects.toThrow(/account_not_found/);
    await expect(effectiveLevel(env.DB, "e4", "e5a", "read.search")).rejects.toThrow(/account_not_found/);
  });
  it("setPolicy upserts instead of duplicating", async () => {
    await seedUserAndAccount(env.DB, { userId: "e6", accountId: "e6a", alias: "p" });
    await setPolicy(env.DB, { userId: "e6", accountId: null, action: "trash.move", level: "allow" });
    await setPolicy(env.DB, { userId: "e6", accountId: null, action: "trash.move", level: "deny" });
    expect(await effectiveLevel(env.DB, "e6", "e6a", "trash.move")).toBe("deny");
  });
});

describe("decide with modifiers", () => {
  it("raises allow to ask, leaves ask and deny", async () => {
    await seedUserAndAccount(env.DB, { userId: "e7", accountId: "e7a", alias: "p" });
    await seedUserAndAccount(env.DB, { userId: "e7", accountId: "e7b", alias: "q" });
    await setPolicy(env.DB, { userId: "e7", accountId: "e7a", action: "send.message", level: "allow" });
    await setPolicy(env.DB, { userId: "e7", accountId: "e7b", action: "send.message", level: "deny" });
    expect(await decide(env.DB, { userId: "e7", accountId: "e7a", action: "send.message", modifiers: ["+external"] })).toEqual({ base: "allow", level: "ask", modifiers: ["+external"] });
    expect((await decide(env.DB, { userId: "e7", accountId: "e7b", action: "send.message", modifiers: ["+attachment"] })).level).toBe("deny");
    expect((await decide(env.DB, { userId: "e7", accountId: "e7a", action: "label.apply", modifiers: [] })).level).toBe("allow");
  });
});
