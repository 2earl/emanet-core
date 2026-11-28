/**
 * The accountant's month (docs/DESIGN.md §4.6): everything booked in one calendar month of Turkey
 * time, in the shape an accountant enters into their own system. Sales invoices with the buyer's
 * tax details; receipts; payments to agents with what the payment document needs (name, ID
 * number, address, gross, withholding, net); and the journal, line by line, with account codes
 * from the Uniform Chart of Accounts. Nothing here changes anything.
 */
import { auditStatement } from './audit';
import { open } from './pii';
import { fail, ok, type Result } from './result';

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const TR_OFFSET = 3 * 3600;

/** The first second of a Turkey-time month and of the next, in Unix time. */
export function monthBounds(month: string): [number, number] | null {
  const m = MONTH.exec(month);
  if (!m) return null;
  const year = Number(m[1]);
  const index = Number(m[2]) - 1;
  return [
    Date.UTC(year, index, 1) / 1000 - TR_OFFSET,
    Date.UTC(year, index + 1, 1) / 1000 - TR_OFFSET,
  ];
}

export const monthOf = (unix: number) =>
  new Date((unix + TR_OFFSET) * 1000).toISOString().slice(0, 7);

export interface AccountingMonth {
  month: string;
  closed: { by: string; at: number } | null;
  invoices: {
    id: string;
    number: string | null;
    issued_at: number;
    partner: string;
    vkn: string | null;
    tax_office: string | null;
    net_kurus: number;
    kdv_kurus: number;
    total_kurus: number;
    status: string;
    cases: number;
  }[];
  receipts: {
    id: string;
    value_date: string;
    partner: string;
    amount_kurus: number;
    bank_ref: string;
    invoice_number: string | null;
  }[];
  /** Payments sent in the month: the month their withholding is declared for. */
  payouts: {
    id: string;
    paid_at: number;
    agent_id: string;
    name: string | null;
    tckn: string | null;
    address: string | null;
    tax_profile: string;
    vkn: string | null;
    iban: string | null;
    gross_kurus: number;
    withholding_kurus: number;
    net_kurus: number;
    bank_ref: string | null;
  }[];
  journal: {
    entry_id: string;
    occurred_at: number;
    kind: string;
    memo: string;
    ref_id: string | null;
    account_code: string;
    account_name: string;
    debit_kurus: number;
    credit_kurus: number;
  }[];
  totals: {
    invoiced_net: number;
    invoiced_kdv: number;
    received: number;
    paid_gross: number;
    withheld: number;
    paid_net: number;
    debit: number;
    credit: number;
  };
  /** Withholding by the agent's tax profile, for the withholding return. */
  withholding: {
    tax_profile: string;
    payouts: number;
    gross_kurus: number;
    withheld_kurus: number;
  }[];
  /** Agents paid in the month whose record lacks something the payment document needs. */
  incomplete: { agent_id: string; name: string | null; missing: string[] }[];
}

