/**
 * The support desk (docs/DESIGN.md §20). Agents (Emanet Saha) and companies (Emanet Kurumsal)
 * write to 2earl; staff answer in Emanet Merkez. A ticket is one question with a thread of
 * messages; staff can add notes the requester never sees. A ticket is `open` while it waits for
 * staff, `answered` while it waits for the requester, and `closed` when done.
 *
 * It holds what people wrote, so it has a retention period (`support_retention_days` after it
 * closes) and a legal hold on an agent keeps their tickets. No attachments yet: a photo or a
 * document goes through the flows that already protect them (requests, evidence).
 */
import { auditStatement } from './audit';
import { fail, newId, ok, type Result } from './result';
import { readSettings } from './settings';

const DAY = 86_400;

export type RequesterKind = 'agent' | 'partner';
export type TicketStatus = 'open' | 'answered' | 'closed';

export const CATEGORIES: Record<RequesterKind, readonly string[]> = {
  agent: ['payment', 'delivery', 'account', 'technical', 'other'],
  partner: ['case', 'invoice', 'integration', 'account', 'other'],
};

/** Open or answered tickets one requester may have at the same time. */
export const OPEN_LIMIT = 5;
/** A closed ticket can still be answered for this long; after that, open a new one. */
export const REOPEN_DAYS = 30;

export interface Ticket {
  id: string;
  requester_kind: RequesterKind;
  requester_ref: string;
  subject: string;
  category: string;
  status: TicketStatus;
  created_at: number;
  updated_at: number;
  first_response_at: number | null;
  closed_at: number | null;
}

export interface TicketMessage {
  id: string;
  author_kind: 'requester' | 'staff' | 'note';
  body: string;
  created_at: number;
}

export interface TicketThread {
  ticket: Ticket;
  messages: TicketMessage[];
}

const text = (value: unknown, min: number, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/\r\n/g, '\n').trim();
  return clean.length >= min && clean.length <= max ? clean : null;
};

const COLUMNS = `id, requester_kind, requester_ref, subject, category, status, created_at, updated_at,
  first_response_at, closed_at`;

