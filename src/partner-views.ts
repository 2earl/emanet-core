/**
 * What a partner sees beyond its cases (docs/DESIGN.md §5, Emanet Kurumsal): each case's timeline
 * (states and times only), the custody documents of a delivered vehicle, its invoices, and a
 * monthly report. Never an agent's identity.
 */
import { auditStatement } from './audit';
import type { Partner } from './cases';
import { fail, ok, type Result } from './result';

// ---- Timeline -----------------------------------------------------------------------------------

export type TimelineEvent =
  | 'created'
  | 'updated'
  | 'identity_accepted'
  | 'identity_rejected'
  | 'withdrawn'
  | 'expired'
  | 'delivered';

const TIMELINE_ACTIONS: Record<string, TimelineEvent> = {
  'case.created': 'created',
  'case.updated': 'updated',
  'identity.accepted': 'identity_accepted',
  'identity.rejected': 'identity_rejected',
  'case.rejected': 'identity_rejected',
  'case.withdrawn': 'withdrawn',
  'case.expired': 'expired',
  'case.delivered': 'delivered',
};

/** A case's history from the audit log: what happened and when, never who on 2earl's side. */
export async function timeline(
  db: D1Database,
  partner: Partner,
  caseId: string,
): Promise<Result<{ event: TimelineEvent; at: number }[]>> {
  const owned = await db
    .prepare('SELECT 1 AS yes FROM cases WHERE id = ? AND partner_id = ?')
    .bind(caseId, partner.id)
    .first();
  if (!owned) return fail('not_found');
  // What the core records about the case, and what it told the partner (webhook events).
  const actions = Object.keys(TIMELINE_ACTIONS);
  const [audit, outbox] = await db.batch([
    db
      .prepare(
        `SELECT action, at FROM audit_events WHERE subject = ? AND action IN (${actions
          .map(() => '?')
          .join(', ')}) LIMIT 200`,
      )
      .bind(`case:${caseId}`, ...actions),
    db
      .prepare(
        `SELECT type AS action, created_at AS at FROM outbox
         WHERE partner_id = ? AND json_extract(payload, '$.case_id') = ? LIMIT 200`,
      )
      .bind(partner.id, caseId),
  ]);
  const seen = new Set<string>();
  const events: { event: TimelineEvent; at: number }[] = [];
  for (const r of [...(audit?.results ?? []), ...(outbox?.results ?? [])] as {
    action: string;
    at: number;
  }[]) {
    const event = TIMELINE_ACTIONS[r.action];
    const key = `${String(event)}@${String(r.at)}`;
    if (!event || seen.has(key)) continue;
    seen.add(key);
    events.push({ event, at: r.at });
  }
  return ok(events.sort((a, b) => a.at - b.at));
}

// ---- Custody documents --------------------------------------------------------------------------

export interface CaseDocument {
  id: string;
  kind: 'scene' | 'police_report' | 'tow_report' | 'yediemin_receipt' | 'yediemin_vehicle';
  sha256: string;
  taken_at: number | null;
  created_at: number;
}

