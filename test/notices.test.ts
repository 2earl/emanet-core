import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { upsertCase } from '../src/cases';
import { addEvidence, claimVehicle, recordSighting } from '../src/claims';
import type { ControlApi } from '../src/index';
import { confirmDelivery } from '../src/ledger';
import type { Mail } from '../src/mail';
import { sendNotices } from '../src/notices';
import { setProvider } from '../src/provider';
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
const KURUMSAL = 'https://kurumsal.test';
const hash = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

function outbox() {
  const sent: Mail[] = [];
  return {
    sent,
    send: (mail: Mail) => {
      sent.push(mail);
      return Promise.resolve(true);
    },
  };
}

async function partnerWithContact() {
  const partner = await activePartner();
  await db()
    .prepare("UPDATE partners SET contact_email = 'ops@bank.example' WHERE id = ?")
    .bind(partner.id)
    .run();
  return partner;
}

async function deliver(partner: Awaited<ReturnType<typeof activePartner>>, at: number) {
  await payoutRule(5000);
  const vin = randomVin();
  const kase = unwrap(
    await upsertCase(db(), partner, caseInput({ vin, plate: randomPlate() }), 'u', at),
  );
  const vehicle = await db()
    .prepare('SELECT id FROM vehicles WHERE vin = ?')
    .bind(vin)
    .first<{ id: string }>();
  const agent = await activeAgent();
  const claim = unwrap(await claimVehicle(db(), agent, vehicle?.id ?? '', at));
  unwrap(
    await recordSighting(
      db(),
      agent,
      claim.id,
      { lat: 41, lng: 29, taken_at: at + HOUR },
      at + HOUR,
    ),
  );
  for (const kind of ['scene', 'yediemin_receipt'] as const) {
    unwrap(
      await addEvidence(
        db(),
        agent,
        claim.id,
        { kind, file_ref: `r2://${kind}`, sha256: hash() },
        at + HOUR,
      ),
    );
  }
  unwrap(await confirmDelivery(db(), 'staff-1', claim.id, at + 2 * HOUR));
  return kase;
}

describe('partner notices', () => {
  it('mails each delivery once, at most hourly', async () => {
    const partner = await partnerWithContact();
    const box = outbox();
    const kase = await deliver(partner, T0);
    expect(await sendNotices(db(), box.send, KURUMSAL, T0 + 3 * HOUR)).toMatchObject({
      delivered: 1,
    });
    expect(box.sent[0]?.to).toBe('ops@bank.example');
    expect(box.sent[0]?.subject).toContain('yedieminde');
    expect(box.sent[0]?.paragraphs.join(' ')).toContain(
      `${KURUMSAL}/o/${partner.orgId}/cases/${kase.id}`,
    );
    // Nothing new: nothing sent.
    await sendNotices(db(), box.send, KURUMSAL, T0 + 5 * HOUR);
    expect(box.sent.filter((m) => m.subject.includes('yedieminde'))).toHaveLength(1);
  });

  it('warns once a day about cases about to expire', async () => {
    const partner = await partnerWithContact();
    const box = outbox();
    unwrap(await upsertCase(db(), partner, caseInput(), 'u', T0));
    // Cases expire after reconfirm_days (14): warn from day 11.
    await sendNotices(db(), box.send, KURUMSAL, T0 + 10 * DAY);
    expect(box.sent).toHaveLength(0);
    await sendNotices(db(), box.send, KURUMSAL, T0 + 12 * DAY);
    await sendNotices(db(), box.send, KURUMSAL, T0 + 12 * DAY + HOUR);
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0]?.subject).toContain('süresi doluyor');
    expect(box.sent[0]?.action?.url).toBe(`${KURUMSAL}/o/${partner.orgId}`);
  });

  it('sends nothing to a partner that turned notices off, or without a contact', async () => {
    const partner = await partnerWithContact();
    const silent = await activePartner();
    const box = outbox();
    const control = exports.ControlApi as unknown as ControlApi;
    unwrap(await control.setPartnerNotices('staff-1', partner.id, false));
    unwrap(await upsertCase(db(), partner, caseInput(), 'u', T0));
    unwrap(await upsertCase(db(), silent, caseInput(), 'u', T0));
    await sendNotices(db(), box.send, KURUMSAL, T0 + 12 * DAY);
    expect(box.sent).toHaveLength(0);
  });

  it('tells waiting companies once 2earl’s details make the agreement acceptable', async () => {
    const box = outbox();
    await db().prepare('DELETE FROM provider_details').run();
    const { id } = unwrap(
      await (
        await import('../src/onboarding')
      ).invite(
        db(),
        box.send,
        { kurumsal: KURUMSAL, merkez: 'https://merkez.test', staffEmail: 's@x.test' },
        'staff-1',
        {
          company: 'Örnek',
          kind: 'bank',
          contactName: 'Ayşe Yılmaz',
          contactEmail: 'ayse@ornek.example',
          locale: 'tr',
          priceList: { default_kurus: 100_000, rules: [] },
        },
        T0,
      ),
    );
    await db()
      .prepare(
        `UPDATE onboardings SET status = 'in_progress', claimed_by = 'u-1', details = '{"legalName":"Örnek A.Ş."}' WHERE id = ?`,
      )
      .bind(id)
      .run();
    const details = {
      name: '2earl Teknoloji A.Ş.',
      address: 'Maslak Mah. Büyükdere Cad. No: 255, İstanbul',
      taxOffice: 'Maslak',
      vkn: '0123456789',
      mersis: '0012345678900015',
      kep: '2earl@hs01.kep.tr',
      email: 'iletisim@emanet.dev',
    };
    unwrap(
      await setProvider(db(), 'staff-1', details, T0 + 60, { send: box.send, kurumsal: KURUMSAL }),
    );
    const ready = box.sent.filter((m) => m.subject.includes('onaya hazır'));
    expect(ready).toHaveLength(1);
    expect(ready[0]?.action?.url).toBe(`${KURUMSAL}/onboarding/${id}/agreement`);
    // A later change doesn't send it again.
    unwrap(
      await setProvider(db(), 'staff-1', { ...details, taxOffice: 'Sarıyer' }, T0 + 120, {
        send: box.send,
        kurumsal: KURUMSAL,
      }),
    );
    expect(box.sent.filter((m) => m.subject.includes('onaya hazır'))).toHaveLength(1);
  });
});
