import { newId } from './result';

/** One row of the append-only audit log, as a statement to batch with the change it records. */
export function auditStatement(
  db: D1Database,
  at: number,
  actor: string,
  action: string,
  subject: string,
  detail: Record<string, unknown> = {},
): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO audit_events (id, at, actor, action, subject, detail) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(newId(), at, actor, action, subject, JSON.stringify(detail));
}

/** An event for a partner's webhooks and polling, batched with the change it reports. */
export function outboxStatement(
  db: D1Database,
  at: number,
  partnerId: string,
  type: string,
  payload: Record<string, unknown>,
): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO outbox (id, partner_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(newId(), partnerId, type, JSON.stringify(payload), at);
}
