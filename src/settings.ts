/**
 * Settings staff change in Emanet Merkez (docs/DESIGN.md §7). A row in `settings` wins over the
 * default here. Every setting is a whole number with a range a person could mean, a unit, and a
 * group; Merkez shows them with their explanation (its handbook has the long form).
 */

export type SettingUnit = 'hours' | 'days' | 'minutes' | 'count' | 'bp' | 'kurus' | 'switch';
export type SettingGroup =
  'search' | 'review' | 'agents' | 'partners' | 'money' | 'privacy' | 'operations';

interface SettingSpec {
  default: number;
  min: number;
  max: number;
  unit: SettingUnit;
  group: SettingGroup;
}

const spec = (
  group: SettingGroup,
  unit: SettingUnit,
  fallback: number,
  min: number,
  max: number,
): SettingSpec => ({ default: fallback, min, max, unit, group });

export const SETTINGS = {
  // ---- Searching ----
  /** How long a claim lasts while the agent searches. */
  claim_hours: spec('search', 'hours', 24, 1, 24 * 14),
  /** How long a claim lasts once the agent has found the vehicle and called the police. */
  reporting_hours: spec('search', 'hours', 12, 1, 24 * 7),
  /** After a claim ends without a delivery, how long its agent can't claim that vehicle again. */
  cooldown_hours: spec('search', 'hours', 72, 0, 24 * 90),
  /** Open claims an agent may hold at once, unless set on the agent. */
  max_active_claims: spec('search', 'count', 3, 1, 50),
  /** Photos and documents an agent may attach to one claim. */
  max_evidence_per_claim: spec('search', 'count', 40, 5, 200),

  // ---- Reviews and service levels ----
  /** A reported delivery should be decided within this time. */
  review_sla_hours: spec('review', 'hours', 24, 1, 24 * 14),
  /** A vehicle-identity question (no chassis number, plate conflict) should be decided within this. */
  identity_sla_hours: spec('review', 'hours', 48, 1, 24 * 14),
  /** Whether confirming a delivery needs every point of the checklist ticked. */
  review_checklist: spec('review', 'switch', 1, 0, 1),

  // ---- Agents ----
  /** A sent application should be decided within this time. */
  agent_sla_hours: spec('agents', 'hours', 72, 1, 24 * 30),
  /** Strikes at which an agent is suspended automatically; 0 switches this off. */
  strike_limit: spec('agents', 'count', 3, 0, 20),
  /** How long an emailed verification code works. */
  email_code_minutes: spec('agents', 'minutes', 15, 5, 120),
  /** Whether agents are emailed about decisions on their application, deliveries and payouts. */
  agent_mail: spec('agents', 'switch', 1, 0, 1),

  // ---- Partners ----
  /** How long an invitation to a company works. */
  invitation_days: spec('partners', 'days', 14, 1, 90),
  /** A signed agreement should be approved or returned within this time. */
  onboarding_sla_hours: spec('partners', 'hours', 48, 1, 24 * 30),
  /** How long before its cases expire a partner is warned. */
  expiry_warning_days: spec('partners', 'days', 3, 1, 30),
  /** Failed deliveries in a row after which a partner's webhook is switched off. */
  webhook_disable_after: spec('partners', 'count', 20, 3, 200),
  /** Webhooks one organization may have. */
  max_webhooks: spec('partners', 'count', 5, 1, 20),

  // ---- Money ----
  /** VAT on our invoices to partners, in basis points (2000 = 20 %). */
  kdv_bp: spec('money', 'bp', 2000, 0, 5000),
  /** Days after a delivery by which its invoice must be issued (VUK 231/5: seven). */
  invoice_days: spec('money', 'days', 7, 1, 7),
  /** Payouts at or above this need a second admin's approval. */
  dual_approval_kurus: spec('money', 'kurus', 2_500_000, 0, 1_000_000_000_00),
  /** Income-tax withholding on payouts, per agent tax profile (accountant to confirm). */
  withholding_individual_bp: spec('money', 'bp', 0, 0, 5000),
  withholding_sole_trader_bp: spec('money', 'bp', 0, 0, 5000),
  withholding_company_bp: spec('money', 'bp', 0, 0, 5000),

  // ---- Privacy and retention ----
  /** How long the photos of a delivery, and a partner's documents, are kept (TTK 82: ten years). */
  evidence_retention_days: spec('privacy', 'days', 3650, 365, 7300),
  /** How long the photos of a claim that ended without a delivery are kept. */
  failed_claim_evidence_days: spec('privacy', 'days', 30, 7, 365),
  /** How long after a case closes its addresses and notes are kept. */
  place_retention_days: spec('privacy', 'days', 30, 1, 365),
  /** How long the documents of an onboarding that wasn't completed are kept. */
  abandoned_onboarding_days: spec('privacy', 'days', 90, 7, 365),
  /** Days to answer a data subject's request (KVKK 13: thirty at most). */
  privacy_request_days: spec('privacy', 'days', 30, 1, 30),

  // ---- Operations ----
  /** The shortest time between two alert emails to staff. */
  alert_interval_minutes: spec('operations', 'minutes', 60, 15, 24 * 60),
  /** How long recorded errors are kept. */
  ops_keep_days: spec('operations', 'days', 30, 7, 365),
} as const satisfies Record<string, SettingSpec>;

