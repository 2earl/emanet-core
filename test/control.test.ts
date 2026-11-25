import { describe, expect, it } from 'vitest';
import { getCase, upsertCase } from '../src/cases';
import {
  listPartners,
  partnerDetail,
  resolveIdentity,
  reviewDetail,
  updatePartner,
} from '../src/control';
import { activePartner, caseInput, db, randomPlate, randomVin, T0, unwrap } from './helpers';

async function openReview(caseId: string) {
  const row = await db()
    .prepare(`SELECT id FROM review_items WHERE subject_id = ? AND status = 'open'`)
    .bind(caseId)
    .first<{ id: string }>();
  return row?.id ?? '';
}

describe('control', () => {
  it('lists partners with their case counts, and their price list', async () => {
    const partner = await activePartner();
    unwrap(await upsertCase(db(), partner, caseInput(), 'u', T0));
    const row = (await listPartners(db())).find((p) => p.id === partner.id);
    expect(row).toMatchObject({ active_cases: 1, delivered_cases: 0, status: 'active' });
    const detail = unwrap(await partnerDetail(db(), partner.id, T0));
    expect(detail.priceList).toEqual({ default_kurus: 1_000_000, rules: [] });
    expect(
      await updatePartner(
        db(),
        's',
        partner.id,
        {
          legalName: 'X',
          vkn: '12',
          taxOffice: null,
          kepAddress: null,
          eInvoice: true,
          reconfirmDays: 14,
        },
        T0,
      ),
    ).toMatchObject({ error: 'invalid_vkn' });
    unwrap(
      await updatePartner(
        db(),
        's',
        partner.id,
        {
          legalName: 'Yeni Ad A.Ş.',
          vkn: '1234567890',
          taxOffice: 'Kadıköy',
          kepAddress: null,
          eInvoice: true,
          reconfirmDays: 30,
        },
        T0,
      ),
    );
    expect(unwrap(await partnerDetail(db(), partner.id, T0)).partner).toMatchObject({
      legal_name: 'Yeni Ad A.Ş.',
      reconfirm_days: 30,
    });
  });

  it('accepts a missing VIN, joining the vehicle that already has it', async () => {
    const a = await activePartner();
    const b = await activePartner();
    const vin = randomVin();
    const plate = randomPlate();
    unwrap(await upsertCase(db(), a, caseInput({ vin, plate }), 'u', T0));
    const pending = unwrap(await upsertCase(db(), b, caseInput({ vin: '', plate }), 'u', T0));
    expect(pending.status).toBe('pending_identity');
    const reviewId = await openReview(pending.id);
    const detail = unwrap(await reviewDetail(db(), reviewId));
    expect(detail.item.kind).toBe('missing_vin');
    expect(
      await resolveIdentity(db(), 's', reviewId, { action: 'accept', vin: 'nope' }, T0),
    ).toMatchObject({ error: 'invalid_vin' });
    unwrap(await resolveIdentity(db(), 's', reviewId, { action: 'accept', vin }, T0 + 1));
    expect(unwrap(await getCase(db(), b.id, pending.id)).status).toBe('active');
    const vehicles = await db()
      .prepare(
        'SELECT count(DISTINCT vehicle_id) AS n FROM cases WHERE id IN (SELECT id FROM cases WHERE vehicle_id = (SELECT id FROM vehicles WHERE vin = ?))',
      )
      .bind(vin)
      .first<{ n: number }>();
    expect(vehicles?.n).toBe(1);
    expect(await reviewDetail(db(), reviewId)).toMatchObject({ error: 'not_found' });
  });

  it('accepts a plate change, moving the plate', async () => {
    const partner = await activePartner();
    const vin = randomVin();
    const first = unwrap(await upsertCase(db(), partner, caseInput({ vin }), 'u', T0));
    const other = await activePartner();
    const newPlate = randomPlate();
    const changed = unwrap(
      await upsertCase(db(), other, caseInput({ vin, plate: newPlate }), 'u', T0),
    );
    unwrap(
      await resolveIdentity(db(), 's', await openReview(changed.id), { action: 'accept' }, T0 + 1),
    );
    const plates = await db()
      .prepare(
        'SELECT plate FROM vehicle_plates WHERE vehicle_id = (SELECT id FROM vehicles WHERE vin = ?) AND valid_to IS NULL',
      )
      .bind(vin)
      .all<{ plate: string }>();
    expect(plates.results.map((r) => r.plate)).toEqual([newPlate]);
    expect(unwrap(await getCase(db(), partner.id, first.id)).status).toBe('active');
  });

  it('rejects, closing the case and telling the partner', async () => {
    const partner = await activePartner();
    const pending = unwrap(await upsertCase(db(), partner, caseInput({ vin: '' }), 'u', T0));
    unwrap(
      await resolveIdentity(
        db(),
        's',
        await openReview(pending.id),
        { action: 'reject', reason: 'Plate belongs to a scrapped vehicle' },
        T0 + 1,
      ),
    );
    expect(unwrap(await getCase(db(), partner.id, pending.id)).status).toBe('withdrawn');
    const event = await db()
      .prepare(`SELECT type FROM outbox WHERE partner_id = ? AND type = 'case.rejected'`)
      .bind(partner.id)
      .first();
    expect(event).not.toBeNull();
  });
});
