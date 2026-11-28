import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { deleteUser, exportUser } from '../src/account-events';
import {
  REQUESTS_PER_MONTH,
  declineInvitationRequest,
  invitationRequest,
  myInvitationRequest,
  nameKey,
  purgeInvitationRequests,
  requestInvitation,
} from '../src/invitation-requests';
import type { Mail } from '../src/mail';
import { mailRoute, setMailRoute } from '../src/mail-routes';
import type { ControlApi } from '../src/index';
import { db, T0, unwrap } from './helpers';

const DAY = 86_400;
const control = () => exports.ControlApi as unknown as ControlApi;

function mailbox() {
  const sent: Mail[] = [];
  const send = (mail: Mail) => {
    sent.push(mail);
    return Promise.resolve(true);
  };
  return { sent, send };
}

const input = (over: Record<string, string> = {}) => ({
  company: 'Örnek Varlık Yönetim A.Ş.',
  kind: 'vys',
  contactName: 'Zeynep Kaya',
  contactEmail: 'Zeynep@Ornek.example',
  phone: '+90 212 555 00 00',
  jobTitle: 'Hukuk Müdürü',
  volume: 'medium',
  message: 'Yaklaşık 300 dosyamız var.',
  locale: 'tr',
  ...over,
});

describe('invitation requests', () => {
  it('records a request, emails the team at its address and the person a receipt', async () => {
    const box = mailbox();
    const user = crypto.randomUUID();
    unwrap(await setMailRoute(db(), 'admin-1', 'invitation_requests', 'Ekip@Emanet.dev', T0));
    expect(await mailRoute(db(), 'invitation_requests')).toBe('ekip@emanet.dev');
    const { id } = unwrap(
      await requestInvitation(db(), box.send, 'https://merkez.test', user, input(), T0),
    );
    const team = box.sent.find((m) => m.to === 'ekip@emanet.dev');
    expect(team?.subject).toContain('Örnek Varlık Yönetim A.Ş.');
    expect(team?.action?.url).toBe(`https://merkez.test/onboarding/requests/${id}`);
    // The team's email names the company, not the person.
    expect(JSON.stringify(team)).not.toContain('Zeynep');
    expect(box.sent.find((m) => m.to === 'zeynep@ornek.example')?.subject).toContain(
      'davet isteğinizi aldık',
    );
    const mine = unwrap(await myInvitationRequest(db(), user));
    expect(mine).toMatchObject({ id, status: 'new', contact_email: 'zeynep@ornek.example' });
    expect(mine).not.toHaveProperty('staff_note');
    // One open request at a time.
    expect(
      await requestInvitation(db(), box.send, 'https://merkez.test', user, input(), T0 + 1),
    ).toEqual({ ok: false, error: 'already_requested' });
    expect(await setMailRoute(db(), 'admin-1', 'invitation_requests', 'not-an-email', T0)).toEqual({
      ok: false,
      error: 'invalid_email',
    });
    expect(await setMailRoute(db(), 'admin-1', 'nowhere', 'a@b.example', T0)).toEqual({
      ok: false,
      error: 'unknown_route',
    });
  });

  it('checks what it is given', async () => {
    const box = mailbox();
    const ask = (over: Record<string, string>) =>
      requestInvitation(db(), box.send, 'https://m', crypto.randomUUID(), input(over), T0);
    expect(await ask({ company: 'x' })).toMatchObject({ error: 'missing_company' });
    expect(await ask({ kind: 'casino' })).toMatchObject({ error: 'invalid_kind' });
    expect(await ask({ contactEmail: 'nope' })).toMatchObject({ error: 'invalid_email' });
    expect(await ask({ phone: 'call me' })).toMatchObject({ error: 'invalid_phone' });
    expect(await ask({ volume: 'huge' })).toMatchObject({ error: 'invalid_volume' });
    expect(box.sent).toHaveLength(0);
  });

  it('declines without a reason to the person, keeps the note for staff, and limits asking again', async () => {
    const box = mailbox();
    const user = crypto.randomUUID();
    for (let i = 0; i < REQUESTS_PER_MONTH; i += 1) {
      const { id } = unwrap(
        await requestInvitation(db(), box.send, 'https://m', user, input(), T0 + i * 10),
      );
      unwrap(
        await declineInvitationRequest(
          db(),
          box.send,
          'admin-1',
          id,
          { note: 'Not a creditor' },
          T0 + i * 10 + 1,
        ),
      );
      expect(unwrap(await invitationRequest(db(), id))).toMatchObject({
        status: 'declined',
        staff_note: 'Not a creditor',
      });
      expect(await declineInvitationRequest(db(), box.send, 'admin-1', id, {}, T0)).toMatchObject({
        error: 'already_handled',
      });
    }
    const declined = box.sent.filter((m) => m.subject.includes('davet isteğiniz hakkında'));
    expect(declined).toHaveLength(REQUESTS_PER_MONTH);
    expect(JSON.stringify(declined)).not.toContain('Not a creditor');
    expect(
      await requestInvitation(db(), box.send, 'https://m', user, input(), T0 + 100),
    ).toMatchObject({ error: 'too_many_requests' });
    // A month later they may ask again.
    unwrap(await requestInvitation(db(), box.send, 'https://m', user, input(), T0 + 31 * DAY));
  });

  it('links an invitation made from a request and closes it', async () => {
    const box = mailbox();
    const user = crypto.randomUUID();
    const { id } = unwrap(await requestInvitation(db(), box.send, 'https://m', user, input(), T0));
    const invited = unwrap(
      await control().inviteCompany(
        'admin-1',
        {
          company: 'Örnek Varlık Yönetim A.Ş.',
          kind: 'vys',
          contactName: 'Zeynep Kaya',
          contactEmail: `zeynep-${crypto.randomUUID().slice(0, 6)}@ornek.example`,
          locale: 'tr',
          priceList: { default_kurus: 1_000_000, rules: [] },
        },
        id,
      ),
    );
    expect(unwrap(await invitationRequest(db(), id))).toMatchObject({
      status: 'invited',
      onboarding_id: invited.id,
    });
    expect(unwrap(await control().invitationRequests('new')).some((r) => r.id === id)).toBe(false);
  });

  it('deletes handled requests after their time, and with the account', async () => {
    const box = mailbox();
    const user = crypto.randomUUID();
    const { id } = unwrap(await requestInvitation(db(), box.send, 'https://m', user, input(), T0));
    unwrap(await declineInvitationRequest(db(), box.send, 'admin-1', id, { tell: false }, T0));
    expect(box.sent.some((m) => m.subject.includes('hakkında'))).toBe(false);
    expect((await exportUser(db(), user)).invitation_requests).toHaveLength(1);
    await purgeInvitationRequests(db(), T0 + 364 * DAY);
    expect(await invitationRequest(db(), id)).toMatchObject({ ok: true });
    expect(await purgeInvitationRequests(db(), T0 + 366 * DAY)).toBeGreaterThanOrEqual(1);
    expect(await invitationRequest(db(), id)).toMatchObject({ error: 'not_found' });
    const other = crypto.randomUUID();
    const open = unwrap(await requestInvitation(db(), box.send, 'https://m', other, input(), T0));
    await deleteUser(db(), other, T0 + 1);
    expect(await invitationRequest(db(), open.id)).toMatchObject({ error: 'not_found' });
  });

  it('keeps a name on one line, and shows staff what a request may duplicate', async () => {
    const box = mailbox();
    const user = crypto.randomUUID();
    const { id } = unwrap(
      await requestInvitation(
        db(),
        box.send,
        'https://m',
        user,
        input({
          company: 'Örnek\r\nBcc: x@evil.example Bank A.Ş.',
          contactEmail: `z-${user.slice(0, 6)}@ornek.example`,
        }),
        T0,
      ),
    );
    const saved = unwrap(await invitationRequest(db(), id));
    expect(saved.company).not.toMatch(/[\r\n]/);
    expect(box.sent.every((m) => !/[\r\n]/.test(m.subject))).toBe(true);
    expect(nameKey('ÖRNEK Bank A.Ş.')).toBe(nameKey('Örnek Bank'));
    const partnerOrg = `org_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await db()
      .prepare(
        `INSERT INTO partners (id, org_id, kind, legal_name, vkn, status, created_by, created_at, updated_at)
         VALUES (?, ?, 'bank', 'ÖRNEK BCC X EVIL EXAMPLE BANK A.Ş.', '5555555555', 'active', 'staff-1', ?, ?)`,
      )
      .bind(crypto.randomUUID(), partnerOrg, T0, T0)
      .run();
    const full = unwrap(await control().invitationRequest(id));
    expect(full.matches.earlier).toBe(0);
    expect(full.matches.partners.map((p) => p.legal_name)).toContain(
      'ÖRNEK BCC X EVIL EXAMPLE BANK A.Ş.',
    );
  });
});
