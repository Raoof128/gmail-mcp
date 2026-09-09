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
