/**
 * Where Emanet emails 2earl's own teams (docs/DESIGN.md §7). Staff change an address in Merkez →
 * Settings; until then the default here is used.
 */
import { auditStatement } from './audit';
import { fail, ok, type Result } from './result';

export const MAIL_ROUTES = {
  /** New requests from companies to be invited to Emanet. */
  invitation_requests: 'kurumsal-ekip@emanet.dev',
} as const;

export type MailRoute = keyof typeof MAIL_ROUTES;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface MailRouteView {
  key: MailRoute;
  address: string;
  default: string;
  updated_by: string | null;
  updated_at: number | null;
}

export async function mailRoutes(db: D1Database): Promise<MailRouteView[]> {
  const { results } = await db
    .prepare('SELECT key, address, updated_by, updated_at FROM mail_routes')
    .all<{ key: string; address: string; updated_by: string; updated_at: number }>();
  return (Object.keys(MAIL_ROUTES) as MailRoute[]).map((key) => {
    const row = results.find((r) => r.key === key);
    return {
      key,
      address: row?.address ?? MAIL_ROUTES[key],
      default: MAIL_ROUTES[key],
      updated_by: row?.updated_by ?? null,
      updated_at: row?.updated_at ?? null,
    };
  });
}

export async function mailRoute(db: D1Database, key: MailRoute): Promise<string> {
  const row = await db
    .prepare('SELECT address FROM mail_routes WHERE key = ?')
    .bind(key)
    .first<{ address: string }>();
  return row?.address ?? MAIL_ROUTES[key];
}

export async function setMailRoute(
  db: D1Database,
  staffId: string,
  key: string,
  address: string,
  at: number,
): Promise<Result<null>> {
  if (!Object.hasOwn(MAIL_ROUTES, key)) return fail('unknown_route');
  const value = typeof address === 'string' ? address.trim().toLowerCase() : '';
  if (value.length > 254 || !EMAIL.test(value)) return fail('invalid_email');
  await db.batch([
    db
      .prepare(
        `INSERT INTO mail_routes (key, address, updated_by, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET address = excluded.address, updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .bind(key, value, staffId, at),
    auditStatement(db, at, `staff:${staffId}`, 'settings.mail_route', `mail_route:${key}`, {
      address: value,
    }),
  ]);
  return ok(null);
}
