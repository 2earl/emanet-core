/**
 * Knowing when something is wrong (docs/DESIGN.md §12). Two layers:
 * - Cloudflare Workers Logs, traces and Issues are on for every Worker (wrangler.jsonc): each
 *   request and job logs one structured line, without personal data.
 * - Here: errors the Workers report, and when each cron job last ran, kept thirty days for Emanet
 *   Merkez's System page; and an email to staff, at most hourly, when there are new errors.
 *
 * An event is a source, a name and an error's name. Never a plate, an address, a person.
 */
import { opsAlertMail, type Send } from './mail';
import { newId } from './result';
import { readSettings } from './settings';

export type OpsSource = 'core' | 'kurumsal' | 'merkez' | 'saha' | 'web';
export type OpsLevel = 'error' | 'warn' | 'info';

const SAFE = /[^A-Za-z0-9_.:/ -]/g;
const clip = (value: unknown, max: number) =>
  (typeof value === 'string' ? value : '').replace(SAFE, '').slice(0, max);

/** One structured log line for Workers Logs. */
export function log(level: OpsLevel, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** Records an event; the same one from the same source within a minute is counted once. */
export async function recordOps(
  db: D1Database,
  source: OpsSource,
  level: OpsLevel,
  event: string,
  detail: string,
  at: number,
): Promise<void> {
  const name = clip(event, 80) || 'unknown';
  const about = clip(detail, 200);
  log(level, name, { source, detail: about });
  await db
    .prepare(
      `INSERT INTO ops_events (id, at, source, level, event, detail)
       SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (
         SELECT 1 FROM ops_events WHERE source = ? AND event = ? AND detail = ? AND at > ?)`,
    )
    .bind(newId(), at, source, level, name, about, source, name, about, at - 60)
    .run();
}

export async function heartbeat(
  db: D1Database,
  name: string,
  error: string | null,
  at: number,
): Promise<void> {
  await db
    .prepare(
      error === null
        ? `INSERT INTO ops_heartbeats (name, ok_at) VALUES (?, ?)
           ON CONFLICT (name) DO UPDATE SET ok_at = excluded.ok_at`
        : `INSERT INTO ops_heartbeats (name, failed_at, error) VALUES (?, ?, ?)
           ON CONFLICT (name) DO UPDATE SET failed_at = excluded.failed_at, error = excluded.error`,
    )
    .bind(...(error === null ? [name, at] : [name, at, clip(error, 80)]))
    .run();
}

/** Cron: mails staff about errors nobody has been told of, at most once an hour; forgets old events. */
export async function alertOps(
  db: D1Database,
  send: Send,
  staffEmail: string,
  merkez: string,
  at: number,
): Promise<number> {
  const settings = await readSettings(db);
  await db
    .prepare('DELETE FROM ops_events WHERE at < ?')
    .bind(at - settings.ops_keep_days * 86_400)
    .run();
  const last = await db
    .prepare('SELECT max(alerted_at) AS at FROM ops_events')
    .first<{ at: number | null }>();
  if (last?.at != null && at - last.at < settings.alert_interval_minutes * 60) return 0;
  const { results } = await db
    .prepare(
      `SELECT source, event, count(*) AS n FROM ops_events
       WHERE level = 'error' AND alerted_at IS NULL GROUP BY source, event ORDER BY n DESC LIMIT 20`,
    )
    .all<{ source: string; event: string; n: number }>();
  if (results.length === 0) return 0;
  const sent = await send(
    opsAlertMail(
      staffEmail,
      results.map((row) => `${row.source}: ${row.event} × ${String(row.n)}`),
      `${merkez}/system`,
    ),
  );
  if (!sent) return 0;
  await db
    .prepare(`UPDATE ops_events SET alerted_at = ? WHERE level = 'error' AND alerted_at IS NULL`)
    .bind(at)
    .run();
  return results.length;
}

export interface OpsOverview {
  events: {
    id: string;
    at: number;
    source: string;
    level: string;
    event: string;
    detail: string;
  }[];
  heartbeats: {
    name: string;
    ok_at: number | null;
    failed_at: number | null;
    error: string | null;
  }[];
  last_day: { source: string; level: string; n: number }[];
  queues: {
    oldest_review_at: number | null;
    files_due: number;
    requests_open: number;
    requests_overdue: number;
    agents_waiting: number;
  };
}

export async function opsOverview(db: D1Database, at: number): Promise<OpsOverview> {
  const [events, heartbeats, day, queues] = await db.batch([
    db.prepare(
      'SELECT id, at, source, level, event, detail FROM ops_events ORDER BY at DESC LIMIT 200',
    ),
    db.prepare('SELECT name, ok_at, failed_at, error FROM ops_heartbeats ORDER BY name'),
    db
      .prepare(
        'SELECT source, level, count(*) AS n FROM ops_events WHERE at > ? GROUP BY source, level ORDER BY source, level',
      )
      .bind(at - 86_400),
    db
      .prepare(
        `SELECT
           (SELECT min(created_at) FROM review_items WHERE status = 'open') AS oldest_review_at,
           (SELECT count(*) FROM erased_files WHERE erased_at IS NULL) AS files_due,
           (SELECT count(*) FROM privacy_requests WHERE status = 'open') AS requests_open,
           (SELECT count(*) FROM privacy_requests WHERE status = 'open' AND due_at < ?) AS requests_overdue,
           (SELECT count(*) FROM agents WHERE status = 'kyc_pending') AS agents_waiting`,
      )
      .bind(at),
  ]);
  return {
    events: (events?.results ?? []) as OpsOverview['events'],
    heartbeats: (heartbeats?.results ?? []) as OpsOverview['heartbeats'],
    last_day: (day?.results ?? []) as OpsOverview['last_day'],
    queues: ((queues?.results ?? [])[0] ?? {
      oldest_review_at: null,
      files_due: 0,
      requests_open: 0,
      requests_overdue: 0,
      agents_waiting: 0,
    }) as OpsOverview['queues'],
  };
}

// ---- Service levels ------------------------------------------------------------------------------

export type QueueKey = 'delivery' | 'identity' | 'agents' | 'onboarding' | 'privacy' | 'invoicing';

/** One of the queues staff work through, measured against the time the settings give it. */
export interface Queue {
  key: QueueKey;
  open: number;
  /** When the item waiting longest arrived. */
  oldest_at: number | null;
  /** Items waiting longer than the limit. */
  overdue: number;
  /** Items past four fifths of the limit, not yet overdue. */
  due_soon: number;
  limit_seconds: number;
}

/**
 * The work waiting for staff, each queue against its service level (docs/DESIGN.md §12). The
 * limits are settings; the privacy and invoicing limits are legal ones (KVKK 13, VUK 231/5).
 */
export async function queues(db: D1Database, at: number): Promise<Queue[]> {
  const s = await readSettings(db);
  const limits: Record<QueueKey, number> = {
    delivery: s.review_sla_hours * 3600,
    identity: s.identity_sla_hours * 3600,
    agents: s.agent_sla_hours * 3600,
    onboarding: s.onboarding_sla_hours * 3600,
    privacy: s.privacy_request_days * 86_400,
    invoicing: s.invoice_days * 86_400,
  };
  const sources: Record<QueueKey, string> = {
    delivery: `SELECT created_at AS t FROM review_items WHERE status = 'open' AND kind = 'delivery'`,
    identity: `SELECT created_at AS t FROM review_items WHERE status = 'open' AND kind != 'delivery'`,
    agents: `SELECT coalesce(submitted_at, updated_at) AS t FROM agents WHERE status = 'kyc_pending'`,
    onboarding: `SELECT coalesce(signed_at, updated_at) AS t FROM onboardings WHERE status = 'signed'`,
    privacy: `SELECT received_at AS t FROM privacy_requests WHERE status = 'open'`,
    invoicing: `SELECT c.delivered_at AS t FROM cases c WHERE c.status = 'delivered'
      AND NOT EXISTS (SELECT 1 FROM invoice_lines l WHERE l.case_id = c.id)`,
  };
  const keys = Object.keys(sources) as QueueKey[];
  const results = await db.batch(
    keys.map((key) =>
      db
        .prepare(
          `SELECT count(*) AS open, min(t) AS oldest_at,
             coalesce(sum(t <= ?), 0) AS overdue,
             coalesce(sum(t > ? AND t <= ?), 0) AS due_soon
           FROM (${sources[key]})`,
        )
        .bind(at - limits[key], at - limits[key], at - Math.floor(limits[key] * 0.8)),
    ),
  );
  return keys.map((key, index) => {
    const row = (results[index]?.results[0] ?? {}) as Partial<Queue>;
    return {
      key,
      open: row.open ?? 0,
      oldest_at: row.oldest_at ?? null,
      overdue: row.overdue ?? 0,
      due_soon: row.due_soon ?? 0,
      limit_seconds: limits[key],
    };
  });
}

/**
 * Cron: a queue with overdue work is recorded as an error once a day, so it reaches staff through
 * the same alert email and System page as a failing job. Counts only; never what is waiting.
 */
export async function watchServiceLevels(db: D1Database, at: number): Promise<number> {
  let recorded = 0;
  for (const queue of await queues(db, at)) {
    if (queue.overdue === 0) continue;
    const event = `sla.${queue.key}`;
    const recent = await db
      .prepare('SELECT 1 AS yes FROM ops_events WHERE source = ? AND event = ? AND at > ? LIMIT 1')
      .bind('core', event, at - 86_400)
      .first();
    if (recent) continue;
    await recordOps(db, 'core', 'error', event, `overdue ${String(queue.overdue)}`, at);
    recorded++;
  }
  return recorded;
}
