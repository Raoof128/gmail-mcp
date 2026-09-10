import { describe, it, expect } from "vitest";
import { signToken, verifyToken } from "../src/crypto/hmac";
import { checkOrigin, csrfToken, verifyCsrf } from "../src/web/csrf";
import { testEnv } from "./test-env";
import type { Session } from "../src/web/session";

const env = testEnv();
const session: Session = { id: "sid-A", idHash: "h", userId: "u", authenticatedAt: 0, lastSeenAt: 0 };
const other: Session = { ...session, id: "sid-B" };

describe("hmac tokens", () => {
  it("round-trips and binds every field and the purpose", async () => {
    const exp = Date.now() + 60_000;
    const t = await signToken(env.STATE_HMAC_KEY, "p", ["a", "b"], exp);
    expect(await verifyToken(env.STATE_HMAC_KEY, "p", ["a", "b"], t)).toBe(true);
    expect(await verifyToken(env.STATE_HMAC_KEY, "q", ["a", "b"], t)).toBe(false);
    expect(await verifyToken(env.STATE_HMAC_KEY, "p", ["a", "c"], t)).toBe(false);
    expect(await verifyToken(env.STATE_HMAC_KEY, "p", ["ab", ""], t)).toBe(false);
    const nul = await signToken(env.STATE_HMAC_KEY, "p", ["a\0b", "c"], exp);
    expect(await verifyToken(env.STATE_HMAC_KEY, "p", ["a", "b\0c"], nul)).toBe(false);
    expect(await verifyToken(env.STATE_HMAC_KEY, "p", ["a\0b", "c"], nul)).toBe(true);
    expect(await verifyToken("AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=", "p", ["a", "b"], t)).toBe(false);
  });
  it("rejects expired and malformed tokens", async () => {
    const t = await signToken(env.STATE_HMAC_KEY, "p", ["a"], Date.now() - 1);
    expect(await verifyToken(env.STATE_HMAC_KEY, "p", ["a"], t)).toBe(false);
    expect(await verifyToken(env.STATE_HMAC_KEY, "p", ["a"], "garbage")).toBe(false);
    expect(await verifyToken(env.STATE_HMAC_KEY, "p", ["a"], "123.")).toBe(false);
  });
});

describe("csrf", () => {
  it("a token for /approve/A cannot approve /approve/B, another session, or another method", async () => {
    const t = await csrfToken(env, session, "POST", "/approve", "pa_A");
    expect(await verifyCsrf(env, session, "POST", "/approve", "pa_A", t)).toBe(true);
    expect(await verifyCsrf(env, session, "POST", "/approve", "pa_B", t)).toBe(false);
    expect(await verifyCsrf(env, other, "POST", "/approve", "pa_A", t)).toBe(false);
    expect(await verifyCsrf(env, session, "POST", "/policy", "pa_A", t)).toBe(false);
    expect(await verifyCsrf(env, session, "POST", "/approve", "pa_A", "")).toBe(false);
  });
  it("origin must match the worker hostname when present and is required on POST", () => {
    const mk = (origin?: string, method = "POST") =>
      new Request("https://gmail-mcp.example.workers.dev/approve/x", {
        method,
        headers: origin ? { origin } : {},
      });
    expect(checkOrigin(mk("https://gmail-mcp.example.workers.dev"), env)).toBe(true);
    expect(checkOrigin(mk("https://evil.test"), env)).toBe(false);
    expect(checkOrigin(mk("null"), env)).toBe(false);
    expect(checkOrigin(mk(undefined), env)).toBe(false);
    expect(checkOrigin(mk(undefined, "GET"), env)).toBe(true);
  });
});
