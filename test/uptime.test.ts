import { describe, expect, it } from 'vitest';
import { checkUptime, targets } from '../src/uptime';
import { db, T0 } from './helpers';

const list = targets({
  kurumsal: 'https://k.test',
  merkez: 'https://m.test',
  saha: 'https://s.test',
});

const events = async (event: string) =>
  (
    await db()
      .prepare(`SELECT detail FROM ops_events WHERE event = ?`)
      .bind(event)
      .all<{ detail: string }>()
  ).results.map((row) => row.detail);

describe('looking at the public apps from outside', () => {
  it('records an app that is down or errors, and nothing for one that answers or redirects', async () => {
    const down = await checkUptime(
      db(),
      list,
      (url) => {
        if (url.startsWith('https://k.test'))
          return Promise.resolve(new Response(null, { status: 502 }));
        if (url.startsWith('https://s.test')) return Promise.reject(new Error('timeout'));
        if (url.startsWith('https://m.test')) {
          return Promise.resolve(
            new Response(null, { status: 302, headers: { Location: '/signin' } }),
          );
        }
        return Promise.resolve(new Response('ok', { status: 200 }));
      },
      T0,
    );
    expect(down).toEqual(['kurumsal', 'saha']);
    expect(await events('uptime.kurumsal')).toEqual(['status 502']);
    expect(await events('uptime.saha')).toEqual(['no answer']);
    expect(await events('uptime.merkez')).toEqual([]);
    expect(await events('uptime.web')).toEqual([]);
  });

  it('treats a 404 as up: the app answered', async () => {
    const down = await checkUptime(
      db(),
      list,
      () => Promise.resolve(new Response(null, { status: 404 })),
      T0 + 600,
    );
    expect(down).toEqual([]);
  });
});
