import { describe, expect, it } from 'vitest';
import {
  TERMS_VERSION,
  agentProfile,
  earnings,
  myClaims,
  normalizeIban,
  normalizePhone,
  submitApplication,
  updateProfile,
  type ProfileInput,
} from '../src/agents';
import { exportUser, deleteUser } from '../src/account-events';
import { verifyAgentIban } from '../src/control';
import { upsertCase } from '../src/cases';
import { addEvidence, claimVehicle, recordSighting, registerAgent } from '../src/claims';
import { activeAgent, activePartner, caseInput, db, payoutRule, T0, unwrap } from './helpers';

// A valid Turkish IBAN (mod-97 check digits 33).
const IBAN = 'TR33 0006 1005 1978 6457 8413 26';
const profile = (overrides: Partial<ProfileInput> = {}): ProfileInput => ({
  legalName: '  Ayşe   Yılmaz ',
  city: 'İzmir',
  phone: '0532 123 45 67',
  iban: IBAN,
  taxProfile: 'individual',
  ...overrides,
});

async function newAgent(): Promise<string> {
  const id = crypto.randomUUID();
  await registerAgent(db(), id, T0);
  return id;
}

describe('agent values', () => {
  it('checks IBANs and phone numbers', () => {
    expect(normalizeIban(IBAN)).toBe('TR330006100519786457841326');
    expect(normalizeIban('TR340006100519786457841326')).toBeNull();
    expect(normalizeIban('DE89370400440532013000')).toBeNull();
    expect(normalizePhone('+90 532 123 45 67')).toBe('+905321234567');
    expect(normalizePhone('(0532) 123-4567')).toBe('+905321234567');
    expect(normalizePhone('0212 123 45 67')).toBeNull();
  });
});

describe('joining', () => {
  it('fills in a profile, then submits it with the current terms', async () => {
    const agent = await newAgent();
    expect(await submitApplication(db(), agent, TERMS_VERSION, T0)).toEqual({
      ok: false,
      error: 'profile_incomplete',
    });
    expect((await updateProfile(db(), agent, profile({ iban: 'TR00' }), T0)).ok).toBe(false);
    expect(await updateProfile(db(), agent, profile({ legalName: 'Ayşe' }), T0)).toMatchObject({
      error: 'invalid_name',
    });
    expect(await updateProfile(db(), agent, profile({ taxProfile: 'company' }), T0)).toMatchObject({
      error: 'invalid_vkn',
    });
    unwrap(await updateProfile(db(), agent, profile(), T0));
    expect(unwrap(await agentProfile(db(), agent))).toMatchObject({
      status: 'applied',
      legal_name: 'Ayşe Yılmaz',
      phone: '+905321234567',
      iban: 'TR330006100519786457841326',
      iban_verified: false,
      tax_profile: 'individual',
      vkn: null,
    });
    expect(await submitApplication(db(), agent, '2020-01-01', T0)).toMatchObject({
      error: 'terms_changed',
    });
    unwrap(await submitApplication(db(), agent, TERMS_VERSION, T0 + 1));
    expect(unwrap(await agentProfile(db(), agent))).toMatchObject({
      status: 'kyc_pending',
      terms_version: TERMS_VERSION,
      submitted_at: T0 + 1,
    });
    expect(await submitApplication(db(), agent, TERMS_VERSION, T0 + 2)).toMatchObject({
      error: 'already_submitted',
    });
  });

  it('once active, only the phone and IBAN change, and a new IBAN needs checking again', async () => {
    const agent = await newAgent();
    unwrap(await updateProfile(db(), agent, profile(), T0));
    await db()
      .prepare(`UPDATE agents SET status = 'active', iban_verified_at = ? WHERE user_id = ?`)
      .bind(T0, agent)
      .run();
    expect(await updateProfile(db(), agent, profile({ city: 'Ankara' }), T0)).toMatchObject({
      error: 'profile_locked',
    });
    unwrap(await updateProfile(db(), agent, profile({ phone: '05551112233' }), T0));
    expect(unwrap(await agentProfile(db(), agent)).iban_verified).toBe(true);
    unwrap(await updateProfile(db(), agent, profile({ iban: 'TR320010009999901234567890' }), T0));
    expect(unwrap(await agentProfile(db(), agent)).iban_verified).toBe(false);
  });

  it('exports the profile, and deleting the account removes it', async () => {
    const agent = await newAgent();
    unwrap(await updateProfile(db(), agent, profile(), T0));
    const exported = (await exportUser(db(), agent)) as { agent: Record<string, unknown> };
    expect(exported.agent).toMatchObject({ phone: '+905321234567', legal_name: 'Ayşe Yılmaz' });
    await deleteUser(db(), agent, T0);
    expect(unwrap(await agentProfile(db(), agent))).toMatchObject({
      status: 'banned',
      legal_name: null,
      phone: null,
      iban: null,
    });
  });
});

describe('IBAN check', () => {
  it('verifies only the IBAN staff looked at', async () => {
    const agent = await newAgent();
    unwrap(await updateProfile(db(), agent, profile(), T0));
    expect(
      await verifyAgentIban(db(), 'staff-1', agent, 'TR320010009999901234567890', T0),
    ).toMatchObject({ error: 'iban_changed' });
    unwrap(await verifyAgentIban(db(), 'staff-1', agent, 'TR330006100519786457841326', T0));
    expect(unwrap(await agentProfile(db(), agent)).iban_verified).toBe(true);
  });
});

describe('my claims and earnings', () => {
  it('lists open claims with their evidence, and no earnings yet', async () => {
    await payoutRule(4000);
    const partner = await activePartner({ default_kurus: 2_000_000, rules: [] });
    const view = unwrap(await upsertCase(db(), partner, caseInput(), 'u', T0));
    const row = await db()
      .prepare('SELECT vehicle_id FROM cases WHERE id = ?')
      .bind(view.id)
      .first<{ vehicle_id: string }>();
    const agent = await activeAgent();
    const claim = unwrap(await claimVehicle(db(), agent, row?.vehicle_id ?? '', T0));
    unwrap(
      await recordSighting(db(), agent, claim.id, { lat: 41, lng: 29, taken_at: T0 + 60 }, T0 + 60),
    );
    const sha = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
    unwrap(
      await addEvidence(
        db(),
        agent,
        claim.id,
        { kind: 'yediemin_receipt', file_ref: `claims/${claim.id}/x`, sha256: sha },
        T0 + 120,
      ),
    );
    const mine = unwrap(await myClaims(db(), agent, T0 + 180));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      id: claim.id,
      plate: view.vehicle.plate,
      state: 'reporting',
      evidence: ['yediemin_receipt'],
      under_review: true,
      payout_status: null,
    });
    expect(unwrap(await earnings(db(), agent))).toEqual({
      payouts: [],
      pending_kurus: 0,
      paid_kurus: 0,
    });
  });
});
