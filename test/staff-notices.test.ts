import { describe, expect, it } from 'vitest';
import type { Mail } from '../src/mail';
import { archiveOpenedNotice } from '../src/staff-notices';

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
