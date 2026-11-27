/**
 * Onboarding a company (docs/DESIGN.md §5): staff invite it in Emanet Merkez; its contact opens the
 * emailed link in Emanet Kurumsal, signs in with the invited address, gets a 2earl organization,
 * gives the company's details, uploads documents and accepts the agreement; staff check and
 * approve, which makes the company an active partner.
 *
 *   invited ─(link opened, right address)→ in_progress ─(agreement accepted)→ signed
 *   signed ─(staff approve)→ approved      any open state ─(staff)→ rejected | cancelled
 *   invited | in_progress ─(14 days)→ expired       staff can send a new link at any open state
 *
 * The link's secret is only in the email: the database keeps its SHA-256. Every step is audited.
 */
import { auditStatement, auditStatementIf } from './audit';
import { partnerByOrg, type PartnerKind } from './cases';
import {
  renderContract,
  type ContractParty,
  type ContractPrice,
  type RenderedContract,
} from './contract';
import {
  approvedMail,
  invitationMail,
  receiptMail,
  rejectedMail,
  returnedMail,
  signedMail,
  type MailLocale,
  type Send,
} from './mail';
import { checkPriceList, type PriceList } from './pricing';
import { provider } from './provider';
import { fail, newId, ok, type Result } from './result';

export const INVITATION_TTL = 14 * 24 * 3600;
/** Reminders after 3 and 7 days without the agreement accepted. */
export const REMINDER_AFTER = [3 * 24 * 3600, 7 * 24 * 3600];
export const RESEND_INTERVAL = 10 * 60;
export const MAX_DOCUMENTS = 20;

export type OnboardingStatus =
  'invited' | 'in_progress' | 'signed' | 'approved' | 'rejected' | 'cancelled' | 'expired';
const OPEN: readonly OnboardingStatus[] = ['invited', 'in_progress', 'signed'];

export type DocumentKind =
  'signed_contract' | 'signature_circular' | 'tax_certificate' | 'trade_registry' | 'other';
export const DOCUMENT_KINDS: readonly DocumentKind[] = [
  'signed_contract',
  'signature_circular',
  'tax_certificate',
  'trade_registry',
  'other',
];
/** What staff expect before approving; the console warns when one is missing. */
export const REQUIRED_DOCUMENTS: readonly DocumentKind[] = [
  'signature_circular',
  'tax_certificate',
];

export interface Details extends ContractParty {
  eInvoice: boolean;
}

export interface Origins {
  kurumsal: string;
  merkez: string;
  staffEmail: string;
}

interface Row {
  id: string;
  kind: PartnerKind;
  company: string;
  contact_name: string;
  contact_email: string;
  locale: MailLocale;
  price_list: string | null;
  reconfirm_days: number;
  note: string | null;
  status: OnboardingStatus;
  invited_by: string;
  invited_at: number;
  sent_at: number;
  reminders: number;
  expires_at: number;
  claimed_by: string | null;
  claimed_at: number | null;
  org_id: string | null;
  details: string | null;
  details_at: number | null;
  contract_version: string | null;
  contract_sha256: string | null;
  signer_name: string | null;
  signer_title: string | null;
  signed_at: number | null;
  decided_by: string | null;
  decided_at: number | null;
  decision_reason: string | null;
  partner_id: string | null;
  updated_at: number;
}

export interface OnboardingDocument {
  id: string;
  kind: DocumentKind;
  file_ref: string;
  sha256: string;
  file_name: string;
  content_type: string;
  size: number;
  uploaded_by: string;
  uploaded_at: number;
}

export interface Onboarding {
  id: string;
  kind: PartnerKind;
  company: string;
  contact_name: string;
  contact_email: string;
  locale: MailLocale;
  price_list: PriceList | null;
  reconfirm_days: number;
  status: OnboardingStatus;
  invited_by: string;
  invited_at: number;
  sent_at: number;
  expires_at: number;
  claimed_by: string | null;
  org_id: string | null;
  details: Details | null;
  contract_version: string | null;
  contract_sha256: string | null;
  signer_name: string | null;
  signer_title: string | null;
  signed_at: number | null;
  decided_at: number | null;
  decision_reason: string | null;
  partner_id: string | null;
  documents: OnboardingDocument[];
  updated_at: number;
}

