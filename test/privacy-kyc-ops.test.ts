import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { deleteUser } from '../src/account-events';
import { agentProfile, submitApplication, TERMS_VERSION, updateProfile } from '../src/agents';
import { createPartner, getCase, setPartnerStatus, upsertCase, withdrawCase } from '../src/cases';
import {
  addEvidence,
  claimDetails,
  claimVehicle,
  recordSighting,
  registerAgent,
} from '../src/claims';
import { insertDefinition } from '../src/fields';
import type { ControlApi, PartnerApi } from '../src/index';
import {
  confirmEmailCode,
  nviRegistry,
  requestEmailCode,
  tcknHash,
  validTckn,
  type RegistryCheck,
} from '../src/kyc';
import type { Mail } from '../src/mail';
import { alertOps, heartbeat, opsOverview, recordOps } from '../src/ops';
import { isSealed, open, seal } from '../src/pii';
import {
  closeRequest,
  eraseEvidence,
  filesDue,
  filesErased,
  inventory,
  listRequests,
  openRequest,
  redactCasePlaces,
  scheduleRetention,
} from '../src/privacy';
import {
  activeAgent,
  activePartner,
  caseInput,
  db,
  payoutRule,
  randomMobile,
  randomPlate,
  randomTckn,
  randomVin,
  T0,
  unwrap,
} from './helpers';

const HOUR = 3600;
const DAY = 24 * HOUR;
const hash = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
const outbox = () => {
  const sent: Mail[] = [];
  return { sent, send: (mail: Mail) => (sent.push(mail), Promise.resolve(true)) };
};

describe('personal data in custom fields', () => {
  it('is sealed in the database and opened only for who may see it', async () => {
    const partner = await activePartner();
    for (const [entity, key, visibility] of [
      ['case', 'borclu_tel', 'partner'],
      ['place', 'kapici', 'agent_after_claim'],
      ['case', 'portfoy', 'partner'],
    ] as const) {
      await insertDefinition(
        db(),
        {
          partnerId: partner.id,
          entity,
          key,
          labelTr: key,
          labelEn: key,
          type: 'text',
          visibility,
          pii: key !== 'portfoy',
        },
        T0,
      ).run();
    }
    const vin = randomVin();
    const input = caseInput({
      vin,
      attributes: { borclu_tel: '+90 532 000 00 00', portfoy: 'A' },
      places: [
        {
          kind: 'owner_home',
          address: 'Gizli Sk. 1',
          district: 'Kadıköy',
          city: 'İstanbul',
          attributes: { kapici: 'Hasan Bey' },
        },
      ],
    });
    const created = unwrap(await upsertCase(db(), partner, input, 'u', T0));
    // The partner reads back what it sent.
    expect(created.attributes).toEqual({ borclu_tel: '+90 532 000 00 00', portfoy: 'A' });
    expect(created.places[0]?.attributes).toEqual({ kapici: 'Hasan Bey' });
    // The database holds the personal values sealed, the rest plain.
    const row = await db()
      .prepare('SELECT attributes FROM cases WHERE id = ?')
      .bind(created.id)
      .first<{ attributes: string }>();
    const stored = JSON.parse(row?.attributes ?? '{}') as Record<string, unknown>;
    expect(isSealed(stored.borclu_tel)).toBe(true);
    expect(stored.portfoy).toBe('A');
    expect(row?.attributes).not.toContain('532 000');
    const place = await db()
      .prepare('SELECT attributes FROM case_places WHERE case_id = ?')
      .bind(created.id)
      .first<{ attributes: string }>();
    expect(place?.attributes).not.toContain('Hasan');
    // Sending the case again keeps and re-reads the sealed value.
    const again = unwrap(
      await upsertCase(db(), partner, { ...input, attributes: { portfoy: 'B' } }, 'u', T0 + 1),
    );
    expect(again.attributes).toEqual({ borclu_tel: '+90 532 000 00 00', portfoy: 'B' });
    // The agent holding the claim sees the place's field, opened.
    await payoutRule();
    const agent = await activeAgent();
    const vehicle = await db()
      .prepare('SELECT id FROM vehicles WHERE vin = ?')
      .bind(vin)
      .first<{ id: string }>();
    const claim = unwrap(await claimVehicle(db(), agent, vehicle?.id ?? '', T0 + 2));
    const details = unwrap(await claimDetails(db(), agent, claim.id, T0 + 3));
    expect(details.places[0]?.attributes).toEqual({ kapici: 'Hasan Bey' });
  });

  it('can’t be moved to another field, and old plain values still read', async () => {
    const sealed = await seal('secret', 'field_a');
    expect(await open(sealed, 'field_a')).toBe('secret');
    await expect(open(sealed, 'field_b')).rejects.toThrow();
    expect(await open('plain from before', 'field_a')).toBe('plain from before');
    expect(await seal(42, 'n')).not.toBe(await seal(42, 'n'));
  });
});

