import { env } from "cloudflare:test";
import type { Env } from "../src/env";

const K = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="; // 32 bytes of 0x01, base64

/**
 * Every test builds its env from here. A plain spread copy, never Object.create(env): the test env
 * is a Proxy and writes to a child delegate up the chain. Every secret is set explicitly, so a
 * developer's .dev.vars cannot change what a test sees, and the dev bearer keys are removed if present.
 */
export function testEnv(overrides: Record<string, unknown> = {}): Env {
  const copy: Record<string, unknown> = { ...env };
  delete copy.DEV_STATIC_TOKEN;
  delete copy.DEV_STATIC_USER;
  return {
    ...copy,
    TOKEN_KEKS: JSON.stringify({ k1: K }),
    TOKEN_KEK_CURRENT: "k1",
    STATE_HMAC_KEY: K,
    CSRF_HMAC_KEY: K,
    GOOGLE_CLIENT_ID: "gid.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "gsecret",
    OWNER_GOOGLE_SUBS: "owner-sub",
    OWNER_EMAILS: "owner@example.test",
    WORKER_HOSTNAME: "gmail-mcp.example.workers.dev",
    ...overrides,
  } as unknown as Env;
}

export const HOST = "https://gmail-mcp.example.workers.dev";
