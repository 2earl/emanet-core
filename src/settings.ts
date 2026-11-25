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
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

export async function readSettings(db: D1Database): Promise<Record<SettingKey, number>> {
  const { results } = await db
    .prepare('SELECT key, value FROM settings')
    .all<{ key: string; value: string }>();
  const settings: Record<SettingKey, number> = { ...SETTING_DEFAULTS };
  for (const row of results) {
    if (row.key in SETTING_DEFAULTS) {
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
