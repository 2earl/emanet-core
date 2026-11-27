/**
 * Delivery, invoices, receipts and payouts, all through a double-entry journal
 * (docs/DESIGN.md §4.6, §7). Every money movement is a balanced journal entry written in the same
 * batch as the change that causes it. Entries are never edited (the schema refuses); a correction
 * is a reversing entry.
 *
 * The sequence for one vehicle:
 * 1. Staff confirm the delivery: the cases are delivered, the agent's fee is owed (cost 740, owed
 *    to the agent 320, withholding 360).
 * 2. Staff invoice the partner: receivable 120, sales 600, VAT charged 391.
 * 3. The partner pays: bank 102 against the receivable. A fully paid invoice makes the payouts
 *    for its cases ready.
 * 4. Staff order the payout (a second admin approves large ones) and record the bank's reference:
 *    the debt to the agent is settled from the bank.
 *
 * We sell partners a service and buy agents' services: two contracts, never money collected on
 * an agent's behalf (DESIGN §7, Law 6493).
 */
import { auditStatement, outboxStatement } from './audit';
import { payoutFor, percentOf, type PayoutRule } from './pricing';
import { fail, newId, ok, type Result } from './result';
import { readSettings } from './settings';

type AccountKind = 'asset' | 'liability' | 'revenue' | 'expense';

const BASE_ACCOUNTS: Record<string, { name: string; kind: AccountKind }> = {
  '102': { name: 'Bankalar', kind: 'asset' },
  '120': { name: 'Alıcılar', kind: 'asset' },
  '191': { name: 'İndirilecek KDV', kind: 'asset' },
  '320': { name: 'Satıcılar', kind: 'liability' },
  '360': { name: 'Ödenecek Vergi ve Fonlar', kind: 'liability' },
  '391': { name: 'Hesaplanan KDV', kind: 'liability' },
  '600': { name: 'Yurt İçi Satışlar', kind: 'revenue' },
  '740': { name: 'Hizmet Üretim Maliyeti', kind: 'expense' },
};

export interface JournalLine {
  account: string;
  debit?: number;
  credit?: number;
}

/** Sub-accounts per counterparty: 120.<partner>, 320.<agent>. */
const receivable = (partnerId: string) => `120.${partnerId}`;
const payable = (agentId: string) => `320.${agentId}`;

function accountStatement(db: D1Database, code: string, at: number): D1PreparedStatement {
  const base = BASE_ACCOUNTS[code.split('.')[0] ?? ''];
  if (!base) throw new Error(`unknown account ${code}`);
  return db
    .prepare(
      'INSERT INTO ledger_accounts (code, name, kind, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (code) DO NOTHING',
    )
    .bind(code, code.includes('.') ? `${base.name} ${code.slice(4)}` : base.name, base.kind, at);
}

/**
 * The statements for one journal entry. Refuses an unbalanced or empty entry, a negative or
 * fractional amount, and a line that is both debit and credit: arithmetic mistakes stop here, not
 * in the accountant's trial balance.
 */
export function journalStatements(
  db: D1Database,
  entry: {
    kind: string;
    memo: string;
    caseId?: string;
    refId?: string;
    createdBy: string;
    lines: readonly JournalLine[];
  },
  at: number,
): D1PreparedStatement[] {
  const lines = entry.lines.filter((line) => (line.debit ?? 0) !== 0 || (line.credit ?? 0) !== 0);
  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    const d = line.debit ?? 0;
    const c = line.credit ?? 0;
    if (!Number.isSafeInteger(d) || !Number.isSafeInteger(c) || d < 0 || c < 0) {
      throw new Error('journal amounts must be whole, non-negative kuruş');
    }
    if (d !== 0 && c !== 0) throw new Error('a journal line is a debit or a credit');
    debit += d;
    credit += c;
  }
  if (lines.length < 2 || debit !== credit || debit === 0) {
    throw new Error(`unbalanced journal entry: ${String(debit)} ≠ ${String(credit)}`);
  }
  const id = newId();
  return [
    ...[...new Set(lines.map((line) => line.account))].map((code) =>
      accountStatement(db, code, at),
    ),
    db
      .prepare(
        `INSERT INTO journal_entries (id, occurred_at, kind, case_id, ref_id, memo, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        at,
        entry.kind,
        entry.caseId ?? null,
        entry.refId ?? null,
        entry.memo,
        entry.createdBy,
        at,
      ),
    ...lines.map((line, index) =>
      db
        .prepare(
          `INSERT INTO journal_lines (entry_id, line, account_code, debit_kurus, credit_kurus)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(id, index + 1, line.account, line.debit ?? 0, line.credit ?? 0),
    ),
  ];
}

