/**
 * An agent's own view: their profile and application, their claims, their earnings
 * (docs/DESIGN.md §6). What staff see and decide is in control.ts.
 *
 * Identity is checked by staff for now (a vendor's NFC and liveness check comes with the native
 * app, phase P6): the agent gives their name as on their ID card, their city, a phone number for
 * the check, and an IBAN in their own name; staff check them and activate the agent.
 */
import { AGREEMENT_VERSION } from './agent-agreement';
import { auditStatement } from './audit';
import type { AgentStatus, EvidenceKind } from './claims';
import { kycStatement, noRegistry, tcknHash, validTckn, type RegistryCheck } from './kyc';
import { seal } from './pii';
import { fail, ok, type Result } from './result';

/** The rules of conduct and agent agreement an agent accepts; bump when they change. */
/** What an applicant accepts: the agent agreement's version (src/agent-agreement.ts). */
export const TERMS_VERSION = AGREEMENT_VERSION;

export type TaxProfile = 'individual' | 'sole_trader' | 'company';
const TAX_PROFILES: readonly TaxProfile[] = ['individual', 'sole_trader', 'company'];

export interface AgentProfile {
  status: AgentStatus;
  legal_name: string | null;
  city: string | null;
  phone: string | null;
  iban: string | null;
  iban_verified: boolean;
  /** The address the agent proved with a code, or null. */
  email: string | null;
  /** Whether an ID number is on record (as a keyed hash; the number isn't kept). */
  id_given: boolean;
  birth_year: number | null;
  tax_profile: TaxProfile;
  vkn: string | null;
  terms_version: string | null;
  current_terms: string;
  submitted_at: number | null;
  strikes: number;
  open_claims: number;
  /** What staff asked the applicant to correct, while the application is back with them. */
  review_note: string | null;
  address: string | null;
}

export async function agentProfile(db: D1Database, agentId: string): Promise<Result<AgentProfile>> {
  const row = await db
    .prepare(
      `SELECT status, legal_name, city, phone, iban, iban_verified_at, tax_profile, vkn,
         terms_version, submitted_at, strikes, email, email_verified_at, tckn_hash, birth_year,
         review_note, address,
         (SELECT count(*) FROM claims WHERE agent_id = a.user_id AND closed_at IS NULL) AS open_claims
       FROM agents a WHERE user_id = ?`,
    )
    .bind(agentId)
    .first<{
      status: AgentStatus;
      legal_name: string | null;
      city: string | null;
      phone: string | null;
      iban: string | null;
      iban_verified_at: number | null;
      tax_profile: TaxProfile;
      vkn: string | null;
      terms_version: string | null;
      submitted_at: number | null;
      strikes: number;
      open_claims: number;
      email: string | null;
      email_verified_at: number | null;
      tckn_hash: string | null;
      birth_year: number | null;
      review_note: string | null;
      address: string | null;
    }>();
  if (!row) return fail('not_found');
  return ok({
    status: row.status,
    legal_name: row.legal_name,
    city: row.city,
    phone: row.phone,
    iban: row.iban,
    iban_verified: row.iban_verified_at !== null,
    email: row.email_verified_at !== null ? row.email : null,
    id_given: row.tckn_hash !== null,
    birth_year: row.birth_year,
    tax_profile: row.tax_profile,
    vkn: row.vkn,
    terms_version: row.terms_version,
    current_terms: TERMS_VERSION,
    submitted_at: row.submitted_at,
    strikes: row.strikes,
    review_note: row.status === 'applied' ? row.review_note : null,
    address: row.address,
    open_claims: row.open_claims,
  });
}

/** TR + 2 check digits + 5-digit bank code + reserve digit + 16-character account: ISO 13616. */
export function normalizeIban(value: string): string | null {
  const iban = value.replace(/\s+/g, '').toUpperCase();
  if (!/^TR\d{24}$/.test(iban)) return null;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1 ? iban : null;
}

/** Turkish mobile numbers: +90 5xx xxx xx xx in any common spelling → +905xxxxxxxxx. */
export function normalizePhone(value: string): string | null {
  let digits = value.replace(/[\s().-]/g, '');
  if (digits.startsWith('+90')) digits = digits.slice(3);
  else if (digits.startsWith('0090')) digits = digits.slice(4);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  return /^5\d{9}$/.test(digits) ? `+90${digits}` : null;
}

export interface ProfileInput {
  legalName: string;
  city: string;
  phone: string;
  iban: string;
  taxProfile: TaxProfile;
  vkn?: string | null;
  /** T.C. kimlik no: needed once; afterwards only when it has to change (before activation). */
  tckn?: string | null;
  birthYear?: number | null;
  /** Where the person lives: tax law wants it on the document for a payment. */
  address?: string | null;
}

/**
 * Before activation the agent can change everything. Once active, only the phone and the IBAN;
 * a new IBAN has to be checked again before anything is paid to it.
 */
