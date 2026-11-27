import { exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { partnerByOrg } from '../src/cases';
import { renderContract } from '../src/contract';
import type { ControlApi, PartnerApi, PublicApi } from '../src/index';
import type { Mail } from '../src/mail';
import {
  addDocument,
  approve,
  cancel,
  claim,
  contractFor,
  invitationByToken,
  invite,
  linkOrganization,
  listOnboardings,
  onboardingForStaff,
  onboardingForUser,
  reject,
  remindAndExpire,
  reopen,
  resend,
  saveDetails,
  sign,
  INVITATION_TTL,
  type Invitation,
} from '../src/onboarding';
import { setProvider } from '../src/provider';
import { db, T0, unwrap } from './helpers';

const DAY = 86_400;
const ORIGINS = {
  kurumsal: 'https://kurumsal.test',
  merkez: 'https://merkez.test',
  staffEmail: 'staff@example.test',
};

function outbox() {
  const sent: Mail[] = [];
  const send = (mail: Mail) => {
    sent.push(mail);
    return Promise.resolve(true);
  };
  /** The secret from the last invitation link sent. */
  const token = () => {
    const url = [...sent].reverse().find((m) => m.action?.url.includes('/join/'))?.action?.url;
    return url ? url.slice(url.lastIndexOf('/') + 1) : '';
  };
  return { sent, send, token };
}

const invitation = (overrides: Partial<Invitation> = {}): Invitation => ({
  company: 'Örnek Bank',
  kind: 'bank',
  contactName: 'Ayşe Yılmaz',
  contactEmail: `ops-${crypto.randomUUID().slice(0, 8)}@ornekbank.example`,
  locale: 'tr',
  priceList: { default_kurus: 1_500_000, rules: [{ make: 'Ford', fee_kurus: 2_000_000 }] },
  ...overrides,
});

const DETAILS = {
  legalName: 'Örnek Bank A.Ş.',
  address: 'Büyükdere Cad. No: 1, Şişli, İstanbul',
  taxOffice: 'Büyük Mükellefler',
  vkn: '1234567890',
  mersis: '0123456789012345',
  kep: 'ornekbank@hs01.kep.tr',
  signatoryName: 'Mehmet Demir',
  signatoryTitle: 'Genel Müdür Yardımcısı',
  billingEmail: 'fatura@ornekbank.example',
  operationsName: 'Ayşe Yılmaz',
  operationsEmail: 'ops@ornekbank.example',
  operationsPhone: '+90 212 555 00 00',
  eInvoice: true,
};

const orgId = () => `org_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

/** Invited, claimed, organization linked, details saved: ready to sign. */
async function ready(box = outbox()) {
  const { id } = unwrap(await invite(db(), box.send, ORIGINS, 'staff-1', invitation(), T0));
  const user = crypto.randomUUID();
  unwrap(await claim(db(), box.token(), user, T0 + 60));
  const org = orgId();
  unwrap(await linkOrganization(db(), id, user, org, T0 + 120));
  unwrap(await saveDetails(db(), id, user, DETAILS, T0 + 180));
  return { id, user, org, box };
}

async function signNow(id: string, user: string, box: ReturnType<typeof outbox>, at = T0 + 240) {
  const contract = unwrap(await contractFor(db(), id, user, at));
  return sign(
    db(),
    box.send,
    ORIGINS,
    id,
    user,
    {
      version: contract.version,
      sha256: contract.sha256,
      name: 'Mehmet Demir',
      title: 'Genel Müdür Yardımcısı',
      ip: '192.0.2.1',
      authorised: true,
    },
    at,
  );
}

const PROVIDER = {
  name: '2earl Teknoloji A.Ş.',
  address: 'Maslak Mah. Büyükdere Cad. No: 255, Sarıyer, İstanbul',
  taxOffice: 'Maslak',
  vkn: '0123456789',
  mersis: '0012345678900015',
  kep: '2earl@hs01.kep.tr',
  email: 'iletisim@emanet.dev',
};

describe('onboarding', () => {
  beforeEach(async () => {
    unwrap(await setProvider(db(), 'staff-1', PROVIDER, T0));
  });

  it('runs from invitation to an active partner', async () => {
    const box = outbox();
    const { id, user, org } = await ready(box);
    // The invitation went to the contact, with a link to Kurumsal; only its hash is stored.
    expect(box.sent[0]?.to).toMatch(/@ornekbank\.example$/);
    expect(box.sent[0]?.action?.url).toMatch(/^https:\/\/kurumsal\.test\/join\/[A-Za-z0-9_-]{43}$/);
    const stored = await db()
      .prepare('SELECT token_hash FROM onboardings WHERE id = ?')
      .bind(id)
      .first<{ token_hash: string }>();
    expect(stored?.token_hash).not.toContain(box.token());

    unwrap(await signNow(id, user, box));
    // A receipt to the signer, with the hash; a note to staff.
    const receipt = box.sent.find((m) => m.subject.includes('sözleşmesi onaylandı'));
    expect(receipt?.paragraphs.join(' ')).toMatch(/[0-9a-f]{64}/);
    expect(box.sent.at(-1)?.to).toBe('staff@example.test');

    const staffView = unwrap(await onboardingForStaff(db(), id));
    expect(staffView.status).toBe('signed');
    expect(staffView.contract_text).toContain('Örnek Bank A.Ş.');
    expect(staffView.contract_text).toContain('Ford: 20.000,00 TL');

    // The inviter can't approve their own invitation.
    expect(await approve(db(), box.send, ORIGINS, 'staff-1', id, T0 + 300)).toMatchObject({
      error: 'four_eyes',
    });
    const { partnerId } = unwrap(await approve(db(), box.send, ORIGINS, 'staff-2', id, T0 + 300));
    const partner = await partnerByOrg(db(), org);
    expect(partner).toMatchObject({
      id: partnerId,
      status: 'active',
      legalName: 'Örnek Bank A.Ş.',
    });
    const row = await db()
      .prepare('SELECT billing_email, contract_signed_at, onboarding_id FROM partners WHERE id = ?')
      .bind(partnerId)
      .first();
    expect(row).toEqual({
      billing_email: 'fatura@ornekbank.example',
      contract_signed_at: T0 + 240,
      onboarding_id: id,
    });
    const prices = await db()
      .prepare('SELECT rules FROM price_lists WHERE partner_id = ?')
      .bind(partnerId)
      .first<{ rules: string }>();
    expect(JSON.parse(prices?.rules ?? '{}')).toMatchObject({ default_kurus: 1_500_000 });
    expect(box.sent.at(-1)?.subject).toContain('etkin');
    expect(box.sent.at(-1)?.action?.url).toBe(`https://kurumsal.test/o/${org}`);

    // A second approval does nothing.
    expect(await approve(db(), box.send, ORIGINS, 'staff-2', id, T0 + 400)).toMatchObject({
      error: 'not_signed',
    });
    const audit = await db()
      .prepare(`SELECT action FROM audit_events WHERE subject = ? ORDER BY at, action`)
      .bind(`onboarding:${id}`)
      .all<{ action: string }>();
    expect(audit.results.map((r) => r.action)).toEqual([
      'onboarding.invited',
      'onboarding.claimed',
      'onboarding.org_linked',
      'onboarding.details_saved',
      'onboarding.signed',
      'onboarding.approved',
    ]);
  });

  it('refuses a second open invitation to the same address, in any case', async () => {
    const box = outbox();
    const input = invitation();
    unwrap(await invite(db(), box.send, ORIGINS, 'staff-1', input, T0));
    expect(
      await invite(
        db(),
        box.send,
        ORIGINS,
        'staff-1',
        { ...input, contactEmail: input.contactEmail.toUpperCase() },
        T0,
      ),
    ).toMatchObject({ error: 'already_invited' });
  });

  it('checks the invitation', async () => {
    const { send } = outbox();
    for (const [overrides, error] of [
      [{ company: ' ' }, 'missing_company'],
      [{ contactEmail: 'not-an-address' }, 'invalid_email'],
      [{ priceList: { default_kurus: 0, rules: [] } }, 'invalid_price_list'],
      [{ reconfirmDays: 0 }, 'invalid_reconfirm_days'],
      [{ kind: 'casino' as never }, 'invalid_kind'],
    ] as const) {
      expect(await invite(db(), send, ORIGINS, 'staff-1', invitation(overrides), T0)).toMatchObject(
        {
          error,
        },
      );
    }
  });

  it('lets only the first account take the invitation', async () => {
    const box = outbox();
    unwrap(await invite(db(), box.send, ORIGINS, 'staff-1', invitation(), T0));
    const first = crypto.randomUUID();
    unwrap(await claim(db(), box.token(), first, T0));
    // Again by the same account: fine. By another: refused.
    unwrap(await claim(db(), box.token(), first, T0 + 1));
    expect(await claim(db(), box.token(), crypto.randomUUID(), T0 + 2)).toMatchObject({
      error: 'claimed_by_another',
    });
    expect(await claim(db(), 'x'.repeat(43), first, T0)).toMatchObject({ error: 'not_found' });
    expect(await claim(db(), 'short', first, T0)).toMatchObject({ error: 'not_found' });
  });

  it('keeps one account out of another’s onboarding', async () => {
    const { id } = await ready();
    const stranger = crypto.randomUUID();
    expect(await onboardingForUser(db(), id, stranger, T0)).toMatchObject({ error: 'not_found' });
    expect(await saveDetails(db(), id, stranger, DETAILS, T0)).toMatchObject({
      error: 'not_found',
    });
    expect(await contractFor(db(), id, stranger, T0)).toMatchObject({ error: 'not_found' });
  });

  it('checks the company’s details', async () => {
    const { id, user } = await ready();
    for (const [field, value] of [
      ['vkn', '12345'],
      ['mersis', '123'],
      ['billingEmail', 'nope'],
      ['signatoryName', 'Mehmet'],
      ['operationsPhone', 'call me'],
      ['address', 'short'],
    ] as const) {
      expect(await saveDetails(db(), id, user, { ...DETAILS, [field]: value }, T0)).toMatchObject({
        error: 'invalid_details',
        detail: field,
      });
    }
    // Newlines can't reach a subject line or the contract.
    const saved = unwrap(
      await saveDetails(db(), id, user, { ...DETAILS, legalName: 'Örnek\r\nBcc: x@y.z Bank' }, T0),
    );
    expect(saved.legalName).toBe('Örnek Bcc: x@y.z Bank');
  });

  it('refuses a signature on text that changed since it was shown', async () => {
    const box = outbox();
    const { id, user } = await ready(box);
    const shown = unwrap(await contractFor(db(), id, user, T0 + 200));
    unwrap(
      await saveDetails(db(), id, user, { ...DETAILS, signatoryTitle: 'Genel Müdür' }, T0 + 210),
    );
    const input = {
      version: shown.version,
      sha256: shown.sha256,
      name: 'Mehmet Demir',
      title: 'Genel Müdür',
      ip: null,
      authorised: true,
    };
    expect(await sign(db(), box.send, ORIGINS, id, user, input, T0 + 220)).toMatchObject({
      error: 'contract_changed',
    });
    expect(
      await sign(db(), box.send, ORIGINS, id, user, { ...input, authorised: false }, T0 + 220),
    ).toMatchObject({ error: 'not_authorised' });
  });

  it('needs an organization before signing, and one organization per company', async () => {
    const box = outbox();
    const { id } = unwrap(await invite(db(), box.send, ORIGINS, 'staff-1', invitation(), T0));
    const user = crypto.randomUUID();
    unwrap(await claim(db(), box.token(), user, T0));
    unwrap(await saveDetails(db(), id, user, DETAILS, T0));
    expect(await signNow(id, user, box)).toMatchObject({ error: 'org_missing' });
    expect(await linkOrganization(db(), id, user, 'not an org', T0)).toMatchObject({
      error: 'invalid_org',
    });
    const other = await ready();
    expect(await linkOrganization(db(), id, user, other.org, T0)).toMatchObject({
      error: 'org_in_use',
    });
  });

  it('takes documents, under the onboarding’s own prefix, until staff decide', async () => {
    const box = outbox();
    const { id, user } = await ready(box);
    const doc = {
      kind: 'signature_circular' as const,
      file_ref: `onboarding/${id}/${crypto.randomUUID()}`,
      sha256: 'a'.repeat(64),
      file_name: 'imza-sirküleri.pdf',
      content_type: 'application/pdf',
      size: 120_000,
    };
    unwrap(await addDocument(db(), id, user, doc, T0));
    expect(
      await addDocument(db(), id, user, { ...doc, file_ref: 'onboarding/other/x' }, T0),
    ).toMatchObject({ error: 'invalid_ref' });
    unwrap(await signNow(id, user, box));
    // A wet-signed copy can follow the acceptance.
    unwrap(await addDocument(db(), id, user, { ...doc, kind: 'signed_contract' }, T0 + 300));
    unwrap(await reject(db(), box.send, 'staff-2', id, 'Imza yetkisi doğrulanamadı', T0 + 400));
    expect(await addDocument(db(), id, user, doc, T0 + 500)).toMatchObject({
      error: 'not_editable',
    });
    expect(unwrap(await onboardingForUser(db(), id, user, T0)).documents).toHaveLength(2);
  });

  it('sends a signed onboarding back for changes, clearing the acceptance', async () => {
    const box = outbox();
    const { id, user } = await ready(box);
    unwrap(await signNow(id, user, box));
    unwrap(await reopen(db(), box.send, ORIGINS, 'staff-2', id, 'Adres eksik', T0 + 300));
    const back = unwrap(await onboardingForUser(db(), id, user, T0 + 300));
    expect(back).toMatchObject({
      status: 'in_progress',
      contract_sha256: null,
      contract_text: null,
    });
    expect(box.sent.at(-1)?.paragraphs[0]).toContain('Adres eksik');
    unwrap(
      await saveDetails(
        db(),
        id,
        user,
        { ...DETAILS, address: 'Levent Mah., Beşiktaş, İstanbul' },
        T0 + 400,
      ),
    );
    unwrap(await signNow(id, user, box, T0 + 500));
    unwrap(await approve(db(), box.send, ORIGINS, 'staff-2', id, T0 + 600));
  });

  it('keeps every acceptance, even after a send-back, and never changes it', async () => {
    const box = outbox();
    const { id, user } = await ready(box);
    unwrap(await signNow(id, user, box));
    unwrap(await reopen(db(), box.send, ORIGINS, 'staff-2', id, 'Adres eksik', T0 + 300));
    unwrap(
      await saveDetails(
        db(),
        id,
        user,
        { ...DETAILS, address: 'Levent Mah., Beşiktaş, İstanbul' },
        T0 + 400,
      ),
    );
    unwrap(await signNow(id, user, box, T0 + 500));
    const staff = unwrap(await onboardingForStaff(db(), id));
    expect(staff.acceptances).toHaveLength(2);
    expect(staff.acceptances[0]?.contract_sha256).not.toBe(staff.acceptances[1]?.contract_sha256);
    expect(staff.acceptances[1]?.contract_sha256).toBe(staff.contract_sha256);
    await expect(
      db().prepare("UPDATE onboarding_acceptances SET signer_name = 'x'").run(),
    ).rejects.toThrow(/immutable/);
    await expect(db().prepare('DELETE FROM onboarding_acceptances').run()).rejects.toThrow(
      /immutable/,
    );
  });

  it('records a refused acceptance nowhere', async () => {
    const box = outbox();
    const { id, user } = await ready(box);
    unwrap(await signNow(id, user, box));
    // A second acceptance of an already signed onboarding is refused and leaves no trace.
    expect(await signNow(id, user, box, T0 + 260)).toMatchObject({ error: 'not_editable' });
    const signed = await db()
      .prepare(
        `SELECT count(*) AS n FROM audit_events WHERE action = 'onboarding.signed' AND subject = ?`,
      )
      .bind(`onboarding:${id}`)
      .first<{ n: number }>();
    expect(signed?.n).toBe(1);
  });

  it('cancels and rejects, with a reason', async () => {
    const box = outbox();
    const { id } = unwrap(await invite(db(), box.send, ORIGINS, 'staff-1', invitation(), T0));
    expect(await cancel(db(), 'staff-1', id, ' ', T0)).toMatchObject({ error: 'invalid_reason' });
    unwrap(await cancel(db(), 'staff-1', id, 'Yanlış adres', T0));
    expect(await invitationByToken(db(), box.token(), T0)).toMatchObject({ error: 'not_found' });
    // Rejecting needs the company to have started.
    const other = unwrap(await invite(db(), box.send, ORIGINS, 'staff-1', invitation(), T0));
    expect(await reject(db(), box.send, 'staff-1', other.id, 'Hayır', T0)).toMatchObject({
      error: 'not_open',
    });
  });

  it('sends a new link that replaces the old one, not too often', async () => {
    const box = outbox();
    const { id } = unwrap(await invite(db(), box.send, ORIGINS, 'staff-1', invitation(), T0));
    const old = box.token();
    expect(await resend(db(), box.send, ORIGINS, 'staff-1', id, T0 + 60)).toMatchObject({
      error: 'sent_recently',
    });
    unwrap(await resend(db(), box.send, ORIGINS, 'staff-1', id, T0 + 3600));
    expect(box.token()).not.toBe(old);
    expect(await invitationByToken(db(), old, T0 + 3600)).toMatchObject({ error: 'not_found' });
    unwrap(await invitationByToken(db(), box.token(), T0 + 3600));
  });

  it('reminds after 3 and 7 days, then expires; staff can start it again', async () => {
    const box = outbox();
    const input = invitation();
    const { id } = unwrap(await invite(db(), box.send, ORIGINS, 'staff-1', input, T0));
    const mine = () => box.sent.filter((m) => m.to === input.contactEmail);
    const sent = () => mine().filter((m) => m.subject.startsWith('Hatırlatma')).length;
    await remindAndExpire(db(), box.send, ORIGINS, T0 + 2 * DAY);
    expect(sent()).toBe(0);
    await remindAndExpire(db(), box.send, ORIGINS, T0 + 3 * DAY);
    await remindAndExpire(db(), box.send, ORIGINS, T0 + 3 * DAY + 300);
    expect(sent()).toBe(1);
    await remindAndExpire(db(), box.send, ORIGINS, T0 + 7 * DAY);
    expect(sent()).toBe(2);
    // The reminder's link works; it replaced the first one.
    const link = mine().at(-1)?.action?.url ?? '';
    const token = link.slice(link.lastIndexOf('/') + 1);
    unwrap(await invitationByToken(db(), token, T0 + 7 * DAY));
    await remindAndExpire(db(), box.send, ORIGINS, T0 + INVITATION_TTL);
    expect(unwrap(await onboardingForStaff(db(), id)).status).toBe('expired');
    expect(await invitationByToken(db(), token, T0 + INVITATION_TTL)).toMatchObject({
      error: 'not_found',
    });
    unwrap(await resend(db(), box.send, ORIGINS, 'staff-1', id, T0 + INVITATION_TTL + 60));
    expect(unwrap(await onboardingForStaff(db(), id)).status).toBe('invited');
  });

  it('lists signed onboardings first', async () => {
    const box = outbox();
    const { id, user } = await ready(box);
    unwrap(await signNow(id, user, box));
    const list = unwrap(await listOnboardings(db(), null));
    expect(list[0]?.status).toBe('signed');
    expect(unwrap(await listOnboardings(db(), 'signed')).every((o) => o.status === 'signed')).toBe(
      true,
    );
  });

  it('can’t be accepted while 2earl’s own details are missing', async () => {
    const box = outbox();
    const { id, user } = await ready(box);
    await db().prepare('DELETE FROM provider_details').run();
    try {
      const contract = unwrap(await contractFor(db(), id, user, T0 + 200));
      expect(contract.final).toBe(false);
      expect(contract.text).toContain('[2earl Türkiye şirketinin ticaret unvanı]');
      expect(await signNow(id, user, box)).toMatchObject({ error: 'provider_incomplete' });
    } finally {
      unwrap(await setProvider(db(), 'staff-1', PROVIDER, T0));
    }
    const contract = unwrap(await contractFor(db(), id, user, T0 + 300));
    expect(contract.final).toBe(true);
    expect(contract.text).toContain('2earl Teknoloji A.Ş.');
    expect(contract.text).not.toContain('[2earl');
  });

  it('checks 2earl’s own details and audits every change', async () => {
    expect(await setProvider(db(), 'staff-1', { ...PROVIDER, vkn: '123' }, T0)).toMatchObject({
      error: 'invalid_provider',
      detail: 'vkn',
    });
    expect(await setProvider(db(), 'staff-1', { ...PROVIDER, mersis: '' }, T0)).toMatchObject({
      detail: 'mersis',
    });
    unwrap(
      await setProvider(
        db(),
        'staff-2',
        { ...PROVIDER, address: 'Levent, Beşiktaş, İstanbul' },
        T0 + 5,
      ),
    );
    const audit = await db()
      .prepare(
        `SELECT detail FROM audit_events WHERE action = 'provider.updated' ORDER BY at DESC LIMIT 1`,
      )
      .first<{ detail: string }>();
    expect(JSON.parse(audit?.detail ?? '{}')).toMatchObject({
      before: { address: PROVIDER.address },
      after: { address: 'Levent, Beşiktaş, İstanbul' },
    });
    unwrap(await setProvider(db(), 'staff-1', PROVIDER, T0 + 6));
  });

  it('renders the agreement the same way twice, and differently for different details', async () => {
    const a = await renderContract(DETAILS, null, 14);
    const b = await renderContract(DETAILS, null, 14);
    const c = await renderContract({ ...DETAILS, vkn: '9999999999' }, null, 14);
    expect(a.sha256).toBe(b.sha256);
    expect(c.sha256).not.toBe(a.sha256);
    expect(a.text).not.toMatch(/\{\{/);
  });

  it('records staff looking at a company’s documents', async () => {
    const control = exports.ControlApi as unknown as ControlApi;
    unwrap(await control.recordView('staff-1', 'onboarding:abc', 'document d-1'));
    expect(await control.recordView('staff-1', 'partner; DROP', 'x')).toMatchObject({
      error: 'invalid_subject',
    });
    const row = await db()
      .prepare(`SELECT actor, detail FROM audit_events WHERE action = 'staff.viewed'`)
      .first<{ actor: string; detail: string }>();
    expect(row).toEqual({ actor: 'staff:staff-1', detail: '{"what":"document d-1"}' });
  });

  it('tells the public site 2earl’s company details, once set', async () => {
    const pub = exports.PublicApi as unknown as PublicApi;
    expect(unwrap(await pub.company())).toMatchObject({
      name: PROVIDER.name,
      mersis: PROVIDER.mersis,
    });
    await db().prepare('DELETE FROM provider_details').run();
    expect(unwrap(await pub.company())).toBeNull();
  });

  it('is reachable over the entrypoints', async () => {
    const control = exports.ControlApi as unknown as ControlApi;
    const partner = exports.PartnerApi as unknown as PartnerApi;
    const { id } = unwrap(await control.inviteCompany('staff-1', invitation()));
    expect(unwrap(await control.onboarding(id)).status).toBe('invited');
    expect(await partner.onboardingInvitation('nope')).toMatchObject({ error: 'not_found' });
    expect(unwrap(await partner.myOnboardings(crypto.randomUUID()))).toEqual([]);
  });
});