// ---------------------------------------------------------------------------------------------
// 1. Delivery

export async function setPayoutRule(
  db: D1Database,
  rule: PayoutRule,
  staffId: string,
  validFrom: number,
  at: number,
): Promise<Result<null>> {
  await db.batch([
    db
      .prepare(
        'INSERT INTO payout_rules (id, valid_from, rule, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(newId(), validFrom, JSON.stringify(rule), staffId, at),
    auditStatement(db, at, `staff:${staffId}`, 'payout_rule.set', 'payout_rules', { validFrom }),
  ]);
  return ok(null);
}

export interface Delivery {
  vehicle_id: string;
  cases: string[];
  payout: { id: string; gross_kurus: number; withholding_kurus: number; net_kurus: number };
}

/**
 * Staff confirm that a claimed vehicle is in a custodian car park, on the agent's evidence. Every
 * active case on the vehicle is delivered and its partner told; the agent is paid once, on the
 * highest fee (owner's decision, DESIGN §11.4).
 */
export async function confirmDelivery(
  db: D1Database,
  staffId: string,
  claimId: string,
  at: number,
): Promise<Result<Delivery>> {
  const claim = await db
    .prepare(
      `SELECT c.id, c.vehicle_id, c.agent_id, c.state, a.tax_profile FROM claims c
       JOIN agents a ON a.user_id = c.agent_id
       WHERE c.id = ? AND c.closed_at IS NULL`,
    )
    .bind(claimId)
    .first<{
      id: string;
      vehicle_id: string;
      agent_id: string;
      state: string;
      tax_profile: 'individual' | 'sole_trader' | 'company';
    }>();
  if (!claim) return fail('not_found');
  if (claim.state !== 'reporting') return fail('no_sighting');
  const { results: kinds } = await db
    .prepare(`SELECT DISTINCT kind FROM evidence WHERE claim_id = ? AND status != 'rejected'`)
    .bind(claimId)
    .all<{ kind: string }>();
  const have = new Set(kinds.map((row) => row.kind));
  for (const required of ['scene', 'yediemin_receipt']) {
    if (!have.has(required)) return fail('missing_evidence', required);
  }

  const { results: cases } = await db
    .prepare(
      `SELECT id, partner_id, external_ref, fee_kurus FROM cases
       WHERE vehicle_id = ? AND status = 'active' ORDER BY fee_kurus DESC, created_at`,
    )
    .bind(claim.vehicle_id)
    .all<{ id: string; partner_id: string; external_ref: string; fee_kurus: number }>();
  const top = cases[0];
  if (!top) return fail('no_active_case');

  const ruleRow = await db
    .prepare(
      'SELECT rule FROM payout_rules WHERE valid_from <= ? ORDER BY valid_from DESC, created_at DESC LIMIT 1',
    )
    .bind(at)
    .first<{ rule: string }>();
  if (!ruleRow) return fail('no_payout_rule');
  const settings = await readSettings(db);
  const gross = payoutFor(JSON.parse(ruleRow.rule) as PayoutRule, top.fee_kurus);
  const withholding = percentOf(gross, settings[`withholding_${claim.tax_profile}_bp`]);
  const net = gross - withholding;
  const payoutId = newId();

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE cases SET status = 'delivered', delivered_at = ?, updated_at = ?
         WHERE vehicle_id = ? AND status = 'active'`,
      )
      .bind(at, at, claim.vehicle_id),
    db
      .prepare('UPDATE vehicles SET custody_since = ?, updated_at = ? WHERE id = ?')
      .bind(at, at, claim.vehicle_id),
    db
      .prepare(`UPDATE claims SET closed_at = ?, close_reason = 'delivered' WHERE id = ?`)
      .bind(at, claimId),
    db
      .prepare(
        `UPDATE evidence SET status = 'accepted', reviewed_by = ? WHERE claim_id = ? AND status = 'submitted'`,
      )
      .bind(staffId, claimId),
    db
      .prepare(
        `UPDATE review_items SET status = 'resolved', resolved_by = ?, resolved_at = ?
         WHERE kind = 'delivery' AND subject_id = ? AND status = 'open'`,
      )
      .bind(staffId, at, claimId),
    db
      .prepare(
        `INSERT INTO payouts (id, agent_id, vehicle_id, case_id, gross_kurus, withholding_kurus,
           net_kurus, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        payoutId,
        claim.agent_id,
        claim.vehicle_id,
        top.id,
        gross,
        withholding,
        net,
        gross === 0 ? 'cancelled' : 'awaiting_receipt',
        at,
        at,
      ),
    // A payout rule can yield nothing (a 0 % share): then there is no fee to book.
    ...(gross === 0
      ? []
      : journalStatements(
          db,
          {
            kind: 'agent_fee',
            memo: `Agent fee, vehicle delivered to custody (claim ${claimId})`,
            caseId: top.id,
            refId: payoutId,
            createdBy: staffId,
            lines: [
              { account: '740', debit: gross },
              { account: payable(claim.agent_id), credit: net },
              { account: '360', credit: withholding },
            ],
          },
          at,
        )),
    ...cases.map((row) =>
      outboxStatement(db, at, row.partner_id, 'case.delivered', {
        case_id: row.id,
        external_ref: row.external_ref,
        delivered_at: at,
      }),
    ),
    auditStatement(db, at, `staff:${staffId}`, 'delivery.confirmed', `claim:${claimId}`, {
      vehicle: claim.vehicle_id,
      cases: cases.map((row) => row.id),
    }),
  ];
  await db.batch(statements);
  return ok({
    vehicle_id: claim.vehicle_id,
    cases: cases.map((row) => row.id),
    payout: { id: payoutId, gross_kurus: gross, withholding_kurus: withholding, net_kurus: net },
  });
}

