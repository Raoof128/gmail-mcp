import { getOAuthApi, type OAuthHelpers, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";

export const COMPANION_KEY = "companion_client_id";

const PENDING = "pending";

export async function getCompanionClientId(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind(COMPANION_KEY)
    .first<{ value: string }>();
  return row && row.value !== PENDING ? row.value : null;
}

/**
 * One public client, created once, id stored in settings. createClient() picks the id, so a
 * pre-agreed name like "companion" is not an option; the owner copies the id from the Accounts page.
 * Loopback redirect URIs match on any port, which is what the companion's ephemeral port needs.
 */
export type HelpersSource = OAuthHelpers | { oauthOptions: (env: Env) => OAuthProviderOptions<Env> };

export async function registerCompanionClient(env: Env, source: HelpersSource): Promise<string> {
  const existing = await getCompanionClientId(env.DB);
  if (existing) return existing;
  // Reserve first. The primary key makes exactly one caller the creator; everyone else waits on the
  // stored value, so the provider never ends up with an orphan client that would be classed as "mcp".
  const reserved = await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(COMPANION_KEY, PENDING, Date.now())
    .run();
  if ((reserved.meta.changes ?? 0) !== 1) {
    for (let i = 0; i < 20; i++) {
      const id = await getCompanionClientId(env.DB);
      if (id) return id;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("companion registration in progress; retry");
  }
  // Inside a request the provider has put OAuthHelpers on env; outside one (tests, a future CLI) the
  // worker's own options rebuild the same helpers over the same KV.
  const helpers: OAuthHelpers = "createClient" in source ? source : getOAuthApi(source.oauthOptions(env), env);
  try {
    const client = await helpers.createClient({
      clientName: "gmail-mcp-companion",
      redirectUris: ["http://127.0.0.1/callback", "http://localhost/callback"],
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
    });
    await env.DB.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ? AND value = ?")
      .bind(client.clientId, Date.now(), COMPANION_KEY, PENDING)
      .run();
    return client.clientId;
  } catch (e) {
    await env.DB.prepare("DELETE FROM settings WHERE key = ? AND value = ?").bind(COMPANION_KEY, PENDING).run();
    throw e;
  }
}
