import { describe, expect, it } from 'vitest';
import {
  confirmCases,
  expireCases,
  getCase,
  listCases,
  setPartnerStatus,
  upsertCase,
  withdrawCase,
} from '../src/cases';
import { insertDefinition } from '../src/fields';
import { activePartner, caseInput, db, randomPlate, randomVin, T0, unwrap } from './helpers';

const DAY = 86_400;

describe('cases', () => {
  it('creates a case with the fee in force, and the partner sees only what it sent', async () => {
    const partner = await activePartner({
      default_kurus: 1_000_000,
      rules: [{ make: 'Renault', model: 'Clio', fee_kurus: 1_250_000 }],
    });
    const view = unwrap(await upsertCase(db(), partner, caseInput(), 'user-1', T0));
    expect(view.status).toBe('active');
    expect(view.fee_kurus).toBe(1_250_000);
    expect(view.expires_at).toBe(T0 + 14 * DAY);
    expect(view.places).toHaveLength(1);
    expect(view.vehicle.make).toBe('Renault');

    // A later price change doesn't move the fee of an existing case.
    const again = unwrap(
      await upsertCase(
        db(),
        partner,
        {
          ...caseInput(),
          external_ref: view.external_ref,
          vin: view.vehicle.vin ?? '',
          plate: view.vehicle.plate,
        },
        'user-1',
        T0 + 10,
      ),
    );
    expect(again.fee_kurus).toBe(1_250_000);
  });

  it('needs an active partner with a price list', async () => {
    const partner = await activePartner();
    await setPartnerStatus(db(), partner.id, 'suspended', 'staff-1', T0);
    expect(
      await upsertCase(db(), { ...partner, status: 'suspended' }, caseInput(), 'u', T0),
    ).toMatchObject({
      error: 'partner_not_active',
    });
  });

  it('is idempotent on external_ref: sending again updates and confirms', async () => {
    const partner = await activePartner();
    const input = caseInput();
    const first = unwrap(await upsertCase(db(), partner, input, 'u', T0));
    const second = unwrap(
      await upsertCase(
        db(),
        partner,
        {
          ...input,
          places: [
            { kind: 'work', address: 'İş Merkezi No:5', district: 'Şişli', city: 'İstanbul' },
            {
              kind: 'last_seen',
              address: 'AVM otoparkı',
              district: 'Ataşehir',
              city: 'İstanbul',
              lat: 40.99,
              lng: 29.12,
            },
          ],
        },
        'u',
        T0 + DAY,
      ),
    );
    expect(second.id).toBe(first.id);
    expect(second.places.map((p) => p.kind)).toEqual(['work', 'last_seen']);
    expect(second.last_confirmed_at).toBe(T0 + DAY);
  });

  it('refuses a second open case by the same partner for the same vehicle', async () => {
    const partner = await activePartner();
    const input = caseInput();
    unwrap(await upsertCase(db(), partner, input, 'u', T0));
    expect(
      await upsertCase(db(), partner, { ...input, external_ref: 'another-ref' }, 'u', T0),
    ).toMatchObject({ error: 'duplicate_case' });
  });

  it('tells a partner nothing about another partner chasing the same vehicle', async () => {
    const a = await activePartner();
    const b = await activePartner();
    const vin = randomVin();
    const plate = randomPlate();
    const caseA = unwrap(await upsertCase(db(), a, caseInput({ vin, plate }), 'u', T0));
    const caseB = unwrap(
      await upsertCase(db(), b, caseInput({ vin, plate, make: 'RENAULT', colour: 'Gri' }), 'u', T0),
    );
    // Same answer as for a vehicle nobody pursues: active, and only B's own account of it.
    expect(caseB.status).toBe('active');
    expect(caseB.vehicle.colour).toBe('Gri');
    expect(Object.keys(caseB).sort()).toEqual(Object.keys(caseA).sort());
    // And B can't read A's case.
    expect(await getCase(db(), b.id, caseA.id)).toMatchObject({ error: 'not_found' });
    const listed = unwrap(await listCases(db(), b.id, {}));
    expect(listed.cases.map((c) => c.id)).toEqual([caseB.id]);
    // One vehicle row for both.
    const vehicles = await db()
      .prepare('SELECT count(*) AS n FROM vehicles WHERE vin = ?')
      .bind(vin)
      .first<{ n: number }>();
    expect(vehicles?.n).toBe(1);
  });

  it('holds a case for staff when its plate is on another vehicle, or changed', async () => {
    const a = await activePartner();
    const b = await activePartner();
    const plate = randomPlate();
    const vin = randomVin();
    unwrap(await upsertCase(db(), a, caseInput({ vin, plate }), 'u', T0));

    const conflict = unwrap(await upsertCase(db(), b, caseInput({ plate }), 'u', T0));
    expect(conflict.status).toBe('pending_identity');

    const changed = unwrap(
      await upsertCase(db(), b, caseInput({ vin, plate: randomPlate() }), 'u', T0),
    );
    expect(changed.status).toBe('pending_identity');

    const { results } = await db()
      .prepare(
        `SELECT kind, detail FROM review_items WHERE subject_id IN (?, ?) ORDER BY created_at`,
      )
      .bind(conflict.id, changed.id)
      .all<{ kind: string; detail: string }>();
    expect(
      results.map((r) => [r.kind, (JSON.parse(r.detail) as { reason: string }).reason]),
    ).toEqual([
      ['plate_conflict', 'plate_on_other_vehicle'],
      ['plate_conflict', 'plate_change'],
    ]);
  });

  it('holds a case without a VIN for staff, once', async () => {
    const partner = await activePartner();
    const input = caseInput({ vin: '' });
    const view = unwrap(await upsertCase(db(), partner, input, 'u', T0));
    expect(view.status).toBe('pending_identity');
    unwrap(await upsertCase(db(), partner, input, 'u', T0 + 1));
    const items = await db()
      .prepare(
        `SELECT count(*) AS n FROM review_items WHERE subject_id = ? AND kind = 'missing_vin'`,
      )
      .bind(view.id)
      .first<{ n: number }>();
    expect(items?.n).toBe(1);
  });

  it('refuses a VIN that differs from the one the case was created with', async () => {
    const partner = await activePartner();
    const input = caseInput();
    unwrap(await upsertCase(db(), partner, input, 'u', T0));
    expect(await upsertCase(db(), partner, { ...input, vin: randomVin() }, 'u', T0)).toMatchObject({
      error: 'vin_mismatch',
    });
  });

  it('checks input from the partner', async () => {
    const partner = await activePartner();
    expect(await upsertCase(db(), partner, caseInput({ plate: 'ABC' }), 'u', T0)).toMatchObject({
      error: 'invalid_plate',
    });
    expect(await upsertCase(db(), partner, caseInput({ vin: 'SHORT' }), 'u', T0)).toMatchObject({
      error: 'invalid_vin',
    });
    expect(
      await upsertCase(db(), partner, caseInput({ serh_date: '01.10.2026' }), 'u', T0),
    ).toMatchObject({ error: 'invalid_serh_date' });
    expect(
      await upsertCase(db(), partner, caseInput({ legal_basis: 'kefalet' as 'rehin' }), 'u', T0),
    ).toMatchObject({ error: 'invalid_legal_basis' });
    expect(
      await upsertCase(db(), partner, caseInput({ attributes: { anything: 1 } }), 'u', T0),
    ).toMatchObject({ error: 'unknown_field', detail: 'anything' });
  });

  it("validates a partner's own custom fields and keeps staff-only ones from it", async () => {
    const partner = await activePartner();
    await db().batch([
      insertDefinition(
        db(),
        {
          partnerId: partner.id,
          entity: 'case',
          key: 'portfolio',
          labelTr: 'Portföy',
          labelEn: 'Portfolio',
          type: 'enum',
          enumValues: ['A', 'B'],
          required: true,
        },
        T0,
      ),
      insertDefinition(
        db(),
        {
          partnerId: partner.id,
          entity: 'case',
          key: 'staff_note',
          labelTr: 'Not',
          labelEn: 'Note',
          type: 'text',
          visibility: 'admin',
        },
        T0,
      ),
    ]);
    expect(await upsertCase(db(), partner, caseInput(), 'u', T0)).toMatchObject({
      error: 'invalid_field',
    });
    const view = unwrap(
      await upsertCase(db(), partner, caseInput({ attributes: { portfolio: 'B' } }), 'u', T0),
    );
    expect(view.attributes).toEqual({ portfolio: 'B' });
    await db()
      .prepare(
        `UPDATE cases SET attributes = json_set(attributes, '$.staff_note', 'x') WHERE id = ?`,
      )
      .bind(view.id)
      .run();
    expect(unwrap(await getCase(db(), partner.id, view.id)).attributes).toEqual({ portfolio: 'B' });
  });

  it('confirms, withdraws and expires', async () => {
    const partner = await activePartner();
    const kept = unwrap(await upsertCase(db(), partner, caseInput(), 'u', T0));
    const dropped = unwrap(await upsertCase(db(), partner, caseInput(), 'u', T0));
    const withdrawn = unwrap(await upsertCase(db(), partner, caseInput(), 'u', T0));

    expect(
      unwrap(await confirmCases(db(), partner, [kept.id, 'not-a-case'], 'u', T0 + 10 * DAY)),
    ).toEqual({ confirmed: 1 });
    expect(
      unwrap(await withdrawCase(db(), partner, withdrawn.id, 'Borç ödendi', 'u', T0 + DAY)).status,
    ).toBe('withdrawn');
    expect(await withdrawCase(db(), partner, withdrawn.id, 'again', 'u', T0 + DAY)).toMatchObject({
      error: 'case_closed',
    });

    await expireCases(db(), T0 + 15 * DAY);
    expect(unwrap(await getCase(db(), partner.id, dropped.id)).status).toBe('expired');
    expect(unwrap(await getCase(db(), partner.id, kept.id)).status).toBe('active');
    const event = await db()
      .prepare(`SELECT type FROM outbox WHERE partner_id = ? AND payload LIKE ?`)
      .bind(partner.id, `%${dropped.id}%`)
      .first<{ type: string }>();
    expect(event?.type).toBe('case.expired');

    // Sending an expired case again reopens it.
    const reopened = unwrap(
      await upsertCase(
        db(),
        partner,
        {
          ...caseInput(),
          external_ref: dropped.external_ref,
          vin: dropped.vehicle.vin ?? '',
          plate: dropped.vehicle.plate,
        },
        'u',
        T0 + 16 * DAY,
      ),
    );
    expect(reopened.status).toBe('active');
  });

  it('finds cases by plate, chassis number or reference, newest first', async () => {
    const partner = await activePartner();
    const a = unwrap(
      await upsertCase(db(), partner, caseInput({ external_ref: 'REF-A' }), 'u', T0),
    );
    for (let i = 1; i < 4; i++) unwrap(await upsertCase(db(), partner, caseInput(), 'u', T0 + i));
    const byRef = unwrap(await listCases(db(), partner.id, { search: 'REF-A' }));
    expect(byRef.cases.map((c) => c.id)).toEqual([a.id]);
    const plate = byRef.cases[0]?.vehicle.plate ?? '';
    const spaced = plate.replace(/^(\d{2})([A-Z]+)(\d+)$/, '$1 $2 $3').toLowerCase();
    const byPlate = unwrap(await listCases(db(), partner.id, { search: spaced }));
    expect(byPlate.cases.map((c) => c.id)).toContain(a.id);
    expect(unwrap(await listCases(db(), partner.id, { search: 'nothing' })).cases).toHaveLength(0);
    const newest = unwrap(await listCases(db(), partner.id, { newest: true, limit: 2 }));
    expect(newest.cases[0]?.updated_at).toBeGreaterThanOrEqual(newest.cases[1]?.updated_at ?? 0);
    const rest = unwrap(
      await listCases(db(), partner.id, {
        newest: true,
        limit: 2,
        cursor: newest.next_cursor ?? '',
      }),
    );
    const all = [...newest.cases, ...rest.cases].map((c) => c.id);
    expect(new Set(all).size).toBe(4);
    expect(all.at(-1)).toBe(a.id);
  });

  it('pages through cases with a cursor', async () => {
    const partner = await activePartner();
    for (let i = 0; i < 5; i++) unwrap(await upsertCase(db(), partner, caseInput(), 'u', T0 + i));
    const first = unwrap(await listCases(db(), partner.id, { limit: 2 }));
    expect(first.cases).toHaveLength(2);
    const second = unwrap(
      await listCases(db(), partner.id, { limit: 2, cursor: first.next_cursor ?? '' }),
    );
    const third = unwrap(
      await listCases(db(), partner.id, { limit: 2, cursor: second.next_cursor ?? '' }),
    );
    expect(third.cases).toHaveLength(1);
    expect(third.next_cursor).toBeNull();
    const ids = [...first.cases, ...second.cases, ...third.cases].map((c) => c.id);
    expect(new Set(ids).size).toBe(5);
    expect(await listCases(db(), partner.id, { cursor: 'nope' })).toMatchObject({
      error: 'invalid_cursor',
    });
  });
});
