import { describe, it, expect } from "vitest";
import { ACTIONS, DEFAULT_POLICY, MODIFIERS, raise } from "../src/actions";
import { AccountAlias, PendingApprovalResult, StagingHandle, StagingHandleResponse, Sha256Hex } from "../src/schemas";

const H = "sh_" + "A".repeat(43);

describe("actions", () => {
  it("has a default for every action", () => {
    for (const a of ACTIONS) expect(DEFAULT_POLICY[a]).toBeDefined();
  });
  it("matches the spec defaults", () => {
    expect(DEFAULT_POLICY["send.message"]).toBe("ask");
    expect(DEFAULT_POLICY["read.search"]).toBe("allow");
    expect(DEFAULT_POLICY["policy.edit"]).toBe("browser");
    expect(DEFAULT_POLICY["trash.restore"]).toBe("allow");
  });
  it("raise only goes up", () => {
    expect(raise("allow")).toBe("ask");
    expect(raise("ask")).toBe("ask");
    expect(raise("deny")).toBe("deny");
  });
  it("lists the five modifiers", () => {
    expect([...MODIFIERS].sort()).toEqual(["+attachment", "+bulk", "+external", "+overwrite", "+sensitive"]);
  });
});

describe("strict schemas", () => {
  it("accepts only well-formed handles, hashes and aliases", () => {
    expect(StagingHandle.safeParse(H).success).toBe(true);
    expect(StagingHandle.safeParse("sh_abc").success).toBe(false);
    expect(Sha256Hex.safeParse("a".repeat(64)).success).toBe(true);
    expect(Sha256Hex.safeParse("A".repeat(64)).success).toBe(false);
    expect(AccountAlias.safeParse("uni-2026").success).toBe(true);
    expect(AccountAlias.safeParse("Uni").success).toBe(false);
    expect(AccountAlias.safeParse("a/b").success).toBe(false);
  });
  it("accepts a staging handle response and rejects a loose one", () => {
    const ok = StagingHandleResponse.safeParse({
      handle: H,
      account: "personal",
      filename: "a.pdf",
      mime: "application/pdf",
      size: 10,
      sha256: "0".repeat(64),
      expires_at: "2026-09-09T00:00:00Z",
    });
    expect(ok.success).toBe(true);
    const bad = StagingHandleResponse.safeParse({
      handle: H,
      account: "personal",
      filename: "a.pdf",
      mime: "application/pdf",
      size: 10,
      sha256: "0".repeat(64),
      expires_at: "tomorrow",
    });
    expect(bad.success).toBe(false);
  });
  it("pending result requires known action and modifier names", () => {
    const base = {
      status: "pending_approval",
      action_id: "pa_" + "B".repeat(22),
      account: "personal",
      summary: "s",
      approval: { mode: "url", url: "https://x.test/approve/pa_x" },
      expires_at: "2026-09-09T00:00:00Z",
    };
    expect(PendingApprovalResult.safeParse({ ...base, action: "send.message", modifiers: ["+external"] }).success).toBe(
      true,
    );
    expect(PendingApprovalResult.safeParse({ ...base, action: "send.anything", modifiers: [] }).success).toBe(false);
    expect(PendingApprovalResult.safeParse({ ...base, action: "send.message", modifiers: ["+magic"] }).success).toBe(
      false,
    );
  });
});