const COLUMNS = `id, kind, company, contact_name, contact_email, locale, price_list, reconfirm_days, note,
  status, invited_by, invited_at, sent_at, reminders, expires_at, claimed_by, claimed_at, org_id,
  details, details_at, contract_version, contract_sha256, signer_name, signer_title, signed_at,
  decided_by, decided_at, decision_reason, partner_id, updated_at`;

async function documentsOf(db: D1Database, id: string): Promise<OnboardingDocument[]> {
  const { results } = await db
    .prepare(
      `SELECT id, kind, file_ref, sha256, file_name, content_type, size, uploaded_by, uploaded_at
       FROM onboarding_documents WHERE onboarding_id = ? ORDER BY uploaded_at`,
    )
    .bind(id)
    .all<OnboardingDocument>();
  return results;
}

async function view(db: D1Database, row: Row): Promise<Onboarding & { note: string | null }> {
  return {
    id: row.id,
    kind: row.kind,
    company: row.company,
    contact_name: row.contact_name,
    contact_email: row.contact_email,
    locale: row.locale,
    price_list: row.price_list ? (JSON.parse(row.price_list) as PriceList) : null,
    reconfirm_days: row.reconfirm_days,
    note: row.note,
    status: row.status,
    invited_by: row.invited_by,
    invited_at: row.invited_at,
    sent_at: row.sent_at,
    expires_at: row.expires_at,
    claimed_by: row.claimed_by,
    org_id: row.org_id,
    details: row.details ? (JSON.parse(row.details) as Details) : null,
    contract_version: row.contract_version,
    contract_sha256: row.contract_sha256,
    signer_name: row.signer_name,
    signer_title: row.signer_title,
    signed_at: row.signed_at,
    decided_at: row.decided_at,
    decision_reason: row.decision_reason,
    partner_id: row.partner_id,
    documents: await documentsOf(db, row.id),
    updated_at: row.updated_at,
  };
}

