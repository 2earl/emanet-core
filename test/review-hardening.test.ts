import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { myClaims } from '../src/agents';
import {
  expireCases,
  getCase,
  redactClosedCasePlaces,
  upsertCase,
  withdrawCase,
} from '../src/cases';
import {
  addEvidence,
  claimVehicle,
  MAX_EVIDENCE_PER_CLAIM,
  recordSighting,
  registerAgent,
  setAgentStatus,
} from '../src/claims';
import { auditLog, distanceMetres, reviewDetail } from '../src/control';
import type { ControlApi, PartnerApi } from '../src/index';
import {
  confirmDelivery,
  issueInvoice,
  markPayoutSent,
  orderPayout,
  recordReceipt,
  rejectDelivery,
  setInvoiceNumber,
} from '../src/ledger';
import { settingAllowed } from '../src/settings';
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
const DAY = 24 * HOUR;
const hash = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

/** A vehicle found and reported; with `receipt`, waiting for staff to confirm the delivery. */
async function reported(receipt = true) {
  await payoutRule(5000);
  const partner = await activePartner();
  const vin = randomVin();
  const kase = unwrap(
    await upsertCase(
      db(),
      partner,
      caseInput({
        vin,
        plate: randomPlate(),
        places: [
          {
            kind: 'owner_home',
            address: 'Örnek Mah. Deneme Sk. No:1',
            district: 'Kadıköy',
            city: 'İstanbul',
            lat: 41,
            lng: 29,
            note: 'Arka sokak',
          },
        ],
      }),
      'u',
      T0,
    ),
  );
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
      { lat: 41.001, lng: 29, taken_at: T0 + 300 },
      T0 + 300,
    ),
  );
  unwrap(
    await addEvidence(
      db(),
      agent,
      claim.id,
      { kind: 'scene', file_ref: 'claims/x/1', sha256: hash() },
      T0 + 300,
    ),
  );
  if (receipt) {
    unwrap(
      await addEvidence(
        db(),
        agent,
        claim.id,
        { kind: 'yediemin_receipt', file_ref: 'claims/x/2', sha256: hash() },
        T0 + HOUR,
      ),
    );
  }
  return { partner, kase, agent, claim, vehicleId: vehicle?.id ?? '' };
}

const openReview = (claimId: string) =>
  db()
    .prepare(`SELECT id FROM review_items WHERE subject_id = ? AND status = 'open'`)
    .bind(claimId)
    .first<{ id: string }>();

describe('rejecting a delivery', () => {
  it('ends the claim, tells the agent why, and books nothing', async () => {
    const { agent, claim, kase, partner, vehicleId } = await reported();
    const at = T0 + 2 * HOUR;
    expect(
      await rejectDelivery(db(), 'staff-1', claim.id, { reason: ' ', strike: false }, at),
    ).toMatchObject({ error: 'invalid_reason' });
    const result = unwrap(
      await rejectDelivery(
        db(),
        'staff-1',
        claim.id,
        { reason: 'The receipt shows another plate', strike: true },
        at,
      ),
    );
    expect(result.strikes).toBe(1);
    expect(await openReview(claim.id)).toBeNull();
    const mine = unwrap(await myClaims(db(), agent, at));
    expect(mine[0]).toMatchObject({
      close_reason: 'rejected',
      close_note: 'The receipt shows another plate',
    });
    // The case is still open for another agent; this one waits out the cooldown.
    expect(unwrap(await getCase(db(), partner.id, kase.id)).status).toBe('active');
    expect(await claimVehicle(db(), agent, vehicleId, at + 60)).toMatchObject({
      error: 'cooldown',
    });
    const payouts = await db()
      .prepare('SELECT count(*) AS n FROM payouts WHERE vehicle_id = ?')
      .bind(vehicleId)
      .first<{ n: number }>();
    expect(payouts?.n).toBe(0);
    const evidence = await db()
      .prepare('SELECT DISTINCT status FROM evidence WHERE claim_id = ?')
      .bind(claim.id)
      .all<{ status: string }>();
    expect(evidence.results.map((r) => r.status)).toEqual(['rejected']);
    // Decided once.
    expect(
      await rejectDelivery(db(), 'staff-2', claim.id, { reason: 'again', strike: true }, at + 1),
    ).toMatchObject({ error: 'not_found' });
    expect(await confirmDelivery(db(), 'staff-2', claim.id, at + 1)).toMatchObject({
      error: 'not_found',
    });
    const strikes = await db()
      .prepare('SELECT strikes FROM agents WHERE user_id = ?')
      .bind(agent)
      .first<{ strikes: number }>();
    expect(strikes?.strikes).toBe(1);
  });

  it('shows staff what to look at twice', async () => {
    const { claim } = await reported();
    const review = await openReview(claim.id);
    const detail = unwrap(await reviewDetail(db(), review?.id ?? ''));
    expect(detail.signals?.seconds_to_sighting).toBe(300);
    // 0.001° of latitude is about 111 m.
    expect(detail.signals?.nearest_place_m).toBeGreaterThan(100);
    expect(detail.signals?.nearest_place_m).toBeLessThan(120);
    expect(distanceMetres({ lat: 41, lng: 29 }, { lat: 41, lng: 29 })).toBe(0);
  });
});