// ---------------------------------------------------------------------------------------------
// 2. Invoice

export interface Invoice {
  id: string;
  partner_id: string;
  net_kurus: number;
  kdv_kurus: number;
  total_kurus: number;
  cases: string[];
}

/**
 * Invoices a partner for every delivered case not yet invoiced. The e-invoice itself is issued by
 * the GİB integrator (phase P5); its number is recorded on the invoice afterwards. Turkish law
 * wants the invoice within seven days of the service: Emanet Control lists cases nearing that.
 */
export async function issueInvoice(
  db: D1Database,
  staffId: string,
  partnerId: string,
  at: number,
): Promise<Result<Invoice>> {
  const { results: cases } = await db
    .prepare(
      `SELECT c.id, c.fee_kurus FROM cases c
       WHERE c.partner_id = ? AND c.status = 'delivered'
         AND NOT EXISTS (SELECT 1 FROM invoice_lines l WHERE l.case_id = c.id)
       ORDER BY c.delivered_at LIMIT 500`,
    )
    .bind(partnerId)
    .all<{ id: string; fee_kurus: number }>();
  if (cases.length === 0) return fail('nothing_to_invoice');
  const settings = await readSettings(db);
  const lines = cases.map((row) => ({
    caseId: row.id,
    net: row.fee_kurus,
    kdv: percentOf(row.fee_kurus, settings.kdv_bp),
  }));
  const net = lines.reduce((sum, line) => sum + line.net, 0);
  const kdv = lines.reduce((sum, line) => sum + line.kdv, 0);
  const id = newId();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO invoices (id, partner_id, issued_at, net_kurus, kdv_kurus, total_kurus, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, partnerId, at, net, kdv, net + kdv, staffId),
      ...lines.map((line) =>
        db
          .prepare(
            'INSERT INTO invoice_lines (invoice_id, case_id, net_kurus, kdv_bp, kdv_kurus) VALUES (?, ?, ?, ?, ?)',
          )
          .bind(id, line.caseId, line.net, settings.kdv_bp, line.kdv),
      ),
      ...journalStatements(
        db,
        {
          kind: 'invoice',
          memo: `Invoice ${id}`,
          refId: id,
          createdBy: staffId,
          lines: [
            { account: receivable(partnerId), debit: net + kdv },
            { account: '600', credit: net },
            { account: '391', credit: kdv },
          ],
        },
        at,
      ),
      outboxStatement(db, at, partnerId, 'invoice.issued', {
        invoice_id: id,
        total_kurus: net + kdv,
      }),
      auditStatement(db, at, `staff:${staffId}`, 'invoice.issued', `invoice:${id}`, {
        partner: partnerId,
      }),
    ]);
  } catch (error) {
    // Two staff invoicing the same partner at once: invoice_lines.case_id is unique.
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
      return fail('conflict_retry');
    }
    throw error;
  }
  return ok({
    id,
    partner_id: partnerId,
    net_kurus: net,
    kdv_kurus: kdv,
    total_kurus: net + kdv,
    cases: lines.map((line) => line.caseId),
  });
}