async function rowById(db: D1Database, id: string): Promise<Row | null> {
  return db.prepare(`SELECT ${COLUMNS} FROM onboardings WHERE id = ?`).bind(id).first<Row>();
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clean = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';

/** The staff note stays with staff. */
function withoutNote(o: Onboarding & { note: string | null }): Onboarding {
  const copy: Partial<Onboarding & { note: string | null }> = { ...o };
  delete copy.note;
  return copy as Onboarding;
}

// ---- Staff (ControlApi) ------------------------------------------------------------------------

export interface Invitation {
  company: string;
  kind: PartnerKind;
  contactName: string;
  contactEmail: string;
  locale: MailLocale;
  priceList: unknown;
  reconfirmDays?: number;
  note?: string;
}

const KINDS: readonly PartnerKind[] = ['bank', 'vys', 'law_firm', 'leasing', 'other'];

export async function invite(
  db: D1Database,
  send: Send,
  origins: Origins,
  staffId: string,
  input: Invitation,
  at: number,
): Promise<Result<{ id: string; emailed: boolean }>> {
  const company = clean(input.company, 200);
  const contactName = clean(input.contactName, 120);
  const contactEmail = clean(input.contactEmail, 254).toLowerCase();
  if (!company) return fail('missing_company');
  if (!KINDS.includes(input.kind)) return fail('invalid_kind');
  if (!contactName) return fail('missing_contact');
  if (!EMAIL.test(contactEmail)) return fail('invalid_email');
  if (!['tr', 'en'].includes(input.locale)) return fail('invalid_locale');
  const prices = checkPriceList(input.priceList);
  if (!prices.ok) return prices;
  const reconfirmDays = input.reconfirmDays ?? 14;
  if (!Number.isInteger(reconfirmDays) || reconfirmDays < 1 || reconfirmDays > 90) {
    return fail('invalid_reconfirm_days');
  }
  const open = await db
    .prepare(
      `SELECT id FROM onboardings WHERE lower(contact_email) = ? AND status IN ('invited', 'in_progress', 'signed')`,
    )
    .bind(contactEmail)
    .first<{ id: string }>();
  if (open) return fail('already_invited', open.id);
  const id = newId();
  const secret = newSecret();
  const expiresAt = at + INVITATION_TTL;
  await db.batch([
    db
      .prepare(
        `INSERT INTO onboardings (id, token_hash, kind, company, contact_name, contact_email, locale,
           price_list, reconfirm_days, note, status, invited_by, invited_at, sent_at, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'invited', ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        await sha256Hex(secret),
        input.kind,
        company,
        contactName,
        contactEmail,
        input.locale,
        JSON.stringify(prices.value),
        reconfirmDays,
        clean(input.note, 500) || null,
        staffId,
        at,
        at,
        expiresAt,
        at,
      ),
    auditStatement(db, at, `staff:${staffId}`, 'onboarding.invited', `onboarding:${id}`, {
      kind: input.kind,
    }),
  ]);
  const emailed = await send(
    invitationMail(
      input.locale,
      contactEmail,
      company,
      contactName,
      `${origins.kurumsal}/join/${secret}`,
      expiresAt,
      false,
    ),
  );
  return ok({ id, emailed });
}

/** A new link (the old one stops working), valid for another 14 days. */
export async function resend(
  db: D1Database,
  send: Send,
  origins: Origins,
  staffId: string,
  id: string,
  at: number,
): Promise<Result<{ emailed: boolean }>> {
  const row = await rowById(db, id);
  if (!row) return fail('not_found');
  if (!['invited', 'in_progress', 'expired'].includes(row.status))
    return fail('not_open', row.status);
  if (at - row.sent_at < RESEND_INTERVAL) return fail('sent_recently');
  if (row.status === 'expired') {
    const other = await db
      .prepare(
        `SELECT 1 AS x FROM onboardings WHERE lower(contact_email) = ? AND id != ?
           AND status IN ('invited', 'in_progress', 'signed')`,
      )
      .bind(row.contact_email, id)
      .first();
    if (other) return fail('already_invited');
  }
  const secret = newSecret();
  const expiresAt = at + INVITATION_TTL;
  await db.batch([
    db
      .prepare(
        `UPDATE onboardings SET token_hash = ?, sent_at = ?, expires_at = ?, reminders = 0,
           status = CASE WHEN status = 'expired' THEN (CASE WHEN claimed_by IS NULL THEN 'invited' ELSE 'in_progress' END) ELSE status END,
           updated_at = ?
         WHERE id = ?`,
      )
      .bind(await sha256Hex(secret), at, expiresAt, at, id),
    auditStatement(db, at, `staff:${staffId}`, 'onboarding.resent', `onboarding:${id}`),
  ]);
  const emailed = await send(
    invitationMail(
      row.locale,
      row.contact_email,
      row.company,
      row.contact_name,
      `${origins.kurumsal}/join/${secret}`,
      expiresAt,
      false,
    ),
  );
  return ok({ emailed });
}

export async function listOnboardings(
  db: D1Database,
  status: OnboardingStatus | null,
): Promise<Result<Omit<Onboarding, 'documents' | 'details' | 'price_list'>[]>> {
  const { results } = await db
    .prepare(
      `SELECT id, kind, company, contact_name, contact_email, locale, reconfirm_days, status, invited_by,
         invited_at, sent_at, expires_at, claimed_by, org_id, contract_version, contract_sha256,
         signer_name, signer_title, signed_at, decided_at, decision_reason, partner_id, updated_at,
         json_extract(details, '$.legalName') AS legal_name
       FROM onboardings WHERE (?1 IS NULL OR status = ?1)
       ORDER BY CASE status WHEN 'signed' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'invited' THEN 2 ELSE 3 END,
         updated_at DESC LIMIT 500`,
    )
    .bind(status)
    .all<Omit<Onboarding, 'documents' | 'details' | 'price_list'>>();
  return ok(results);
}

export async function onboardingForStaff(
  db: D1Database,
  id: string,
): Promise<
  Result<
    Onboarding & {
      note: string | null;
      contract_text: string | null;
      acceptances: Acceptance[];
    }
  >
> {
  const row = await rowById(db, id);
  if (!row) return fail('not_found');
  const [text, acceptances] = await Promise.all([
    db
      .prepare('SELECT contract_text FROM onboardings WHERE id = ?')
      .bind(id)
      .first<{ contract_text: string | null }>(),
    db
      .prepare(
        `SELECT contract_version, contract_sha256, signer_name, signer_title, signer_ip, signed_at
         FROM onboarding_acceptances WHERE onboarding_id = ? ORDER BY signed_at`,
      )
      .bind(id)
      .all<Acceptance>(),
  ]);
  return ok({
    ...(await view(db, row)),
    contract_text: text?.contract_text ?? null,
    acceptances: acceptances.results,
  });
}

/** One acceptance of the agreement, kept even after staff sent the onboarding back. */
export interface Acceptance {
  contract_version: string;
  contract_sha256: string;
  signer_name: string;
  signer_title: string;
  signer_ip: string | null;
  signed_at: number;
}

export async function cancel(
  db: D1Database,
  staffId: string,
  id: string,
  reason: string,
  at: number,
): Promise<Result<null>> {
  const why = clean(reason, 300);
  if (!why) return fail('invalid_reason');
  const result = await db.batch([
    db
      .prepare(
        `UPDATE onboardings SET status = 'cancelled', decided_by = ?, decided_at = ?, decision_reason = ?,
           updated_at = ? WHERE id = ? AND status IN ('invited', 'in_progress', 'signed', 'expired')`,
      )
      .bind(staffId, at, why, at, id),
    auditStatement(db, at, `staff:${staffId}`, 'onboarding.cancelled', `onboarding:${id}`),
  ]);
  return result[0]?.meta.changes === 1 ? ok(null) : fail('not_open');
}

export async function reject(
  db: D1Database,
  send: Send,
  staffId: string,
  id: string,
  reason: string,
  at: number,
): Promise<Result<{ emailed: boolean }>> {
  const why = clean(reason, 300);
  if (!why) return fail('invalid_reason');
  const row = await rowById(db, id);
  if (!row) return fail('not_found');
  const result = await db.batch([
    db
      .prepare(
        `UPDATE onboardings SET status = 'rejected', decided_by = ?, decided_at = ?, decision_reason = ?,
           updated_at = ? WHERE id = ? AND status IN ('in_progress', 'signed')`,
      )
      .bind(staffId, at, why, at, id),
    auditStatement(db, at, `staff:${staffId}`, 'onboarding.rejected', `onboarding:${id}`),
  ]);
  if (result[0]?.meta.changes !== 1) return fail('not_open', row.status);
  const company = row.details ? (JSON.parse(row.details) as Details).legalName : row.company;
  return ok({ emailed: await send(rejectedMail(row.locale, row.contact_email, company, why)) });
}

/**
 * Staff send a signed onboarding back for changes (wrong details, a missing document): the
 * acceptance is cleared, the company corrects what's needed and accepts again. The link stays
 * valid for at least another 7 days.
 */
export async function reopen(
  db: D1Database,
  send: Send,
  origins: Origins,
  staffId: string,
  id: string,
  reason: string,
  at: number,
): Promise<Result<{ emailed: boolean }>> {
  const why = clean(reason, 300);
  if (!why) return fail('invalid_reason');
  const row = await rowById(db, id);
  if (!row) return fail('not_found');
  const result = await db.batch([
    db
      .prepare(
        `UPDATE onboardings SET status = 'in_progress', contract_version = NULL, contract_sha256 = NULL,
           contract_text = NULL, signed_by = NULL, signer_name = NULL, signer_title = NULL,
           signer_ip = NULL, signed_at = NULL, decision_reason = ?, expires_at = max(expires_at, ?),
           updated_at = ?
         WHERE id = ? AND status = 'signed'`,
      )
      .bind(why, at + 7 * 24 * 3600, at, id),
    auditStatement(db, at, `staff:${staffId}`, 'onboarding.returned', `onboarding:${id}`, {
      previous_sha256: row.contract_sha256,
    }),
  ]);
  if (result[0]?.meta.changes !== 1) return fail('not_signed', row.status);
  const company = row.details ? (JSON.parse(row.details) as Details).legalName : row.company;
  return ok({
    emailed: await send(
      returnedMail(
        row.locale,
        row.contact_email,
        company,
        why,
        `${origins.kurumsal}/onboarding/${id}`,
      ),
    ),
  });
}

/**
 * The company becomes an active partner of its organization, with the agreed price list and the
 * details it gave, in one batch: it either all happens or none of it does. The contact is told.
 */
export async function approve(
  db: D1Database,
  send: Send,
  origins: Origins,
  staffId: string,
  id: string,
  at: number,
): Promise<Result<{ partnerId: string; emailed: boolean }>> {
  const row = await rowById(db, id);
  if (!row) return fail('not_found');
  if (row.status !== 'signed') return fail('not_signed', row.status);
  if (!row.org_id || !row.details || !row.price_list) return fail('incomplete');
  if (row.invited_by === staffId) return fail('four_eyes');
  if (await partnerByOrg(db, row.org_id)) return fail('partner_exists');
  const prices = checkPriceList(JSON.parse(row.price_list));
  if (!prices.ok) return prices;
  const details = JSON.parse(row.details) as Details;
  const partnerId = newId();
  const actor = `staff:${staffId}`;
  const results = await db.batch([
    // Only while the onboarding is still signed, so two approvals can't make two partners.
    db
      .prepare(
        `INSERT INTO partners (id, org_id, kind, legal_name, vkn, tax_office, kep_address, e_invoice,
           status, reconfirm_days, address, mersis, billing_email, contact_email, contract_version,
           contract_signed_at, onboarding_id, created_by, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM onboardings WHERE id = ? AND status = 'signed')`,
      )
      .bind(
        partnerId,
        row.org_id,
        row.kind,
        details.legalName,
        details.vkn,
        details.taxOffice,
        details.kep,
        details.eInvoice ? 1 : 0,
        row.reconfirm_days,
        details.address,
        details.mersis,
        details.billingEmail,
        details.operationsEmail,
        row.contract_version,
        row.signed_at,
        id,
        staffId,
        at,
        at,
        id,
      ),
    db
      .prepare(
        `UPDATE onboardings SET status = 'approved', decided_by = ?, decided_at = ?, partner_id = ?,
           updated_at = ? WHERE id = ? AND status = 'signed' AND EXISTS (SELECT 1 FROM partners WHERE id = ?)`,
      )
      .bind(staffId, at, partnerId, at, id, partnerId),
    db
      .prepare(
        `INSERT INTO price_lists (id, partner_id, valid_from, rules, created_by, created_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM partners WHERE id = ?)`,
      )
      .bind(newId(), partnerId, at, JSON.stringify(prices.value), actor, at, partnerId),
    ...(
      [
        ['onboarding.approved', `onboarding:${id}`, { partner: partnerId }],
        ['partner.created', `partner:${partnerId}`, { org: row.org_id, onboarding: id }],
        ['partner.active', `partner:${partnerId}`, {}],
      ] as const
    ).map(([action, subject, detail]) =>
      db
        .prepare(
          `INSERT INTO audit_events (id, at, actor, action, subject, detail)
           SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM partners WHERE id = ?)`,
        )
        .bind(newId(), at, actor, action, subject, JSON.stringify(detail), partnerId),
    ),
  ]);
  if (results[0]?.meta.changes !== 1) return fail('not_signed');
  const emailed = await send(
    approvedMail(
      row.locale,
      row.contact_email,
      details.legalName,
      `${origins.kurumsal}/o/${row.org_id}`,
    ),
  );
  return ok({ partnerId, emailed });
}

// ---- The invited company (PartnerApi, from Emanet Kurumsal) ------------------------------------

export interface InvitationView {
  id: string;
  company: string;
  contact_name: string;
  contact_email: string;
  locale: MailLocale;
  invited_by: string;
  status: OnboardingStatus;
  expires_at: number;
  claimed_by: string | null;
}

/** What the link shows, for anyone holding it. Nothing for a used, expired or unknown link. */
export async function invitationByToken(
  db: D1Database,
  token: string,
  at: number,
): Promise<Result<InvitationView>> {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return fail('not_found');
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM onboardings WHERE token_hash = ?`)
    .bind(await sha256Hex(token))
    .first<Row>();
  if (!row || !OPEN.includes(row.status)) return fail('not_found');
  if (row.status !== 'signed' && row.expires_at <= at) return fail('expired');
  return ok({
    id: row.id,
    company: row.company,
    contact_name: row.contact_name,
    contact_email: row.contact_email,
    locale: row.locale,
    invited_by: row.invited_by,
    status: row.status,
    expires_at: row.expires_at,
    claimed_by: row.claimed_by,
  });
}

/**
 * The account that opened the link (Kurumsal checked with login that it signs in with the invited
 * address) takes the onboarding. Only one account can: the first.
 */
export async function claim(
  db: D1Database,
  token: string,
  userId: string,
  at: number,
): Promise<Result<{ id: string }>> {
  const invitation = await invitationByToken(db, token, at);
  if (!invitation.ok) return invitation;
  const i = invitation.value;
  if (i.claimed_by !== null) {
    return i.claimed_by === userId ? ok({ id: i.id }) : fail('claimed_by_another');
  }
  const result = await db.batch([
    db
      .prepare(
        `UPDATE onboardings SET claimed_by = ?, claimed_at = ?, status = 'in_progress', updated_at = ?
         WHERE id = ? AND claimed_by IS NULL AND status = 'invited'`,
      )
      .bind(userId, at, at, i.id),
    auditStatement(db, at, `user:${userId}`, 'onboarding.claimed', `onboarding:${i.id}`),
  ]);
  return result[0]?.meta.changes === 1 ? ok({ id: i.id }) : fail('claimed_by_another');
}

/** The onboardings this account runs, newest first. */
export async function mine(db: D1Database, userId: string): Promise<Result<Onboarding[]>> {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM onboardings WHERE claimed_by = ? ORDER BY updated_at DESC LIMIT 20`,
    )
    .bind(userId)
    .all<Row>();
  const views = await Promise.all(results.map((row) => view(db, row)));
  return ok(views.map(withoutNote));
}

/** The onboarding, for the account that took it; open ones only change. */
async function owned(
  db: D1Database,
  id: string,
  userId: string,
  at: number,
  editable: boolean,
): Promise<Result<Row>> {
  const row = await rowById(db, id);
  if (!row || row.claimed_by !== userId) return fail('not_found');
  if (editable) {
    if (row.status !== 'in_progress') return fail('not_editable', row.status);
    if (row.expires_at <= at) return fail('expired');
  }
  return ok(row);
}

export async function onboardingForUser(
  db: D1Database,
  id: string,
  userId: string,
  at: number,
): Promise<Result<Onboarding & { contract_text: string | null }>> {
  const row = await owned(db, id, userId, at, false);
  if (!row.ok) return row;
  const rest = withoutNote(await view(db, row.value));
  const text = await db
    .prepare('SELECT contract_text FROM onboardings WHERE id = ?')
    .bind(id)
    .first<{ contract_text: string | null }>();
  return ok({ ...rest, contract_text: text?.contract_text ?? null });
}

export async function linkOrganization(
  db: D1Database,
  id: string,
  userId: string,
  orgId: string,
  at: number,
): Promise<Result<null>> {
  const row = await owned(db, id, userId, at, true);
  if (!row.ok) return row;
  if (!/^org_[A-Za-z0-9_-]{4,40}$/.test(orgId)) return fail('invalid_org');
  if (await partnerByOrg(db, orgId)) return fail('partner_exists');
  const taken = await db
    .prepare(
      `SELECT 1 AS x FROM onboardings WHERE org_id = ? AND id != ? AND status IN ('in_progress', 'signed')`,
    )
    .bind(orgId, id)
    .first();
  if (taken) return fail('org_in_use');
  await db.batch([
    db
      .prepare('UPDATE onboardings SET org_id = ?, updated_at = ? WHERE id = ?')
      .bind(orgId, at, id),
    auditStatement(db, at, `user:${userId}`, 'onboarding.org_linked', `onboarding:${id}`, {
      org: orgId,
    }),
  ]);
  return ok(null);
}

function checkDetails(input: Record<string, unknown>): Result<Details> {
  const d = {
    legalName: clean(input.legalName, 200),
    address: clean(input.address, 400),
    taxOffice: clean(input.taxOffice, 100),
    vkn: clean(input.vkn, 11),
    mersis: clean(input.mersis, 16) || null,
    kep: clean(input.kep, 254).toLowerCase() || null,
    signatoryName: clean(input.signatoryName, 120),
    signatoryTitle: clean(input.signatoryTitle, 120),
    billingEmail: clean(input.billingEmail, 254).toLowerCase(),
    operationsName: clean(input.operationsName, 120),
    operationsEmail: clean(input.operationsEmail, 254).toLowerCase(),
    operationsPhone: clean(input.operationsPhone, 30),
    eInvoice: input.eInvoice === true,
  };
  if (d.legalName.length < 3) return fail('invalid_details', 'legalName');
  if (d.address.length < 10) return fail('invalid_details', 'address');
  if (d.taxOffice.length < 2) return fail('invalid_details', 'taxOffice');
  if (!/^\d{10,11}$/.test(d.vkn)) return fail('invalid_details', 'vkn');
  if (d.mersis !== null && !/^\d{16}$/.test(d.mersis)) return fail('invalid_details', 'mersis');
  if (d.kep !== null && !EMAIL.test(d.kep)) return fail('invalid_details', 'kep');
  if (d.signatoryName.length < 3 || !d.signatoryName.includes(' ')) {
    return fail('invalid_details', 'signatoryName');
  }
  if (d.signatoryTitle.length < 2) return fail('invalid_details', 'signatoryTitle');
  if (!EMAIL.test(d.billingEmail)) return fail('invalid_details', 'billingEmail');
  if (d.operationsName.length < 3) return fail('invalid_details', 'operationsName');
  if (!EMAIL.test(d.operationsEmail)) return fail('invalid_details', 'operationsEmail');
  if (!/^\+?[0-9 ()-]{10,20}$/.test(d.operationsPhone))
    return fail('invalid_details', 'operationsPhone');
  return ok(d);
}

export async function saveDetails(
  db: D1Database,
  id: string,
  userId: string,
  input: Record<string, unknown>,
  at: number,
): Promise<Result<Details>> {
  const row = await owned(db, id, userId, at, true);
  if (!row.ok) return row;
  const details = checkDetails(input);
  if (!details.ok) return details;
  await db.batch([
    db
      .prepare('UPDATE onboardings SET details = ?, details_at = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(details.value), at, at, id),
    auditStatement(db, at, `user:${userId}`, 'onboarding.details_saved', `onboarding:${id}`),
  ]);
  return details;
}

export async function addDocument(
  db: D1Database,
  id: string,
  userId: string,
  document: {
    kind: DocumentKind;
    file_ref: string;
    sha256: string;
    file_name: string;
    content_type: string;
    size: number;
  },
  at: number,
): Promise<Result<{ id: string }>> {
  const row = await owned(db, id, userId, at, false);
  if (!row.ok) return row;
  // Documents can follow the signature (a wet-signed copy), until staff decide.
  if (row.value.status !== 'in_progress' && row.value.status !== 'signed') {
    return fail('not_editable', row.value.status);
  }
  if (!DOCUMENT_KINDS.includes(document.kind)) return fail('invalid_kind');
  if (!/^[0-9a-f]{64}$/.test(document.sha256)) return fail('invalid_hash');
  if (!document.file_ref.startsWith(`onboarding/${id}/`)) return fail('invalid_ref');
  const count = await db
    .prepare('SELECT count(*) AS n FROM onboarding_documents WHERE onboarding_id = ?')
    .bind(id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_DOCUMENTS) return fail('too_many_documents');
  const docId = newId();
  await db.batch([
    db
      .prepare(
        `INSERT INTO onboarding_documents (id, onboarding_id, kind, file_ref, sha256, file_name,
           content_type, size, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        docId,
        id,
        document.kind,
        document.file_ref,
        document.sha256,
        clean(document.file_name, 200) || 'document',
        document.content_type,
        document.size,
        userId,
        at,
      ),
    db.prepare('UPDATE onboardings SET updated_at = ? WHERE id = ?').bind(at, id),
    auditStatement(db, at, `user:${userId}`, 'onboarding.document_added', `onboarding:${id}`, {
      kind: document.kind,
    }),
  ]);
  return ok({ id: docId });
}

