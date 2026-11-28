import { describe, expect, it } from 'vitest';
import { deleteUser } from '../src/account-events';
import { notifyAgentSecurity } from '../src/agent-notices';
import { registerAgent } from '../src/claims';
import { updatePartner } from '../src/control';
import { purgeDeletedAccounts } from '../src/deleted-accounts';
import { requestInvitation } from '../src/invitation-requests';
import { agentMail, maskEmail, maskIban, type Mail } from '../src/mail';
import { claim, invite } from '../src/onboarding';
import { activePartner, db, T0, unwrap } from './helpers';

const outbox = () => {
  const sent: Mail[] = [];
  let token = '';
  return {
    sent,
    token: () => token,
    send: (mail: Mail) => {
      sent.push(mail);
      token = /\/join\/([A-Za-z0-9_-]+)/.exec(mail.action?.url ?? '')?.[1] ?? token;
      return Promise.resolve(true);
    },
  };
};

const ORIGINS = { kurumsal: 'https://k', merkez: 'https://m', staffEmail: 'staff@example.com' };

describe('a deleted account', () => {
  it('can’t start anything new, and its open application stops', async () => {
    const box = outbox();
    const user = crypto.randomUUID();
    const { id } = unwrap(
      await invite(
        db(),
        box.send,
        ORIGINS,
        'staff-1',
        {
          company: 'Silinen A.Ş.',
          kind: 'bank',
          contactName: 'Ayşe Yılmaz',
          contactEmail: `ayse-${user.slice(0, 6)}@silinen.example`,
          locale: 'tr',
          priceList: { default_kurus: 1_000_000, rules: [] },
        },
        T0,
      ),
    );
    unwrap(await claim(db(), box.token(), user, T0 + 1));
    await deleteUser(db(), user, T0 + 2);
    const row = await db()
      .prepare('SELECT status, decision_reason FROM onboardings WHERE id = ?')
      .bind(id)
      .first();
    expect(row).toEqual({ status: 'cancelled', decision_reason: 'account deleted' });
    expect(await registerAgent(db(), user, T0 + 3)).toMatchObject({ error: 'account_deleted' });
    expect(
      await requestInvitation(
        db(),
        box.send,
        'https://m',
        user,
        {
          company: 'X A.Ş.',
          kind: 'bank',
          contactName: 'Ayşe Yılmaz',
          contactEmail: 'a@x.example',
        },
        T0 + 3,
      ),
    ).toMatchObject({ error: 'account_deleted' });
    // Only a hash is kept, and only for as long as a session can last.
    const stored = await db()
      .prepare('SELECT user_hash FROM deleted_accounts')
      .all<{ user_hash: string }>();
    expect(stored.results.some((r) => r.user_hash.includes(user))).toBe(false);
    expect(await purgeDeletedAccounts(db(), T0 + 61 * 86_400)).toBeGreaterThanOrEqual(1);
    unwrap(await registerAgent(db(), user, T0 + 62 * 86_400));
  });
});

describe('security notices', () => {
  it('tell the agent when the IBAN or address changes, whatever the mail setting', async () => {
    const agent = crypto.randomUUID();
    unwrap(await registerAgent(db(), agent, T0));
    await db()
      .prepare(
        `UPDATE agents SET email = 'ali@example.com', email_verified_at = ? WHERE user_id = ?`,
      )
      .bind(T0, agent)
      .run();
    await db().prepare(`UPDATE settings SET value = 0 WHERE key = 'agent_mail'`).run();
    const box = outbox();
    const iban = 'TR180006200119000006672315';
    expect(
      await notifyAgentSecurity(db(), box.send, 'https://s', agent, {
        kind: 'iban_changed',
        masked: maskIban(iban),
      }),
    ).toBe(true);
    expect(box.sent[0]?.to).toBe('ali@example.com');
    expect(JSON.stringify(box.sent[0])).not.toContain(iban);
    expect(JSON.stringify(box.sent[0])).toContain('2315');
    await notifyAgentSecurity(
      db(),
      box.send,
      'https://s',
      agent,
      { kind: 'email_changed', masked: maskEmail('new@example.com') },
      'ali@example.com',
    );
    expect(box.sent[1]?.to).toBe('ali@example.com');
    expect(box.sent[1]?.subject).toContain('e-posta');
    expect(
      agentMail(
        'en',
        'x@y.example',
        { kind: 'iban_changed', masked: 'TR18 •••• 2315' },
        'https://s',
      ).subject,
    ).toBe('Emanet Saha: your IBAN changed');
  });
});

describe('partners', () => {
  it('keep one tax number each when staff edit them', async () => {
    const a = await activePartner();
    const b = await activePartner();
    unwrap(
      await updatePartner(
        db(),
        'staff-1',
        a.id,
        {
          legalName: 'A A.Ş.',
          vkn: '7777777777',
          taxOffice: null,
          kepAddress: null,
          eInvoice: false,
          reconfirmDays: 14,
        },
        T0,
      ),
    );
    expect(
      await updatePartner(
        db(),
        'staff-1',
        b.id,
        {
          legalName: 'B A.Ş.',
          vkn: '7777777777',
          taxOffice: null,
          kepAddress: null,
          eInvoice: false,
          reconfirmDays: 14,
        },
        T0,
      ),
    ).toMatchObject({ error: 'vkn_exists' });
  });
});