describe('one person, one agent account', () => {
  const profile = (over: Record<string, unknown> = {}) => ({
    legalName: 'Ayşe Yılmaz',
    city: 'İzmir',
    phone: randomMobile(),
    iban: 'TR330006100519786457841326',
    taxProfile: 'individual' as const,
    tckn: randomTckn(),
    birthYear: 1990,
    ...over,
  });
  const newAgent = async () => {
    const id = crypto.randomUUID();
    await registerAgent(db(), id, T0);
    return id;
  };

  it('checks the ID number and keeps only a keyed hash of it', async () => {
    expect(validTckn('10000000146')).toBe(true);
    expect(validTckn('10000000147')).toBe(false);
    expect(validTckn('01234567890')).toBe(false);
    const agent = await newAgent();
    expect(await updateProfile(db(), agent, profile({ tckn: '12345678901' }), T0)).toMatchObject({
      error: 'invalid_tckn',
    });
    expect(await updateProfile(db(), agent, profile({ tckn: null }), T0)).toMatchObject({
      error: 'invalid_tckn',
    });
    expect(await updateProfile(db(), agent, profile({ birthYear: 2020 }), T0)).toMatchObject({
      error: 'invalid_birth_year',
    });
    const tckn = randomTckn();
    unwrap(await updateProfile(db(), agent, profile({ tckn }), T0));
    const row = await db().prepare('SELECT * FROM agents WHERE user_id = ?').bind(agent).first();
    expect(row?.tckn_hash).toBe(await tcknHash(tckn));
    expect(JSON.stringify(row)).not.toContain(tckn);
    // The same person can't open a second account, with the same number or the same phone.
    const second = await newAgent();
    expect(await updateProfile(db(), second, profile({ tckn }), T0)).toMatchObject({
      error: 'tckn_taken',
    });
    expect(
      await updateProfile(db(), second, profile({ phone: String(row?.phone) }), T0),
    ).toMatchObject({ error: 'phone_taken' });
  });

  it('asks the population registry, and falls back to staff when it doesn’t answer', async () => {
    const asked: unknown[] = [];
    const registry =
      (answer: Awaited<ReturnType<RegistryCheck>>): RegistryCheck =>
      (person) => (asked.push(person), Promise.resolve(answer));
    const agent = await newAgent();
    expect(await updateProfile(db(), agent, profile(), T0, registry('no_match'))).toMatchObject({
      error: 'identity_not_confirmed',
    });
    expect(asked[0]).toMatchObject({ firstName: 'Ayşe', lastName: 'Yılmaz', birthYear: 1990 });
    unwrap(await updateProfile(db(), agent, profile(), T0 + 1, registry('unavailable')));
    unwrap(await updateProfile(db(), agent, profile(), T0 + 2, registry('match')));
    const { results } = await db()
      .prepare(
        `SELECT result FROM kyc_checks WHERE agent_id = ? AND kind = 'id_registry' ORDER BY created_at`,
      )
      .bind(agent)
      .all<{ result: string }>();
    expect(results.map((r) => r.result)).toEqual(['review', 'passed']);

    // The service itself: a clear true or false, anything else is "unavailable".
    const service = (body: string, status = 200) =>
      nviRegistry('https://registry.example/kps', () =>
        Promise.resolve(new Response(body, { status })),
      )({ tckn: '10000000146', firstName: 'Ali & Veli', lastName: 'Öz', birthYear: 1980 });
    const answer = (value: string) =>
      `<soap:Envelope><soap:Body><TCKimlikNoDogrulaResponse><TCKimlikNoDogrulaResult>${value}</TCKimlikNoDogrulaResult></TCKimlikNoDogrulaResponse></soap:Body></soap:Envelope>`;
    expect(await service(answer('true'))).toBe('match');
    expect(await service(answer('false'))).toBe('no_match');
    expect(await service('<html>captcha</html>')).toBe('unavailable');
    expect(await service(answer('true'), 503)).toBe('unavailable');
    expect(
      await nviRegistry('https://registry.example/kps', () => Promise.reject(new Error('down')))({
        tckn: '1',
        firstName: 'a',
        lastName: 'b',
        birthYear: 1980,
      }),
    ).toBe('unavailable');
  });

  it('limits email codes to five a day and wrong guesses to ten, across codes', async () => {
    const agent = await newAgent();
    const mail = outbox();
    const ask = (at: number) =>
      requestEmailCode(db(), mail.send, agent, { email: 'limit@example.com', locale: 'tr' }, at);
    for (let i = 0; i < 5; i++) unwrap(await ask(T0 + i * 120));
    expect(await ask(T0 + 600)).toMatchObject({ error: 'too_many_codes' });
    // A day later it starts again.
    unwrap(await ask(T0 + 86_400 + 1));
    // Ten wrong guesses over several codes lock the day, even with the right code after.
    const base = T0 + 3 * 86_400;
    let code = '';
    for (let i = 0; i < 3; i++) {
      unwrap(await ask(base + i * 120));
      code = /(\d{6})/.exec(mail.sent.at(-1)?.subject ?? '')?.[1] ?? '';
      const wrong = code === '000000' ? '000001' : '000000';
      for (let j = 0; j < 4; j++) await confirmEmailCode(db(), agent, wrong, base + i * 120 + 1);
    }
    expect(await confirmEmailCode(db(), agent, code, base + 400)).toMatchObject({
      error: 'code_expired',
    });
    expect(await ask(base + 600)).toMatchObject({ error: 'too_many_codes' });
  });

  it('proves an email address with a mailed code, once per address', async () => {
    const agent = await newAgent();
    const mail = outbox();
    expect(
      await requestEmailCode(db(), mail.send, agent, { email: 'not an address', locale: 'tr' }, T0),
    ).toMatchObject({ error: 'invalid_email' });
    unwrap(
      await requestEmailCode(
        db(),
        mail.send,
        agent,
        { email: ' Ayse@Example.com ', locale: 'tr' },
        T0,
      ),
    );
    expect(mail.sent[0]?.to).toBe('ayse@example.com');
    const code = /(\d{6})/.exec(mail.sent[0]?.subject ?? '')?.[1] ?? '';
    // The code isn't in the database.
    const stored = await db()
      .prepare('SELECT code_hash FROM agent_email_codes WHERE agent_id = ?')
      .bind(agent)
      .first<{ code_hash: string }>();
    expect(stored?.code_hash).not.toContain(code);
    expect(
      await requestEmailCode(
        db(),
        mail.send,
        agent,
        { email: 'ayse@example.com', locale: 'tr' },
        T0 + 5,
      ),
    ).toMatchObject({ error: 'sent_recently' });
    const wrong = code === '000000' ? '000001' : '000000';
    expect(await confirmEmailCode(db(), agent, wrong, T0 + 10)).toMatchObject({
      error: 'wrong_code',
    });
    expect(await confirmEmailCode(db(), agent, code, T0 + 16 * 60)).toMatchObject({
      error: 'code_expired',
    });
    unwrap(
      await requestEmailCode(
        db(),
        mail.send,
        agent,
        { email: 'ayse@example.com', locale: 'en' },
        T0 + 20 * 60,
      ),
    );
    const fresh = /(\d{6})/.exec(mail.sent[1]?.subject ?? '')?.[1] ?? '';
    expect(unwrap(await confirmEmailCode(db(), agent, fresh, T0 + 21 * 60)).email).toBe(
      'ayse@example.com',
    );
    expect(unwrap(await agentProfile(db(), agent)).email).toBe('ayse@example.com');
    // Another agent can't use that address.
    const other = await newAgent();
    expect(
      await requestEmailCode(
        db(),
        mail.send,
        other,
        { email: 'AYSE@example.com', locale: 'tr' },
        T0,
      ),
    ).toMatchObject({ error: 'email_taken' });
    // Five wrong tries end a code.
    unwrap(
      await requestEmailCode(
        db(),
        mail.send,
        other,
        { email: 'veli@example.com', locale: 'tr' },
        T0,
      ),
    );
    const good = /(\d{6})/.exec(mail.sent[2]?.subject ?? '')?.[1] ?? '';
    const bad = good === '111111' ? '222222' : '111111';
    for (let i = 0; i < 5; i++) await confirmEmailCode(db(), other, bad, T0 + 1);
    expect(await confirmEmailCode(db(), other, good, T0 + 2)).toMatchObject({
      error: 'code_expired',
    });
    // And the application waits for the email.
    unwrap(await updateProfile(db(), other, profile(), T0));
    expect(await submitApplication(db(), other, TERMS_VERSION, T0)).toMatchObject({
      error: 'email_not_verified',
    });
  });
});