export type SettingKey = keyof typeof SETTINGS;
export type Settings = Record<SettingKey, number>;

const KEYS = Object.keys(SETTINGS) as SettingKey[];

export const SETTING_DEFAULTS = Object.fromEntries(
  KEYS.map((key) => [key, SETTINGS[key].default]),
) as Settings;

export const SETTING_LIMITS = Object.fromEntries(
  KEYS.map((key) => [key, [SETTINGS[key].min, SETTINGS[key].max] as const]),
) as Record<SettingKey, readonly [min: number, max: number]>;

/**
 * Whole numbers within the setting's range. A slip of the hand (a claim that lasts zero hours,
 * 2,000 % VAT) is refused here, whatever the form let through.
 */
export function settingAllowed(key: string, value: unknown): key is SettingKey {
  if (!Object.hasOwn(SETTINGS, key)) return false;
  const { min, max } = SETTINGS[key as SettingKey];
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

export async function readSettings(db: D1Database): Promise<Settings> {
  const { results } = await db
    .prepare('SELECT key, value FROM settings')
    .all<{ key: string; value: string }>();
  const settings: Settings = { ...SETTING_DEFAULTS };
  for (const row of results) {
    if (Object.hasOwn(SETTINGS, row.key)) {
      const value = Number(row.value);
      // A stored value outside today's range (the range was narrowed since) falls back.
      if (settingAllowed(row.key, value)) settings[row.key] = value;
    }
  }
  return settings;
}

export interface SettingInfo {
  key: SettingKey;
  value: number;
  default: number;
  min: number;
  max: number;
  unit: SettingUnit;
  group: SettingGroup;
  /** Who last changed it and when; null while it is the default. */
  updated_by: string | null;
  updated_at: number | null;
}

/** Every setting with its value, range and last change, in the order of the list above. */
export async function settingsInfo(db: D1Database): Promise<SettingInfo[]> {
  const { results } = await db
    .prepare('SELECT key, value, updated_by, updated_at FROM settings')
    .all<{ key: string; value: string; updated_by: string | null; updated_at: number | null }>();
  const stored = new Map(results.map((row) => [row.key, row]));
  return KEYS.map((key) => {
    const row = stored.get(key);
    const value = row ? Number(row.value) : NaN;
    const valid = row !== undefined && settingAllowed(key, value);
    return {
      key,
      ...SETTINGS[key],
      value: valid ? value : SETTINGS[key].default,
      updated_by: valid ? (row.updated_by ?? null) : null,
      updated_at: valid ? (row.updated_at ?? null) : null,
    };
  });
}

export function writeSetting(
  db: D1Database,
  key: SettingKey,
  value: number,
  by: string,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    )
    .bind(key, String(value), by, at);
}

/** Back to the default: the row goes, so a later change of the default applies. */
export function resetSetting(db: D1Database, key: SettingKey): D1PreparedStatement {
  return db.prepare('DELETE FROM settings WHERE key = ?').bind(key);
}
