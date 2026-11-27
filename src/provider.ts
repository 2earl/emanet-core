/**
 * 2earl's own company details for the agreement and invoices (docs/DESIGN.md §5, Onboarding):
 * one row staff set in Emanet Merkez. Until they do, the agreement shows placeholders and can't
 * be accepted.
 */
import { auditStatement } from './audit';
import type { Provider } from './contract';
import { fail, ok, type Result } from './result';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clean = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';

export async function provider(db: D1Database): Promise<Provider | null> {
  const row = await db
    .prepare('SELECT details FROM provider_details WHERE id = 1')
    .first<{ details: string }>();
  return row ? (JSON.parse(row.details) as Provider) : null;
}

export async function providerForStaff(
  db: D1Database,
): Promise<Result<{ details: Provider; updated_by: string; updated_at: number } | null>> {
  const row = await db
    .prepare('SELECT details, updated_by, updated_at FROM provider_details WHERE id = 1')
    .first<{ details: string; updated_by: string; updated_at: number }>();
  return ok(row ? { ...row, details: JSON.parse(row.details) as Provider } : null);
}

export function checkProvider(input: Record<string, unknown>): Result<Provider> {
  const p: Provider = {
    name: clean(input.name, 200),
    address: clean(input.address, 400),
    taxOffice: clean(input.taxOffice, 100),
    vkn: clean(input.vkn, 10),
    mersis: clean(input.mersis, 16),
    kep: clean(input.kep, 254).toLowerCase(),
    email: clean(input.email, 254).toLowerCase(),
  };
  if (p.name.length < 3) return fail('invalid_provider', 'name');
  if (p.address.length < 10) return fail('invalid_provider', 'address');
  if (p.taxOffice.length < 2) return fail('invalid_provider', 'taxOffice');
  // A company's tax number has 10 digits.
  if (!/^\d{10}$/.test(p.vkn)) return fail('invalid_provider', 'vkn');
  if (!/^\d{16}$/.test(p.mersis)) return fail('invalid_provider', 'mersis');
  if (!EMAIL.test(p.kep)) return fail('invalid_provider', 'kep');
  if (!EMAIL.test(p.email)) return fail('invalid_provider', 'email');
  return ok(p);
}

export async function setProvider(
  db: D1Database,
  staffId: string,
  input: Record<string, unknown>,
  at: number,
): Promise<Result<Provider>> {
  const checked = checkProvider(input);
  if (!checked.ok) return checked;
  const before = await provider(db);
  await db.batch([
    db
      .prepare(
        `INSERT INTO provider_details (id, details, updated_by, updated_at) VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET details = excluded.details, updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .bind(JSON.stringify(checked.value), staffId, at),
    auditStatement(db, at, `staff:${staffId}`, 'provider.updated', 'provider:2earl', {
      before,
      after: checked.value,
    }),
  ]);
  return checked;
}