/** The agreement as it would be signed now, with the company's details and price list. */
export async function contractFor(
  db: D1Database,
  id: string,
  userId: string,
  at: number,
): Promise<Result<RenderedContract>> {
  const row = await owned(db, id, userId, at, false);
  if (!row.ok) return row;
  if (!row.value.details) return fail('details_missing');
  const prices = row.value.price_list ? (JSON.parse(row.value.price_list) as ContractPrice) : null;
  return ok(
    await renderContract(
      JSON.parse(row.value.details) as Details,
      prices,
      row.value.reconfirm_days,
      await provider(db),
    ),
  );
}

/**
 * The signatory accepts the agreement they were shown: the version and SHA-256 must match the
 * agreement rendered now, so a change of details in between needs a new look.
 */
export async function sign(
  db: D1Database,
  send: Send,
  origins: Origins,
  id: string,
  userId: string,
  input: {
    version: string;
    sha256: string;
    name: string;
    title: string;
    ip: string | null;
    authorised: boolean;
  },
  at: number,
): Promise<Result<null>> {
  const row = await owned(db, id, userId, at, true);
  if (!row.ok) return row;
  if (!row.value.org_id) return fail('org_missing');
  if (!row.value.details) return fail('details_missing');
  if (!input.authorised) return fail('not_authorised');
  const name = clean(input.name, 120);
  const title = clean(input.title, 120);
  if (name.length < 3 || !name.includes(' ')) return fail('invalid_signer');
  if (title.length < 2) return fail('invalid_signer');
  const contract = await contractFor(db, id, userId, at);
  if (!contract.ok) return contract;
  if (!contract.value.final) return fail('provider_incomplete');
  if (input.version !== contract.value.version || input.sha256 !== contract.value.sha256) {
    return fail('contract_changed');
  }
  const result = await db.batch([
    db
      .prepare(
        `UPDATE onboardings SET status = 'signed', contract_version = ?, contract_sha256 = ?,
           contract_text = ?, signed_by = ?, signer_name = ?, signer_title = ?, signer_ip = ?,
           signed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'in_progress'`,
      )
      .bind(
        contract.value.version,
        contract.value.sha256,
        contract.value.text,
        userId,
        name,
        title,
        input.ip,
        at,
        at,
        id,
      ),
    // Kept for good, even if staff later send the onboarding back (migration 0005).
    db
      .prepare(
        `INSERT INTO onboarding_acceptances (id, onboarding_id, contract_version, contract_sha256,
           contract_text, signed_by, signer_name, signer_title, signer_ip, signed_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM onboardings WHERE id = ? AND status = 'signed' AND signed_at = ?
           AND signed_by = ? AND contract_sha256 = ?)`,
      )
      .bind(
        newId(),
        id,
        contract.value.version,
        contract.value.sha256,
        contract.value.text,
        userId,
        name,
        title,
        input.ip,
        at,
        id,
        at,
        userId,
        contract.value.sha256,
      ),
    auditStatementIf(
      db,
      at,
      `user:${userId}`,
      'onboarding.signed',
      `onboarding:${id}`,
      { version: contract.value.version, sha256: contract.value.sha256 },
      `EXISTS (SELECT 1 FROM onboarding_acceptances WHERE onboarding_id = ? AND signed_at = ? AND signed_by = ?)`,
      id,
      at,
      userId,
    ),
  ]);
  if (result[0]?.meta.changes !== 1) return fail('not_editable');
  const company = (JSON.parse(row.value.details) as Details).legalName;
  await send(
    receiptMail(
      row.value.locale,
      row.value.contact_email,
      company,
      contract.value.version,
      contract.value.sha256,
      `${origins.kurumsal}/onboarding/${id}`,
    ),
  );
  await send(signedMail(origins.staffEmail, company, `${origins.merkez}/onboarding/${id}`));
  return ok(null);
}

