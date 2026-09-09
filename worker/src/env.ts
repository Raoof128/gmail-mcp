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
      DEV_STATIC_TOKEN?: string; // dev only; Plan 2 deletes the code that reads it
      DEV_STATIC_USER?: string; // dev only
    }
  }
}
export type Env = Cloudflare.Env;
