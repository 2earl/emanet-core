/**
 * What is deleted when (docs/DESIGN.md §19). One row per kind of data the cron removes on its own:
 * the rule in days (from the settings), how many records it would take at the next run, and how
 * many a legal hold keeps back. The conditions mirror scheduleRetention, redactClosedCasePlaces
 * and purgeArchives; a test keeps them in step.
 */
import { CLAIM_HELD } from './holds';
import { readSettings } from './settings';

const DAY = 86_400;

export interface RetentionRow {
  key:
    | 'failed_evidence'
    | 'delivered_evidence'
    | 'abandoned_documents'
    | 'partner_documents'
    | 'agent_documents'
    | 'case_places'
    | 'archive'
    | 'support';
  days: number;
  /** Records the next run takes. */
  due: number;
  /** Records past their time that a legal hold keeps. */
  held: number;
}

export interface RetentionOverview {
  rows: RetentionRow[];
  /** Files queued for deletion that Merkez has not yet removed from storage. */
  files_waiting: number;
  open_holds: number;
}

const count = async (db: D1Database, sql: string, ...binds: unknown[]): Promise<number> =>
  (
    await db
      .prepare(sql)
      .bind(...binds)
      .first<{ n: number }>()
  )?.n ?? 0;

export async function retentionOverview(db: D1Database, at: number): Promise<RetentionOverview> {
  const s = await readSettings(db);
  const failedAt = at - s.failed_claim_evidence_days * DAY;
  const keptAt = at - s.evidence_retention_days * DAY;
  const abandonedAt = at - s.abandoned_onboarding_days * DAY;
  const placesAt = at - s.place_retention_days * DAY;

  const evidence = (reason: string) => `
    SELECT count(*) AS n FROM evidence e JOIN claims c ON c.id = e.claim_id
    WHERE c.closed_at IS NOT NULL AND ${reason}
      AND NOT EXISTS (SELECT 1 FROM erased_files x WHERE x.file_ref = e.file_ref)`;
  const failedCond = `(c.close_reason != 'delivered' AND c.closed_at <= ?)`;
  const deliveredCond = `(c.close_reason = 'delivered' AND c.closed_at <= ?)`;
  const [failedAll, failedHeld, deliveredAll, deliveredHeld] = await Promise.all([
    count(db, evidence(failedCond), failedAt),
    count(db, `${evidence(failedCond)} AND ${CLAIM_HELD}`, failedAt),
    count(db, evidence(deliveredCond), keptAt),
    count(db, `${evidence(deliveredCond)} AND ${CLAIM_HELD}`, keptAt),
  ]);

  const docs = (cond: string) => `
    SELECT count(*) AS n FROM onboarding_documents d JOIN onboardings o ON o.id = d.onboarding_id
    WHERE ${cond} AND NOT EXISTS (SELECT 1 FROM erased_files x WHERE x.file_ref = d.file_ref)`;
  const heldDoc = `EXISTS (SELECT 1 FROM legal_holds h WHERE h.released_at IS NULL
    AND h.subject_kind = 'onboarding' AND h.subject_ref = o.id)`;
  const abandonedCond = `(o.status IN ('rejected', 'cancelled', 'expired') AND o.updated_at <= ?)`;
  const approvedCond = `(o.status = 'approved' AND o.updated_at <= ?)`;
  const [abAll, abHeld, apAll, apHeld] = await Promise.all([
    count(db, docs(abandonedCond), abandonedAt),
    count(db, `${docs(abandonedCond)} AND ${heldDoc}`, abandonedAt),
    count(db, docs(approvedCond), keptAt),
    count(db, `${docs(approvedCond)} AND ${heldDoc}`, keptAt),
  ]);

  const agentDocs = `
    SELECT count(*) AS n FROM agent_documents d
    WHERE d.status = 'uploaded' AND d.uploaded_at <= ?
      AND NOT EXISTS (SELECT 1 FROM erased_files x WHERE x.file_ref = d.file_ref)`;
  const [agAll, agHeld] = await Promise.all([
    count(db, agentDocs, abandonedAt),
    count(
      db,
      `${agentDocs} AND EXISTS (SELECT 1 FROM legal_holds h WHERE h.released_at IS NULL
         AND h.subject_kind = 'agent' AND h.subject_ref = d.agent_id)`,
      abandonedAt,
    ),
  ]);

  const places = `
    SELECT count(*) AS n FROM cases c
    WHERE c.status IN ('delivered', 'withdrawn', 'expired') AND c.updated_at <= ?
      AND EXISTS (SELECT 1 FROM case_places p WHERE p.case_id = c.id AND p.address != '')`;
  const [plAll, plHeld] = await Promise.all([
    count(db, places, placesAt),
    count(
      db,
      `${places} AND EXISTS (SELECT 1 FROM legal_holds h WHERE h.released_at IS NULL
         AND h.subject_kind = 'case' AND h.subject_ref = c.id)`,
      placesAt,
    ),
  ]);

  const archives = `SELECT count(*) AS n FROM erasure_archive a WHERE purged_at IS NULL AND purge_at <= ?`;
  const [arAll, arHeld] = await Promise.all([
    count(db, archives, at),
    count(
      db,
      `${archives} AND EXISTS (SELECT 1 FROM legal_holds h WHERE h.released_at IS NULL
         AND h.subject_kind = 'agent' AND h.subject_ref = a.subject_ref)`,
      at,
    ),
  ]);

  const tickets = `SELECT count(*) AS n FROM support_tickets t
    WHERE t.status = 'closed' AND t.closed_at IS NOT NULL AND t.closed_at <= ?`;
  const [suAll, suHeld] = await Promise.all([
    count(db, tickets, at - s.support_retention_days * DAY),
    count(
      db,
      `${tickets} AND t.requester_kind = 'agent' AND EXISTS (SELECT 1 FROM legal_holds h
         WHERE h.released_at IS NULL AND h.subject_kind = 'agent' AND h.subject_ref = t.requester_ref)`,
      at - s.support_retention_days * DAY,
    ),
  ]);

  const [waiting, holds] = await Promise.all([
    count(db, 'SELECT count(*) AS n FROM erased_files WHERE erased_at IS NULL'),
    count(db, 'SELECT count(*) AS n FROM legal_holds WHERE released_at IS NULL'),
  ]);

  const row = (
    key: RetentionRow['key'],
    days: number,
    all: number,
    held: number,
  ): RetentionRow => ({
    key,
    days,
    due: all - held,
    held,
  });
  return {
    rows: [
      row('failed_evidence', s.failed_claim_evidence_days, failedAll, failedHeld),
      row('delivered_evidence', s.evidence_retention_days, deliveredAll, deliveredHeld),
      row('abandoned_documents', s.abandoned_onboarding_days, abAll, abHeld),
      row('partner_documents', s.evidence_retention_days, apAll, apHeld),
      row('agent_documents', s.abandoned_onboarding_days, agAll, agHeld),
      row('case_places', s.place_retention_days, plAll, plHeld),
      row('archive', s.erasure_archive_days, arAll, arHeld),
      row('support', s.support_retention_days, suAll, suHeld),
    ],
    files_waiting: waiting,
    open_holds: holds,
  };
}