describe('a delivery under review', () => {
  it('keeps its case: no withdrawal, change or expiry until staff decide', async () => {
    const { partner, kase, claim } = await reported();
    const at = T0 + 2 * HOUR;
    expect(await withdrawCase(db(), partner, kase.id, 'debt paid', 'u', at)).toMatchObject({
      error: 'delivery_in_review',
    });
    expect(
      await upsertCase(
        db(),
        partner,
        caseInput({ external_ref: kase.external_ref, vin: kase.vehicle.vin ?? '' }),
        'u',
        at,
      ),
    ).toMatchObject({ error: 'delivery_in_review' });
    await expireCases(db(), T0 + 20 * DAY);
    expect(unwrap(await getCase(db(), partner.id, kase.id)).status).toBe('active');
    const withdrawn = await db()
      .prepare(
        `SELECT count(*) AS n FROM audit_events WHERE subject = ? AND action = 'case.withdrawn'`,
      )
      .bind(`case:${kase.id}`)
      .first<{ n: number }>();
    expect(withdrawn?.n).toBe(0);
    // Once staff reject it, the partner can take the case back.
    unwrap(
      await rejectDelivery(db(), 'staff-1', claim.id, { reason: 'wrong car', strike: false }, at),
    );
    expect(unwrap(await withdrawCase(db(), partner, kase.id, 'debt paid', 'u', at)).status).toBe(
      'withdrawn',
    );
  });

  it('doesn’t hold another creditor’s case that is still waiting for its identity', async () => {
    const { vehicleId } = await reported();
    const plate = await db()
      .prepare('SELECT plate FROM vehicle_plates WHERE vehicle_id = ? AND valid_to IS NULL')
      .bind(vehicleId)
      .first<{ plate: string }>();
    // No VIN: linked to the vehicle by its plate, pending until staff confirm.
    const other = await activePartner();
    const pending = unwrap(
      await upsertCase(db(), other, caseInput({ vin: '', plate: plate?.plate ?? '' }), 'u', T0),
    );
    expect(pending.status).toBe('pending_identity');
    // Withdrawn like any other case: nothing tells this partner about the delivery.
    expect(
      unwrap(await withdrawCase(db(), other, pending.id, 'mistake', 'u', T0 + 2 * HOUR)).status,
    ).toBe('withdrawn');
  });

  it('leaves the queue when its claim ends another way', async () => {
    const { agent, claim } = await reported();
    expect(await openReview(claim.id)).not.toBeNull();
    unwrap(await setAgentStatus(db(), agent, 'suspended', 'staff-1', 'false reports', T0 + HOUR));
    expect(await openReview(claim.id)).toBeNull();
  });

  it('before the receipt, the partner can still withdraw', async () => {
    const { partner, kase } = await reported(false);
    expect(unwrap(await withdrawCase(db(), partner, kase.id, 'paid', 'u', T0 + HOUR)).status).toBe(
      'withdrawn',
    );
  });
});

