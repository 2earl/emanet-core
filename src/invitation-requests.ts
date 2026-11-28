/**
 * Invitation requests (docs/DESIGN.md §5): someone with a 2earl account but no organization in
 * Emanet asks 2earl to invite their company. 2earl's team is emailed (Merkez → Settings sets the
 * address), the person gets a receipt, and staff invite or decline in Merkez → Onboarding. An
 * invitation made from a request is linked to it. Handled requests are deleted after
 * `invitation_request_days`.
 */
import { auditStatement } from './audit';
import type { PartnerKind } from './cases';
import {
  invitationRequestDeclinedMail,
  invitationRequestReceiptMail,
  invitationRequestStaffMail,
  type MailLocale,
  type Send,
} from './mail';
import { mailRoute } from './mail-routes';
import { fail, newId, ok, type Result } from './result';
import { readSettings } from './settings';

const DAY = 86_400;
const KINDS: readonly PartnerKind[] = ['bank', 'vys', 'law_firm', 'leasing', 'other'];
const VOLUMES = ['small', 'medium', 'large'] as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Requests one account may send in 30 days, so the team's inbox can't be flooded. */
export const REQUESTS_PER_MONTH = 3;

const clean = (value: unknown, max: number): string =>
  typeof value === 'string'
    ? value
        .trim()
        .replace(/[ \t]+/g, ' ')
        .slice(0, max)
    : '';

export type RequestStatus = 'new' | 'invited' | 'declined';

export interface InvitationRequestInput {
  company: string;
  kind: string;
  contactName: string;
  contactEmail: string;
  phone?: string;
  jobTitle?: string;
  volume?: string;
  message?: string;
  locale?: string;
}

export interface InvitationRequest {
  id: string;
  user_id: string;
  company: string;
  kind: PartnerKind;
  contact_name: string;
  contact_email: string;
  phone: string | null;
  job_title: string | null;
  volume: (typeof VOLUMES)[number] | null;
  message: string | null;
  locale: MailLocale;
  status: RequestStatus;
  handled_by: string | null;
  handled_at: number | null;
  staff_note: string | null;
  onboarding_id: string | null;
  created_at: number;
}

/** What the person who asked sees of their request: never the staff note. */
export type OwnRequest = Omit<InvitationRequest, 'staff_note' | 'handled_by'>;

const OWN = `id, user_id, company, kind, contact_name, contact_email, phone, job_title, volume, message,
  locale, status, handled_at, onboarding_id, created_at`;

