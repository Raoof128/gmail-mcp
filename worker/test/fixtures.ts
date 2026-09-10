import type { Env } from "../src/env";
import { Keyring } from "../src/crypto/keyring";

export async function seedUserAndAccount(
  db: D1Database,
  o: {
    userId: string;
    accountId: string;
    alias: string;
    isDefault?: boolean;
    orgDomains?: string[];
    sendAs?: string[];
  },
): Promise<void> {
  const now = Date.now();
  await db
    .prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind(o.userId, `${o.userId}@example.test`, now)
    .run();
  await db
    .prepare(
      `INSERT INTO accounts (id, user_id, alias, google_sub, google_email, send_as, org_domains, scopes, status, is_default, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .bind(
      o.accountId,
      o.userId,
      o.alias,
      `sub-${o.accountId}`,
      `${o.alias}@example.test`,
      JSON.stringify(o.sendAs ?? []),
      o.orgDomains ? JSON.stringify(o.orgDomains) : null,
      "gmail.modify",
      o.isDefault ? 1 : 0,
      now,
    )
    .run();
}

export async function insertOperation(
  db: D1Database,
  id: string,
  userId: string,
  accountId: string,
  state: string,
  updatedAt = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO operations (id, user_id, account_id, action, state, payload_hash, created_at, updated_at) VALUES (?, ?, ?, 'send.message', ?, 'h', ?, ?)`,
    )
    .bind(id, userId, accountId, state, updatedAt, updatedAt)
    .run();
}

/** Stores an already-valid access token so tool tests never need the token endpoint. */
export async function seedAccessToken(
  e: Env,
  o: { userId: string; accountId: string; access?: string; refresh?: string; expiresInMs?: number },
): Promise<void> {
  const ring = Keyring.fromEnv(e);
  const at = await ring.encrypt(o.access ?? "at-seeded", {
    userId: o.userId,
    accountId: o.accountId,
    field: "access_token",
  });
  const rt = await ring.encrypt(o.refresh ?? "rt-seeded", {
    userId: o.userId,
    accountId: o.accountId,
    field: "refresh_token",
  });
  await e.DB.prepare(
    `UPDATE accounts SET status = 'active', access_token_enc = ?, access_token_key_id = ?, access_expires_at = ?,
       refresh_token_enc = ?, refresh_token_key_id = ? WHERE id = ? AND user_id = ?`,
  )
    .bind(
      at.ciphertext,
      at.keyId,
      Date.now() + (o.expiresInMs ?? 3_600_000),
      rt.ciphertext,
      rt.keyId,
      o.accountId,
      o.userId,
    )
    .run();
}