describe('agents', () => {
  it('become active only from the identity check, with an application', async () => {
    const id = crypto.randomUUID();
    await registerAgent(db(), id, T0);
    expect(await setAgentStatus(db(), id, 'active', 'staff-1', 'skip', T0)).toMatchObject({
      error: 'agent_not_ready',
    });
    expect(await setAgentStatus(db(), id, 'owner' as never, 'staff-1', 'x', T0)).toMatchObject({
      error: 'invalid_status',
    });
    expect(await setAgentStatus(db(), id, 'banned', 'staff-1', '', T0)).toMatchObject({
      error: 'invalid_reason',
    });
    // Sent on to the check without an application: still not activatable.
    await db().prepare(`UPDATE agents SET status = 'kyc_pending' WHERE user_id = ?`).bind(id).run();
    expect(await setAgentStatus(db(), id, 'active', 'staff-1', 'skip', T0)).toMatchObject({
      error: 'agent_not_ready',
      detail: 'application',
    });
    expect(await setAgentStatus(db(), 'nobody', 'banned', 'staff-1', 'x', T0)).toMatchObject({
      error: 'not_found',
    });
  });

  it('can’t send a sighting without numbers, or pile up photos', async () => {
    const { agent, claim } = await reported(false);
    expect(
      await recordSighting(db(), agent, claim.id, { lat: NaN, lng: 29, taken_at: T0 }, T0 + 400),
    ).toMatchObject({ error: 'invalid_location' });
    expect(
      await addEvidence(
        db(),
        agent,
        claim.id,
        { kind: 'selfie' as never, file_ref: 'k', sha256: hash() },
        T0 + 400,
      ),
    ).toMatchObject({ error: 'invalid_kind' });
    for (let i = 1; i < MAX_EVIDENCE_PER_CLAIM; i++) {
      unwrap(
        await addEvidence(
          db(),
          agent,
          claim.id,
          { kind: 'tow_report', file_ref: `k/${String(i)}`, sha256: hash() },
          T0 + 400,
        ),
      );
    }
    expect(
      await addEvidence(
        db(),
        agent,
        claim.id,
        { kind: 'tow_report', file_ref: 'k/last', sha256: hash() },
        T0 + 400,
      ),
    ).toMatchObject({ error: 'too_much_evidence' });
  });
});