export async function accountingMonth(
  db: D1Database,
  staffId: string,
  month: string,
  at: number,
): Promise<Result<AccountingMonth>> {
  const bounds = monthBounds(month);
  if (!bounds) return fail('invalid_month');
  const [from, to] = bounds;
  const [invoices, receipts, payouts, journal, closed] = await db.batch([
    db
      .prepare(
        `SELECT i.id, i.number, i.issued_at, p.legal_name AS partner, p.vkn, p.tax_office,
           i.net_kurus, i.kdv_kurus, i.total_kurus, i.status,
           (SELECT count(*) FROM invoice_lines l WHERE l.invoice_id = i.id) AS cases
         FROM invoices i JOIN partners p ON p.id = i.partner_id
         WHERE i.issued_at >= ? AND i.issued_at < ? ORDER BY i.issued_at`,
      )
      .bind(from, to),
    db
      .prepare(
        `SELECT r.id, r.value_date, p.legal_name AS partner, r.amount_kurus, r.bank_ref,
           i.number AS invoice_number
         FROM receipts r JOIN partners p ON p.id = r.partner_id
         LEFT JOIN invoices i ON i.id = r.invoice_id
         WHERE r.created_at >= ? AND r.created_at < ? ORDER BY r.created_at`,
      )
      .bind(from, to),
    db
      .prepare(
        `SELECT po.id, po.updated_at AS paid_at, po.agent_id, a.legal_name AS name, a.tckn_enc,
           a.address, a.tax_profile, a.vkn, a.iban, po.gross_kurus, po.withholding_kurus,
           po.net_kurus, po.bank_ref
         FROM payouts po JOIN agents a ON a.user_id = po.agent_id
         WHERE po.status = 'sent' AND po.updated_at >= ? AND po.updated_at < ? ORDER BY po.updated_at`,
      )
      .bind(from, to),
    db
      .prepare(
        `SELECT e.id AS entry_id, e.occurred_at, e.kind, e.memo, e.ref_id, l.account_code,
           coalesce(c.name, '') AS account_name, l.debit_kurus, l.credit_kurus
         FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
         LEFT JOIN ledger_accounts c ON c.code = l.account_code
         WHERE e.occurred_at >= ? AND e.occurred_at < ? ORDER BY e.occurred_at, e.id, l.line`,
      )
      .bind(from, to),
    db
      .prepare('SELECT closed_by AS by, closed_at AS at FROM closed_months WHERE month = ?')
      .bind(month),
  ]);
  type PayoutRow = Omit<AccountingMonth['payouts'][number], 'tckn'> & { tckn_enc: string | null };
  const paid: AccountingMonth['payouts'] = [];
  for (const row of (payouts?.results ?? []) as PayoutRow[]) {
    const { tckn_enc: sealed, ...rest } = row;
    let tckn: string | null = null;
    if (sealed) {
      const opened = await open(sealed, `agent:${row.agent_id}:tckn`);
      tckn = typeof opened === 'string' ? opened : null;
    }
    paid.push({ ...rest, tckn });
  }
  const inv = (invoices?.results ?? []) as AccountingMonth['invoices'];
  const rec = (receipts?.results ?? []) as AccountingMonth['receipts'];
  const lines = (journal?.results ?? []) as AccountingMonth['journal'];
  const live = inv.filter((i) => i.status !== 'cancelled');
  const sum = <T>(rows: T[], pick: (row: T) => number) => rows.reduce((n, row) => n + pick(row), 0);
  const profiles = new Map<string, AccountingMonth['withholding'][number]>();
  for (const p of paid) {
    const row = profiles.get(p.tax_profile) ?? {
      tax_profile: p.tax_profile,
      payouts: 0,
      gross_kurus: 0,
      withheld_kurus: 0,
    };
    row.payouts++;
    row.gross_kurus += p.gross_kurus;
    row.withheld_kurus += p.withholding_kurus;
    profiles.set(p.tax_profile, row);
  }
  const incomplete = new Map<string, AccountingMonth['incomplete'][number]>();
  for (const p of paid) {
    const missing = [
      ...(p.name ? [] : ['name']),
      ...(p.tax_profile === 'individual' && !p.tckn ? ['tckn'] : []),
      ...(p.tax_profile !== 'individual' && !p.vkn ? ['vkn'] : []),
      ...(p.address ? [] : ['address']),
    ];
    if (missing.length > 0)
      incomplete.set(p.agent_id, { agent_id: p.agent_id, name: p.name, missing });
  }
  // Opening ID numbers is itself recorded: who took which month.
  await auditStatement(db, at, `staff:${staffId}`, 'accounting.month_read', `month:${month}`, {
    payouts: paid.length,
  }).run();
  return ok({
    month,
    closed: ((closed?.results ?? [])[0] as AccountingMonth['closed'] | undefined) ?? null,
    invoices: inv,
    receipts: rec,
    payouts: paid,
    journal: lines,
    totals: {
      invoiced_net: sum(live, (i) => i.net_kurus),
      invoiced_kdv: sum(live, (i) => i.kdv_kurus),
      received: sum(rec, (r) => r.amount_kurus),
      paid_gross: sum(paid, (p) => p.gross_kurus),
      withheld: sum(paid, (p) => p.withholding_kurus),
      paid_net: sum(paid, (p) => p.net_kurus),
      debit: sum(lines, (l) => l.debit_kurus),
      credit: sum(lines, (l) => l.credit_kurus),
    },
    withholding: [...profiles.values()],
    incomplete: [...incomplete.values()],
  });
}

/** Marks a finished month as handed to the accountant. */
export async function closeMonth(
  db: D1Database,
  staffId: string,
  month: string,
  at: number,
): Promise<Result<null>> {
  if (!monthBounds(month)) return fail('invalid_month');
  if (month >= monthOf(at)) return fail('month_not_over');
  await db.batch([
    db
      .prepare(
        'INSERT INTO closed_months (month, closed_by, closed_at) VALUES (?, ?, ?) ON CONFLICT (month) DO NOTHING',
      )
      .bind(month, staffId, at),
    auditStatement(db, at, `staff:${staffId}`, 'accounting.month_closed', `month:${month}`),
  ]);
  return ok(null);
}

/** The months that have anything booked, newest first, with whether each was handed over. */
export async function accountingMonths(
  db: D1Database,
): Promise<{ month: string; entries: number; closed: boolean }[]> {
  const { results } = await db
    .prepare(
      `SELECT strftime('%Y-%m', occurred_at + ${String(TR_OFFSET)}, 'unixepoch') AS month, count(*) AS entries,
         EXISTS (SELECT 1 FROM closed_months c WHERE c.month = strftime('%Y-%m', occurred_at + ${String(TR_OFFSET)}, 'unixepoch')) AS closed
       FROM journal_entries GROUP BY month ORDER BY month DESC LIMIT 36`,
    )
    .all<{ month: string; entries: number; closed: number }>();
  return results.map((row) => ({ ...row, closed: row.closed === 1 }));
}
