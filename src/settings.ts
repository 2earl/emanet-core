/** Settings staff change in Emanet Control (docs/DESIGN.md §7). A row in `settings` wins. */

export const SETTING_DEFAULTS = {
  /** How long a claim lasts while the agent searches. */
  claim_hours: 24,
  /** How long a claim lasts once the agent has found the vehicle and called the police. */
  reporting_hours: 12,
  /** After a claim ends without a delivery, how long its agent can't claim that vehicle again. */
  cooldown_hours: 72,
  /** Open claims an agent may hold at once, unless set on the agent. */
  max_active_claims: 3,
  /** VAT on our invoices to partners, in basis points (2000 = 20 %). */
  kdv_bp: 2000,
  /** Payouts at or above this need a second admin's approval. */
  dual_approval_kurus: 2_500_000,
  /** Income-tax withholding on payouts, per agent tax profile (accountant to confirm). */
  withholding_individual_bp: 0,
  withholding_sole_trader_bp: 0,
  withholding_company_bp: 0,
  /** How long the photos of a delivery, and a partner's documents, are kept (TTK 82: ten years). */
  evidence_retention_days: 3650,
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

/**
 * What each setting may be: whole numbers within a range a person could mean. A slip of the hand
 * (a claim that lasts zero hours, 2,000 % VAT) is refused here, whatever the form let through.
 */
export const SETTING_LIMITS: Record<SettingKey, readonly [min: number, max: number]> = {
  claim_hours: [1, 24 * 14],
  reporting_hours: [1, 24 * 7],
  cooldown_hours: [0, 24 * 90],
  max_active_claims: [1, 50],
  kdv_bp: [0, 5000],
  dual_approval_kurus: [0, 1_000_000_000_00],
  withholding_individual_bp: [0, 5000],
  withholding_sole_trader_bp: [0, 5000],
  withholding_company_bp: [0, 5000],
  evidence_retention_days: [365, 7300],
};

export function settingAllowed(key: string, value: unknown): key is SettingKey {
  if (!Object.hasOwn(SETTING_LIMITS, key)) return false;
  const [min, max] = SETTING_LIMITS[key as SettingKey];
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

export async function readSettings(db: D1Database): Promise<Record<SettingKey, number>> {
  const { results } = await db
    .prepare('SELECT key, value FROM settings')
    .all<{ key: string; value: string }>();
  const settings: Record<SettingKey, number> = { ...SETTING_DEFAULTS };
  for (const row of results) {
    if (Object.hasOwn(SETTING_DEFAULTS, row.key)) {
      const value = Number(row.value);
      if (Number.isFinite(value)) settings[row.key as SettingKey] = value;
    }
  }
  return settings;
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