export async function openTicket(
  db: D1Database,
  kind: RequesterKind,
  ref: string,
  userId: string,
  input: { subject: string; category: string; message: string },
  at: number,
): Promise<Result<{ id: string }>> {
  const subject = text(input.subject, 3, 120);
  const message = text(input.message, 3, 4000);
  if (!subject) return fail('invalid_subject');
  if (!message) return fail('invalid_message');
  if (!CATEGORIES[kind].includes(input.category)) return fail('invalid_category');
  const open = await db
    .prepare(
      `SELECT count(*) AS n FROM support_tickets
       WHERE requester_kind = ? AND requester_ref = ? AND status != 'closed'`,
    )
    .bind(kind, ref)
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= OPEN_LIMIT) return fail('too_many_open');
  const id = newId();
  await db.batch([
    db
      .prepare(
        `INSERT INTO support_tickets (id, requester_kind, requester_ref, opened_by, subject, category, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, kind, ref, userId, subject, input.category, at, at),
    db
      .prepare(
        `INSERT INTO support_messages (id, ticket_id, author_kind, author, body, created_at)
         VALUES (?, ?, 'requester', ?, ?, ?)`,
      )
      .bind(newId(), id, userId, message, at),
    auditStatement(db, at, `${kind}:${userId}`, 'support.opened', `ticket:${id}`, {
      category: input.category,
    }),
  ]);
  return ok({ id });
}

export async function myTickets(
  db: D1Database,
  kind: RequesterKind,
  ref: string,
): Promise<Ticket[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM support_tickets
       WHERE requester_kind = ? AND requester_ref = ? ORDER BY updated_at DESC LIMIT 50`,
    )
    .bind(kind, ref)
    .all<Ticket>();
  return results;
}

async function thread(
  db: D1Database,
  where: string,
  binds: unknown[],
  withNotes: boolean,
): Promise<TicketThread | null> {
  const ticket = await db
    .prepare(`SELECT ${COLUMNS} FROM support_tickets WHERE ${where}`)
    .bind(...binds)
    .first<Ticket>();
  if (!ticket) return null;
  const { results } = await db
    .prepare(
      `SELECT id, author_kind, body, created_at FROM support_messages
       WHERE ticket_id = ? ${withNotes ? '' : "AND author_kind != 'note'"} ORDER BY created_at, rowid`,
    )
    .bind(ticket.id)
    .all<TicketMessage>();
  return { ticket, messages: results };
}

/** A requester reads only their own ticket, and never a staff note. */
export async function myTicket(
  db: D1Database,
  kind: RequesterKind,
  ref: string,
  id: string,
): Promise<Result<TicketThread>> {
  const found = await thread(
    db,
    'id = ? AND requester_kind = ? AND requester_ref = ?',
    [id, kind, ref],
    false,
  );
  return found ? ok(found) : fail('not_found');
}

export async function replyAsRequester(
  db: D1Database,
  kind: RequesterKind,
  ref: string,
  userId: string,
  id: string,
  body: string,
  at: number,
): Promise<Result<null>> {
  const message = text(body, 2, 4000);
  if (!message) return fail('invalid_message');
  const ticket = await db
    .prepare(
      'SELECT status, closed_at FROM support_tickets WHERE id = ? AND requester_kind = ? AND requester_ref = ?',
    )
    .bind(id, kind, ref)
    .first<{ status: TicketStatus; closed_at: number | null }>();
  if (!ticket) return fail('not_found');
  if (ticket.status === 'closed') {
    if (ticket.closed_at !== null && ticket.closed_at < at - REOPEN_DAYS * DAY) {
      return fail('closed_long');
    }
    const open = await db
      .prepare(
        `SELECT count(*) AS n FROM support_tickets
         WHERE requester_kind = ? AND requester_ref = ? AND status != 'closed'`,
      )
      .bind(kind, ref)
      .first<{ n: number }>();
    if ((open?.n ?? 0) >= OPEN_LIMIT) return fail('too_many_open');
  }
  await db.batch([
    db
      .prepare(
        `INSERT INTO support_messages (id, ticket_id, author_kind, author, body, created_at)
         VALUES (?, ?, 'requester', ?, ?, ?)`,
      )
      .bind(newId(), id, userId, message, at),
    db
      .prepare(
        `UPDATE support_tickets SET status = 'open', closed_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .bind(at, id),
  ]);
  return ok(null);
}

export async function closeAsRequester(
  db: D1Database,
  kind: RequesterKind,
  ref: string,
  userId: string,
  id: string,
  at: number,
): Promise<Result<null>> {
  const result = await db
    .prepare(
      `UPDATE support_tickets SET status = 'closed', closed_at = ?, updated_at = ?
       WHERE id = ? AND requester_kind = ? AND requester_ref = ? AND status != 'closed'`,
    )
    .bind(at, at, id, kind, ref)
    .run();
  if (result.meta.changes === 0) return fail('not_found');
  await auditStatement(db, at, `${kind}:${userId}`, 'support.closed', `ticket:${id}`).run();
  return ok(null);
}

// ---- Staff -----------------------------------------------------------------------------------

export interface TicketRow extends Ticket {
  assigned_to: string | null;
  /** Who is asking: an agent's name, or a company's. */
  who: string | null;
  messages: number;
}

export async function staffTickets(
  db: D1Database,
  filter: { status?: TicketStatus | 'active'; kind?: RequesterKind; mine?: string } = {},
): Promise<TicketRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (filter.status === 'active') where.push(`t.status != 'closed'`);
  else if (filter.status) {
    where.push('t.status = ?');
    binds.push(filter.status);
  }
  if (filter.kind) {
    where.push('t.requester_kind = ?');
    binds.push(filter.kind);
  }
  if (filter.mine) {
    where.push('t.assigned_to = ?');
    binds.push(filter.mine);
  }
  const { results } = await db
    .prepare(
      `SELECT t.id, t.requester_kind, t.requester_ref, t.subject, t.category, t.status, t.created_at,
              t.updated_at, t.first_response_at, t.closed_at, t.assigned_to,
              CASE t.requester_kind
                WHEN 'agent' THEN (SELECT legal_name FROM agents a WHERE a.user_id = t.requester_ref)
                ELSE (SELECT legal_name FROM partners p WHERE p.id = t.requester_ref) END AS who,
              (SELECT count(*) FROM support_messages m WHERE m.ticket_id = t.id AND m.author_kind != 'note') AS messages
       FROM support_tickets t ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY (t.status = 'closed'), (t.status = 'answered'), t.updated_at LIMIT 200`,
    )
    .bind(...binds)
    .all<TicketRow>();
  return results;
}

export interface StaffThread extends TicketThread {
  ticket: Ticket & { assigned_to: string | null; who: string | null };
}

export async function staffTicket(db: D1Database, id: string): Promise<Result<StaffThread>> {
  const found = await thread(db, 'id = ?', [id], true);
  if (!found) return fail('not_found');
  const extra = await db
    .prepare(
      `SELECT assigned_to,
              CASE requester_kind
                WHEN 'agent' THEN (SELECT legal_name FROM agents a WHERE a.user_id = requester_ref)
                ELSE (SELECT legal_name FROM partners p WHERE p.id = requester_ref) END AS who
       FROM support_tickets WHERE id = ?`,
    )
    .bind(id)
    .first<{ assigned_to: string | null; who: string | null }>();
  return ok({
    ticket: { ...found.ticket, assigned_to: extra?.assigned_to ?? null, who: extra?.who ?? null },
    messages: found.messages,
  });
}

export async function staffReply(
  db: D1Database,
  staffId: string,
  id: string,
  body: string,
  note: boolean,
  at: number,
): Promise<Result<{ notify: boolean }>> {
  const message = text(body, 2, 4000);
  if (!message) return fail('invalid_message');
  const ticket = await db
    .prepare('SELECT status FROM support_tickets WHERE id = ?')
    .bind(id)
    .first<{ status: TicketStatus }>();
  if (!ticket) return fail('not_found');
  const statements = [
    db
      .prepare(
        `INSERT INTO support_messages (id, ticket_id, author_kind, author, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(newId(), id, note ? 'note' : 'staff', staffId, message, at),
  ];
  if (!note) {
    statements.push(
      db
        .prepare(
          `UPDATE support_tickets SET status = 'answered', closed_at = NULL, updated_at = ?,
             first_response_at = coalesce(first_response_at, ?),
             assigned_to = coalesce(assigned_to, ?) WHERE id = ?`,
        )
        .bind(at, at, staffId, id),
      auditStatement(db, at, `staff:${staffId}`, 'support.replied', `ticket:${id}`),
    );
  }
  await db.batch(statements);
  return ok({ notify: !note });
}

export async function assignTicket(
  db: D1Database,
  staffId: string,
  id: string,
  to: string | null,
  at: number,
): Promise<Result<null>> {
  const result = await db
    .prepare('UPDATE support_tickets SET assigned_to = ? WHERE id = ?')
    .bind(to, id)
    .run();
  if (result.meta.changes === 0) return fail('not_found');
  await auditStatement(db, at, `staff:${staffId}`, 'support.assigned', `ticket:${id}`, {
    to,
  }).run();
  return ok(null);
}

export async function setTicketStatus(
  db: D1Database,
  staffId: string,
  id: string,
  closed: boolean,
  at: number,
): Promise<Result<null>> {
  const result = await db
    .prepare(
      closed
        ? `UPDATE support_tickets SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ? AND status != 'closed'`
        : `UPDATE support_tickets SET status = 'open', closed_at = NULL, updated_at = ? WHERE id = ? AND status = 'closed'`,
    )
    .bind(...(closed ? [at, at, id] : [at, id]))
    .run();
  if (result.meta.changes === 0) return fail('not_found');
  await auditStatement(
    db,
    at,
    `staff:${staffId}`,
    closed ? 'support.closed' : 'support.reopened',
    `ticket:${id}`,
  ).run();
  return ok(null);
}

/** Where to write back to a requester: their verified address and language, or null. */
export async function requesterContact(
  db: D1Database,
  ticketId: string,
): Promise<{ kind: RequesterKind; email: string; locale: 'tr' | 'en' } | null> {
  const t = await db
    .prepare('SELECT requester_kind, requester_ref FROM support_tickets WHERE id = ?')
    .bind(ticketId)
    .first<{ requester_kind: RequesterKind; requester_ref: string }>();
  if (!t) return null;
  if (t.requester_kind === 'agent') {
    const a = await db
      .prepare('SELECT email, email_verified_at, locale FROM agents WHERE user_id = ?')
      .bind(t.requester_ref)
      .first<{ email: string | null; email_verified_at: number | null; locale: string }>();
    return a?.email && a.email_verified_at !== null
      ? { kind: 'agent', email: a.email, locale: a.locale === 'en' ? 'en' : 'tr' }
      : null;
  }
  const p = await db
    .prepare('SELECT contact_email FROM partners WHERE id = ?')
    .bind(t.requester_ref)
    .first<{ contact_email: string | null }>();
  return p?.contact_email ? { kind: 'partner', email: p.contact_email, locale: 'tr' } : null;
}

/** Cron: a ticket closed longer ago than the retention period is deleted, unless a hold keeps it. */
export async function purgeSupport(db: D1Database, at: number): Promise<number> {
  const cutoff = at - (await readSettings(db)).support_retention_days * DAY;
  const due = `closed_at IS NOT NULL AND closed_at <= ${String(cutoff)}
    AND NOT (requester_kind = 'agent' AND EXISTS (SELECT 1 FROM legal_holds h WHERE h.released_at IS NULL
      AND h.subject_kind = 'agent' AND h.subject_ref = support_tickets.requester_ref))`;
  const count = await db
    .prepare(`SELECT count(*) AS n FROM support_tickets WHERE status = 'closed' AND ${due}`)
    .first<{ n: number }>();
  const n = count?.n ?? 0;
  if (n === 0) return 0;
  await db.batch([
    db.prepare(
      `DELETE FROM support_messages WHERE ticket_id IN
         (SELECT id FROM support_tickets WHERE status = 'closed' AND ${due} ORDER BY id LIMIT 500)`,
    ),
    db.prepare(
      `DELETE FROM support_tickets WHERE id IN
         (SELECT id FROM support_tickets WHERE status = 'closed' AND ${due} ORDER BY id LIMIT 500)`,
    ),
    auditStatement(db, at, 'system', 'retention.support_purged', 'support_tickets', { tickets: n }),
  ]);
  return n;
}
