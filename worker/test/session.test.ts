import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import {
  ABSOLUTE_MS,
  IDLE_MS,
  RECENT_AUTH_MS,
  SESSION_COOKIE,
  createSession,
  isRecentlyAuthenticated,
  markReauthenticated,
  readSession,
  revokeOtherSessions,
  revokeSession,
} from "../src/web/session";
import { seedUserAndAccount } from "./fixtures";

const req = (cookie: string | null) => new Request("https://x.test/accounts", { headers: cookie ? { cookie } : {} });

beforeAll(async () => {
  await seedUserAndAccount(env.DB, { userId: "su", accountId: "sa", alias: "personal", isDefault: true });
});

describe("sessions", () => {
  it("creates a __Host- cookie with the required attributes and stores only a hash", async () => {
    const s = await createSession(env.DB, "su");
    expect(s.cookie).toMatch(
      new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; Secure; SameSite=Lax$`),
    );
    const row = await env.DB.prepare("SELECT id_hash FROM web_sessions WHERE user_id = 'su'").first<{
      id_hash: string;
    }>();
    expect(row?.id_hash).not.toBe(s.id);
    expect(row?.id_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reads back the session and rejects a tampered or missing cookie", async () => {
    const s = await createSession(env.DB, "su");
    expect((await readSession(env.DB, req(`${SESSION_COOKIE}=${s.id}`)))?.userId).toBe("su");
    expect(await readSession(env.DB, req(`${SESSION_COOKIE}=${s.id.slice(0, -1)}x`))).toBeNull();
    expect(await readSession(env.DB, req(null))).toBeNull();
  });

  it("enforces idle and absolute limits from stored timestamps", async () => {
    const idle = await createSession(env.DB, "su");
    await env.DB.prepare("UPDATE web_sessions SET last_seen_at = ? WHERE id_hash = ?")
      .bind(Date.now() - IDLE_MS - 1000, idle.idHash)
      .run();
    expect(await readSession(env.DB, req(`${SESSION_COOKIE}=${idle.id}`))).toBeNull();

    const old = await createSession(env.DB, "su");
    await env.DB.prepare("UPDATE web_sessions SET created_at = ?, expires_at = ? WHERE id_hash = ?")
      .bind(Date.now() - ABSOLUTE_MS - 1000, Date.now() - 1000, old.idHash)
      .run();
    expect(await readSession(env.DB, req(`${SESSION_COOKIE}=${old.id}`))).toBeNull();
  });

  it("recent authentication counts authenticated_at only, never last_seen_at", async () => {
    const s = await createSession(env.DB, "su");
    const live = (await readSession(env.DB, req(`${SESSION_COOKIE}=${s.id}`)))!;
    expect(isRecentlyAuthenticated(live)).toBe(true);
    await env.DB.prepare("UPDATE web_sessions SET authenticated_at = ?, last_seen_at = ? WHERE id_hash = ?")
      .bind(Date.now() - RECENT_AUTH_MS - 1000, Date.now(), s.idHash)
      .run();
    const stale = (await readSession(env.DB, req(`${SESSION_COOKIE}=${s.id}`)))!;
    expect(isRecentlyAuthenticated(stale)).toBe(false);
    await markReauthenticated(env.DB, s.idHash);
    expect(isRecentlyAuthenticated((await readSession(env.DB, req(`${SESSION_COOKIE}=${s.id}`)))!)).toBe(true);
  });

  it("revoke and revoke-others", async () => {
    const a = await createSession(env.DB, "su");
    const b = await createSession(env.DB, "su");
    await revokeOtherSessions(env.DB, "su", a.idHash);
    expect(await readSession(env.DB, req(`${SESSION_COOKIE}=${b.id}`))).toBeNull();
    expect((await readSession(env.DB, req(`${SESSION_COOKIE}=${a.id}`)))?.userId).toBe("su");
    await revokeSession(env.DB, a.idHash);
    expect(await readSession(env.DB, req(`${SESSION_COOKIE}=${a.id}`))).toBeNull();
  });
});
