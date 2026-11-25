import { describe, expect, it } from 'vitest';
import { upsertCase, withdrawCase } from '../src/cases';
import {
  addEvidence,
  claimDetails,
  claimVehicle,
  expireClaims,
  listHunts,
  recordSighting,
  releaseClaim,
  setAgentStatus,
} from '../src/claims';
import { writeSetting } from '../src/settings';
import {
  activeAgent,
  activePartner,
  caseInput,
  db,
  payoutRule,
  randomPlate,
  randomVin,
  T0,
  unwrap,
} from './helpers';

const HOUR = 3600;
const hash = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

async function huntableVehicle(city = 'İstanbul') {
  const partner = await activePartner({ default_kurus: 2_000_000, rules: [] });
  const view = unwrap(
    await upsertCase(
      db(),
      partner,
      caseInput({
        places: [{ kind: 'owner_home', address: 'Gizli Sk. No:7', district: 'Üsküdar', city }],
      }),
      'u',
      T0,
    ),
  );
  const row = await db()
    .prepare('SELECT vehicle_id FROM cases WHERE id = ?')
    .bind(view.id)
    .first<{ vehicle_id: string }>();
  return { partner, view, vehicleId: row?.vehicle_id ?? '' };
}

describe('hunts and claims', () => {
  it('shows active vehicles at district level with what the agent earns', async () => {
    await payoutRule(4000);
    const { vehicleId, view } = await huntableVehicle('Kırşehir');
    const agent = await activeAgent();
    const hunts = unwrap(await listHunts(db(), agent, { city: 'Kırşehir' }, T0));
    const hunt = hunts.find((h) => h.vehicle_id === vehicleId);
    expect(hunt).toMatchObject({
      plate: view.vehicle.plate,
      earn_kurus: 800_000,
      areas: [{ district: 'Üsküdar', city: 'Kırşehir' }],
    });
    expect(JSON.stringify(hunt)).not.toContain('Gizli');
  });

  it('keeps vehicles without a VIN, and agents who are not active, out', async () => {
    await payoutRule();
    const partner = await activePartner();
    const pending = unwrap(await upsertCase(db(), partner, caseInput({ vin: '' }), 'u', T0));
    const agent = await activeAgent();
    const hunts = unwrap(await listHunts(db(), agent, {}, T0));
    expect(hunts.some((h) => h.plate === pending.vehicle.plate)).toBe(false);
    await setAgentStatus(db(), agent, 'suspended', 'staff-1', 'test', T0);
    expect(await listHunts(db(), agent, {}, T0)).toMatchObject({ error: 'agent_not_active' });
  });

  it('gives one agent the addresses for a limited time', async () => {
    await payoutRule();
    const { vehicleId } = await huntableVehicle();
    const first = await activeAgent();
    const second = await activeAgent();
    const claim = unwrap(await claimVehicle(db(), first, vehicleId, T0));
    expect(claim.expires_at).toBe(T0 + 24 * HOUR);
    expect(await claimVehicle(db(), second, vehicleId, T0 + 1)).toMatchObject({
      error: 'already_claimed',
    });
    expect(
      unwrap(await listHunts(db(), second, {}, T0 + 1)).some((h) => h.vehicle_id === vehicleId),
    ).toBe(false);

    const details = unwrap(await claimDetails(db(), first, claim.id, T0 + 60));
    expect(details.places[0]?.address).toBe('Gizli Sk. No:7');
    expect(await claimDetails(db(), second, claim.id, T0 + 60)).toMatchObject({
      error: 'not_found',
    });
    const viewed = await db()
      .prepare(
        `SELECT count(*) AS n FROM audit_events WHERE action = 'claim.places_viewed' AND subject = ?`,
      )
      .bind(`claim:${claim.id}`)
      .first<{ n: number }>();
    expect(viewed?.n).toBe(1);
  });

  it('expires claims, then makes the same agent wait while others may claim', async () => {
    await payoutRule();
    const { vehicleId } = await huntableVehicle();
    const agent = await activeAgent();
    const other = await activeAgent();
    const claim = unwrap(await claimVehicle(db(), agent, vehicleId, T0));
    expect(await claimDetails(db(), agent, claim.id, T0 + 24 * HOUR)).toMatchObject({
      error: 'not_found',
    });

    await expireClaims(db(), T0 + 24 * HOUR);
    expect(await claimVehicle(db(), agent, vehicleId, T0 + 25 * HOUR)).toMatchObject({
      error: 'cooldown',
    });
    const theirs = unwrap(await claimVehicle(db(), other, vehicleId, T0 + 25 * HOUR));

    // Releasing early doesn't reset the clock either.
    unwrap(await releaseClaim(db(), other, theirs.id, T0 + 26 * HOUR));
    expect(await claimVehicle(db(), other, vehicleId, T0 + 27 * HOUR)).toMatchObject({
      error: 'cooldown',
    });
    // After the cooldown (72 h after expiry), the first agent may try again.
    unwrap(await claimVehicle(db(), agent, vehicleId, T0 + 24 * HOUR + 72 * HOUR));
  });

  it('limits open claims per agent', async () => {
    await payoutRule();
    await writeSetting(db(), 'max_active_claims', 2, 'staff-1', T0).run();
    const agent = await activeAgent();
    const vehicles = await Promise.all([huntableVehicle(), huntableVehicle(), huntableVehicle()]);
    unwrap(await claimVehicle(db(), agent, vehicles[0].vehicleId, T0));
    unwrap(await claimVehicle(db(), agent, vehicles[1].vehicleId, T0));
    expect(await claimVehicle(db(), agent, vehicles[2].vehicleId, T0)).toMatchObject({
      error: 'too_many_claims',
    });
    await writeSetting(db(), 'max_active_claims', 3, 'staff-1', T0).run();
  });

  it('extends a claim when the vehicle is found, and takes evidence only after that', async () => {
    await payoutRule();
    const { vehicleId } = await huntableVehicle();
    const agent = await activeAgent();
    const claim = unwrap(await claimVehicle(db(), agent, vehicleId, T0));
    const photo = { kind: 'scene' as const, file_ref: 'r2://scene.jpg', sha256: hash() };
    expect(await addEvidence(db(), agent, claim.id, photo, T0 + 10)).toMatchObject({
      error: 'no_sighting',
    });

    expect(
      await recordSighting(
        db(),
        agent,
        claim.id,
        { lat: 41, lng: 29, taken_at: T0 + 99_999 },
        T0 + 20 * HOUR,
      ),
    ).toMatchObject({ error: 'invalid_time' });
    const found = unwrap(
      await recordSighting(
        db(),
        agent,
        claim.id,
        { lat: 41.02, lng: 29.01, accuracy_m: 8, taken_at: T0 + 20 * HOUR },
        T0 + 20 * HOUR,
      ),
    );
    expect(found.state).toBe('reporting');
    expect(found.expires_at).toBe(T0 + 32 * HOUR);

    unwrap(await addEvidence(db(), agent, claim.id, photo, T0 + 20 * HOUR));
    expect(await addEvidence(db(), agent, claim.id, photo, T0 + 20 * HOUR)).toMatchObject({
      error: 'duplicate_photo',
    });
  });

  it('ends claims on a vehicle whose last case is withdrawn, without a cooldown', async () => {
    await payoutRule();
    const { vehicleId, partner, view } = await huntableVehicle();
    const agent = await activeAgent();
    const claim = unwrap(await claimVehicle(db(), agent, vehicleId, T0));
    unwrap(await withdrawCase(db(), partner, view.id, 'Yapılandırıldı', 'u', T0 + HOUR));
    expect(await claimDetails(db(), agent, claim.id, T0 + HOUR)).toMatchObject({
      error: 'not_found',
    });
    const cooldown = await db()
      .prepare('SELECT 1 FROM cooldowns WHERE agent_id = ?')
      .bind(agent)
      .first();
    expect(cooldown).toBeNull();
  });

  it('does not show one place twice when two creditors know it', async () => {
    await payoutRule();
    const a = await activePartner();
    const b = await activePartner();
    const vin = randomVin();
    const plate = randomPlate();
    const place = {
      kind: 'owner_home' as const,
      address: 'Aynı Sk. 3',
      district: 'Çankaya',
      city: 'Ankara',
    };
    unwrap(await upsertCase(db(), a, caseInput({ vin, plate, places: [place] }), 'u', T0));
    unwrap(
      await upsertCase(
        db(),
        b,
        caseInput({ vin, plate, places: [{ ...place, kind: 'last_seen' }] }),
        'u',
        T0,
      ),
    );
    const vehicle = await db()
      .prepare('SELECT id FROM vehicles WHERE vin = ?')
      .bind(vin)
      .first<{ id: string }>();
    const agent = await activeAgent();
    const claim = unwrap(await claimVehicle(db(), agent, vehicle?.id ?? '', T0));
    expect(unwrap(await claimDetails(db(), agent, claim.id, T0)).places).toHaveLength(1);
  });
});
