import { describe, expect, it } from 'vitest';
import { validateAttributes, type FieldDefinition } from '../src/fields';
import { formatPlate, normalizePlate, normalizeVin } from '../src/normalize';
import { checkPayoutRule, checkPriceList, feeFor, payoutFor, percentOf } from '../src/pricing';

describe('vehicle identity', () => {
  it('normalises VINs and refuses I, O and Q', () => {
    expect(normalizeVin('vf1 rja00-0612345 67')).toBe('VF1RJA00061234567');
    expect(normalizeVin('VF1RJA0006123456I')).toBeNull();
    expect(normalizeVin('VF1RJA000612345')).toBeNull();
  });

  it('normalises Turkish plates and checks the province code', () => {
    expect(normalizePlate('34 abc 123')).toBe('34ABC123');
    expect(normalizePlate('06-a-1234')).toBe('06A1234');
    expect(normalizePlate('00 ABC 123')).toBeNull();
    expect(normalizePlate('82 ABC 123')).toBeNull();
    expect(normalizePlate('34 ABCD 12')).toBeNull();
    expect(normalizePlate('34 ŞAB 12')).toBeNull();
    expect(formatPlate('34ABC123')).toBe('34 ABC 123');
  });
});

describe('pricing', () => {
  const list = {
    default_kurus: 500_000,
    rules: [
      { make: 'Renault', fee_kurus: 800_000 },
      { make: 'renault', model: 'Clio', fee_kurus: 900_000 },
      { make: 'Renault', model: 'Clio', year_from: 2022, fee_kurus: 1_200_000 },
    ],
  };

  it('uses the most specific matching rule', () => {
    expect(feeFor(list, { make: 'Fiat', model: 'Egea', year: 2020 })).toBe(500_000);
    expect(feeFor(list, { make: 'RENAULT', model: 'Megane', year: 2020 })).toBe(800_000);
    expect(feeFor(list, { make: 'Renault', model: 'Clio', year: 2021 })).toBe(900_000);
    expect(feeFor(list, { make: 'Renault', model: 'Clio', year: 2023 })).toBe(1_200_000);
    expect(feeFor(list, { make: 'Renault', model: 'Clio', year: null })).toBe(900_000);
  });

  it('refuses free vehicles and bad rules', () => {
    expect(checkPriceList({ default_kurus: 0, rules: [] }).ok).toBe(false);
    expect(checkPriceList({ default_kurus: 1, rules: [{ fee_kurus: 1.5 }] }).ok).toBe(false);
    expect(
      checkPriceList({ default_kurus: 1, rules: [{ fee_kurus: 1, year_from: 1800 }] }).ok,
    ).toBe(false);
    expect(checkPriceList(list).ok).toBe(true);
  });

  it('computes payouts, never above the fee', () => {
    expect(payoutFor({ share_bp: 4000 }, 1_000_000)).toBe(400_000);
    expect(payoutFor({ share_bp: 4000, min_kurus: 500_000 }, 1_000_000)).toBe(500_000);
    expect(payoutFor({ share_bp: 4000, max_kurus: 300_000 }, 1_000_000)).toBe(300_000);
    expect(payoutFor({ fixed_kurus: 2_000_000 }, 1_000_000)).toBe(1_000_000);
    expect(checkPayoutRule({ share_bp: 5000, fixed_kurus: 1 }).ok).toBe(false);
    expect(checkPayoutRule({ share_bp: 12_000 }).ok).toBe(false);
    expect(percentOf(333, 2000)).toBe(67);
  });
});

describe('custom fields', () => {
  const field = (overrides: Partial<FieldDefinition>): FieldDefinition => ({
    id: crypto.randomUUID(),
    partnerId: null,
    entity: 'case',
    key: 'segment',
    labelTr: 'Segment',
    labelEn: 'Segment',
    type: 'text',
    enumValues: null,
    required: false,
    maxLength: null,
    visibility: 'partner',
    pii: false,
    position: 0,
    deprecated: false,
    ...overrides,
  });
  const fields = [
    field({ key: 'risk', type: 'enum', enumValues: ['low', 'high'], required: true }),
    field({ key: 'branch_phone', type: 'phone' }),
    field({ key: 'old_code', deprecated: true }),
    field({ key: 'internal_note', visibility: 'admin' }),
  ];

  it('accepts valid values and refuses unknown or invalid ones', () => {
    expect(validateAttributes(fields, { risk: 'low' }, 'partner')).toEqual({
      ok: true,
      value: { risk: 'low' },
    });
    expect(validateAttributes(fields, { risk: 'medium' }, 'partner').ok).toBe(false);
    expect(validateAttributes(fields, { risk: 'low', typo: 1 }, 'partner')).toMatchObject({
      error: 'unknown_field',
    });
    expect(validateAttributes(fields, {}, 'partner')).toMatchObject({ error: 'invalid_field' });
    expect(validateAttributes(fields, { risk: 'low', branch_phone: 'call me' }, 'partner').ok).toBe(
      false,
    );
  });

  it('keeps deprecated and staff-only values the writer may not change', () => {
    const stored = { risk: 'low', old_code: 'A1', internal_note: 'watch' };
    expect(validateAttributes(fields, { risk: 'high', old_code: 'A1' }, 'partner', stored)).toEqual(
      {
        ok: true,
        value: { risk: 'high', old_code: 'A1', internal_note: 'watch' },
      },
    );
    expect(validateAttributes(fields, { old_code: 'B2' }, 'partner', stored)).toMatchObject({
      error: 'deprecated_field',
    });
    // A partner can't tell a staff-only field exists.
    expect(validateAttributes(fields, { internal_note: 'x' }, 'partner', stored)).toMatchObject({
      error: 'unknown_field',
    });
    expect(validateAttributes(fields, { internal_note: 'x' }, 'admin', stored).ok).toBe(true);
    expect(
      validateAttributes(fields, { branch_phone: null }, 'partner', {
        ...stored,
        branch_phone: '+90 212 000 00 00',
      }),
    ).toEqual({
      ok: true,
      value: stored,
    });
  });
});