// ---------------------------------------------------------------------------------------------
// 3. Receipt

/**
 * Money from a partner, entered by staff from the bank statement (later read from the bank's
 * API). A bank reference is recorded once, so importing the same statement twice changes nothing.
 */
export async function recordReceipt(
  db: D1Database,
  staffId: string,
  receipt: {
    partnerId: string;
    invoiceId?: string;
    amountKurus: number;
    valueDate: string;
    bankRef: string;
    source: 'manual' | 'statement' | 'bank_api';
  },
  at: number,
): Promise<Result<{ id: string; invoice_paid: boolean }>> {
  if (!Number.isSafeInteger(receipt.amountKurus) || receipt.amountKurus <= 0) {
    return fail('invalid_amount');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receipt.valueDate)) return fail('invalid_value_date');
  if (!receipt.bankRef.trim()) return fail('missing_bank_ref');
  let invoice: { total_kurus: number; paid_kurus: number } | null = null;
  if (receipt.invoiceId !== undefined) {
    invoice = await db
      .prepare(
        `SELECT total_kurus, paid_kurus FROM invoices WHERE id = ? AND partner_id = ? AND status = 'issued'`,
      )
      .bind(receipt.invoiceId, receipt.partnerId)
      .first();
    if (!invoice) return fail('invoice_not_open');
  }
  const id = newId();
  const paid = invoice !== null && invoice.paid_kurus + receipt.amountKurus >= invoice.total_kurus;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO receipts (id, partner_id, invoice_id, amount_kurus, value_date, bank_ref, source, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        receipt.partnerId,
        receipt.invoiceId ?? null,
        receipt.amountKurus,
        receipt.valueDate,
        receipt.bankRef.trim(),
        receipt.source,
        staffId,
        at,
      ),
    ...journalStatements(
      db,
      {
        kind: 'receipt',
        memo: `Payment ${receipt.bankRef.trim()}`,
        refId: id,
        createdBy: staffId,
        lines: [
          { account: '102', debit: receipt.amountKurus },
          { account: receivable(receipt.partnerId), credit: receipt.amountKurus },
        ],
      },
      at,
    ),
    auditStatement(db, at, `staff:${staffId}`, 'receipt.recorded', `receipt:${id}`, {
      partner: receipt.partnerId,
      invoice: receipt.invoiceId ?? null,
    }),
  ];
  if (receipt.invoiceId !== undefined) {
    statements.push(
      db
        .prepare(
          `UPDATE invoices SET paid_kurus = paid_kurus + ?,
             status = CASE WHEN paid_kurus + ? >= total_kurus THEN 'paid' ELSE status END
           WHERE id = ?`,
        )
        .bind(receipt.amountKurus, receipt.amountKurus, receipt.invoiceId),
    );
    if (paid) {
      statements.push(
        db
          .prepare(
            `UPDATE payouts SET status = 'ready', updated_at = ?
             WHERE status = 'awaiting_receipt'
               AND case_id IN (SELECT case_id FROM invoice_lines WHERE invoice_id = ?)`,
          )
          .bind(at, receipt.invoiceId),
      );
    }
  }
  try {
    await db.batch(statements);
  } catch (error) {
    if (
      error instanceof Error &&
      /UNIQUE constraint failed: receipts\.bank_ref/.test(error.message)
    ) {
      return fail('duplicate_bank_ref');
    }
    throw error;
  }
  return ok({ id, invoice_paid: paid });
}

// ---------------------------------------------------------------------------------------------
// 4. Payout

/**
 * An admin orders a ready payout. Below the dual-approval amount that is enough; at or above it, a
 * second, different admin must approve.
 */
