import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

declare global {
  // A namespace is the shape `wrangler types` generates and the only way to merge secrets
  // into the generated Cloudflare.Env, so the ES-module preference does not apply here.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    interface Env {
      TOKEN_KEKS: string; // JSON { key_id: base64 32 bytes }
      TOKEN_KEK_CURRENT: string; // key_id
      STATE_HMAC_KEY: string; // base64 32 bytes
      CSRF_HMAC_KEY: string; // base64 32 bytes
      GOOGLE_CLIENT_ID: string;
      GOOGLE_CLIENT_SECRET: string;
      OWNER_GOOGLE_SUBS: string; // comma separated Google subs allowed to log in; empty enables bootstrap
      OWNER_EMAILS: string; // comma separated; consulted only while OWNER_GOOGLE_SUBS is empty, to decide who may see their sub
      OAUTH_PROVIDER: OAuthHelpers; // injected by workers-oauth-provider on every handled request
      DEV_STATIC_TOKEN?: string; // dev only; deleted with mcp/auth-dev.ts once the provider guards /mcp
      DEV_STATIC_USER?: string; // dev only
    }
  }
}
export type Env = Cloudflare.Env;

export function ownerSubs(env: Env): string[] {
  return env.OWNER_GOOGLE_SUBS.split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}
export function ownerEmails(env: Env): string[] {
  return env.OWNER_EMAILS.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
}
