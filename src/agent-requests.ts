/**
 * Asking an applicant, or an agent, for more (docs/DESIGN.md §6): a detail to correct, a document
 * that is missing, or another document staff want to see. Each thing asked is one request with
 * staff's words to the agent; the agent answers each in Emanet Saha, and staff accept the answer,
 * ask again or withdraw the request.
 *
 * An application that was already sent goes back to the applicant while anything is open, so they
 * can change their details; it can't be sent again, and nobody can be activated, until every
 * request is settled.
 */
import { auditStatement } from './audit';
import { fail, newId, ok, type Result } from './result';
import { ALL_DOCUMENT_KINDS, type DocumentKind } from './vetting';

export const INFO_SUBJECTS = [
  'legal_name',
  'id_number',
  'phone',
  'email',
  'address',
  'city',
  'iban',
  'tax',
  'other',
] as const;
export type InfoSubject = (typeof INFO_SUBJECTS)[number];

export interface AgentRequest {
  id: string;
  agent_id: string;
  kind: 'info' | 'document';
  subject: InfoSubject | DocumentKind;
  note: string;
  status: 'open' | 'answered' | 'accepted' | 'cancelled';
  answer: string | null;
  document_id: string | null;
  created_at: number;
  due_at: number;
  answered_at: number | null;
  closed_at: number | null;
}

export interface Ask {
  kind: string;
  subject: string;
  note: string;
}

const COLUMNS = `id, agent_id, kind, subject, note, status, answer, document_id, created_at, due_at,
  answered_at, closed_at`;

const noteOf = (value: unknown): string | null => {
  const note = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return note.length >= 5 && note.length <= 300 ? note : null;
};

/**
 * Staff ask for one or more things at once. A sent application returns to the applicant; an
 * active agent keeps working and answers alongside.
 */
