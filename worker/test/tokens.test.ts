import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { FakeGoogle } from "./fake-google";
import { testEnv } from "./test-env";
import { Keyring } from "../src/crypto/keyring";
import { getAccessToken, revokeAccount } from "../src/google/tokens";
import { seedUserAndAccount } from "./fixtures";

const K1 = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
const K2 = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=";
let g: FakeGoogle;
beforeAll(async () => {
  g = await FakeGoogle.create();
  await seedUserAndAccount(env.DB, { userId: "tu", accountId: "ta", alias: "personal", isDefault: true });
  await seedUserAndAccount(env.DB, { userId: "tu", accountId: "tb", alias: "second" });
  await seedUserAndAccount(env.DB, { userId: "tv", accountId: "tc", alias: "personal", isDefault: true });
});

async function seedTokens(
  e: ReturnType<typeof testEnv>,
  accountId: string,
  o: { refresh: string; access?: string; expiresAt?: number },
) {
  const ring = Keyring.fromEnv(e);
  const rt = await ring.encrypt(o.refresh, { userId: "tu", accountId, field: "refresh_token" });
  const at = o.access ? await ring.encrypt(o.access, { userId: "tu", accountId, field: "access_token" }) : null;
  await env.DB.prepare(
    "UPDATE accounts SET status = 'active', is_default = is_default, refresh_token_enc = ?, refresh_token_key_id = ?, access_token_enc = ?, access_token_key_id = ?, access_expires_at = ? WHERE id = ?",
  )
    .bind(rt.ciphertext, rt.keyId, at?.ciphertext ?? null, at?.keyId ?? null, o.expiresAt ?? null, accountId)
    .run();
}

