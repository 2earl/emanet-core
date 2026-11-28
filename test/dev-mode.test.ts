import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { ControlApi } from '../src/index';
import { DEV_MODE_SECONDS, devModeStatus, readSettings } from '../src/settings';
import { db, unwrap } from './helpers';

const control = () => exports.ControlApi as unknown as ControlApi;
const off = () => control().setDevMode('staff-1', false);

describe('development mode', () => {
  it('lifts the gates that slow testing, for twelve hours, and says so in the log', async () => {
    const before = await readSettings(db());
    expect(before.dev_mode).toBe(0);
    expect(before.require_signoffs).toBe(1);
    expect(before.require_documents).toBe(1);

    const on = unwrap(await control().setDevMode('staff-1', true));
    expect(on.active).toBe(true);
    const switchedOn =
      (
        await db()
          .prepare(`SELECT updated_at FROM settings WHERE key = 'dev_mode'`)
          .first<{ updated_at: number }>()
      )?.updated_at ?? 0;
    expect(on.until).toBe(switchedOn + DEV_MODE_SECONDS);

    const during = await readSettings(db(), switchedOn + 60);
    expect(during).toMatchObject({ dev_mode: 1, require_signoffs: 0, require_documents: 0 });
    // Money stays as it was: two people still approve a large payout.
    expect(during.dual_approval_kurus).toBe(before.dual_approval_kurus);

    // It ends by itself.
    const later = await readSettings(db(), switchedOn + DEV_MODE_SECONDS);
    expect(later).toMatchObject({ dev_mode: 0, require_signoffs: 1, require_documents: 1 });
    expect((await devModeStatus(db(), switchedOn + DEV_MODE_SECONDS)).active).toBe(false);

    unwrap(await off());
    expect((await readSettings(db())).require_signoffs).toBe(1);
    const events = await db()
      .prepare(`SELECT action FROM audit_events WHERE subject = 'setting:dev_mode' ORDER BY rowid`)
      .all<{ action: string }>();
    expect(events.results.map((e) => e.action)).toEqual(['dev_mode.on', 'dev_mode.off']);
  });

  it('can be changed only through its own entry', async () => {
    expect(await control().setSetting('staff-1', 'dev_mode', 1)).toMatchObject({
      error: 'invalid_setting',
    });
    expect(await control().resetSetting('staff-1', 'dev_mode')).toMatchObject({
      error: 'invalid_setting',
    });
    expect((await devModeStatus(db())).active).toBe(false);
  });

  it('does nothing when it is already in the state asked for', async () => {
    unwrap(await control().setDevMode('staff-1', false));
    const count = await db()
      .prepare(`SELECT count(*) AS n FROM audit_events WHERE action = 'dev_mode.off'`)
      .first<{ n: number }>();
    unwrap(await control().setDevMode('staff-1', false));
    const again = await db()
      .prepare(`SELECT count(*) AS n FROM audit_events WHERE action = 'dev_mode.off'`)
      .first<{ n: number }>();
    expect(again?.n).toBe(count?.n);
  });
});
