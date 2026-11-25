import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { expireCases, upsertCase } from '../src/cases';
import type { PartnerApi } from '../src/index';
import { activePartner, caseInput, db, T0, unwrap } from './helpers';

const DAY = 86_400;

describe('PartnerApi', () => {
  it('pages through events with a cursor, including events in the same second', async () => {
    const partner = await activePartner();
    for (let i = 0; i < 3; i++) unwrap(await upsertCase(db(), partner, caseInput(), 'u', T0));
    // Three cases expire in the same second: three events with the same created_at.
    await expireCases(db(), T0 + 30 * DAY);
    const api = exports.PartnerApi as unknown as PartnerApi;
    const first = unwrap(await api.events(partner.orgId, null, 2));
    expect(first.events).toHaveLength(2);
    const second = unwrap(await api.events(partner.orgId, first.next_cursor, 2));
    expect(second.events).toHaveLength(1);
    const third = unwrap(await api.events(partner.orgId, second.next_cursor, 2));
    expect(third.events).toHaveLength(0);
    expect(third.next_cursor).toBe(second.next_cursor);
    const ids = [...first.events, ...second.events].map((e) => e.id);
    expect(new Set(ids).size).toBe(3);
    expect(await api.events('not-a-partner', null)).toMatchObject({ error: 'not_a_partner' });
  });

  it('counts cases per status', async () => {
    const partner = await activePartner();
    unwrap(await upsertCase(db(), partner, caseInput(), 'u', T0));
    unwrap(await upsertCase(db(), partner, caseInput({ vin: '' }), 'u', T0));
    const counts = unwrap(
      await (exports.PartnerApi as unknown as PartnerApi).counts(partner.orgId),
    );
    expect(counts).toEqual({
      pending_identity: 1,
      active: 1,
      delivered: 0,
      withdrawn: 0,
      expired: 0,
    });
  });

  it('refuses writes for an organization that is not an active partner', async () => {
    expect(
      await (exports.PartnerApi as unknown as PartnerApi).upsertCase(
        'unknown-org',
        'u',
        caseInput(),
      ),
    ).toMatchObject({
      error: 'not_a_partner',
    });
  });
});
