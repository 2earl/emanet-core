import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { upsertCase, withdrawCase } from '../src/cases';
import { addEvidence, claimVehicle, recordSighting } from '../src/claims';
import type { PartnerApi } from '../src/index';
import { confirmDelivery, issueInvoice } from '../src/ledger';
import {
  caseDocument,
  caseDocuments,
  invoice,
  invoices,
  report,
  timeline,
} from '../src/partner-views';
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
const DAY = 86_400;
const hash = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

/** One partner's vehicle found, documented and delivered; another case of theirs withdrawn. */
async function delivered() {
  await payoutRule(5000);
  const partner = await activePartner({ default_kurus: 1_000_000, rules: [] });
  const other = await activePartner();
  const vin = randomVin();
  const kase = unwrap(
    await upsertCase(db(), partner, caseInput({ vin, plate: randomPlate() }), 'u', T0),
  );
  const otherCase = unwrap(await upsertCase(db(), other, caseInput({ vin }), 'u', T0));
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
  for (const [kind, at] of [
    ['scene', T0 + HOUR],
    ['yediemin_receipt', T0 + 3 * HOUR],
  ] as const) {
    unwrap(
      await addEvidence(
        db(),
        agent,
        claim.id,
        { kind, file_ref: `claims/${claim.id}/${kind}`, sha256: hash() },
        at,
      ),
    );
  }
  unwrap(await confirmDelivery(db(), 'staff-1', claim.id, T0 + 2 * DAY));
  const withdrawn = unwrap(
    await upsertCase(db(), partner, caseInput({ vin: randomVin() }), 'u', T0),
  );
  unwrap(await withdrawCase(db(), partner, withdrawn.id, 'Ödendi', 'u', T0 + DAY));
  return { partner, other, kase, otherCase, agent };
}

describe('what a partner sees', () => {
  it('shows a case’s states and times, nothing about who', async () => {
    const { partner, other, kase } = await delivered();
    const events = unwrap(await timeline(db(), partner, kase.id));
    expect(events.map((e) => e.event)).toEqual(['created', 'delivered']);
    expect(events[1]?.at).toBe(T0 + 2 * DAY);
    expect(JSON.stringify(events)).not.toContain('staff');
    expect(await timeline(db(), other, kase.id)).toMatchObject({ error: 'not_found' });
  });

  it('gives a delivered case’s accepted documents to its partner only, and records each look', async () => {
    const { partner, other, kase } = await delivered();
    const docs = unwrap(await caseDocuments(db(), partner, kase.id));
    expect(docs.map((d) => d.kind)).toEqual(['scene', 'yediemin_receipt']);
    // Another creditor of the same vehicle doesn't see this case's documents.
    expect(unwrap(await caseDocuments(db(), other, kase.id))).toEqual([]);
    const first = docs[0];
    const ref = unwrap(
      await caseDocument(db(), partner, 'partner:x/u-1', kase.id, first?.id ?? '', T0 + 3 * DAY),
    );
    expect(ref.file_ref).toMatch(/^claims\//);
    expect(
      await caseDocument(db(), other, 'partner:y/u', kase.id, first?.id ?? '', T0),
    ).toMatchObject({
      error: 'not_found',
    });
    const looked = await db()
      .prepare(
        `SELECT actor FROM audit_events WHERE action = 'case.document_viewed' AND subject = ?`,
      )
      .bind(`case:${kase.id}`)
      .all<{ actor: string }>();
    expect(looked.results).toEqual([{ actor: 'partner:x/u-1' }]);
    // Nothing for a case that isn't delivered.
    const open = unwrap(await upsertCase(db(), partner, caseInput(), 'u', T0));
    expect(unwrap(await caseDocuments(db(), partner, open.id))).toEqual([]);
  });

  it('lists its invoices with their cases', async () => {
    const { partner, other, kase } = await delivered();
    const issued = unwrap(await issueInvoice(db(), 'staff-1', partner.id, T0 + 3 * DAY));
    const list = unwrap(await invoices(db(), partner));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: issued.id,
      cases: 1,
      net_kurus: 1_000_000,
      status: 'issued',
    });
    const detail = unwrap(await invoice(db(), partner, issued.id));
    expect(detail.lines).toEqual([
      expect.objectContaining({
        case_id: kase.id,
        external_ref: kase.external_ref,
        net_kurus: 1_000_000,
      }),
    ]);
    expect(detail.lines[0]?.plate).toBe(kase.vehicle.plate);
    expect(await invoice(db(), other, issued.id)).toMatchObject({ error: 'not_found' });
  });

  it('reports by month, with the recovery rate and cities', async () => {
    const { partner } = await delivered();
    const r = unwrap(await report(db(), partner, T0 + 5 * DAY));
    expect(r.delivered_total).toBe(1);
    expect(r.recovery_rate).toBe(0.5);
    const month = r.months[0];
    expect(month).toMatchObject({
      added: 2,
      delivered: 1,
      withdrawn: 1,
      fees_kurus: 1_000_000,
      days_to_custody: 2,
    });
    expect(r.by_city.length).toBeGreaterThan(0);
  });

  it('is reachable over PartnerApi', async () => {
    const { partner, kase } = await delivered();
    const api = exports.PartnerApi as unknown as PartnerApi;
    expect(unwrap(await api.caseTimeline(partner.orgId, kase.id))).toHaveLength(2);
    expect(unwrap(await api.caseDocuments(partner.orgId, kase.id))).toHaveLength(2);
    expect(unwrap(await api.invoices(partner.orgId))).toEqual([]);
    expect(unwrap(await api.report(partner.orgId)).open).toBe(0);
    expect(await api.report('nobody')).toMatchObject({ error: 'not_a_partner' });
  });
});
