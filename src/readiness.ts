/**
 * Ready for the first customer (docs/DESIGN.md §13). Two kinds of checks: ones the system can see
 * for itself (company details set, a payout rule, final texts), and sign-offs a person records
 * when the lawyer or the accountant has confirmed something. A sign-off names the version it was
 * given for; when the text changes, the sign-off no longer counts.
 */
import { AGREEMENT_VERSION } from './agent-agreement';
import { auditStatement } from './audit';
import { CONTRACT_VERSION } from './contract';
import { provider } from './provider';
import { fail, ok, type Result } from './result';
import { readSettings } from './settings';

/** The privacy texts and arrangements as a whole: bump when a notice or a transfer changes. */
export const PRIVACY_VERSION = '2026-11-28';
/** How money is booked and taxed: bump when a rate's meaning or the document flow changes. */
export const ACCOUNTING_VERSION = '2026-11-28';

export const SIGNOFFS = {
  legal_service_agreement: { by: 'lawyer', version: () => CONTRACT_VERSION },
  legal_agent_agreement: { by: 'lawyer', version: () => AGREEMENT_VERSION },
  legal_privacy: { by: 'lawyer', version: () => PRIVACY_VERSION },
  accounting_setup: { by: 'accountant', version: () => ACCOUNTING_VERSION },
} as const;
export type SignoffKey = keyof typeof SIGNOFFS;

export interface ReadinessCheck {
  key: string;
  kind: 'auto' | 'signoff';
  ok: boolean;
  /** For sign-offs: the version that must be signed, and what is on file. */
  version?: string;
  by?: 'lawyer' | 'accountant';
  signer?: string | null;
  signed_at?: number | null;
  signed_version?: string | null;
  note?: string | null;
}

export interface Readiness {
  checks: ReadinessCheck[];
  partners_ready: boolean;
  agents_ready: boolean;
  enforced: boolean;
}

/** What must be signed before a company, or an agent, can be admitted. */
const NEEDED = {
  partners: ['legal_service_agreement', 'legal_privacy', 'accounting_setup'],
  agents: ['legal_agent_agreement', 'legal_privacy', 'accounting_setup'],
} as const satisfies Record<string, readonly SignoffKey[]>;

export async function readiness(db: D1Database, hasPiiKey: boolean): Promise<Readiness> {
  const [company, rule, settings, signed] = await Promise.all([
    provider(db),
    db.prepare('SELECT 1 AS yes FROM payout_rules LIMIT 1').first(),
    readSettings(db),
    db.prepare('SELECT key, version, signer, note, signed_at FROM signoffs').all<{
      key: string;
      version: string;
      signer: string;
      note: string | null;
      signed_at: number;
    }>(),
  ]);
  const byKey = new Map(signed.results.map((row) => [row.key, row]));
  const auto: ReadinessCheck[] = [
    { key: 'company_details', kind: 'auto', ok: company !== null },
    { key: 'payout_rule', kind: 'auto', ok: rule !== null },
    { key: 'encryption_key', kind: 'auto', ok: hasPiiKey },
    { key: 'service_agreement_final', kind: 'auto', ok: !/draft|taslak/i.test(CONTRACT_VERSION) },
    { key: 'agent_agreement_final', kind: 'auto', ok: !/draft|taslak/i.test(AGREEMENT_VERSION) },
  ];
  const signoffs: ReadinessCheck[] = (Object.keys(SIGNOFFS) as SignoffKey[]).map((key) => {
    const row = byKey.get(key);
    const version = SIGNOFFS[key].version();
    return {
      key,
      kind: 'signoff',
      by: SIGNOFFS[key].by,
      version,
      ok: row !== undefined && row.version === version,
      signer: row?.signer ?? null,
      signed_at: row?.signed_at ?? null,
      signed_version: row?.version ?? null,
      note: row?.note ?? null,
    };
  });
  const signedOk = (keys: readonly SignoffKey[]) =>
    keys.every((key) => signoffs.find((c) => c.key === key)?.ok === true);
  const base = company !== null && rule !== null && hasPiiKey;
  return {
    checks: [...auto, ...signoffs],
    partners_ready: base && signedOk(NEEDED.partners),
    agents_ready: base && signedOk(NEEDED.agents),
    enforced: settings.require_signoffs === 1,
  };
}

/** Staff record that the lawyer or accountant confirmed something, for the version in force. */
export async function signOff(
  db: D1Database,
  staffId: string,
  key: string,
  input: { signer: string; note?: string },
  at: number,
): Promise<Result<null>> {
  if (!Object.hasOwn(SIGNOFFS, key)) return fail('invalid_signoff');
  const signer = typeof input.signer === 'string' ? input.signer.trim().slice(0, 120) : '';
  if (signer.length < 3) return fail('invalid_signer');
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 300) : '';
  const version = SIGNOFFS[key as SignoffKey].version();
  await db.batch([
    db
      .prepare(
        `INSERT INTO signoffs (key, version, signer, note, signed_by, signed_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET version = excluded.version, signer = excluded.signer,
           note = excluded.note, signed_by = excluded.signed_by, signed_at = excluded.signed_at`,
      )
      .bind(key, version, signer, note || null, staffId, at),
    auditStatement(db, at, `staff:${staffId}`, 'signoff.recorded', `signoff:${key}`, {
      version,
      signer,
    }),
  ]);
  return ok(null);
}

export async function withdrawSignoff(
  db: D1Database,
  staffId: string,
  key: string,
  at: number,
): Promise<Result<null>> {
  if (!Object.hasOwn(SIGNOFFS, key)) return fail('invalid_signoff');
  await db.batch([
    db.prepare('DELETE FROM signoffs WHERE key = ?').bind(key),
    auditStatement(db, at, `staff:${staffId}`, 'signoff.withdrawn', `signoff:${key}`),
  ]);
  return ok(null);
}

/** The checks that still keep agents out, by key, so staff can see what to do. */
export function missingForAgents(r: Readiness): string[] {
  const needed: readonly string[] = [
    'company_details',
    'payout_rule',
    'encryption_key',
    ...NEEDED.agents,
  ];
  return r.checks
    .filter((check) => needed.includes(check.key) && !check.ok)
    .map((check) => check.key);
}

/** The checks that still keep companies out, by key. */
export function missingForPartners(r: Readiness): string[] {
  const needed: readonly string[] = [
    'company_details',
    'payout_rule',
    'encryption_key',
    ...NEEDED.partners,
  ];
  return r.checks
    .filter((check) => needed.includes(check.key) && !check.ok)
    .map((check) => check.key);
}
