import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { testEnv } from "./test-env";

describe("plan 2 scaffold", () => {
  it("has the settings and oauth_states tables and the credential_version column", async () => {
    await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('k', 'v', 1)").run();
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'k'").first<{ value: string }>();
    expect(row?.value).toBe("v");

    await env.DB.prepare(
      "INSERT INTO oauth_states (id, kind, payload, created_at, expires_at) VALUES ('st_x', 'login', '{}', 1, 2)",
    ).run();
    const consumed = await env.DB.prepare(
      "UPDATE oauth_states SET consumed_at = 3 WHERE id = 'st_x' AND consumed_at IS NULL AND expires_at > 1 RETURNING payload",
    ).first<{ payload: string }>();
    expect(consumed?.payload).toBe("{}");

    const cols = (await env.DB.prepare("PRAGMA table_info(accounts)").all<{ name: string }>()).results.map(
      (c) => c.name,
    );
    expect(cols).toContain("credential_version");
  });

  it("testEnv is a plain object with every secret and no dev bearer", () => {
    const e = testEnv();
    expect(Object.getPrototypeOf(e)).toBe(Object.prototype);
    for (const k of [
      "TOKEN_KEKS",
      "TOKEN_KEK_CURRENT",
      "STATE_HMAC_KEY",
      "CSRF_HMAC_KEY",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "OWNER_GOOGLE_SUBS",
      "OWNER_EMAILS",
      "WORKER_HOSTNAME",
    ])
      expect(typeof (e as unknown as Record<string, unknown>)[k]).toBe("string");
    expect("DEV_STATIC_TOKEN" in e).toBe(false);
    expect(e.DB).toBe(env.DB);
  });
});
