import {
  getOAuthApi,
  type OAuthHelpers,
  type OAuthProviderOptions,
  type ClientInfo,
} from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import type { Env } from "../env";
import { randomId } from "../crypto/random";
export const COMPANION_KEY = "companion_client_id";
export const COMPANION_MARKER = "gmail-mcp-companion:attempt:";
export const isCompanionName = (name: unknown) =>
  typeof name === "string" && (name.startsWith(COMPANION_MARKER) || name === "gmail-mcp-companion");
const Attempt = z.object({
  marker: z.string().startsWith(COMPANION_MARKER),
  fence: z.string(),
  lease_until: z.number(),
});
export async function getCompanionClientId(db: D1Database): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key=?").bind(COMPANION_KEY).first<{ value: string }>();
  return row && row.value !== "pending" && !row.value.startsWith("{") ? row.value : null;
}
export type HelpersSource = OAuthHelpers | { oauthOptions: (env: Env) => OAuthProviderOptions<Env> };
const metadata = {
  redirectUris: ["http://127.0.0.1/callback", "http://localhost/callback"],
  tokenEndpointAuthMethod: "none",
  grantTypes: ["authorization_code", "refresh_token"],
  responseTypes: ["code"],
};
function matches(client: ClientInfo, marker: string) {
  return (
    client.clientName === marker &&
    client.tokenEndpointAuthMethod === metadata.tokenEndpointAuthMethod &&
    JSON.stringify(client.redirectUris) === JSON.stringify(metadata.redirectUris) &&
    JSON.stringify(client.grantTypes) === JSON.stringify(metadata.grantTypes) &&
    JSON.stringify(client.responseTypes) === JSON.stringify(metadata.responseTypes)
  );
}
/** Owner/recent-authentication enforced by the accounts route; ambiguous attempts remain quarantined. */
export async function registerCompanionClient(env: Env, source: HelpersSource): Promise<string> {
  const db = env.DB;
  const existing = await getCompanionClientId(db);
  if (existing) return existing;
  const helpers: OAuthHelpers = "createClient" in source ? source : getOAuthApi(source.oauthOptions(env), env);
  const attempt = {
    marker: COMPANION_MARKER + randomId("reg"),
    fence: randomId("fence"),
    lease_until: Date.now() + 120_000,
  };
  let value = JSON.stringify(attempt);
  const reserved = await db
    .prepare("INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES(?,?,?)")
    .bind(COMPANION_KEY, value, Date.now())
    .run();
  let client: ClientInfo;
  if (reserved.meta.changes === 1) {
    // Persisted marker survives createClient response loss; never erase it on failure.
    client = await helpers.createClient({ clientName: attempt.marker, ...metadata });
  } else {
    const row = await db
      .prepare("SELECT value FROM settings WHERE key=?")
      .bind(COMPANION_KEY)
      .first<{ value: string }>();
    if (!row || row.value === "pending")
      throw new Error("companion registration quarantined: legacy attempt requires owner repair");
    if (!row.value.startsWith("{")) return row.value;
    let old = Attempt.parse(JSON.parse(row.value));
    if (old.lease_until > Date.now()) {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const id = await getCompanionClientId(db);
        if (id) return id;
      }
      throw new Error("companion registration in progress; retry");
    }
    const replacement = { ...old, fence: randomId("fence"), lease_until: Date.now() + 120_000 };
    value = JSON.stringify(replacement);
    const claimed = await db
      .prepare("UPDATE settings SET value=?,updated_at=? WHERE key=? AND value=?")
      .bind(value, Date.now(), COMPANION_KEY, row.value)
      .run();
    if (claimed.meta.changes !== 1) throw new Error("companion registration in progress; retry");
    old = replacement;
    const candidates: ClientInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await helpers.listClients({ limit: 100, ...(cursor ? { cursor } : {}) });
      candidates.push(...result.items.filter((c) => c.clientName === old.marker));
      cursor = result.cursor;
      if (!cursor) break;
    }
    if (cursor || candidates.length !== 1 || !matches(candidates[0]!, old.marker))
      throw new Error("companion registration quarantined: reconciliation incomplete");
    client = candidates[0]!;
  }
  const finalized = await db
    .prepare("UPDATE settings SET value=?,updated_at=? WHERE key=? AND value=?")
    .bind(client.clientId, Date.now(), COMPANION_KEY, value)
    .run();
  if (finalized.meta.changes !== 1 && (await getCompanionClientId(db)) !== client.clientId)
    throw new Error("companion registration quarantined: creator fence lost");
  return client.clientId;
}