export async function updateProfile(
  db: D1Database,
  agentId: string,
  input: ProfileInput,
  at: number,
  registry: RegistryCheck = noRegistry,
): Promise<Result<null>> {
  const current = await agentProfile(db, agentId);
  if (!current.ok) return current;
  const profile = current.value;
  if (profile.status === 'banned' || profile.status === 'suspended')
    return fail('agent_not_active');
  const legalName = input.legalName.trim().replace(/\s+/g, ' ');
  const city = input.city.trim();
  if (legalName.length < 3 || legalName.length > 120 || !legalName.includes(' ')) {
    return fail('invalid_name');
  }
  if (city.length < 2 || city.length > 40) return fail('invalid_city');
  const phone = normalizePhone(input.phone);
  if (!phone) return fail('invalid_phone');
  const iban = normalizeIban(input.iban);
  if (!iban) return fail('invalid_iban');
  if (!TAX_PROFILES.includes(input.taxProfile)) return fail('invalid_tax_profile');
  const vkn = input.vkn?.trim() ? input.vkn.trim() : null;
  if (input.taxProfile !== 'individual' && (!vkn || !/^\d{10,11}$/.test(vkn))) {
    return fail('invalid_vkn');
  }
  const locked = profile.status === 'active';
  const address =
    typeof input.address === 'string' && input.address.trim()
      ? input.address.trim().replace(/\s+/g, ' ')
      : null;
  if (address !== null && (address.length < 10 || address.length > 300)) {
    return fail('invalid_address');
  }

  // The ID number: required once, checked, and kept only as a keyed hash.
  const tckn = typeof input.tckn === 'string' ? input.tckn.replace(/\s/g, '') : '';
  const birthYear = input.birthYear ?? profile.birth_year;
  let idHash: string | null = null;
  let idSealed: string | null = null;
  let registryResult: 'passed' | 'review' | null = null;
  if (tckn) {
    if (locked) return fail('profile_locked');
    if (!validTckn(tckn)) return fail('invalid_tckn');
    if (
      birthYear === null ||
      !Number.isInteger(birthYear) ||
      birthYear < 1920 ||
      birthYear > new Date(at * 1000).getUTCFullYear() - 18
    ) {
      return fail('invalid_birth_year');
    }
    idHash = await tcknHash(tckn);
    // Sealed, for the payment documents tax law requires; opened only for the accountant's month.
    idSealed = await seal(tckn, `agent:${agentId}:tckn`);
    const other = await db
      .prepare('SELECT 1 AS yes FROM agents WHERE tckn_hash = ? AND user_id != ?')
      .bind(idHash, agentId)
      .first();
    if (other) return fail('tckn_taken');
    const space = legalName.lastIndexOf(' ');
    const answer = await registry({
      tckn,
      firstName: legalName.slice(0, space),
      lastName: legalName.slice(space + 1),
      birthYear,
    });
    if (answer === 'no_match') return fail('identity_not_confirmed');
    registryResult = answer === 'match' ? 'passed' : 'review';
  } else if (!profile.id_given) {
    return fail('invalid_tckn');
  }
  if (
    phone !== profile.phone &&
    (await db
      .prepare('SELECT 1 AS yes FROM agents WHERE phone = ? AND user_id != ?')
      .bind(phone, agentId)
      .first())
  ) {
    return fail('phone_taken');
  }
  if (
    locked &&
    (legalName !== profile.legal_name ||
      city !== profile.city ||
      input.taxProfile !== profile.tax_profile ||
      (input.taxProfile === 'individual' ? null : vkn) !== profile.vkn)
  ) {
    return fail('profile_locked');
  }
  const ibanChanged = iban !== profile.iban;
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE agents SET legal_name = ?, city = ?, phone = ?, iban = ?, tax_profile = ?, vkn = ?,
             iban_verified_at = CASE WHEN ? THEN NULL ELSE iban_verified_at END,
             phone_verified_at = CASE WHEN phone IS ? THEN phone_verified_at ELSE NULL END,
             tckn_hash = coalesce(?, tckn_hash), tckn_enc = coalesce(?, tckn_enc),
             address = coalesce(?, address),
             birth_year = coalesce(?, birth_year), updated_at = ?
           WHERE user_id = ?`,
        )
        .bind(
          legalName,
          city,
          phone,
          iban,
          input.taxProfile,
          input.taxProfile === 'individual' ? null : vkn,
          ibanChanged ? 1 : 0,
          phone,
          idHash,
          idSealed,
          address,
          idHash === null ? null : birthYear,
          at,
          agentId,
        ),
      ...(registryResult === null
        ? []
        : [kycStatement(db, agentId, 'id_registry', 'nvi-kps', registryResult, at)]),
      auditStatement(db, at, `agent:${agentId}`, 'agent.profile_updated', `agent:${agentId}`, {
        iban_changed: ibanChanged,
        id_changed: idHash !== null,
      }),
    ]);
  } catch (error) {
    // Someone else took the number or the phone in the same moment.
    if (error instanceof Error && /UNIQUE constraint failed: agents\.phone/.test(error.message)) {
      return fail('phone_taken');
    }
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
      return fail('tckn_taken');
    }
    throw error;
  }
  return ok(null);
}

/** The agent accepts the current terms and asks staff to check them: applied → kyc_pending. */
export async function submitApplication(
  db: D1Database,
  agentId: string,
  termsVersion: string,
  at: number,
): Promise<Result<null>> {
  const current = await agentProfile(db, agentId);
  if (!current.ok) return current;
  const p = current.value;
  if (p.status !== 'applied') return fail('already_submitted');
  if (termsVersion !== TERMS_VERSION) return fail('terms_changed');
  if (!p.legal_name || !p.city || !p.phone || !p.iban || !p.id_given) {
    return fail('profile_incomplete');
  }
  if (p.email === null) return fail('email_not_verified');
  await db.batch([
    db
      .prepare(
        `UPDATE agents SET status = 'kyc_pending', terms_version = ?, terms_accepted_at = ?,
           submitted_at = ?, updated_at = ?, review_note = NULL
         WHERE user_id = ? AND status = 'applied'`,
      )
      .bind(termsVersion, at, at, at, agentId),
    auditStatement(db, at, `agent:${agentId}`, 'agent.submitted', `agent:${agentId}`, {
      terms: termsVersion,
    }),
  ]);
  return ok(null);
}

export interface MyClaim {
  id: string;
  plate: string | null;
  make: string;
  model: string;
  state: 'searching' | 'reporting';
  claimed_at: number;
  expires_at: number;
  closed_at: number | null;
  close_reason: string | null;
  /** Staff's reason, when a reported delivery wasn't accepted. */
  close_note: string | null;
  evidence: EvidenceKind[];
  /** delivery: staff are checking the evidence. */
  under_review: boolean;
  payout_status: string | null;
}

/** Open claims, and those closed in the last 30 days, newest first. */
export async function myClaims(
  db: D1Database,
  agentId: string,
  at: number,
): Promise<Result<MyClaim[]>> {
  const { results } = await db
    .prepare(
      `SELECT cl.id, p.plate, v.make, v.model, cl.state, cl.claimed_at, cl.expires_at, cl.closed_at,
         cl.close_reason, cl.close_note,
         (SELECT json_group_array(kind) FROM evidence e WHERE e.claim_id = cl.id) AS evidence,
         EXISTS (SELECT 1 FROM review_items r WHERE r.kind = 'delivery' AND r.subject_id = cl.id
                   AND r.status = 'open') AS under_review,
         (SELECT po.status FROM payouts po WHERE po.agent_id = cl.agent_id AND po.vehicle_id = cl.vehicle_id
            AND cl.close_reason = 'delivered' ORDER BY po.created_at DESC LIMIT 1) AS payout_status
       FROM claims cl
       JOIN vehicles v ON v.id = cl.vehicle_id
       LEFT JOIN vehicle_plates p ON p.vehicle_id = v.id AND p.valid_to IS NULL
       WHERE cl.agent_id = ? AND (cl.closed_at IS NULL OR cl.closed_at > ?)
       ORDER BY cl.closed_at IS NOT NULL, cl.claimed_at DESC LIMIT 100`,
    )
    .bind(agentId, at - 30 * 24 * 3600)
    .all<Omit<MyClaim, 'evidence' | 'under_review'> & { evidence: string; under_review: number }>();
  return ok(
    results.map((row) => ({
      ...row,
      evidence: JSON.parse(row.evidence) as EvidenceKind[],
      under_review: row.under_review === 1,
    })),
  );
}

export interface Earnings {
  payouts: {
    id: string;
    plate: string | null;
    gross_kurus: number;
    withholding_kurus: number;
    net_kurus: number;
    status: string;
    created_at: number;
    updated_at: number;
  }[];
  /** Net amounts by state: owed but not yet paid, and paid. */
  pending_kurus: number;
  paid_kurus: number;
}

export async function earnings(db: D1Database, agentId: string): Promise<Result<Earnings>> {
  const { results } = await db
    .prepare(
      `SELECT po.id, p.plate, po.gross_kurus, po.withholding_kurus, po.net_kurus, po.status,
         po.created_at, po.updated_at
       FROM payouts po
       LEFT JOIN vehicle_plates p ON p.vehicle_id = po.vehicle_id AND p.valid_to IS NULL
       WHERE po.agent_id = ? ORDER BY po.created_at DESC LIMIT 200`,
    )
    .bind(agentId)
    .all<Earnings['payouts'][number]>();
  let pending = 0;
  let paid = 0;
  for (const row of results) {
    if (row.status === 'sent') paid += row.net_kurus;
    else if (row.status !== 'cancelled') pending += row.net_kurus;
  }
  return ok({ payouts: results, pending_kurus: pending, paid_kurus: paid });
}
