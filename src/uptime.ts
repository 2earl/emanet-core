/**
 * A look from outside (docs/DESIGN.md §16): every few minutes the cron asks each public app for its
 * front page. An answer below 500 means the app is up (Merkez answers a visitor with a redirect to
 * sign in, and that is fine); a timeout, a refusal or a 5xx is recorded as an error, which the alert
 * job emails to staff (at most once per `alert_interval_minutes`). Names and status codes only.
 */
import { recordOps } from './ops';

export interface Target {
  name: string;
  url: string;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** The public apps: the three from the environment, and the public site. */
export function targets(origins: { kurumsal: string; merkez: string; saha: string }): Target[] {
  return [
    { name: 'web', url: 'https://emanet.dev/' },
    { name: 'kurumsal', url: `${origins.kurumsal}/` },
    { name: 'merkez', url: `${origins.merkez}/` },
    { name: 'saha', url: `${origins.saha}/` },
  ];
}

/** Returns the names of the apps that did not answer well. */
export async function checkUptime(
  db: D1Database,
  list: readonly Target[],
  fetcher: Fetcher,
  at: number,
): Promise<string[]> {
  const down: string[] = [];
  await Promise.all(
    list.map(async (target) => {
      let detail: string | null = null;
      try {
        const response = await fetcher(target.url, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(8000),
        });
        // A body nobody reads is released, not held open.
        await response.body?.cancel();
        if (response.status >= 500) detail = `status ${String(response.status)}`;
      } catch {
        detail = 'no answer';
      }
      if (detail !== null) {
        down.push(target.name);
        await recordOps(db, 'core', 'error', `uptime.${target.name}`, detail, at);
      }
    }),
  );
  return down.sort();
}
