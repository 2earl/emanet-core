import { env } from 'cloudflare:workers';
import {
  createPartner,
  setPartnerStatus,
  setPriceList,
  type CaseInput,
  type Partner,
} from '../src/cases';
import { registerAgent, setAgentStatus } from '../src/claims';
import { setPayoutRule } from '../src/ledger';
import type { PriceList } from '../src/pricing';

export const db = (): D1Database => env.DB;
export const T0 = 1_800_000_000;

const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
const pick = (chars: string, n: number) =>
  Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');

export const randomVin = (): string => pick(VIN_CHARS, 17);
export const randomPlate = (): string =>
  `${String(10 + Math.floor(Math.random() * 70))}${pick('ABCDEFGHJKLMNPRSTUVYZ', 3)}${pick('0123456789', 3)}`;

export async function activePartner(
  prices: PriceList = { default_kurus: 1_000_000, rules: [] },
): Promise<Partner> {
  const created = await createPartner(
    db(),
    { orgId: crypto.randomUUID(), kind: 'bank', legalName: 'Test Bankası A.Ş.', vkn: '1234567890' },
    'staff-1',
    T0,
  );
  if (!created.ok) throw new Error(created.error);
  // As its onboarding leaves it: the agreement accepted and approved.
  await db()
    .prepare(
      'UPDATE partners SET contract_signed_at = ?, contract_version = ?, onboarding_id = ? WHERE id = ?',
    )
    .bind(T0, 'test', `ob-${created.value.id}`, created.value.id)
    .run();
  const activated = await setPartnerStatus(db(), created.value.id, 'active', 'staff-1', T0);
  if (!activated.ok) throw new Error(activated.error);
  await setPriceList(db(), created.value.id, prices, 'staff:staff-1', T0, T0);
  return { ...created.value, status: 'active' };
}

export async function activeAgent(): Promise<string> {
  const id = crypto.randomUUID();
  await registerAgent(db(), id, T0);
  // The application as the agent sent it, with an IBAN staff have checked (payouts need one).
  await db()
    .prepare(
      `UPDATE agents SET status = 'kyc_pending', legal_name = 'Deneme Saha', city = 'İstanbul',
         phone = ?, iban = 'TR330006100519786457841326', iban_verified_at = ?,
         email = ?, email_verified_at = ?, tckn_hash = ?, birth_year = 1990,
         terms_version = 'test', terms_accepted_at = ?, submitted_at = ? WHERE user_id = ?`,
    )
    .bind(
      `+905${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
      T0,
      `${id}@agent.example`,
      T0,
      `hash-${id}`,
      T0,
      T0,
      id,
    )
    .run();
  const activated = await setAgentStatus(db(), id, 'active', 'staff-1', 'kyc passed', T0);
  if (!activated.ok) throw new Error(activated.error);
  return id;
}

export async function payoutRule(share_bp = 5000): Promise<void> {
  await setPayoutRule(db(), { share_bp }, 'staff-1', 0, T0);
}

export function caseInput(overrides: Partial<CaseInput> = {}): CaseInput {
  return {
    external_ref: crypto.randomUUID(),
    vin: randomVin(),
    plate: randomPlate(),
    make: 'Renault',
    model: 'Clio',
    year: 2021,
    colour: 'Beyaz',
    icra_office: 'İstanbul 5. İcra Dairesi',
    icra_file_no: '2026/12345',
    serh_date: '2026-10-01',
    legal_basis: 'rehin',
    places: [
      {
        kind: 'owner_home',
        address: 'Örnek Mah. Deneme Sk. No:1',
        district: 'Kadıköy',
        city: 'İstanbul',
      },
    ],
    ...overrides,
  };
}

export function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return result.value;
}

/** A T.C. kimlik no with valid check digits (not a real person's). */
export function randomTckn(): string {
  const d = [1 + Math.floor(Math.random() * 9)];
  for (let i = 1; i < 9; i++) d.push(Math.floor(Math.random() * 10));
  const odd = (d[0] ?? 0) + (d[2] ?? 0) + (d[4] ?? 0) + (d[6] ?? 0) + (d[8] ?? 0);
  const even = (d[1] ?? 0) + (d[3] ?? 0) + (d[5] ?? 0) + (d[7] ?? 0);
  d.push((((odd * 7 - even) % 10) + 10) % 10);
  d.push(d.reduce((sum, n) => sum + n, 0) % 10);
  return d.join('');
}

/** A Turkish mobile number nobody else in the tests has. */
export const randomMobile = (): string =>
  `+905${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

/** As if the agent had typed the code mailed to them. */
export async function verifiedEmail(agentId: string): Promise<string> {
  const email = `${agentId}@agent.example`;
  await db()
    .prepare('UPDATE agents SET email = ?, email_verified_at = ? WHERE user_id = ?')
    .bind(email, T0, agentId)
    .run();
  return email;
}