describe('partners', () => {
  it('become active only with an accepted agreement', async () => {
    const created = unwrap(
      await createPartner(
        db(),
        { orgId: crypto.randomUUID(), kind: 'bank', legalName: 'Kestirme A.Ş.' },
        's',
        T0,
      ),
    );
    expect(await setPartnerStatus(db(), created.id, 'active', 'staff-1', T0)).toMatchObject({
      error: 'no_agreement',
    });
    // And staff have no way to create one outside onboarding.
    const control = exports.ControlApi as unknown as {
      createPartner(staffId: string, input: unknown): Promise<unknown>;
    };
    let refused = false;
    try {
      await control.createPartner('staff-1', { orgId: 'x' });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });
});

describe('finding and removing a person’s data', () => {
  async function delivered() {
    await payoutRule();
    const partner = await activePartner();
    const vin = randomVin();
    const plate = randomPlate();
    const kase = unwrap(await upsertCase(db(), partner, caseInput({ vin, plate }), 'u', T0));
    const vehicle = await db()
      .prepare('SELECT id FROM vehicles WHERE vin = ?')
      .bind(vin)
      .first<{ id: string }>();
    const agent = await activeAgent();
    const claim = unwrap(await claimVehicle(db(), agent, vehicle?.id ?? '', T0));
    unwrap(
      await recordSighting(db(), agent, claim.id, { lat: 41, lng: 29, taken_at: T0 + 60 }, T0 + 60),
    );
    const ids: string[] = [];
    for (const kind of ['scene', 'police_report'] as const) {
      ids.push(
        unwrap(
          await addEvidence(
            db(),
            agent,
            claim.id,
            { kind, file_ref: `claims/${claim.id}/${kind}`, sha256: hash() },
            T0 + 120,
          ),
        ).id,
      );
    }
    return { partner, kase, agent, claim, plate, vin, evidence: ids };
  }

  it('lists what is held for a plate, an agent and a contact’s address', async () => {
    const { plate, vin, agent, kase, evidence } = await delivered();
    const byPlate = unwrap(await inventory(db(), plate.replace(/^(\d\d)/, '$1 ')));
    expect(byPlate.vehicle?.cases).toMatchObject([{ id: kase.id, places: 1, addresses: 1 }]);
    expect(byPlate.evidence.map((e) => [e.kind, e.about, e.erased])).toEqual([
      ['scene', 'vehicle', 'no'],
      ['police_report', 'document', 'no'],
    ]);
    expect(unwrap(await inventory(db(), vin)).vehicle?.plate).toBe(plate);
    const byAgent = unwrap(await inventory(db(), agent));
    expect(byAgent.agent).toMatchObject({ user_id: agent, sightings: 1 });
    expect(byAgent.evidence).toHaveLength(2);
    expect(unwrap(await inventory(db(), `${agent}@agent.example`)).agent?.user_id).toBe(agent);
    expect(unwrap(await inventory(db(), 'nobody@example.com'))).toMatchObject({
      vehicle: null,
      agent: null,
    });
    expect(await inventory(db(), 'x')).toMatchObject({ error: 'invalid_search' });
    // One photo, on request: queued for Merkez to delete, then reported gone.
    expect(await eraseEvidence(db(), 'staff-1', evidence[1] ?? '', ' ', T0)).toMatchObject({
      error: 'invalid_reason',
    });
    unwrap(
      await eraseEvidence(db(), 'staff-1', evidence[1] ?? '', 'KVKK başvurusu 2026/3', T0 + 200),
    );
    const due = await filesDue(db());
    expect(due.filter((f) => f.file_ref.endsWith('police_report'))).toHaveLength(1);
    expect(unwrap(await inventory(db(), plate)).evidence[1]?.erased).toBe('due');
    expect(
      await filesErased(
        db(),
        due.map((f) => f.file_ref),
        T0 + 300,
      ),
    ).toBe(due.length);
    expect(unwrap(await inventory(db(), plate)).evidence[1]?.erased).toBe('yes');
    expect(
      await filesErased(
        db(),
        due.map((f) => f.file_ref),
        T0 + 301,
      ),
    ).toBe(0);
  });

  it('removes a closed case’s addresses at once, an open one’s never', async () => {
    const { partner, kase, claim } = await delivered();
    expect(await redactCasePlaces(db(), 'staff-1', kase.id, 'request', T0)).toMatchObject({
      error: 'case_open',
    });
    await db()
      .prepare(`UPDATE claims SET closed_at = ?, close_reason = 'released' WHERE id = ?`)
      .bind(T0 + 500, claim.id)
      .run();
    unwrap(await withdrawCase(db(), partner, kase.id, 'paid', 'u', T0 + 600));
    expect(
      unwrap(await redactCasePlaces(db(), 'staff-1', kase.id, 'request', T0 + 700)).places,
    ).toBe(1);
    expect(unwrap(await getCase(db(), partner.id, kase.id)).places[0]?.address).toBe('');
  });

  it('lets photos go when their purpose ends, and when the agent’s account is deleted', async () => {
    const a = await delivered();
    // A claim that delivered nothing: its photos go after thirty days.
    await db()
      .prepare(`UPDATE claims SET closed_at = ?, close_reason = 'rejected' WHERE id = ?`)
      .bind(T0 + DAY, a.claim.id)
      .run();
    await scheduleRetention(db(), T0 + 20 * DAY);
    const refs = async () => (await filesDue(db(), 500)).map((f) => f.file_ref);
    expect((await refs()).some((r) => r.startsWith(`claims/${a.claim.id}/`))).toBe(false);
    await scheduleRetention(db(), T0 + 32 * DAY);
    expect((await refs()).filter((r) => r.startsWith(`claims/${a.claim.id}/`))).toHaveLength(2);
    // A delivery's photos are kept for the retention period.
    const b = await delivered();
    await db()
      .prepare(`UPDATE claims SET closed_at = ?, close_reason = 'delivered' WHERE id = ?`)
      .bind(T0 + DAY, b.claim.id)
      .run();
    await scheduleRetention(db(), T0 + 400 * DAY);
    expect((await refs()).some((r) => r.startsWith(`claims/${b.claim.id}/`))).toBe(false);
    await scheduleRetention(db(), T0 + 3652 * DAY);
    expect((await refs()).filter((r) => r.startsWith(`claims/${b.claim.id}/`))).toHaveLength(2);
    // An open claim's photos go with the account.
    const c = await delivered();
    await deleteUser(db(), c.agent, T0 + 2 * DAY);
    expect((await refs()).filter((r) => r.startsWith(`claims/${c.claim.id}/`))).toHaveLength(2);
    const gone = await db()
      .prepare('SELECT email, tckn_hash, birth_year FROM agents WHERE user_id = ?')
      .bind(c.agent)
      .first();
    expect(gone).toEqual({ email: null, tckn_hash: null, birth_year: null });
  });

  it('keeps a register of requests with their thirty-day limit', async () => {
    expect(
      await openRequest(
        db(),
        'staff-1',
        { kind: 'gossip', subjectKind: 'agent', subjectRef: 'x', channel: 'email' },
        T0,
      ),
    ).toMatchObject({ error: 'invalid_request' });
    const opened = unwrap(
      await openRequest(
        db(),
        'staff-1',
        {
          kind: 'erasure',
          subjectKind: 'vehicle',
          subjectRef: '34 ABC 123',
          channel: 'KEP',
          receivedAt: T0 - 2 * DAY,
        },
        T0,
      ),
    );
    expect(opened.due_at).toBe(T0 + 28 * DAY);
    expect((await listRequests(db())).find((r) => r.id === opened.id)).toMatchObject({
      status: 'open',
    });
    expect(
      await closeRequest(db(), 'staff-2', opened.id, { status: 'done', outcome: '' }, T0),
    ).toMatchObject({
      error: 'invalid_request',
    });
    unwrap(
      await closeRequest(
        db(),
        'staff-2',
        opened.id,
        { status: 'done', outcome: 'Adresler silindi' },
        T0 + DAY,
      ),
    );
    expect(
      await closeRequest(
        db(),
        'staff-2',
        opened.id,
        { status: 'done', outcome: 'again' },
        T0 + DAY,
      ),
    ).toMatchObject({
      error: 'not_found',
    });
  });
});

describe('operations', () => {
  it('records errors without data, counts a burst once, and mails staff hourly at most', async () => {
    await db().prepare('DELETE FROM ops_events').run();
    await recordOps(
      db(),
      'saha',
      'error',
      'GET /claims/:id',
      'TypeError <script>34ABC123</script>',
      T0,
    );
    await recordOps(
      db(),
      'saha',
      'error',
      'GET /claims/:id',
      'TypeError <script>34ABC123</script>',
      T0 + 5,
    );
    await recordOps(db(), 'kurumsal', 'warn', 'webhook.disabled', 'bank.example', T0 + 6);
    await heartbeat(db(), 'core.expireClaims', null, T0);
    await heartbeat(db(), 'core.notices', 'D1_ERROR', T0);
    const overview = await opsOverview(db(), T0 + 10);
    expect(overview.events).toHaveLength(2);
    expect(overview.events.find((e) => e.source === 'saha')?.detail).toBe(
      'TypeError script34ABC123/script',
    );
    expect(overview.heartbeats).toContainEqual({
      name: 'core.notices',
      ok_at: null,
      failed_at: T0,
      error: 'D1_ERROR',
    });
    const mail = outbox();
    expect(
      await alertOps(db(), mail.send, 'ops@example.com', 'https://merkez.example', T0 + 20),
    ).toBe(1);
    expect(mail.sent[0]?.rows?.map((row) => row.label)).toContain('saha: GET /claims/:id × 1');
    // Told once; a new error within the hour waits.
    await recordOps(db(), 'merkez', 'error', 'POST /money/receipts', 'Error', T0 + 100);
    expect(
      await alertOps(db(), mail.send, 'ops@example.com', 'https://merkez.example', T0 + 200),
    ).toBe(0);
    expect(
      await alertOps(db(), mail.send, 'ops@example.com', 'https://merkez.example', T0 + 20 + HOUR),
    ).toBe(1);
    expect(mail.sent).toHaveLength(2);
  });

  it('tells a partner’s contact when a webhook is switched off', async () => {
    const partner = await activePartner();
    await db()
      .prepare('UPDATE partners SET contact_email = ? WHERE id = ?')
      .bind('ops@bank.example', partner.id)
      .run();
    const sent: Mail[] = [];
    const api = exports.PartnerApi as unknown as PartnerApi;
    // The entrypoint mails through the binding; here only that it finds the contact and answers.
    const result = await api.webhookDisabled(partner.orgId, 'hooks.bank.example');
    expect(result.ok).toBe(true);
    expect(await api.webhookDisabled('no-org', 'x')).toMatchObject({ error: 'not_a_partner' });
    expect(sent).toHaveLength(0);
    const control = exports.ControlApi as unknown as ControlApi;
    const ops = unwrap(await control.ops());
    expect(
      ops.events.some((e) => e.event === 'webhook.disabled' && e.detail === 'hooks.bank.example'),
    ).toBe(true);
  });
});