export async function requestInvitation(
  db: D1Database,
  send: Send,
  merkez: string,
  userId: string,
  input: InvitationRequestInput,
  at: number,
): Promise<Result<{ id: string }>> {
  const company = clean(input.company, 200);
  const contactName = clean(input.contactName, 120);
  const contactEmail = clean(input.contactEmail, 254).toLowerCase();
  const phone = clean(input.phone, 30);
  const jobTitle = clean(input.jobTitle, 120);
  const message = typeof input.message === 'string' ? input.message.trim().slice(0, 2000) : '';
  const locale: MailLocale = input.locale === 'en' ? 'en' : 'tr';
  if (!userId) return fail('not_signed_in');
  if (company.length < 2) return fail('missing_company');
  if (!KINDS.includes(input.kind as PartnerKind)) return fail('invalid_kind');
  if (contactName.length < 3) return fail('missing_contact');
  if (!EMAIL.test(contactEmail)) return fail('invalid_email');
  if (phone && !/^\+?[\d ()-]{7,30}$/.test(phone)) return fail('invalid_phone');
  const volume =
    input.volume && (VOLUMES as readonly string[]).includes(input.volume)
      ? (input.volume as (typeof VOLUMES)[number])
      : null;
  if (input.volume && !volume) return fail('invalid_volume');
  const recent = await db
    .prepare(
      `SELECT count(*) AS n, sum(status = 'new') AS open FROM invitation_requests
       WHERE user_id = ? AND created_at > ?`,
    )
    .bind(userId, at - 30 * DAY)
    .first<{ n: number; open: number | null }>();
  if ((recent?.open ?? 0) > 0) return fail('already_requested');
  if ((recent?.n ?? 0) >= REQUESTS_PER_MONTH) return fail('too_many_requests');
  const id = newId();
  await db.batch([
    db
      .prepare(
        `INSERT INTO invitation_requests (id, user_id, company, kind, contact_name, contact_email, phone,
           job_title, volume, message, locale, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        userId,
        company,
        input.kind,
        contactName,
        contactEmail,
        phone || null,
        jobTitle || null,
        volume,
        message || null,
        locale,
        at,
      ),
    auditStatement(db, at, `user:${userId}`, 'onboarding.requested', `invitation_request:${id}`, {
      kind: input.kind,
    }),
  ]);
  await send(
    invitationRequestStaffMail(
      await mailRoute(db, 'invitation_requests'),
      company,
      input.kind,
      `${merkez}/onboarding/requests/${id}`,
    ),
  );
  await send(invitationRequestReceiptMail(locale, contactEmail, contactName, company));
  return ok({ id });
}

/** The person's latest request, to show where it stands; null when they haven't asked. */
export async function myInvitationRequest(
  db: D1Database,
  userId: string,
): Promise<Result<OwnRequest | null>> {
  const row = await db
    .prepare(
      `SELECT ${OWN} FROM invitation_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(userId)
    .first<OwnRequest>();
  return ok(row ?? null);
}

export async function invitationRequests(
  db: D1Database,
  status: RequestStatus | null,
): Promise<InvitationRequest[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM invitation_requests ${status ? 'WHERE status = ?' : ''}
       ORDER BY (status = 'new') DESC, created_at ${status === 'new' ? 'ASC' : 'DESC'} LIMIT 200`,
    )
    .bind(...(status ? [status] : []))
    .all<InvitationRequest>();
  return results;
}

export async function invitationRequest(
  db: D1Database,
  id: string,
): Promise<Result<InvitationRequest>> {
  const row = await db
    .prepare('SELECT * FROM invitation_requests WHERE id = ?')
    .bind(id)
    .first<InvitationRequest>();
  return row ? ok(row) : fail('not_found');
}

/** Not now: the request is closed, the person is told without a reason, the note stays with staff. */
export async function declineInvitationRequest(
  db: D1Database,
  send: Send,
  staffId: string,
  id: string,
  input: { note?: string; tell?: boolean },
  at: number,
): Promise<Result<null>> {
  const found = await invitationRequest(db, id);
  if (!found.ok) return found;
  if (found.value.status !== 'new') return fail('already_handled');
  const note = clean(input.note, 500);
  await db.batch([
    db
      .prepare(
        `UPDATE invitation_requests SET status = 'declined', handled_by = ?, handled_at = ?, staff_note = ?
         WHERE id = ? AND status = 'new'`,
      )
      .bind(staffId, at, note || null, id),
    auditStatement(
      db,
      at,
      `staff:${staffId}`,
      'onboarding.request_declined',
      `invitation_request:${id}`,
    ),
  ]);
  if (input.tell !== false) {
    const r = found.value;
    await send(invitationRequestDeclinedMail(r.locale, r.contact_email, r.contact_name, r.company));
  }
  return ok(null);
}

/** An invitation was sent from this request: they are linked and the request is done. */
export async function markRequestInvited(
  db: D1Database,
  staffId: string,
  id: string,
  onboardingId: string,
  at: number,
): Promise<Result<null>> {
  const result = await db
    .prepare(
      `UPDATE invitation_requests SET status = 'invited', handled_by = ?, handled_at = ?, onboarding_id = ?
       WHERE id = ? AND status = 'new'`,
    )
    .bind(staffId, at, onboardingId, id)
    .run();
  if (result.meta.changes === 0) return fail('already_handled');
  await auditStatement(
    db,
    at,
    `staff:${staffId}`,
    'onboarding.request_invited',
    `invitation_request:${id}`,
    {
      onboarding: onboardingId,
    },
  ).run();
  return ok(null);
}

const purgeable = (at: number, days: number) =>
  `status != 'new' AND handled_at IS NOT NULL AND handled_at <= ${String(at - days * DAY)}`;

/** Cron: handled requests go after `invitation_request_days`; open ones wait for staff. */
export async function purgeInvitationRequests(db: D1Database, at: number): Promise<number> {
  const days = (await readSettings(db)).invitation_request_days;
  const result = await db
    .prepare(`DELETE FROM invitation_requests WHERE ${purgeable(at, days)}`)
    .run();
  const n = result.meta.changes;
  if (n > 0) {
    await auditStatement(
      db,
      at,
      'system',
      'retention.invitation_requests_purged',
      'invitation_requests',
      {
        requests: n,
      },
    ).run();
  }
  return n;
}

export const invitationRequestsDue = async (db: D1Database, at: number): Promise<number> => {
  const days = (await readSettings(db)).invitation_request_days;
  const row = await db
    .prepare(`SELECT count(*) AS n FROM invitation_requests WHERE ${purgeable(at, days)}`)
    .first<{ n: number }>();
  return row?.n ?? 0;
};
