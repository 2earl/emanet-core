import { describe, expect, it } from 'vitest';
import { agentProfile, updateProfile } from '../src/agents';
import { upsertCase } from '../src/cases';
import { registerAgent } from '../src/claims';
import {
  PROVINCES,
  canonicalPlace,
  findProvince,
  normalisePlaces,
  placeKey,
  unmatchedPlaces,
} from '../src/places';
import {
  activePartner,
  caseInput,
  db,
  randomMobile,
  randomTckn,
  T0,
  unwrap,
  verifiedEmail,
} from './helpers';

describe('the list of places', () => {
  it('holds 81 provinces and 973 districts, none of them twice', () => {
    expect(PROVINCES).toHaveLength(81);
    expect(PROVINCES.reduce((n, p) => n + p.districts.length, 0)).toBe(973);
    expect(new Set(PROVINCES.map((p) => placeKey(p.name))).size).toBe(81);
    for (const p of PROVINCES) {
      // Two districts of one province must never read the same once folded.
      expect(new Set(p.districts.map(placeKey)).size, p.name).toBe(p.districts.length);
    }
  });

  it('matches names as people type them', () => {
    expect(findProvince('ISTANBUL')?.name).toBe('İstanbul');
    expect(findProvince('izmir')?.name).toBe('İzmir');
    expect(findProvince('35')?.name).toBe('İzmir');
    expect(findProvince('6')?.name).toBe('Ankara');
    expect(findProvince('K.Maraş')?.name).toBe('Kahramanmaraş');
    expect(findProvince('Urfa')?.name).toBe('Şanlıurfa');
    expect(findProvince('Istanbul ')?.name).toBe('İstanbul');
    expect(findProvince('Atlantis')).toBeNull();
    expect(canonicalPlace('istanbul', 'KADIKOY')).toEqual({
      ok: true,
      value: { city: 'İstanbul', district: 'Kadıköy' },
    });
    expect(canonicalPlace('Sivas', 'merkez')).toEqual({
      ok: true,
      value: { city: 'Sivas', district: 'Merkez' },
    });
    // A metropolitan province has no "Merkez", and Kadıköy isn't in Ankara.
    expect(canonicalPlace('İstanbul', 'Merkez')).toEqual({
      ok: false,
      error: 'invalid_place',
      detail: 'district',
    });
    expect(canonicalPlace('Ankara', 'Kadıköy')).toMatchObject({ detail: 'district' });
    expect(canonicalPlace('Kadıköy', 'Kadıköy')).toMatchObject({ detail: 'city' });
  });

  it('writes a case’s places as the list writes them, and refuses a place not in it', async () => {
    const partner = await activePartner();
    const view = unwrap(
      await upsertCase(
        db(),
        partner,
        caseInput({
          places: [{ kind: 'work', address: 'Bir Sk. 1', district: 'besiktas', city: 'ISTANBUL' }],
        }),
        'u',
        T0,
      ),
    );
    expect(view.places[0]).toMatchObject({ city: 'İstanbul', district: 'Beşiktaş' });
    expect(
      await upsertCase(
        db(),
        partner,
        caseInput({
          places: [{ kind: 'work', address: 'Bir Sk. 1', district: 'Merkez', city: 'İzmir' }],
        }),
        'u',
        T0,
      ),
    ).toEqual({ ok: false, error: 'invalid_place', detail: 'district' });
  });

  it('keeps an agent’s city to one of the 81 provinces', async () => {
    const id = crypto.randomUUID();
    await registerAgent(db(), id, T0);
    await verifiedEmail(id);
    const profile = (city: string) => ({
      legalName: 'Deneme Saha',
      city,
      phone: randomMobile(),
      iban: 'TR330006100519786457841326',
      taxProfile: 'individual' as const,
      tckn: randomTckn(),
      birthYear: 1990,
      address: 'Örnek Mah. Deneme Sk. No:1 D:2 Karşıyaka İzmir',
    });
    expect(await updateProfile(db(), id, profile('Atlantis'), T0)).toMatchObject({
      error: 'invalid_city',
    });
    unwrap(await updateProfile(db(), id, profile('IZMIR'), T0));
    expect(unwrap(await agentProfile(db(), id)).city).toBe('İzmir');
  });

  it('rewrites stored places once a day and lists what matches nothing', async () => {
    const partner = await activePartner();
    const view = unwrap(await upsertCase(db(), partner, caseInput(), 'u', T0));
    await db()
      .prepare(
        `INSERT INTO case_places (id, case_id, kind, address, district, city, attributes)
         VALUES (?, ?, 'work', 'x', 'kadikoy', 'istanbul', '{}'), (?, ?, 'work', 'y', 'Nowhere', 'Atlantis', '{}')`,
      )
      .bind(crypto.randomUUID(), view.id, crypto.randomUUID(), view.id)
      .run();
    const result = await normalisePlaces(db());
    expect(result.fixed).toBeGreaterThanOrEqual(1);
    expect(result.unmatched).toBeGreaterThanOrEqual(1);
    const rows = await db()
      .prepare('SELECT city, district FROM case_places WHERE case_id = ? ORDER BY address')
      .bind(view.id)
      .all();
    expect(rows.results).toContainEqual({ city: 'İstanbul', district: 'Kadıköy' });
    expect(await unmatchedPlaces(db())).toContainEqual({
      city: 'Atlantis',
      district: 'Nowhere',
      cases: 1,
    });
    expect((await normalisePlaces(db())).fixed).toBe(0);
  });
});