export async function orderPayout(
  db: D1Database,
  staffId: string,
  payoutId: string,
  at: number,
): Promise<Result<{ status: 'ready' | 'approved' }>> {
  const payout = await db
    .prepare(
      `SELECT p.status, p.gross_kurus, p.ordered_by, a.iban_verified_at
       FROM payouts p JOIN agents a ON a.user_id = p.agent_id WHERE p.id = ?`,
    )
    .bind(payoutId)
    .first<{
      status: string;
      gross_kurus: number;
      ordered_by: string | null;
      iban_verified_at: number | null;
    }>();
  if (!payout) return fail('not_found');
  if (payout.status !== 'ready') return fail('payout_not_ready', payout.status);
  // Money goes only to an IBAN staff have checked is in the agent's own name.
  if (payout.iban_verified_at === null) return fail('iban_not_verified');
  const settings = await readSettings(db);
  const needsSecond = payout.gross_kurus >= settings.dual_approval_kurus;

  if (payout.ordered_by === null) {
    const status = needsSecond ? 'ready' : 'approved';
    await db.batch([
      db
        .prepare(
          `UPDATE payouts SET ordered_by = ?, approved_by = ?, status = ?, updated_at = ?
           WHERE id = ? AND status = 'ready' AND ordered_by IS NULL`,
        )
        .bind(staffId, needsSecond ? null : staffId, status, at, payoutId),
      auditStatement(db, at, `staff:${staffId}`, 'payout.ordered', `payout:${payoutId}`),
    ]);
    return ok({ status });
  }
  if (payout.ordered_by === staffId) return fail('second_approver_required');
  await db.batch([
    db
      .prepare(
        `UPDATE payouts SET approved_by = ?, status = 'approved', updated_at = ?
         WHERE id = ? AND status = 'ready'`,
      )
      .bind(staffId, at, payoutId),
    auditStatement(db, at, `staff:${staffId}`, 'payout.approved', `payout:${payoutId}`),
  ]);
  return ok({ status: 'approved' });
}

/** The bank has sent the money: the debt to the agent is settled from the bank account. */
export async function markPayoutSent(
  db: D1Database,
  staffId: string,
  payoutId: string,
  bankRef: string,
  at: number,
): Promise<Result<null>> {
  const payout = await db
    .prepare('SELECT agent_id, case_id, net_kurus, status FROM payouts WHERE id = ?')
    .bind(payoutId)
    .first<{ agent_id: string; case_id: string; net_kurus: number; status: string }>();
  if (!payout) return fail('not_found');
  if (payout.status !== 'approved') return fail('payout_not_approved', payout.status);
  if (!bankRef.trim()) return fail('missing_bank_ref');
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE payouts SET status = 'sent', bank_ref = ?, updated_at = ? WHERE id = ? AND status = 'approved'`,
        )
        .bind(bankRef.trim(), at, payoutId),
      ...journalStatements(
        db,
        {
          kind: 'payout',
          memo: `Payout ${bankRef.trim()}`,
          caseId: payout.case_id,
          refId: payoutId,
          createdBy: staffId,
          lines: [
            { account: payable(payout.agent_id), debit: payout.net_kurus },
            { account: '102', credit: payout.net_kurus },
          ],
        },
        at,
      ),
      auditStatement(db, at, `staff:${staffId}`, 'payout.sent', `payout:${payoutId}`),
    ]);
  } catch (error) {
    if (
      error instanceof Error &&
      /UNIQUE constraint failed: payouts\.bank_ref/.test(error.message)
    ) {
      return fail('duplicate_bank_ref');
    }
    throw error;
  }
  return ok(null);
}

// ---------------------------------------------------------------------------------------------
// Reports

export interface BalanceRow {
  code: string;
  name: string;
  debit_kurus: number;
  credit_kurus: number;
}

/** The trial balance: totals per account. Debits and credits are always equal in sum. */
export async function trialBalance(db: D1Database): Promise<BalanceRow[]> {
  const { results } = await db
    .prepare(
      `SELECT a.code, a.name, coalesce(sum(l.debit_kurus), 0) AS debit_kurus,
         coalesce(sum(l.credit_kurus), 0) AS credit_kurus
       FROM ledger_accounts a LEFT JOIN journal_lines l ON l.account_code = a.code
       GROUP BY a.code ORDER BY a.code`,
    )
    .all<BalanceRow>();
  return results;
}
