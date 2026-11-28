/**
 * Telling staff something happened that they should be able to notice (docs/DESIGN.md §14): a
 * sealed archive record or file was opened. The opening is already in the audit log; this makes
 * sure someone looks. Sending never fails what it reports.
 */
import { archiveOpenedMail, lateRequestsMail, type Send } from './mail';

export async function archiveOpenedNotice(
  send: Send,
  to: string,
  merkez: string,
  what: { kind: 'record' | 'file'; staffId: string; archiveId: string; at: number },
): Promise<boolean> {
  try {
    return await send(archiveOpenedMail(to, what, `${merkez}/privacy/archive/${what.archiveId}`));
  } catch {
    return false;
  }
}

const DAY = 86_400;

/**
 * Once a day: how many requests to agents are past their time limit, and how many answers have
 * waited for staff more than two days. Nothing is sent when both are zero.
 */
export async function lateRequestsNotice(
  db: D1Database,
  send: Send,
  to: string,
  merkez: string,
  at: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT
         coalesce(sum(r.status = 'open' AND r.due_at < ?), 0) AS late,
         coalesce(sum(r.status = 'answered' AND r.answered_at < ?), 0) AS unanswered
       FROM agent_requests r JOIN agents a ON a.user_id = r.agent_id
       WHERE a.erased_at IS NULL AND r.status IN ('open', 'answered')`,
    )
    .bind(at, at - 2 * DAY)
    .first<{ late: number; unanswered: number }>();
  const counts = row ?? { late: 0, unanswered: 0 };
  if (counts.late + counts.unanswered === 0) return 0;
  return (await send(lateRequestsMail(to, counts, `${merkez}/agents`))) ? 1 : 0;
}

/** Nine in the morning in Istanbul, give or take the five minutes between two runs of the cron. */
export const isDigestTime = (at: number): boolean => {
  const secondsIntoDay = at % DAY;
  return secondsIntoDay >= 6 * 3600 && secondsIntoDay < 6 * 3600 + 300;
};
