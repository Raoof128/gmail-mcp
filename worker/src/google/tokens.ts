import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Deps } from "../deps";
import type { Env } from "../env";
import { Keyring } from "../crypto/keyring";
import { refreshAccessToken, revokeToken } from "./oidc";

const EXPIRY_MARGIN_MS = 60_000;

type TokenRow = {
  id: string;
  status: "active" | "needs_reconnect" | "revoked";
  credential_version: number;
  refresh_token_enc: ArrayBuffer | null;
  refresh_token_key_id: string | null;
  access_token_enc: ArrayBuffer | null;
  access_token_key_id: string | null;
  access_expires_at: number | null;
};

async function load(db: D1Database, userId: string, accountId: string): Promise<TokenRow> {
  const row = await db
    .prepare(
      `SELECT id, status, credential_version, refresh_token_enc, refresh_token_key_id, access_token_enc, access_token_key_id, access_expires_at
       FROM accounts WHERE id = ? AND user_id = ?`,
    )
    .bind(accountId, userId)
    .first<TokenRow>();
  if (!row) throw new GmailMcpError("account_not_found", "account_not_found");
  return row;
}

const reconnect = (why: string) => new GmailMcpError("account_needs_reconnect", `account_needs_reconnect: ${why}`);

/**
 * Every credential write is conditional on the version read at the start and on the row still being
 * active. A revoke or reconnect in between bumps the version, the write matches nothing, and the
 * caller gets needs_reconnect rather than a token the owner has just withdrawn.
 */
async function guardedWrite(env: Env, sql: string, binds: unknown[], row: TokenRow, userId: string): Promise<void> {
  const res = await env.DB.prepare(
    `${sql} WHERE id = ? AND user_id = ? AND status = 'active' AND credential_version = ?`,
  )
    .bind(...binds, row.id, userId, row.credential_version)
    .run();
  if ((res.meta.changes ?? 0) !== 1) throw reconnect("credentials changed during refresh");
}

/**
 * Spec 3.3. The cached access token is used while it has more than a minute left; otherwise the
 * refresh token buys a new one. Any ciphertext read under a key that is no longer current is
 * rewritten under the current one, which is how a rotation completes without a migration.
 */
export async function getAccessToken(
  env: Env,
  deps: Deps,
  userId: string,
  accountId: string,
  o: { forceRefresh?: boolean } = {},
): Promise<string> {
  const row = await load(env.DB, userId, accountId);
  if (row.status !== "active") throw reconnect(row.status);
  const ring = Keyring.fromEnv(env);
  const now = Date.now();

  if (
    !o.forceRefresh &&
    row.access_token_enc &&
    row.access_token_key_id &&
    row.access_expires_at &&
    row.access_expires_at - now > EXPIRY_MARGIN_MS
  ) {
    const token = await ring.decrypt(new Uint8Array(row.access_token_enc), row.access_token_key_id, {
      userId,
      accountId,
      field: "access_token",
    });
    if (row.access_token_key_id !== ring.currentKeyId || row.refresh_token_key_id !== ring.currentKeyId) {
      const refresh =
        row.refresh_token_enc && row.refresh_token_key_id
          ? await ring.decrypt(new Uint8Array(row.refresh_token_enc), row.refresh_token_key_id, {
              userId,
              accountId,
              field: "refresh_token",
            })
          : null;
      const at = await ring.encrypt(token, { userId, accountId, field: "access_token" });
      const rt = refresh === null ? null : await ring.encrypt(refresh, { userId, accountId, field: "refresh_token" });
      await guardedWrite(
        env,
        `UPDATE accounts SET access_token_enc = ?, access_token_key_id = ?,
           refresh_token_enc = COALESCE(?, refresh_token_enc), refresh_token_key_id = COALESCE(?, refresh_token_key_id)`,
        [at.ciphertext, at.keyId, rt?.ciphertext ?? null, rt?.keyId ?? null],
        row,
        userId,
      );
    }
    return token;
  }

  if (!row.refresh_token_enc || !row.refresh_token_key_id) throw reconnect("no refresh token");
  const refresh = await ring.decrypt(new Uint8Array(row.refresh_token_enc), row.refresh_token_key_id, {
    userId,
    accountId,
    field: "refresh_token",
  });
  const result = await refreshAccessToken(env, deps, refresh);
  if (result === "invalid_grant") {
    // Same guard: if the account was revoked meanwhile, leave the revoked row exactly as it is.
    await env.DB.prepare(
      `UPDATE accounts SET status = 'needs_reconnect', access_token_enc = NULL, access_token_key_id = NULL, access_expires_at = NULL
       WHERE id = ? AND user_id = ? AND status = 'active' AND credential_version = ?`,
    )
      .bind(accountId, userId, row.credential_version)
      .run();
    throw reconnect("refresh token rejected");
  }
  const at = await ring.encrypt(result.access_token, { userId, accountId, field: "access_token" });
  const rt =
    row.refresh_token_key_id === ring.currentKeyId
      ? null
      : await ring.encrypt(refresh, { userId, accountId, field: "refresh_token" });
  await guardedWrite(
    env,
    `UPDATE accounts SET access_token_enc = ?, access_token_key_id = ?, access_expires_at = ?, last_refresh_at = ?,
       refresh_token_enc = COALESCE(?, refresh_token_enc), refresh_token_key_id = COALESCE(?, refresh_token_key_id)`,
    [at.ciphertext, at.keyId, now + result.expires_in * 1000, now, rt?.ciphertext ?? null, rt?.keyId ?? null],
    row,
    userId,
  );
  return result.access_token;
}

/**
 * Local first. Read the ciphertext, then revoke and wipe in one statement guarded on the version that
 * was read; only after the wipe has landed is Google's revoke endpoint told, best effort. A concurrent
 * reconnect that moved the version makes the guarded wipe match nothing, and the loop re-reads and
 * wipes that newer credential too, so the outcome is always "revoked" for the row the owner pointed at.
 * (RETURNING was measured to yield post-update values, so it cannot return the old ciphertext.)
 */
export async function revokeAccount(env: Env, deps: Deps, userId: string, accountId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await load(env.DB, userId, accountId);
    const res = await env.DB.prepare(
      `UPDATE accounts SET status = 'revoked', is_default = 0, credential_version = credential_version + 1,
         refresh_token_enc = NULL, refresh_token_key_id = NULL, access_token_enc = NULL, access_token_key_id = NULL, access_expires_at = NULL
       WHERE id = ? AND user_id = ? AND credential_version = ?`,
    )
      .bind(accountId, userId, row.credential_version)
      .run();
    if ((res.meta.changes ?? 0) !== 1) continue;
    if (row.refresh_token_enc && row.refresh_token_key_id) {
      const ring = Keyring.fromEnv(env);
      const refresh = await ring.decrypt(new Uint8Array(row.refresh_token_enc), row.refresh_token_key_id, {
        userId,
        accountId,
        field: "refresh_token",
      });
      await revokeToken(deps, refresh);
    }
    return;
  }
  throw new GmailMcpError("internal", "revoke lost three races with concurrent credential writes");
}