/** The claim that delivered the case's vehicle: closed as delivered when the case was. */
async function deliveringClaim(
  db: D1Database,
  partner: Partner,
  caseId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT cl.id FROM cases c
       JOIN claims cl ON cl.vehicle_id = c.vehicle_id AND cl.close_reason = 'delivered'
         AND cl.closed_at = c.delivered_at
       WHERE c.id = ? AND c.partner_id = ? AND c.status = 'delivered'`,
    )
    .bind(caseId, partner.id)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** The documents and photos staff accepted for a delivered case: the partner's proof of custody. */
export async function caseDocuments(
  db: D1Database,
  partner: Partner,
  caseId: string,
): Promise<Result<CaseDocument[]>> {
  const claimId = await deliveringClaim(db, partner, caseId);
  if (!claimId) return ok([]);
  const { results } = await db
    .prepare(
      `SELECT id, kind, sha256, exif_time AS taken_at, created_at FROM evidence
       WHERE claim_id = ? AND status = 'accepted'
         AND file_ref NOT IN (SELECT file_ref FROM erased_files) ORDER BY created_at`,
    )
    .bind(claimId)
    .all<CaseDocument>();
  return ok(results);
}

/** Where one document is stored, for the partner's app to stream it; every look is recorded. */
export async function caseDocument(
  db: D1Database,
  partner: Partner,
  actor: string,
  caseId: string,
  documentId: string,
  at: number,
): Promise<Result<{ file_ref: string; kind: CaseDocument['kind'] }>> {
  const claimId = await deliveringClaim(db, partner, caseId);
  if (!claimId) return fail('not_found');
  const row = await db
    .prepare(
      `SELECT file_ref, kind FROM evidence WHERE id = ? AND claim_id = ? AND status = 'accepted'
         AND file_ref NOT IN (SELECT file_ref FROM erased_files)`,
    )
    .bind(documentId, claimId)
    .first<{ file_ref: string; kind: CaseDocument['kind'] }>();
  if (!row) return fail('not_found');
  await auditStatement(db, at, actor, 'case.document_viewed', `case:${caseId}`, {
    document: documentId,
  }).run();
  return ok(row);
}

// ---- Invoices -----------------------------------------------------------------------------------

export interface PartnerInvoice {
  id: string;
  number: string | null;
  issued_at: number;
  net_kurus: number;
  kdv_kurus: number;
  total_kurus: number;
  paid_kurus: number;
  status: 'issued' | 'paid' | 'cancelled';
  cases: number;
}

export async function invoices(
  db: D1Database,
  partner: Partner,
): Promise<Result<PartnerInvoice[]>> {
  const { results } = await db
    .prepare(
      `SELECT i.id, i.number, i.issued_at, i.net_kurus, i.kdv_kurus, i.total_kurus, i.paid_kurus,
         i.status, (SELECT count(*) FROM invoice_lines l WHERE l.invoice_id = i.id) AS cases
       FROM invoices i WHERE i.partner_id = ? ORDER BY i.issued_at DESC LIMIT 500`,
    )
    .bind(partner.id)
    .all<PartnerInvoice>();
  return ok(results);
}

export interface InvoiceLine {
  case_id: string;
  external_ref: string;
  plate: string | null;
  delivered_at: number | null;
  net_kurus: number;
  kdv_kurus: number;
}

export async function invoice(
  db: D1Database,
  partner: Partner,
  invoiceId: string,
): Promise<Result<PartnerInvoice & { lines: InvoiceLine[] }>> {
  const head = await db
    .prepare(
      `SELECT i.id, i.number, i.issued_at, i.net_kurus, i.kdv_kurus, i.total_kurus, i.paid_kurus,
         i.status, (SELECT count(*) FROM invoice_lines l WHERE l.invoice_id = i.id) AS cases
       FROM invoices i WHERE i.id = ? AND i.partner_id = ?`,
    )
    .bind(invoiceId, partner.id)
    .first<PartnerInvoice>();
  if (!head) return fail('not_found');
  const { results } = await db
    .prepare(
      `SELECT l.case_id, c.external_ref, json_extract(c.vehicle_snapshot, '$.plate') AS plate,
         c.delivered_at, l.net_kurus, l.kdv_kurus
       FROM invoice_lines l JOIN cases c ON c.id = l.case_id
       WHERE l.invoice_id = ? ORDER BY c.delivered_at`,
    )
    .bind(invoiceId)
    .all<InvoiceLine>();
  return ok({ ...head, lines: results });
}

// ---- Report -------------------------------------------------------------------------------------

export interface ReportMonth {
  /** YYYY-MM, Turkey time. */
  month: string;
  added: number;
  delivered: number;
  withdrawn: number;
  expired: number;
  fees_kurus: number;
  /** Mean days from a case being added to its vehicle reaching custody; null without deliveries. */
  days_to_custody: number | null;
}

export interface Report {
  months: ReportMonth[];
  open: number;
  delivered_total: number;
  /** Delivered ÷ (delivered + withdrawn + expired), over the whole period; null if none closed. */
  recovery_rate: number | null;
  by_city: { city: string; open: number; delivered: number }[];
}

/** Twelve months to `at`, by month, plus where open and delivered cases are. */
export async function report(
  db: D1Database,
  partner: Partner,
  at: number,
): Promise<Result<Report>> {
  const since = at - 366 * 86_400;
  // Turkey is UTC+3 all year.
  const month = (column: string) => `strftime('%Y-%m', ${column} + 10800, 'unixepoch')`;
  const [added, closed, open, cities] = await db.batch([
    db
      .prepare(
        `SELECT ${month('created_at')} AS month, count(*) AS n FROM cases
         WHERE partner_id = ? AND created_at >= ? GROUP BY month`,
      )
      .bind(partner.id, since),
    db
      .prepare(
        `SELECT ${month('COALESCE(delivered_at, updated_at)')} AS month, status, count(*) AS n,
           sum(CASE WHEN status = 'delivered' THEN fee_kurus ELSE 0 END) AS fees,
           avg(CASE WHEN status = 'delivered' THEN (delivered_at - created_at) / 86400.0 END) AS days
         FROM cases WHERE partner_id = ? AND COALESCE(delivered_at, updated_at) >= ?
           AND status IN ('delivered', 'withdrawn', 'expired')
         GROUP BY month, status`,
      )
      .bind(partner.id, since),
    db
      .prepare(
        `SELECT count(*) AS n FROM cases WHERE partner_id = ? AND status IN ('active', 'pending_identity')`,
      )
      .bind(partner.id),
    db
      .prepare(
        `SELECT city, sum(open) AS open, sum(delivered) AS delivered FROM (
           SELECT (SELECT p.city FROM case_places p WHERE p.case_id = c.id ORDER BY p.rowid LIMIT 1) AS city,
             CASE WHEN c.status IN ('active', 'pending_identity') THEN 1 ELSE 0 END AS open,
             CASE WHEN c.status = 'delivered' THEN 1 ELSE 0 END AS delivered
           FROM cases c WHERE c.partner_id = ? AND (c.status IN ('active', 'pending_identity')
             OR (c.status = 'delivered' AND c.delivered_at >= ?))
         ) WHERE city IS NOT NULL GROUP BY city ORDER BY open + delivered DESC LIMIT 20`,
      )
      .bind(partner.id, since),
  ]);
  const months = new Map<string, ReportMonth>();
  const get = (m: string) => {
    let row = months.get(m);
    if (!row) {
      row = {
        month: m,
        added: 0,
        delivered: 0,
        withdrawn: 0,
        expired: 0,
        fees_kurus: 0,
        days_to_custody: null,
      };
      months.set(m, row);
    }
    return row;
  };
  for (const r of (added?.results ?? []) as { month: string; n: number }[])
    get(r.month).added = r.n;
  let delivered = 0;
  let closedTotal = 0;
  for (const r of (closed?.results ?? []) as {
    month: string;
    status: 'delivered' | 'withdrawn' | 'expired';
    n: number;
    fees: number;
    days: number | null;
  }[]) {
    const row = get(r.month);
    row[r.status] = r.n;
    closedTotal += r.n;
    if (r.status === 'delivered') {
      delivered += r.n;
      row.fees_kurus = r.fees;
      row.days_to_custody = r.days === null ? null : Math.round(r.days * 10) / 10;
    }
  }
  return ok({
    months: [...months.values()].sort((a, b) => b.month.localeCompare(a.month)),
    open: ((open?.results ?? [])[0] as { n: number } | undefined)?.n ?? 0,
    delivered_total: delivered,
    recovery_rate: closedTotal ? Math.round((delivered / closedTotal) * 1000) / 1000 : null,
    by_city: (cities?.results ?? []) as Report['by_city'],
  });
}
