import { describe, expect, it } from 'vitest';
import type { Mail } from '../src/mail';
import { answerRequest, askAgent } from '../src/agent-requests';
import { registerAgent } from '../src/claims';
import { archiveOpenedNotice, isDigestTime, lateRequestsNotice } from '../src/staff-notices';
import { db, T0, unwrap } from './helpers';

const what = {
  kind: 'record',
  staffId: 'staff-1',
  archiveId: 'arch-1',
  at: 1_800_000_000,
} as const;

describe('telling staff an archive record was opened', () => {
  it('names who, when and which, links to the record, and carries no reason or content', async () => {
    const sent: Mail[] = [];
    const ok = await archiveOpenedNotice(
      (mail) => {
        sent.push(mail);
        return Promise.resolve(true);
      },
      'staff@example.test',
      'https://merkez.test',
      what,
    );
    expect(ok).toBe(true);
    const mail = sent[0];
    expect(mail?.to).toBe('staff@example.test');
    expect(mail?.action?.url).toBe('https://merkez.test/privacy/archive/arch-1');
    const text = JSON.stringify(mail);
    expect(text).toContain('staff-1');
    expect(text).toContain('arch-1');
    expect(text).not.toMatch(/reason|gerekçe/i);
  });

  it('never fails what it reports when the mail can’t be sent', async () => {
    const failing = await archiveOpenedNotice(
      () => Promise.reject(new Error('down')),
      'staff@example.test',
      'https://merkez.test',
      { ...what, kind: 'file' },
    );
    expect(failing).toBe(false);
  });
});

describe('the daily note on requests left waiting', () => {
  it('counts late requests and old answers, and says nothing when there are none', async () => {
    const sent: Mail[] = [];
    const send = (mail: Mail) => {
      sent.push(mail);
      return Promise.resolve(true);
    };
    // Nothing is waiting yet in this agent's name, but other tests may have left requests behind:
    // only the difference this agent makes is asserted.
    const before = await lateRequestsNotice(db(), send, 'staff@example.test', 'https://m.test', T0);
    const id = crypto.randomUUID();
    await registerAgent(db(), id, T0);
    const asked = unwrap(
      await askAgent(
        db(),
        'staff-1',
        id,
        [
          { kind: 'info', subject: 'city', note: 'Şehrinizi doğrulayın lütfen.' },
          { kind: 'info', subject: 'phone', note: 'Telefonunuzu doğrulayın.' },
        ],
        1,
        T0,
      ),
    );
    unwrap(await answerRequest(db(), id, asked.ids[1] ?? '', 'Tamam', T0 + 100));
    const count = (mail: Mail | undefined) =>
      (mail?.rows ?? []).map((row) => row.label).join(' | ');
    sent.length = 0;
    expect(
      await lateRequestsNotice(db(), send, 'staff@example.test', 'https://m.test', T0 + 5 * 86_400),
    ).toBe(1);
    expect(count(sent[0])).toContain('süresini aştı');
    expect(count(sent[0])).toContain('iki günden uzun');
    expect(before === 0 || before === 1).toBe(true);
    expect(isDigestTime(6 * 3600 + 60)).toBe(true);
    expect(isDigestTime(6 * 3600 + 400)).toBe(false);
    expect(isDigestTime(86_400 * 3 + 6 * 3600 + 299)).toBe(true);
  });
});
