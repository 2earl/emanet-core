import { describe, expect, it } from 'vitest';
import { getCase, upsertCase } from '../src/cases';
import { addEvidence, claimVehicle, recordSighting } from '../src/claims';
import {
  confirmDelivery,
  issueInvoice,
  journalStatements,
  markPayoutSent,
  orderPayout,
  recordReceipt,
  trialBalance,
} from '../src/ledger';
import { writeSetting } from '../src/settings';
import {
  activeAgent,
  activePartner,
  caseInput,
  db,
  payoutRule,
  randomPlate,
  randomVin,
  T0,
  unwrap,
} from './helpers';

const HOUR = 3600;
const hash = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

/** Two creditors on one vehicle; an agent finds it and gets it into custody. */
async function deliveredScenario() {
  await payoutRule(5000);
  const a = await activePartner({ default_kurus: 1_000_000, rules: [] });
  const b = await activePartner({ default_kurus: 1_500_000, rules: [] });
  const vin = randomVin();
  const plate = randomPlate();
  const caseA = unwrap(await upsertCase(db(), a, caseInput({ vin, plate }), 'u', T0));
  const caseB = unwrap(await upsertCase(db(), b, caseInput({ vin, plate }), 'u', T0));
  const vehicle = await db()
    .prepare('SELECT id FROM vehicles WHERE vin = ?')
    .bind(vin)
    .first<{ id: string }>();
  const agent = await activeAgent();
  const claim = unwrap(await claimVehicle(db(), agent, vehicle?.id ?? '', T0));
  unwrap(
    await recordSighting(
      db(),
      agent,
      claim.id,
      { lat: 41, lng: 29, taken_at: T0 + HOUR },
      T0 + HOUR,
    ),
  );
  return { a, b, caseA, caseB, agent, claim, vehicleId: vehicle?.id ?? '' };
}

async function addCustodyEvidence(agent: string, claimId: string) {
  unwrap(
    await addEvidence(
      db(),
      agent,
      claimId,
      { kind: 'scene', file_ref: 'r2://1', sha256: hash() },
      T0 + HOUR,
    ),
  );
  unwrap(
    await addEvidence(
      db(),
      agent,
      claimId,
      { kind: 'yediemin_receipt', file_ref: 'r2://2', sha256: hash() },
      T0 + 3 * HOUR,
    ),
  );
}

async function balanceOf(code: string): Promise<number> {
  const row = (await trialBalance(db())).find((r) => r.code === code);
  return row ? row.debit_kurus - row.credit_kurus : 0;
}

describe('journal', () => {
  it('refuses unbalanced or malformed entries', () => {
    const entry = (lines: { account: string; debit?: number; credit?: number }[]) => () =>
      journalStatements(db(), { kind: 't', memo: 't', createdBy: 's', lines }, T0);
    expect(
      entry([
        { account: '102', debit: 100 },
        { account: '600', credit: 99 },
      ]),
    ).toThrow(/unbalanced/);
    expect(
      entry([
        { account: '102', debit: 1.5 },
        { account: '600', credit: 1.5 },
      ]),
    ).toThrow(/whole/);
    expect(
      entry([
        { account: '102', debit: 1, credit: 1 },
        { account: '600', credit: 0 },
      ]),
    ).toThrow();
    expect(
      entry([
        { account: '999', debit: 1 },
        { account: '600', credit: 1 },
      ]),
    ).toThrow(/unknown account/);
  });

  it('can never be changed', async () => {
    await db().batch(
      journalStatements(
        db(),
        {
          kind: 't',
          memo: 't',
          createdBy: 's',
          lines: [
            { account: '102', debit: 5 },
            { account: '600', credit: 5 },
          ],
        },
        T0,
      ),
    );
    await expect(
      db().prepare(`UPDATE journal_lines SET debit_kurus = 6 WHERE debit_kurus = 5`).run(),
    ).rejects.toThrow(/immutable/);
    await expect(db().prepare(`DELETE FROM journal_entries`).run()).rejects.toThrow(/immutable/);
  });
});