// ---- Scheduled ---------------------------------------------------------------------------------

/**
 * Reminders after 3 and 7 days for companies that haven't accepted the agreement, and expiry after
 * 14. A reminder carries a new link, because only the email ever had the old one.
 */
export async function remindAndExpire(
  db: D1Database,
  send: Send,
  origins: Origins,
  at: number,
): Promise<{ reminded: number; expired: number }> {
  const expired = await db
    .prepare(
      `UPDATE onboardings SET status = 'expired', updated_at = ?
       WHERE status IN ('invited', 'in_progress') AND expires_at <= ?`,
    )
    .bind(at, at)
    .run();
  let reminded = 0;
  for (const [index, after] of REMINDER_AFTER.entries()) {
    const { results } = await db
      .prepare(
        `SELECT ${COLUMNS} FROM onboardings
         WHERE status IN ('invited', 'in_progress') AND reminders = ? AND sent_at <= ? AND expires_at > ?
         LIMIT 50`,
      )
      .bind(index, at - after, at)
      .all<Row>();
    for (const row of results) {
      const secret = newSecret();
      const claimed = await db
        .prepare(
          `UPDATE onboardings SET token_hash = ?, reminders = reminders + 1, updated_at = ?
           WHERE id = ? AND reminders = ?`,
        )
        .bind(await sha256Hex(secret), at, row.id, index)
        .run();
      if (claimed.meta.changes !== 1) continue;
      const company = row.details ? (JSON.parse(row.details) as Details).legalName : row.company;
      await send(
        invitationMail(
          row.locale,
          row.contact_email,
          company,
          row.contact_name,
          `${origins.kurumsal}/join/${secret}`,
          row.expires_at,
          true,
        ),
      );
      reminded++;
    }
  }
  return { reminded, expired: expired.meta.changes };
}
