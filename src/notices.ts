/**
 * Email notices to partners (docs/DESIGN.md §5): the operations contact given at onboarding hears
 * when vehicles reach custody and when cases are about to expire, so a company without webhooks
 * misses neither. At most one delivery mail an hour and one expiry mail a day per partner; each
 * delivery is mailed once. Run by the cron.
 */
import { deliveredMail, expiringMail, type MailLocale, type Send } from './mail';

const HOUR = 3600;
const DAY = 24 * HOUR;
export const EXPIRY_WARNING = 3 * DAY;

interface Target {
  id: string;
  legal_name: string;
  org_id: string;
  contact_email: string;
  locale: MailLocale | null;
  delivered_through: number | null;
  delivered_mailed_at: number | null;
  expiring_mailed_at: number | null;
}

export async function sendNotices(
  db: D1Database,
  send: Send,
  kurumsal: string,
  at: number,
): Promise<{ delivered: number; expiring: number }> {
  const { results: targets } = await db
    .prepare(
      `SELECT p.id, p.legal_name, p.org_id, p.contact_email, o.locale,
         n.delivered_through, n.delivered_mailed_at, n.expiring_mailed_at
       FROM partners p
       LEFT JOIN partner_notices n ON n.partner_id = p.id
       LEFT JOIN onboardings o ON o.id = p.onboarding_id
       WHERE p.status = 'active' AND p.mail_notices = 1 AND p.contact_email IS NOT NULL
       LIMIT 500`,
    )
    .all<Target>();
  let delivered = 0;
  let expiring = 0;
  for (const t of targets) {
    const locale: MailLocale = t.locale ?? 'tr';
    const base = `${kurumsal}/o/${t.org_id}`;

    // Vehicles that reached custody since the last mail, at most hourly.
    if (t.delivered_mailed_at === null || at - t.delivered_mailed_at >= HOUR) {
      const { results: events } = await db
        .prepare(
          `SELECT o.created_at, c.id AS case_id, c.external_ref,
             json_extract(c.vehicle_snapshot, '$.plate') AS plate
           FROM outbox o JOIN cases c ON c.id = json_extract(o.payload, '$.case_id')
           WHERE o.partner_id = ? AND o.type = 'case.delivered' AND o.created_at > ?
           ORDER BY o.created_at LIMIT 100`,
        )
        .bind(t.id, t.delivered_through ?? 0)
        .all<{ created_at: number; case_id: string; external_ref: string; plate: string }>();
      const last = events.at(-1);
      if (last) {
        const sent = await send(
          deliveredMail(
            locale,
            t.contact_email,
            t.legal_name,
            events.map((e) => ({
              plate: e.plate,
              ref: e.external_ref,
              url: `${base}/cases/${e.case_id}`,
            })),
          ),
        );
        if (sent) {
          await db
            .prepare(
              `INSERT INTO partner_notices (partner_id, delivered_through, delivered_mailed_at)
               VALUES (?, ?, ?)
               ON CONFLICT (partner_id) DO UPDATE SET delivered_through = excluded.delivered_through,
                 delivered_mailed_at = excluded.delivered_mailed_at`,
            )
            .bind(t.id, last.created_at, at)
            .run();
          delivered++;
        }
      }
    }

    // Cases that expire within three days, at most daily.
    if (t.expiring_mailed_at === null || at - t.expiring_mailed_at >= DAY) {
      const soon = await db
        .prepare(
          `SELECT count(*) AS n, min(expires_at) AS first FROM cases
           WHERE partner_id = ? AND status = 'active' AND expires_at > ? AND expires_at <= ?`,
        )
        .bind(t.id, at, at + EXPIRY_WARNING)
        .first<{ n: number; first: number | null }>();
      if (soon && soon.n > 0 && soon.first !== null) {
        const sent = await send(
          expiringMail(locale, t.contact_email, t.legal_name, soon.n, soon.first, base),
        );
        if (sent) {
          await db
            .prepare(
              `INSERT INTO partner_notices (partner_id, expiring_mailed_at) VALUES (?, ?)
               ON CONFLICT (partner_id) DO UPDATE SET expiring_mailed_at = excluded.expiring_mailed_at`,
            )
            .bind(t.id, at)
            .run();
          expiring++;
        }
      }
    }
  }
  return { delivered, expiring };
}