describe("access tokens", () => {
  it("returns a cached token without calling Google, refreshes when it is about to expire", async () => {
    const e = testEnv();
    g.refreshTokens.set("rt-a", "ok");
    await seedTokens(e, "ta", { refresh: "rt-a", access: "cached", expiresAt: Date.now() + 10 * 60_000 });
    const calls = g.tokenCalls;
    expect(await getAccessToken(e, { googleFetch: g.fetch }, "tu", "ta")).toBe("cached");
    expect(g.tokenCalls).toBe(calls);
    await seedTokens(e, "ta", { refresh: "rt-a", access: "stale", expiresAt: Date.now() + 30_000 });
    const fresh = await getAccessToken(e, { googleFetch: g.fetch }, "tu", "ta");
    expect(fresh).toMatch(/^at-/);
    expect(g.tokenCalls).toBe(calls + 1);
    const row = await env.DB.prepare(
      "SELECT access_expires_at, last_refresh_at FROM accounts WHERE id = 'ta'",
    ).first<any>();
    expect(row.access_expires_at).toBeGreaterThan(Date.now() + 3000 * 1000);
    expect(row.last_refresh_at).toBeGreaterThan(Date.now() - 5000);
  });

  it("invalid_grant flips the account to needs_reconnect and wipes the access token", async () => {
    const e = testEnv();
    g.refreshTokens.set("rt-dead", "invalid_grant");
    await seedTokens(e, "tb", { refresh: "rt-dead" });
    await expect(getAccessToken(e, { googleFetch: g.fetch }, "tu", "tb")).rejects.toMatchObject({
      code: "account_needs_reconnect",
    });
    const row = await env.DB.prepare("SELECT status, access_token_enc FROM accounts WHERE id = 'tb'").first<any>();
    expect(row.status).toBe("needs_reconnect");
    expect(row.access_token_enc).toBeNull();
    await expect(getAccessToken(e, { googleFetch: g.fetch }, "tu", "tb")).rejects.toMatchObject({
      code: "account_needs_reconnect",
    });
  });

  it("re-encrypts lazily under the current key after a rotation", async () => {
    const old = testEnv();
    g.refreshTokens.set("rt-rot", "ok");
    await seedTokens(old, "ta", { refresh: "rt-rot", access: "cached", expiresAt: Date.now() + 10 * 60_000 });
    const rotated = testEnv({ TOKEN_KEKS: JSON.stringify({ k1: K1, k2: K2 }), TOKEN_KEK_CURRENT: "k2" });
    expect(await getAccessToken(rotated, { googleFetch: g.fetch }, "tu", "ta")).toBe("cached");
    const row = await env.DB.prepare(
      "SELECT refresh_token_key_id, access_token_key_id FROM accounts WHERE id = 'ta'",
    ).first<any>();
    expect(row.refresh_token_key_id).toBe("k2");
    expect(row.access_token_key_id).toBe("k2");
    expect(
      await Keyring.fromEnv(rotated).decrypt(
        new Uint8Array(
          (await env.DB.prepare("SELECT refresh_token_enc AS c FROM accounts WHERE id = 'ta'").first<any>()).c,
        ),
        "k2",
        { userId: "tu", accountId: "ta", field: "refresh_token" },
      ),
    ).toBe("rt-rot");
  });

  it("a revoke that lands while a refresh is in flight wins: the refresh result is discarded", async () => {
    const e = testEnv();
    g.refreshTokens.set("rt-race", "ok");
    await seedTokens(e, "ta", { refresh: "rt-race", access: "old", expiresAt: Date.now() + 1000 });
    g.beforeRefresh = async () => {
      await revokeAccount(e, { googleFetch: g.fetch }, "tu", "ta");
    };
    try {
      await expect(getAccessToken(e, { googleFetch: g.fetch }, "tu", "ta")).rejects.toMatchObject({
        code: "account_needs_reconnect",
      });
    } finally {
      g.beforeRefresh = null;
    }
    const row = await env.DB.prepare(
      "SELECT status, access_token_enc, refresh_token_enc FROM accounts WHERE id = 'ta'",
    ).first<any>();
    expect(row).toEqual({ status: "revoked", access_token_enc: null, refresh_token_enc: null });
  });

  it("a lazy re-encrypt that races a revoke cannot resurrect ciphertexts", async () => {
    const old = testEnv();
    g.refreshTokens.set("rt-rot2", "ok");
    await env.DB.prepare("UPDATE accounts SET status = 'active', credential_version = 0 WHERE id = 'tb'").run();
    await seedTokens(old, "tb", { refresh: "rt-rot2", access: "cached", expiresAt: Date.now() + 10 * 60_000 });
    const rotated = testEnv({ TOKEN_KEKS: JSON.stringify({ k1: K1, k2: K2 }), TOKEN_KEK_CURRENT: "k2" });
    // Bump the version between the read and the write by revoking directly in D1, as a concurrent request would.
    await env.DB.prepare(
      "UPDATE accounts SET status = 'revoked', credential_version = credential_version + 1, refresh_token_enc = NULL, refresh_token_key_id = NULL, access_token_enc = NULL, access_token_key_id = NULL WHERE id = 'tb'",
    ).run();
    await expect(getAccessToken(rotated, { googleFetch: g.fetch }, "tu", "tb")).rejects.toMatchObject({
      code: "account_needs_reconnect",
    });
    const row = await env.DB.prepare(
      "SELECT refresh_token_enc, access_token_enc FROM accounts WHERE id = 'tb'",
    ).first<any>();
    expect(row).toEqual({ refresh_token_enc: null, access_token_enc: null });
  });

  it("ownership is in the query, and revoke wipes ciphertexts before telling Google", async () => {
    const e = testEnv();
    await expect(getAccessToken(e, { googleFetch: g.fetch }, "tv", "ta")).rejects.toMatchObject({
      code: "account_not_found",
    });
    g.refreshTokens.set("rt-rev", "ok");
    await seedTokens(e, "ta", { refresh: "rt-rev", access: "x", expiresAt: Date.now() + 600_000 });
    const before = (await env.DB.prepare("SELECT credential_version AS v FROM accounts WHERE id = 'ta'").first<any>())
      .v;
    await revokeAccount(e, { googleFetch: g.fetch }, "tu", "ta");
    expect(g.revoked.has("rt-rev")).toBe(true);
    const row = await env.DB.prepare(
      "SELECT status, is_default, credential_version, refresh_token_enc, access_token_enc, refresh_token_key_id FROM accounts WHERE id = 'ta'",
    ).first<any>();
    expect(row).toMatchObject({
      status: "revoked",
      is_default: 0,
      credential_version: before + 1,
      refresh_token_enc: null,
      access_token_enc: null,
      refresh_token_key_id: null,
    });
  });
});
