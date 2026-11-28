import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { accountingMonth, closeMonth, monthBounds, monthOf } from '../src/accounting';
import { agreementBundle, agreementDigest, AGREEMENT_VERSION } from '../src/agent-agreement';
import { agentProfile, updateProfile } from '../src/agents';
import { registerAgent } from '../src/claims';
import type { ControlApi, FieldApi } from '../src/index';
import { readiness, signOff, SIGNOFFS } from '../src/readiness';
import {
  addDocument,
  decideDocument,
  documentsComplete,
  documentsOf,
  latestAcceptance,
  recordAcceptance,
} from '../src/vetting';
import { activeAgent, db, randomMobile, randomTckn, T0, unwrap, verifiedEmail } from './helpers';

const hash = (seed: string) => seed.repeat(64).slice(0, 64);

async function applicant(): Promise<string> {
  const id = crypto.randomUUID();
  await registerAgent(db(), id, T0);
  await verifiedEmail(id);
  unwrap(
    await updateProfile(
      db(),
      id,
      {
        legalName: 'Deneme Saha',
        city: 'İzmir',
        phone: randomMobile(),
        iban: 'TR330006100519786457841326',
        taxProfile: 'individual',
        tckn: randomTckn(),
        birthYear: 1990,
        address: 'Örnek Mah. Deneme Sk. No:1 D:2 Karşıyaka İzmir',
      },
      T0,
    ),
  );
  return id;
}

const doc = (kind: string, n = 'a') => ({
  kind,
  file_ref: `agents/x/${kind}-${n}`,
  sha256: hash(n),
  barcode: 'ABC12-3456-7890',
});

describe('what an applicant accepts', () => {
  it('is three things, each needed, kept with the digest of the binding text', async () => {
    const id = await applicant();
    expect(
      await recordAcceptance(db(), id, { agreement: true, notice: true, consent: false }, 'tr', T0),
    ).toMatchObject({ error: 'consents_missing' });
    const done = unwrap(
      await recordAcceptance(db(), id, { agreement: true, notice: true, consent: true }, 'en', T0),
    );
    expect(done).toEqual({ version: AGREEMENT_VERSION, sha256: await agreementDigest() });
    expect(await latestAcceptance(db(), id)).toMatchObject({ locale: 'en', current: true });
    // The digest is of the Turkish text whatever language was read.
    expect((await agreementBundle('en')).sha256).toBe((await agreementBundle('tr')).sha256);
    expect((await agreementBundle('tr')).agreement.sections.length).toBe(10);
  });
});

describe('the e-Devlet documents', () => {
  it('are uploaded, replaced, decided once, and their files go with the decision', async () => {
    const id = await applicant();
    expect(await addDocument(db(), id, { ...doc('passport') }, T0)).toMatchObject({
      error: 'invalid_document',
    });
    expect(
      await addDocument(db(), id, { ...doc('criminal_record'), barcode: '!' }, T0),
    ).toMatchObject({
      error: 'invalid_barcode',
    });
    unwrap(await addDocument(db(), id, doc('criminal_record', 'a'), T0));
    const again = unwrap(await addDocument(db(), id, doc('criminal_record', 'b'), T0 + 1));
    expect(again.replaced).toHaveLength(1);
    expect(await documentsComplete(db(), id, 'present')).toBe(false);
    const second = unwrap(await addDocument(db(), id, doc('population_record', 'c'), T0 + 2));
    expect(await documentsComplete(db(), id, 'present')).toBe(true);
    expect(await documentsComplete(db(), id, 'verified')).toBe(false);
    // A record that isn't clean needs a written reason.
    expect(
      await decideDocument(db(), 'staff-1', again.id, { outcome: 'has_record' }, T0 + 3),
    ).toMatchObject({ error: 'invalid_reason' });
    unwrap(await decideDocument(db(), 'staff-1', again.id, { outcome: 'clear' }, T0 + 3));
    unwrap(await decideDocument(db(), 'staff-1', second.id, { outcome: 'clear' }, T0 + 3));
    expect(
      await decideDocument(db(), 'staff-1', again.id, { outcome: 'clear' }, T0 + 4),
    ).toMatchObject({
      error: 'already_decided',
    });
    expect(await documentsComplete(db(), id, 'verified')).toBe(true);
    const docs = await documentsOf(db(), id);
    expect(docs.every((d) => d.file_ref === null && d.outcome === 'clear')).toBe(true);
    const queued = await db()
      .prepare(`SELECT count(*) AS n FROM erased_files WHERE file_ref LIKE 'agents/x/%'`)
      .first<{ n: number }>();
    expect(queued?.n).toBeGreaterThanOrEqual(3);
  });

  it('gate the application and the activation', async () => {
    const id = await applicant();
    const field = exports.FieldApi as unknown as FieldApi;
    const control = exports.ControlApi as unknown as ControlApi;
    const yes = { agreement: true, notice: true, consent: true };
    expect(await field.submit(id, AGREEMENT_VERSION)).toMatchObject({ error: 'consents_missing' });
    expect(await field.submit(id, AGREEMENT_VERSION, yes)).toMatchObject({
      error: 'documents_missing',
    });
    const a = unwrap(await field.addDocument(id, doc('criminal_record', 'd')));
    const b = unwrap(await field.addDocument(id, doc('population_record', 'e')));
    unwrap(await field.submit(id, AGREEMENT_VERSION, yes, 'tr'));
    expect(unwrap(await field.acceptance(id))).toMatchObject({ current: true });
    expect(await control.setAgentStatus('staff-1', id, 'active', 'ok')).toMatchObject({
      error: 'documents_not_verified',
    });
    unwrap(await control.decideDocument('staff-1', a.id, { outcome: 'clear' }));
    unwrap(await control.decideDocument('staff-1', b.id, { outcome: 'clear' }));
    // Still not: nobody has signed off the agent agreement, privacy and accounting.
    expect(await control.setAgentStatus('staff-1', id, 'active', 'ok')).toMatchObject({
      error: 'not_ready',
      detail: 'agents',
    });
  });
});

