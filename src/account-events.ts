import { auditStatement } from './audit';

/**
 * What login tells Emanet when an account or an organization is deleted, and what it asks for
 * "Download your data" (2earl/login GATEWAY_INTEGRATION §5). Every method is idempotent.
 *
 * Money records stay: Turkish law keeps books and their documents for years (VUK 253, TTK 82), so
 * payouts and journal lines remain, tied to an account ID that no longer leads to a person.
 * Everything else that identifies the person goes.
 */

/** An agent's identity, bank account and claims go; their payouts and books stay. */
export async function deleteUser(db: D1Database, userId: string, at: number): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE claims SET closed_at = ?, close_reason = 'revoked'
         WHERE agent_id = ? AND closed_at IS NULL`,
      )
      .bind(at, userId),
    db
      .prepare(
        `UPDATE agents SET status = 'banned', legal_name = NULL, tckn_hash = NULL, city = NULL,
           iban = NULL, iban_verified_at = NULL, vkn = NULL, phone = NULL, updated_at = ?
         WHERE user_id = ?`,
      )
      .bind(at, userId),
    db.prepare('DELETE FROM kyc_checks WHERE agent_id = ?').bind(userId),
    db.prepare('DELETE FROM cooldowns WHERE agent_id = ?').bind(userId),
    auditStatement(db, at, 'system', 'account.deleted', `agent:${userId}`),
  ]);
}

/** What Emanet holds about a person: as an agent, their record, claims and payouts. */
export async function exportUser(db: D1Database, userId: string): Promise<Record<string, unknown>> {
  const agent = await db
    .prepare(
      `SELECT status, legal_name, city, phone, iban, tax_profile, vkn, terms_version, terms_accepted_at,
         created_at FROM agents WHERE user_id = ?`,
    )
    .bind(userId)
    .first();
  if (!agent) return { service: 'Emanet', agent: null };
  const [claims, payouts] = await Promise.all([
    db
      .prepare(
        'SELECT vehicle_id, state, claimed_at, closed_at, close_reason FROM claims WHERE agent_id = ? ORDER BY claimed_at',
      )
      .bind(userId)
      .all(),
    db
      .prepare(
        'SELECT gross_kurus, withholding_kurus, net_kurus, status, created_at FROM payouts WHERE agent_id = ? ORDER BY created_at',
      )
      .bind(userId)
      .all(),
  ]);
  return { service: 'Emanet', agent, claims: claims.results, payouts: payouts.results };
}

/**
 * A creditor's organization is gone: it is suspended and its open cases withdrawn, so agents stop
 * looking. Invoices, receipts and the journal stay (see above).
 */
export async function deleteOrganization(db: D1Database, orgId: string, at: number): Promise<void> {
  const partner = await db
    .prepare('SELECT id FROM partners WHERE org_id = ?')
    .bind(orgId)
    .first<{ id: string }>();
  if (!partner) return;
  await db.batch([
    db
      .prepare(`UPDATE partners SET status = 'suspended', updated_at = ? WHERE id = ?`)
      .bind(at, partner.id),
    db
      .prepare(
        `UPDATE cases SET status = 'withdrawn', closed_reason = 'organization deleted', updated_at = ?
         WHERE partner_id = ? AND status IN ('active', 'pending_identity')`,
      )
      .bind(at, partner.id),
    db
      .prepare(
        `DELETE FROM case_places WHERE case_id IN (
         SELECT id FROM cases WHERE partner_id = ? AND status = 'withdrawn')`,
      )
      .bind(partner.id),
    auditStatement(db, at, 'system', 'organization.deleted', `partner:${partner.id}`),
  ]);
  await db
    .prepare(
      `UPDATE claims SET closed_at = ?, close_reason = 'revoked'
       WHERE closed_at IS NULL AND NOT EXISTS (
         SELECT 1 FROM cases c WHERE c.vehicle_id = claims.vehicle_id AND c.status = 'active')`,
    )
    .bind(at)
    .run();
}
