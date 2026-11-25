import { describe, expect, it } from 'vitest';
import { deleteOrganization, deleteUser, exportUser } from '../src/account-events';
import { getCase, upsertCase } from '../src/cases';
import { claimDetails, claimVehicle } from '../src/claims';
import { activeAgent, activePartner, caseInput, db, payoutRule, T0, unwrap } from './helpers';

describe('account events', () => {
  it('removes an agent’s identity and claims, keeps nothing that names them', async () => {
    await payoutRule();
    const partner = await activePartner();
    const view = unwrap(await upsertCase(db(), partner, caseInput(), 'u', T0));
    const vehicle = await db()
      .prepare('SELECT vehicle_id FROM cases WHERE id = ?')
      .bind(view.id)
      .first<{ vehicle_id: string }>();
    const agent = await activeAgent();
    await db()
      .prepare(`UPDATE agents SET legal_name = 'Ada Yılmaz', iban = 'TR000' WHERE user_id = ?`)
      .bind(agent)
      .run();
    const claim = unwrap(await claimVehicle(db(), agent, vehicle?.vehicle_id ?? '', T0));
    expect(await exportUser(db(), agent)).toMatchObject({ agent: { legal_name: 'Ada Yılmaz' } });

    await deleteUser(db(), agent, T0 + 10);
    await deleteUser(db(), agent, T0 + 20); // idempotent
    expect(await claimDetails(db(), agent, claim.id, T0 + 30)).toMatchObject({
      error: 'not_found',
    });
    const row = await db()
      .prepare('SELECT status, legal_name, iban FROM agents WHERE user_id = ?')
      .bind(agent)
      .first();
    expect(row).toEqual({ status: 'banned', legal_name: null, iban: null });
    expect(await exportUser(db(), 'nobody')).toEqual({ service: 'Emanet', agent: null });
  });

  it('suspends a deleted organization and withdraws its open cases', async () => {
    const partner = await activePartner();
    const view = unwrap(await upsertCase(db(), partner, caseInput(), 'u', T0));
    await deleteOrganization(db(), partner.orgId, T0 + 10);
    await deleteOrganization(db(), partner.orgId, T0 + 20);
    await deleteOrganization(db(), 'unknown-org', T0 + 20);
    const after = unwrap(await getCase(db(), partner.id, view.id));
    expect(after.status).toBe('withdrawn');
    expect(after.places).toEqual([]);
    const status = await db()
      .prepare('SELECT status FROM partners WHERE id = ?')
      .bind(partner.id)
      .first<{ status: string }>();
    expect(status?.status).toBe('suspended');
  });
});