describe('money', () => {
  async function invoiced() {
    const { partner, claim } = await reported();
    const delivery = unwrap(await confirmDelivery(db(), 'staff-3', claim.id, T0 + 2 * HOUR));
    const invoice = unwrap(await issueInvoice(db(), 'staff-1', partner.id, T0 + 3 * HOUR));
    return { partner, invoice, payoutId: delivery.payout.id };
  }

  it('records the e-invoice number once per invoice, and lets a typo be corrected', async () => {
    const { invoice } = await invoiced();
    const other = await invoiced();
    const number = `EMA2026${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
    expect(
      await setInvoiceNumber(db(), 'staff-1', invoice.id, { number: 'a b' }, T0),
    ).toMatchObject({ error: 'invalid_invoice_number' });
    expect(
      await setInvoiceNumber(db(), 'staff-1', invoice.id, { number, uuid: 'nope' }, T0),
    ).toMatchObject({ error: 'invalid_invoice_uuid' });
    unwrap(
      await setInvoiceNumber(db(), 'staff-1', invoice.id, { number: number.toLowerCase() }, T0),
    );
    expect(await setInvoiceNumber(db(), 'staff-1', other.invoice.id, { number }, T0)).toMatchObject(
      { error: 'duplicate_invoice_number' },
    );
    unwrap(
      await setInvoiceNumber(
        db(),
        'staff-1',
        invoice.id,
        { number: `${number.slice(0, -1)}X`, uuid: crypto.randomUUID() },
        T0,
      ),
    );
    const row = await db()
      .prepare('SELECT number, e_invoice_uuid FROM invoices WHERE id = ?')
      .bind(invoice.id)
      .first<{ number: string; e_invoice_uuid: string | null }>();
    expect(row?.number).toBe(`${number.slice(0, -1)}X`);
    expect(row?.e_invoice_uuid).not.toBeNull();
    expect(await setInvoiceNumber(db(), 'staff-1', 'missing', { number }, T0)).toMatchObject({
      error: 'not_found',
    });
  });

  it('releases the payout when part payments complete the invoice', async () => {
    const { partner, invoice, payoutId } = await invoiced();
    const pay = (amountKurus: number) =>
      recordReceipt(
        db(),
        'staff-1',
        {
          partnerId: partner.id,
          invoiceId: invoice.id,
          amountKurus,
          valueDate: '2026-11-28',
          bankRef: crypto.randomUUID(),
          source: 'manual',
        },
        T0 + 4 * HOUR,
      );
    expect(unwrap(await pay(invoice.total_kurus - 1)).invoice_paid).toBe(false);
    expect(unwrap(await pay(1)).invoice_paid).toBe(true);
    const payout = await db()
      .prepare('SELECT status FROM payouts WHERE id = ?')
      .bind(payoutId)
      .first<{ status: string }>();
    expect(payout?.status).toBe('ready');
    // A payment for a partner that doesn't exist opens no account.
    expect(
      await recordReceipt(
        db(),
        'staff-1',
        {
          partnerId: 'nobody',
          amountKurus: 100,
          valueDate: '2026-11-28',
          bankRef: crypto.randomUUID(),
          source: 'manual',
        },
        T0,
      ),
    ).toMatchObject({ error: 'not_found' });
  });

  it('books a payout once, however often it is marked as sent', async () => {
    const { partner, invoice, payoutId } = await invoiced();
    unwrap(
      await recordReceipt(
        db(),
        'staff-1',
        {
          partnerId: partner.id,
          invoiceId: invoice.id,
          amountKurus: invoice.total_kurus,
          valueDate: '2026-11-28',
          bankRef: crypto.randomUUID(),
          source: 'manual',
        },
        T0 + 4 * HOUR,
      ),
    );
    expect(unwrap(await orderPayout(db(), 'staff-1', payoutId, T0 + 5 * HOUR)).status).toBe(
      'approved',
    );
    expect(await orderPayout(db(), 'staff-2', payoutId, T0 + 5 * HOUR)).toMatchObject({
      error: 'payout_not_ready',
    });
    const [first, second] = await Promise.all([
      markPayoutSent(db(), 'staff-1', payoutId, crypto.randomUUID(), T0 + 6 * HOUR),
      markPayoutSent(db(), 'staff-2', payoutId, crypto.randomUUID(), T0 + 6 * HOUR),
    ]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    const entries = await db()
      .prepare(`SELECT count(*) AS n FROM journal_entries WHERE kind = 'payout' AND ref_id = ?`)
      .bind(payoutId)
      .first<{ n: number }>();
    expect(entries?.n).toBe(1);
  });

  it('accepts only settings a person could mean', () => {
    expect(settingAllowed('claim_hours', 24)).toBe(true);
    expect(settingAllowed('claim_hours', 0)).toBe(false);
    expect(settingAllowed('kdv_bp', 2000.5)).toBe(false);
    expect(settingAllowed('kdv_bp', 200_000)).toBe(false);
    expect(settingAllowed('toString', 1)).toBe(false);
    expect(settingAllowed('cooldown_hours', 0)).toBe(true);
  });
});

describe('retention', () => {
  it('erases a closed case’s addresses after thirty days, keeping the city', async () => {
    const partner = await activePartner();
    const kase = unwrap(
      await upsertCase(
        db(),
        partner,
        caseInput({
          places: [
            {
              kind: 'work',
              address: 'Sanayi Cad. No:5',
              district: 'Bornova',
              city: 'İzmir',
              lat: 38.4,
              lng: 27.2,
              note: 'Gece vardiyası',
            },
          ],
        }),
        'u',
        T0,
      ),
    );
    const open = unwrap(await upsertCase(db(), partner, caseInput(), 'u', T0));
    unwrap(await withdrawCase(db(), partner, kase.id, 'paid', 'u', T0 + DAY));
    await redactClosedCasePlaces(db(), T0 + 30 * DAY);
    expect(unwrap(await getCase(db(), partner.id, kase.id)).places[0]?.address).toBe(
      'Sanayi Cad. No:5',
    );
    expect(await redactClosedCasePlaces(db(), T0 + 32 * DAY)).toBeGreaterThanOrEqual(1);
    const place = unwrap(await getCase(db(), partner.id, kase.id)).places[0];
    expect(place).toMatchObject({ address: '', district: 'Bornova', city: 'İzmir' });
    expect(place).not.toHaveProperty('lat');
    expect(place).not.toHaveProperty('note');
    // An open case is never touched.
    expect(unwrap(await getCase(db(), partner.id, open.id)).places[0]?.address).not.toBe('');
  });
});

describe('the audit log', () => {
  it('is read newest first, by subject, and reading it is recorded', async () => {
    const partner = await activePartner();
    const api = exports.ControlApi as unknown as ControlApi;
    const subject = `partner:${partner.id}`;
    const log = unwrap(await api.audit('staff-9', { subject }));
    expect(log.events.length).toBeGreaterThanOrEqual(2);
    expect(log.events.every((e) => e.subject === subject)).toBe(true);
    expect(log.events.map((e) => e.at)).toEqual(
      [...log.events.map((e) => e.at)].sort((a, b) => b - a),
    );
    expect(await auditLog(db(), { subject: 'x" OR 1=1' })).toMatchObject({
      error: 'invalid_filter',
    });
    const paged = unwrap(await auditLog(db(), { limit: 1 }));
    expect(paged.events).toHaveLength(1);
    expect(paged.next_before).not.toBeNull();
    const viewed = unwrap(await auditLog(db(), { actor: 'staff:staff-9' }));
    expect(viewed.events).toContainEqual(
      expect.objectContaining({ action: 'staff.viewed', subject: 'audit' }),
    );
  });

  it('holds what a partner’s people do with keys and webhooks', async () => {
    const partner = await activePartner();
    const api = exports.PartnerApi as unknown as PartnerApi;
    unwrap(await api.recordIntegration(partner.orgId, 'user-1', 'key_created', 'emk_abc'));
    expect(await api.recordIntegration(partner.orgId, 'user-1', 'drop_tables', 'x')).toMatchObject({
      error: 'invalid_action',
    });
    expect(await api.recordIntegration('no-org', 'user-1', 'key_created', 'x')).toMatchObject({
      error: 'not_a_partner',
    });
    const log = unwrap(await auditLog(db(), { subject: `partner:${partner.id}` }));
    expect(log.events.find((e) => e.action.startsWith('integration.'))).toMatchObject({
      action: 'integration.key_created',
      actor: `partner:${partner.id}/user-1`,
      detail: { what: 'emk_abc' },
    });
  });
});

describe('two staff deciding at once', () => {
  it('apply a rejection and its strike once', async () => {
    const { agent, claim } = await reported();
    const at = T0 + 2 * HOUR;
    const results = await Promise.all([
      rejectDelivery(db(), 'staff-1', claim.id, { reason: 'wrong car', strike: true }, at),
      rejectDelivery(db(), 'staff-2', claim.id, { reason: 'wrong car', strike: true }, at),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const row = await db()
      .prepare('SELECT strikes FROM agents WHERE user_id = ?')
      .bind(agent)
      .first<{ strikes: number }>();
    expect(row?.strikes).toBe(1);
    const events = await db()
      .prepare(
        `SELECT count(*) AS n FROM audit_events WHERE subject = ? AND action = 'delivery.rejected'`,
      )
      .bind(`claim:${claim.id}`)
      .first<{ n: number }>();
    expect(events?.n).toBe(1);
  });
});
