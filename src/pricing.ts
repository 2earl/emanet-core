/**
 * Fees (docs/DESIGN.md §4.6). Each partner sets what it pays per vehicle, by make, model and
 * year; 2earl sets what an agent earns from that fee. Amounts are integer kuruş, shares basis
 * points.
 */
import { fail, ok, type Result } from './result';

export interface PriceRule {
  make?: string;
  model?: string;
  year_from?: number;
  year_to?: number;
  fee_kurus: number;
}

export interface PriceList {
  /** When no rule matches. */
  default_kurus: number;
  rules: PriceRule[];
}

export interface PayoutRule {
  /** Share of the partner's fee, in basis points (5000 = half). */
  share_bp?: number;
  /** Or a fixed amount, whatever the fee. */
  fixed_kurus?: number;
  min_kurus?: number;
  max_kurus?: number;
}

const kurus = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

export function checkPriceList(input: unknown): Result<PriceList> {
  if (typeof input !== 'object' || input === null) return fail('invalid_price_list');
  const list = input as Partial<PriceList>;
  // Every vehicle costs something: a zero fee would also mean a zero payout.
  if (!kurus(list.default_kurus) || list.default_kurus === 0) {
    return fail('invalid_price_list', 'default_kurus');
  }
  if (!Array.isArray(list.rules) || list.rules.length > 500) {
    return fail('invalid_price_list', 'rules');
  }
  for (const [index, rule] of list.rules.entries()) {
    if (typeof rule !== 'object' || !kurus(rule.fee_kurus) || rule.fee_kurus === 0) {
      return fail('invalid_price_list', `rules[${String(index)}].fee_kurus`);
    }
    for (const key of ['year_from', 'year_to'] as const) {
      const year = rule[key];
      if (year !== undefined && !(Number.isInteger(year) && year >= 1950 && year <= 2100)) {
        return fail('invalid_price_list', `rules[${String(index)}].${key}`);
      }
    }
  }
  return ok({ default_kurus: list.default_kurus, rules: list.rules });
}

const same = (a: string, b: string) =>
  a.trim().toLocaleLowerCase('tr-TR') === b.trim().toLocaleLowerCase('tr-TR');

/**
 * The fee for a vehicle: the most specific matching rule (the one with the most conditions), the
 * first of equals, or the default.
 */
export function feeFor(
  list: PriceList,
  vehicle: { make: string; model: string; year: number | null },
): number {
  let best: { fee: number; specificity: number } | null = null;
  for (const rule of list.rules) {
    let specificity = 0;
    if (rule.make !== undefined) {
      if (!same(rule.make, vehicle.make)) continue;
      specificity++;
    }
    if (rule.model !== undefined) {
      if (!same(rule.model, vehicle.model)) continue;
      specificity++;
    }
    if (rule.year_from !== undefined || rule.year_to !== undefined) {
      if (vehicle.year === null) continue;
      if (rule.year_from !== undefined && vehicle.year < rule.year_from) continue;
      if (rule.year_to !== undefined && vehicle.year > rule.year_to) continue;
      specificity++;
    }
    if (best === null || specificity > best.specificity) {
      best = { fee: rule.fee_kurus, specificity };
    }
  }
  return best?.fee ?? list.default_kurus;
}

export function checkPayoutRule(input: unknown): Result<PayoutRule> {
  if (typeof input !== 'object' || input === null) return fail('invalid_payout_rule');
  const rule = input as PayoutRule;
  const share = rule.share_bp;
  if ((share !== undefined) === (rule.fixed_kurus !== undefined)) {
    return fail('invalid_payout_rule', 'set share_bp or fixed_kurus');
  }
  if (share !== undefined && !(Number.isInteger(share) && share >= 0 && share <= 10_000)) {
    return fail('invalid_payout_rule', 'share_bp');
  }
  for (const key of ['fixed_kurus', 'min_kurus', 'max_kurus'] as const) {
    if (rule[key] !== undefined && !kurus(rule[key])) return fail('invalid_payout_rule', key);
  }
  return ok(rule);
}

/** What an agent earns from a partner's fee. Never more than the fee: we don't pay at a loss. */
export function payoutFor(rule: PayoutRule, feeKurus: number): number {
  let gross = rule.fixed_kurus ?? Math.round((feeKurus * (rule.share_bp ?? 0)) / 10_000);
  if (rule.min_kurus !== undefined) gross = Math.max(gross, rule.min_kurus);
  if (rule.max_kurus !== undefined) gross = Math.min(gross, rule.max_kurus);
  return Math.min(gross, feeKurus);
}

/** Basis points of an amount, rounded half up (kuruş). */
export const percentOf = (amountKurus: number, bp: number): number =>
  Math.round((amountKurus * bp) / 10_000);
