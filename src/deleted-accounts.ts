/**
 * Accounts login deleted (src/account-events.ts records them): an app may still hold a session
 * for one, so nothing new starts in its name. Only a SHA-256 of the account ID is kept.
 */

/** SHA-256 of an account ID: enough to recognise it again, nothing to read. */
export async function accountHash(userId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`account:${userId}`)),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whether login deleted this account: nothing new starts in its name. */
export async function accountDeleted(db: D1Database, userId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS yes FROM deleted_accounts WHERE user_hash = ?')
    .bind(await accountHash(userId))
    .first();
  return row !== null;
}

/** Sessions in the apps last at most 30 days; after 60 the record has done its job. */
export async function purgeDeletedAccounts(db: D1Database, at: number): Promise<number> {
  const result = await db
    .prepare('DELETE FROM deleted_accounts WHERE deleted_at < ?')
    .bind(at - 60 * 86_400)
    .run();
  return result.meta.changes;
}