describe('from delivery to payout', () => {
  it('needs the scene photo and the custody receipt', async () => {
    const { agent, claim } = await deliveredScenario();
    expect(await confirmDelivery(db(), 'staff-1', claim.id, T0 + 4 * HOUR)).toMatchObject({
      error: 'missing_evidence',
      detail: 'scene',
    });
    await addCustodyEvidence(agent, claim.id);
    unwrap(await confirmDelivery(db(), 'staff-1', claim.id, T0 + 4 * HOUR));
    expect(await confirmDelivery(db(), 'staff-1', claim.id, T0 + 4 * HOUR)).toMatchObject({
      error: 'not_found',
    });
  });

  it('delivers every case, pays the agent once on the highest fee, and balances', async () => {
    const { a, b, caseA, caseB, agent, claim, vehicleId } = await deliveredScenario();
    await addCustodyEvidence(agent, claim.id);
    const delivery = unwrap(await confirmDelivery(db(), 'staff-1', claim.id, T0 + 4 * HOUR));
    expect(delivery.cases.sort()).toEqual([caseA.id, caseB.id].sort());
    expect(delivery.payout).toMatchObject({
      gross_kurus: 750_000,
      withholding_kurus: 0,
      net_kurus: 750_000,
    });
    expect(unwrap(await getCase(db(), a.id, caseA.id)).status).toBe('delivered');
    expect(unwrap(await getCase(db(), b.id, caseB.id)).delivered_at).toBe(T0 + 4 * HOUR);
    for (const partner of [a, b]) {
      const event = await db()
        .prepare(`SELECT type FROM outbox WHERE partner_id = ? AND type = 'case.delivered'`)
        .bind(partner.id)
        .first();
      expect(event).not.toBeNull();
    }
    // In custody: no longer a hunt.
    const vehicle = await db()
      .prepare('SELECT custody_since FROM vehicles WHERE id = ?')
      .bind(vehicleId)
      .first<{ custody_since: number }>();
    expect(vehicle?.custody_since).toBe(T0 + 4 * HOUR);
    expect(await balanceOf(`320.${agent}`)).toBe(-750_000);

    // Invoices with 20 % KDV.
    const invoiceA = unwrap(await issueInvoice(db(), 'staff-1', a.id, T0 + DAYS(1)));
    const invoiceB = unwrap(await issueInvoice(db(), 'staff-1', b.id, T0 + DAYS(1)));
    expect(invoiceB).toMatchObject({
      net_kurus: 1_500_000,
      kdv_kurus: 300_000,
      total_kurus: 1_800_000,
    });
    expect(await issueInvoice(db(), 'staff-1', b.id, T0 + DAYS(1))).toMatchObject({
      error: 'nothing_to_invoice',
    });
    expect(await balanceOf(`120.${b.id}`)).toBe(1_800_000);

    // A pays: the payout still waits, because B's case set it.
    unwrap(
      await recordReceipt(
        db(),
        'staff-1',
        {
          partnerId: a.id,
          invoiceId: invoiceA.id,
          amountKurus: 1_200_000,
          valueDate: '2027-01-10',
          bankRef: `A-${invoiceA.id}`,
          source: 'manual',
        },
        T0 + DAYS(5),
      ),
    );
    expect(await orderPayout(db(), 'staff-1', delivery.payout.id, T0 + DAYS(5))).toMatchObject({
      error: 'payout_not_ready',
    });

    // B pays in two parts; the second completes the invoice and readies the payout.
    const part = unwrap(
      await recordReceipt(
        db(),
        'staff-1',
        {
          partnerId: b.id,
          invoiceId: invoiceB.id,
          amountKurus: 800_000,
          valueDate: '2027-01-11',
          bankRef: `B1-${invoiceB.id}`,
          source: 'statement',
        },
        T0 + DAYS(6),
      ),
    );
    expect(part.invoice_paid).toBe(false);
    expect(
      await recordReceipt(
        db(),
        'staff-1',
        {
          partnerId: b.id,
          invoiceId: invoiceB.id,
          amountKurus: 800_000,
          valueDate: '2027-01-11',
          bankRef: `B1-${invoiceB.id}`,
          source: 'statement',
        },
        T0 + DAYS(6),
      ),
    ).toMatchObject({ error: 'duplicate_bank_ref' });
    const rest = unwrap(
      await recordReceipt(
        db(),
        'staff-1',
        {
          partnerId: b.id,
          invoiceId: invoiceB.id,
          amountKurus: 1_000_000,
          valueDate: '2027-01-12',
          bankRef: `B2-${invoiceB.id}`,
          source: 'statement',
        },
        T0 + DAYS(7),
      ),
    );
    expect(rest.invoice_paid).toBe(true);
    expect(await balanceOf(`120.${b.id}`)).toBe(0);

    expect(unwrap(await orderPayout(db(), 'staff-1', delivery.payout.id, T0 + DAYS(7)))).toEqual({
      status: 'approved',
    });
    unwrap(
      await markPayoutSent(
        db(),
        'staff-1',
        delivery.payout.id,
        `PAY-${delivery.payout.id}`,
        T0 + DAYS(8),
      ),
    );
    expect(await balanceOf(`320.${agent}`)).toBe(0);

    // The books balance.
    const rows = await trialBalance(db());
    const debit = rows.reduce((s, r) => s + r.debit_kurus, 0);
    const credit = rows.reduce((s, r) => s + r.credit_kurus, 0);
    expect(debit).toBe(credit);
  });

  it('needs a second admin for large payouts', async () => {
    const { b, agent, claim } = await deliveredScenario();
    await addCustodyEvidence(agent, claim.id);
    const delivery = unwrap(await confirmDelivery(db(), 'staff-1', claim.id, T0 + 4 * HOUR));
    const invoice = unwrap(await issueInvoice(db(), 'staff-1', b.id, T0 + DAYS(1)));
    unwrap(
      await recordReceipt(
        db(),
        'staff-1',
        {
          partnerId: b.id,
          invoiceId: invoice.id,
          amountKurus: invoice.total_kurus,
          valueDate: '2027-01-12',
          bankRef: `X-${invoice.id}`,
          source: 'manual',
        },
        T0 + DAYS(2),
      ),
    );
    await writeSetting(db(), 'dual_approval_kurus', 500_000, 'staff-1', T0).run();
    try {
      expect(unwrap(await orderPayout(db(), 'staff-1', delivery.payout.id, T0 + DAYS(2)))).toEqual({
        status: 'ready',
      });
      expect(await orderPayout(db(), 'staff-1', delivery.payout.id, T0 + DAYS(2))).toMatchObject({
        error: 'second_approver_required',
      });
      expect(
        await markPayoutSent(db(), 'staff-1', delivery.payout.id, 'R', T0 + DAYS(2)),
      ).toMatchObject({ error: 'payout_not_approved' });
      expect(unwrap(await orderPayout(db(), 'staff-2', delivery.payout.id, T0 + DAYS(2)))).toEqual({
        status: 'approved',
      });
    } finally {
      await writeSetting(db(), 'dual_approval_kurus', 2_500_000, 'staff-1', T0).run();
    }
  });

  it('withholds tax by the agent tax profile when the accountant sets a rate', async () => {
    const { agent, claim } = await deliveredScenario();
    await addCustodyEvidence(agent, claim.id);
    await writeSetting(db(), 'withholding_individual_bp', 2000, 'staff-1', T0).run();
    try {
      const delivery = unwrap(await confirmDelivery(db(), 'staff-1', claim.id, T0 + 4 * HOUR));
      expect(delivery.payout).toMatchObject({
        gross_kurus: 750_000,
        withholding_kurus: 150_000,
        net_kurus: 600_000,
      });
    } finally {
      await writeSetting(db(), 'withholding_individual_bp', 0, 'staff-1', T0).run();
    }
  });
});

function DAYS(n: number) {
  return n * 86_400;
}