describe('ready for the first customer', () => {
  it('needs each sign-off for the version in force', async () => {
    const before = await readiness(db(), true);
    expect(before.enforced).toBe(true);
    expect(before.partners_ready).toBe(false);
    expect(await signOff(db(), 'staff-1', 'nope', { signer: 'Av. X Y' }, T0)).toMatchObject({
      error: 'invalid_signoff',
    });
    expect(await signOff(db(), 'staff-1', 'legal_privacy', { signer: 'x' }, T0)).toMatchObject({
      error: 'invalid_signer',
    });
    for (const key of Object.keys(SIGNOFFS)) {
      unwrap(await signOff(db(), 'staff-1', key, { signer: 'Av. Ayşe Örnek', note: 'ok' }, T0));
    }
    const after = await readiness(db(), true);
    const signed = after.checks.filter((c) => c.kind === 'signoff');
    expect(signed.every((c) => c.ok && c.signer === 'Av. Ayşe Örnek')).toBe(true);
    // A sign-off for an older text doesn't count.
    await db().prepare(`UPDATE signoffs SET version = 'old' WHERE key = 'legal_privacy'`).run();
    expect((await readiness(db(), true)).checks.find((c) => c.key === 'legal_privacy')?.ok).toBe(
      false,
    );
    await db().prepare('DELETE FROM signoffs').run();
  });
});

describe('the accountant’s month', () => {
  it('knows a Turkey-time month and refuses to close one that isn’t over', async () => {
    expect(monthBounds('2026-13')).toBeNull();
    const [from, to] = monthBounds('2026-11') ?? [0, 0];
    expect(monthOf(from)).toBe('2026-11');
    expect(monthOf(to - 1)).toBe('2026-11');
    expect(monthOf(to)).toBe('2026-12');
    expect(await closeMonth(db(), 'staff-1', monthOf(T0), T0)).toMatchObject({
      error: 'month_not_over',
    });
    unwrap(await closeMonth(db(), 'staff-1', '2020-01', T0));
  });

  it('lists a paid agent with the sealed ID number opened, and says what is missing', async () => {
    const id = await applicant();
    const bare = await activeAgent();
    const at = T0 + 500;
    for (const [agent, n] of [
      [id, 1],
      [bare, 2],
    ] as const) {
      const vehicle = crypto.randomUUID();
      const kase = crypto.randomUUID();
      const partner = crypto.randomUUID();
      await db().batch([
        db()
          .prepare(
            `INSERT INTO partners (id, org_id, kind, legal_name, status, created_by, created_at, updated_at) VALUES (?, ?, 'bank', 'B', 'active', 's', ?, ?)`,
          )
          .bind(partner, crypto.randomUUID(), at, at),
        db()
          .prepare(
            `INSERT INTO vehicles (id, make, model, created_at, updated_at) VALUES (?, 'A', 'B', ?, ?)`,
          )
          .bind(vehicle, at, at),
        db()
          .prepare(
            `INSERT INTO cases (id, partner_id, vehicle_id, external_ref, icra_office, icra_file_no, serh_date, legal_basis, vehicle_snapshot, status, fee_kurus, last_confirmed_at, expires_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'x', 'y', '2026-01-01', 'rehin', '{}', 'delivered', 1000, ?, ?, ?, ?)`,
          )
          .bind(kase, partner, vehicle, `r-${String(n)}`, at, at, at, at),
        db()
          .prepare(
            `INSERT INTO payouts (id, agent_id, vehicle_id, case_id, gross_kurus, withholding_kurus, net_kurus, status, bank_ref, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1000, 100, 900, 'sent', ?, ?, ?)`,
          )
          .bind(crypto.randomUUID(), agent, vehicle, kase, `ref-${crypto.randomUUID()}`, at, at),
      ]);
    }
    const month = unwrap(await accountingMonth(db(), 'staff-1', monthOf(at), at));
    const mine = month.payouts.find((p) => p.agent_id === id);
    expect(mine?.tckn).toMatch(/^\d{11}$/);
    expect(mine?.address).toContain('Karşıyaka');
    expect(month.totals.withheld).toBeGreaterThanOrEqual(200);
    expect(month.incomplete.find((x) => x.agent_id === bare)?.missing).toEqual(['tckn', 'address']);
    expect(
      month.withholding.find((w) => w.tax_profile === 'individual')?.payouts,
    ).toBeGreaterThanOrEqual(2);
    expect(unwrap(await agentProfile(db(), id)).address).toContain('Örnek Mah.');
  });
});
