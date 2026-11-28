/**
 * Legal holds (docs/DESIGN.md §18). While a dispute or an investigation is open, the automatic
 * deletions must not destroy what the file may be needed for. A hold names one agent, one case or
 * one company onboarding; staff set it with a reason and lift it with a reason. It stops:
 * - the retention cron queueing the files of that subject, and the queue handing out files already
 *   queued for it (src/privacy.ts);
 * - the redaction of a held case's places (src/cases.ts);
 * - the destruction of a held agent's sealed archive (src/erasure.ts), and the erasure itself.
 * It does not stop a data subject's rights from being recorded: the request stays open and staff
 * answer it, citing the hold.
 */
import { auditStatement } from './audit';
import { fail, newId, ok, type Result } from './result';

export type HoldKind = 'agent' | 'case' | 'onboarding';
export const HOLD_KINDS: readonly HoldKind[] = ['agent', 'case', 'onboarding'];

export interface Hold {
  id: string;
  subject_kind: HoldKind;
  subject_ref: string;
  reason: string;
  set_by: string;
  set_at: number;
  released_by: string | null;
  released_at: number | null;
  release_reason: string | null;
}

const TABLE: Record<HoldKind, string> = {
  agent: 'SELECT 1 FROM agents WHERE user_id = ?',
  case: 'SELECT 1 FROM cases WHERE id = ?',
  onboarding: 'SELECT 1 FROM onboardings WHERE id = ?',
};

const reasonOf = (text: unknown): string | null =>
  typeof text === 'string' && text.trim().length >= 3 ? text.trim().slice(0, 300) : null;

export async function placeHold(
  db: D1Database,
  staffId: string,
  kind: string,
  ref: string,
  reason: string,
  at: number,
): Promise<Result<{ id: string }>> {
  if (!HOLD_KINDS.includes(kind as HoldKind)) return fail('invalid_hold');
  const why = reasonOf(reason);
  if (!why) return fail('invalid_reason');
  const subject = typeof ref === 'string' ? ref.trim().slice(0, 100) : '';
  if (
    !subject ||
    !(await db
      .prepare(TABLE[kind as HoldKind])
      .bind(subject)
      .first())
  ) {
    return fail('not_found');
  }
  const open = await db
    .prepare(
      'SELECT 1 FROM legal_holds WHERE subject_kind = ? AND subject_ref = ? AND released_at IS NULL',
    )
    .bind(kind, subject)
    .first();
  if (open) return fail('already_held');
  const id = newId();
  await db.batch([
    db
      .prepare(
        `INSERT INTO legal_holds (id, subject_kind, subject_ref, reason, set_by, set_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, kind, subject, why, `staff:${staffId}`, at),
    auditStatement(db, at, `staff:${staffId}`, 'hold.placed', `${kind}:${subject}`, {
      reason: why,
    }),
  ]);
  return ok({ id });
}

export async function releaseHold(
  db: D1Database,
  staffId: string,
  id: string,
  reason: string,
  at: number,
): Promise<Result<null>> {
  const why = reasonOf(reason);
  if (!why) return fail('invalid_reason');
  const hold = await db
    .prepare(
      'SELECT subject_kind, subject_ref FROM legal_holds WHERE id = ? AND released_at IS NULL',
    )
    .bind(id)
    .first<{ subject_kind: HoldKind; subject_ref: string }>();
  if (!hold) return fail('not_found');
  await db.batch([
    db
      .prepare(
        `UPDATE legal_holds SET released_by = ?, released_at = ?, release_reason = ?
         WHERE id = ? AND released_at IS NULL`,
      )
      .bind(`staff:${staffId}`, at, why, id),
    auditStatement(
      db,
      at,
      `staff:${staffId}`,
      'hold.released',
      `${hold.subject_kind}:${hold.subject_ref}`,
      { reason: why },
    ),
  ]);
  return ok(null);
}

/** Open holds first, then the lifted ones, newest first. */
export async function listHolds(db: D1Database, limit = 200): Promise<Hold[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM legal_holds
       ORDER BY (released_at IS NOT NULL), set_at DESC LIMIT ?`,
    )
    .bind(Math.min(Math.max(limit, 1), 500))
    .all<Hold>();
  return results;
}

export async function isHeld(db: D1Database, kind: HoldKind, ref: string): Promise<boolean> {
  return Boolean(
    await db
      .prepare(
        'SELECT 1 FROM legal_holds WHERE subject_kind = ? AND subject_ref = ? AND released_at IS NULL',
      )
      .bind(kind, ref)
      .first(),
  );
}

/** For a query on `erased_files` (alias `f`): the file belongs to something under a hold. */
export const FILE_HELD = `EXISTS (SELECT 1 FROM legal_holds h WHERE h.released_at IS NULL AND (
  (h.subject_kind = 'agent' AND (
     f.file_ref IN (SELECT e.file_ref FROM evidence e JOIN claims c ON c.id = e.claim_id WHERE c.agent_id = h.subject_ref)
     OR f.file_ref IN (SELECT a.file_ref FROM agent_documents a WHERE a.agent_id = h.subject_ref)
     OR f.file_ref IN (SELECT s.file_ref FROM support_attachments s JOIN support_tickets t ON t.id = s.ticket_id
                       WHERE t.requester_kind = 'agent' AND t.requester_ref = h.subject_ref)))
  OR (h.subject_kind = 'onboarding' AND
     f.file_ref IN (SELECT d.file_ref FROM onboarding_documents d WHERE d.onboarding_id = h.subject_ref))
  OR (h.subject_kind = 'case' AND
     f.file_ref IN (SELECT e.file_ref FROM evidence e JOIN claims c ON c.id = e.claim_id
                    JOIN cases k ON k.vehicle_id = c.vehicle_id WHERE k.id = h.subject_ref))))`;

/** The same for the retention inserts, which name the claim as `c`. */
export const CLAIM_HELD = `EXISTS (SELECT 1 FROM legal_holds h WHERE h.released_at IS NULL AND (
  (h.subject_kind = 'agent' AND h.subject_ref = c.agent_id)
  OR (h.subject_kind = 'case' AND h.subject_ref IN (SELECT k.id FROM cases k WHERE k.vehicle_id = c.vehicle_id))))`;