export async function askAgent(
  db: D1Database,
  staffId: string,
  agentId: string,
  asks: readonly Ask[],
  days: number,
  at: number,
): Promise<Result<{ ids: string[]; returned: boolean; notes: string[] }>> {
  if (asks.length === 0 || asks.length > 10) return fail('invalid_request');
  const clean: { kind: 'info' | 'document'; subject: string; note: string }[] = [];
  for (const ask of asks) {
    const note = noteOf(ask.note);
    if (!note) return fail('invalid_reason');
    if (ask.kind === 'info' && (INFO_SUBJECTS as readonly string[]).includes(ask.subject)) {
      clean.push({ kind: 'info', subject: ask.subject, note });
    } else if (
      ask.kind === 'document' &&
      (ALL_DOCUMENT_KINDS as readonly string[]).includes(ask.subject)
    ) {
      clean.push({ kind: 'document', subject: ask.subject, note });
    } else {
      return fail('invalid_request');
    }
  }
  const agent = await db
    .prepare('SELECT status, erased_at FROM agents WHERE user_id = ?')
    .bind(agentId)
    .first<{ status: string; erased_at: number | null }>();
  if (!agent || agent.erased_at !== null) return fail('not_found');
  if (agent.status === 'banned') return fail('agent_not_active');
  const returned = agent.status === 'kyc_pending';
  const ids = clean.map(() => newId());
  const due = at + Math.max(1, days) * 86_400;
  await db.batch([
    ...clean.map((ask, i) =>
      db
        .prepare(
          `INSERT INTO agent_requests (id, agent_id, kind, subject, note, created_by, created_at, due_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(ids[i], agentId, ask.kind, ask.subject, ask.note, staffId, at, due),
    ),
    ...(returned
      ? [
          db
            .prepare(
              `UPDATE agents SET status = 'applied', review_note = ?, updated_at = ?
               WHERE user_id = ? AND status = 'kyc_pending'`,
            )
            .bind(
              clean
                .map((ask) => ask.note)
                .join(' · ')
                .slice(0, 300),
              at,
              agentId,
            ),
        ]
      : []),
    auditStatement(db, at, `staff:${staffId}`, 'agent.asked', `agent:${agentId}`, {
      asked: clean.map((ask) => `${ask.kind}:${ask.subject}`),
      returned,
    }),
  ]);
  return ok({ ids, returned, notes: clean.map((ask) => ask.note) });
}

/** An agent's requests, the unsettled ones first. */
export async function requestsOf(db: D1Database, agentId: string): Promise<AgentRequest[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM agent_requests WHERE agent_id = ?
       ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END, created_at DESC
       LIMIT 100`,
    )
    .bind(agentId)
    .all<AgentRequest>();
  return results;
}

/** How many of an agent's requests wait for the agent, and how many for staff. */
export async function pendingRequests(
  db: D1Database,
  agentId: string,
): Promise<{ open: number; answered: number }> {
  const row = await db
    .prepare(
      `SELECT coalesce(sum(status = 'open'), 0) AS open, coalesce(sum(status = 'answered'), 0) AS answered
       FROM agent_requests WHERE agent_id = ?`,
    )
    .bind(agentId)
    .first<{ open: number; answered: number }>();
  return row ?? { open: 0, answered: 0 };
}

/**
 * The agent says a detail is corrected, with a few words if they want. A document request is
 * answered by the upload itself (src/vetting.ts), never here.
 */
export async function answerRequest(
  db: D1Database,
  agentId: string,
  requestId: string,
  answer: string,
  at: number,
): Promise<Result<null>> {
  const words = typeof answer === 'string' ? answer.trim().replace(/\s+/g, ' ').slice(0, 500) : '';
  const request = await db
    .prepare('SELECT kind, subject FROM agent_requests WHERE id = ? AND agent_id = ?')
    .bind(requestId, agentId)
    .first<{ kind: string; subject: string }>();
  if (!request) return fail('not_found');
  if (request.kind !== 'info') return fail('document_needed');
  // "Something else" has nothing to change in the profile: the answer is the words.
  if (request.subject === 'other' && words.length < 2) return fail('answer_needed');
  const results = await db.batch([
    db
      .prepare(
        `UPDATE agent_requests SET status = 'answered', answer = ?, answered_at = ?
         WHERE id = ? AND agent_id = ? AND status = 'open'`,
      )
      .bind(words || null, at, requestId, agentId),
    auditStatement(db, at, `agent:${agentId}`, 'agent.request_answered', `agent:${agentId}`, {
      request: requestId,
    }),
  ]);
  return results[0]?.meta.changes === 1 ? ok(null) : fail('request_not_open');
}

/** Staff accept an answer, or withdraw a request they no longer need. */
export async function settleRequest(
  db: D1Database,
  staffId: string,
  requestId: string,
  status: string,
  at: number,
): Promise<Result<{ agent_id: string }>> {
  if (status !== 'accepted' && status !== 'cancelled') return fail('invalid_request');
  const request = await db
    .prepare('SELECT agent_id, status FROM agent_requests WHERE id = ?')
    .bind(requestId)
    .first<{ agent_id: string; status: string }>();
  if (!request) return fail('not_found');
  // Only an answer can be accepted; anything unsettled can be withdrawn.
  const from = status === 'accepted' ? ['answered'] : ['open', 'answered'];
  if (!from.includes(request.status)) return fail('request_not_open');
  const results = await db.batch([
    db
      .prepare(
        `UPDATE agent_requests SET status = ?, closed_by = ?, closed_at = ?
         WHERE id = ? AND status IN ('open', 'answered')`,
      )
      .bind(status, staffId, at, requestId),
    auditStatement(
      db,
      at,
      `staff:${staffId}`,
      `agent.request_${status}`,
      `agent:${request.agent_id}`,
      {
        request: requestId,
      },
    ),
  ]);
  return results[0]?.meta.changes === 1
    ? ok({ agent_id: request.agent_id })
    : fail('conflict_retry');
}

/** The answer doesn't settle it: the request is open again, with what is still missing. */
export async function askAgain(
  db: D1Database,
  staffId: string,
  requestId: string,
  note: string,
  days: number,
  at: number,
): Promise<Result<{ agent_id: string; note: string }>> {
  const words = noteOf(note);
  if (!words) return fail('invalid_reason');
  const request = await db
    .prepare('SELECT agent_id FROM agent_requests WHERE id = ?')
    .bind(requestId)
    .first<{ agent_id: string }>();
  if (!request) return fail('not_found');
  const results = await db.batch([
    db
      .prepare(
        `UPDATE agent_requests SET status = 'open', note = ?, answer = NULL, answered_at = NULL, due_at = ?
         WHERE id = ? AND status = 'answered'`,
      )
      .bind(words, at + Math.max(1, days) * 86_400, requestId),
    auditStatement(db, at, `staff:${staffId}`, 'agent.asked_again', `agent:${request.agent_id}`, {
      request: requestId,
    }),
  ]);
  return results[0]?.meta.changes === 1
    ? ok({ agent_id: request.agent_id, note: words })
    : fail('request_not_open');
}

export interface AnsweredRequest {
  id: string;
  agent_id: string;
  legal_name: string | null;
  agent_status: string;
  kind: 'info' | 'document';
  subject: string;
  answered_at: number;
}

/** Answers waiting for staff, oldest first: for the Today page. */
export async function answeredRequests(db: D1Database, limit = 50): Promise<AnsweredRequest[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.agent_id, a.legal_name, a.status AS agent_status, r.kind, r.subject, r.answered_at
       FROM agent_requests r JOIN agents a ON a.user_id = r.agent_id
       WHERE r.status = 'answered' ORDER BY r.answered_at LIMIT ?`,
    )
    .bind(Math.min(Math.max(limit, 1), 200))
    .all<AnsweredRequest>();
  return results;
}

/** A reminder goes out this long before an open request's time limit. */
const REMIND_BEFORE = 3 * 86_400;

/**
 * Reminds each agent once, a few days before the time limit, of the requests still waiting for
 * them. The request is marked first, so a failing mail is never sent twice. Returns the number of
 * agents reminded.
 */
export async function remindRequests(
  db: D1Database,
  send: (agentId: string, items: string[], daysLeft: number) => Promise<boolean>,
  at: number,
): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.agent_id, r.note, r.due_at FROM agent_requests r
       JOIN agents a ON a.user_id = r.agent_id
       WHERE r.status = 'open' AND r.reminded_at IS NULL AND r.due_at > ? AND r.due_at <= ?
         AND a.erased_at IS NULL
       ORDER BY r.agent_id, r.created_at LIMIT 200`,
    )
    .bind(at, at + REMIND_BEFORE)
    .all<{ id: string; agent_id: string; note: string; due_at: number }>();
  const byAgent = new Map<string, { notes: string[]; due: number; ids: string[] }>();
  for (const row of results) {
    const entry = byAgent.get(row.agent_id) ?? { notes: [], due: row.due_at, ids: [] };
    entry.notes.push(row.note);
    entry.ids.push(row.id);
    entry.due = Math.min(entry.due, row.due_at);
    byAgent.set(row.agent_id, entry);
  }
  let reminded = 0;
  for (const [agentId, entry] of byAgent) {
    const marked = await db.batch(
      entry.ids.map((id) =>
        db
          .prepare(
            `UPDATE agent_requests SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL AND status = 'open'`,
          )
          .bind(at, id),
      ),
    );
    if (marked.some((result) => result.meta.changes !== 1)) continue;
    const daysLeft = Math.max(1, Math.ceil((entry.due - at) / 86_400));
    if (await send(agentId, entry.notes, daysLeft)) reminded++;
  }
  return reminded;
}
