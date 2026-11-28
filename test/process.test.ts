import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { claimPlate, notifyAgent } from '../src/agent-notices';
import { agentProfile } from '../src/agents';
import { upsertCase } from '../src/cases';
import { addEvidence, claimVehicle, recordSighting, returnApplication } from '../src/claims';
import { DELIVERY_CHECKS, type ControlApi, type PartnerApi } from '../src/index';
import { rejectDelivery } from '../src/ledger';
import { agentMail, html, text, type Mail } from '../src/mail';
import { queues, watchServiceLevels } from '../src/ops';
import {
  readSettings,
  SETTINGS,
  settingAllowed,
  settingsInfo,
  writeSetting,
} from '../src/settings';
import {
  activeAgent,
  activePartner,
  caseInput,
  db,
  payoutRule,
  randomPlate,
  randomVin,
  T0,
  unwrap,
} from './helpers';

const HOUR = 3600;
const hash = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

const outbox = () => {
  const sent: Mail[] = [];
  return { sent, send: (mail: Mail) => (sent.push(mail), Promise.resolve(true)) };
};

/** A vehicle an agent found and reported, waiting for staff. */
async function reported(agent?: string) {
  await payoutRule(5000);
  const partner = await activePartner();
  const vin = randomVin();
  const plate = randomPlate();
  const kase = unwrap(await upsertCase(db(), partner, caseInput({ vin, plate }), 'u', T0));
  const vehicle = await db()
    .prepare('SELECT id FROM vehicles WHERE vin = ?')
    .bind(vin)
    .first<{ id: string }>();
  const who = agent ?? (await activeAgent());
  const claim = unwrap(await claimVehicle(db(), who, vehicle?.id ?? '', T0));
  unwrap(
    await recordSighting(db(), who, claim.id, { lat: 41, lng: 29, taken_at: T0 + 300 }, T0 + 300),
  );
  for (const kind of ['scene', 'yediemin_receipt'] as const) {
    unwrap(
      await addEvidence(
        db(),
        who,
        claim.id,
        { kind, file_ref: `claims/${claim.id}/${kind}`, sha256: hash() },
        T0 + 600,
      ),
    );
  }
  return { partner, kase, agent: who, claim, plate };
}

describe('settings', () => {
  it('each has a default inside its range, and a group and unit', () => {
    for (const [key, spec] of Object.entries(SETTINGS)) {
      expect(spec.min, key).toBeLessThanOrEqual(spec.default);
      expect(spec.default, key).toBeLessThanOrEqual(spec.max);
      expect(settingAllowed(key, spec.default), key).toBe(true);
      expect(settingAllowed(key, spec.max + 1), key).toBe(false);
    }
    // The legal ceilings can't be raised from the settings page.
    expect(settingAllowed('privacy_request_days', 31)).toBe(false);
    expect(settingAllowed('invoice_days', 8)).toBe(false);
  });

  it('reports value, default and last change; a change is audited, a reset removes it', async () => {
    const control = exports.ControlApi as unknown as ControlApi;
    unwrap(await control.setSetting('staff-9', 'review_sla_hours', 6));
    const info = unwrap(await control.settingsInfo()).find((s) => s.key === 'review_sla_hours');
    expect(info).toMatchObject({ value: 6, default: 24, unit: 'hours', group: 'review' });
    expect(info?.updated_by).toBe('staff-9');
    const audit = await db()
      .prepare(`SELECT detail FROM audit_events WHERE subject = 'setting:review_sla_hours'`)
      .first<{ detail: string }>();
    expect(JSON.parse(audit?.detail ?? '{}')).toEqual({ from: 24, to: 6 });
    unwrap(await control.resetSetting('staff-9', 'review_sla_hours'));
    expect((await readSettings(db())).review_sla_hours).toBe(24);
    expect(await control.setSetting('staff-9', 'review_sla_hours', 0)).toMatchObject({
      error: 'invalid_setting',
    });
  });

  it('ignores a stored value that is out of range', async () => {
    await writeSetting(db(), 'claim_hours', 99_999, 'staff-1', T0).run();
    expect((await readSettings(db())).claim_hours).toBe(24);
    expect((await settingsInfo(db())).find((s) => s.key === 'claim_hours')?.updated_by).toBeNull();
    await db().prepare(`DELETE FROM settings WHERE key = 'claim_hours'`).run();
  });

  it('gives integrations their limits', async () => {
    const api = exports.PartnerApi as unknown as PartnerApi;
    expect(unwrap(await api.limits())).toEqual({ webhook_disable_after: 20, max_webhooks: 5 });
  });
});

describe('confirming a delivery', () => {
  it('needs every point of the checklist, and keeps what was ticked', async () => {
    const { claim } = await reported();
    const control = exports.ControlApi as unknown as ControlApi;
    expect(await control.confirmDelivery('staff-1', claim.id, ['plate_matches'])).toMatchObject({
      error: 'checklist_incomplete',
    });
    unwrap(await control.confirmDelivery('staff-1', claim.id, [...DELIVERY_CHECKS]));
    const row = await db()
      .prepare('SELECT checks FROM claims WHERE id = ?')
      .bind(claim.id)
      .first<{ checks: string }>();
    expect(JSON.parse(row?.checks ?? '[]')).toEqual([...DELIVERY_CHECKS]);
  });

  it('can be switched to no checklist', async () => {
    const { claim } = await reported();
    const control = exports.ControlApi as unknown as ControlApi;
    unwrap(await control.setSetting('staff-1', 'review_checklist', 0));
    unwrap(await control.confirmDelivery('staff-1', claim.id));
    unwrap(await control.resetSetting('staff-1', 'review_checklist'));
  });
});

describe('strikes', () => {
  it('suspend the agent at the limit and end their other claims', async () => {
    await writeSetting(db(), 'strike_limit', 2, 'staff-1', T0).run();
    const first = await reported();
    const one = unwrap(
      await rejectDelivery(
        db(),
        'staff-1',
        first.claim.id,
        { reason: 'not the vehicle', strike: true },
        T0 + HOUR,
      ),
    );
    expect(one).toMatchObject({ strikes: 1, suspended: false });
    const second = await reported(first.agent);
    const two = unwrap(
      await rejectDelivery(
        db(),
        'staff-1',
        second.claim.id,
        { reason: 'not the vehicle', strike: true },
        T0 + 2 * HOUR,
      ),
    );
    expect(two).toMatchObject({ strikes: 2, suspended: true });
    expect(unwrap(await agentProfile(db(), first.agent)).status).toBe('suspended');
    const audit = await db()
      .prepare(`SELECT actor FROM audit_events WHERE action = 'agent.suspended' AND subject = ?`)
      .bind(`agent:${first.agent}`)
      .first<{ actor: string }>();
    expect(audit?.actor).toBe('system');
    await db().prepare(`DELETE FROM settings WHERE key = 'strike_limit'`).run();
  });
});

describe('an application sent back', () => {
  it('returns to the applicant with the note, which goes when they send it again', async () => {
    const agent = await activeAgent();
    await db()
      .prepare(`UPDATE agents SET status = 'kyc_pending' WHERE user_id = ?`)
      .bind(agent)
      .run();
    expect(await returnApplication(db(), agent, 'staff-1', '  ', T0)).toMatchObject({
      error: 'invalid_reason',
    });
    unwrap(await returnApplication(db(), agent, 'staff-1', 'IBAN başkasına ait', T0));
    const profile = unwrap(await agentProfile(db(), agent));
    expect(profile).toMatchObject({ status: 'applied', review_note: 'IBAN başkasına ait' });
    // Only a waiting application can be sent back.
    expect(await returnApplication(db(), agent, 'staff-1', 'again', T0)).toMatchObject({
      error: 'agent_not_ready',
    });
  });
});

describe('telling the agent', () => {
  it('mails the proved address in the agent’s language, unless switched off', async () => {
    const agent = await activeAgent();
    const box = outbox();
    expect(
      await notifyAgent(db(), box.send, 'https://saha.test', agent, { kind: 'approved' }),
    ).toBe(true);
    expect(box.sent[0]).toMatchObject({ to: `${agent}@agent.example`, product: 'Saha' });
    expect(box.sent[0]?.subject).toContain('etkin');
    await db().prepare(`UPDATE agents SET locale = 'en' WHERE user_id = ?`).bind(agent).run();
    await notifyAgent(db(), box.send, 'https://saha.test', agent, {
      kind: 'delivery_refused',
      plate: '34 ABC 123',
      reason: 'Fotoğraf başka araca ait',
      strikes: 1,
    });
    expect(box.sent[1]?.subject).toBe('Your delivery was not confirmed');
    expect(box.sent[1]?.rows?.[0]).toMatchObject({ label: '34 ABC 123', plate: true });
    await writeSetting(db(), 'agent_mail', 0, 'staff-1', T0).run();
    expect(
      await notifyAgent(db(), box.send, 'https://saha.test', agent, { kind: 'payout_sent' }),
    ).toBe(false);
    await db().prepare(`DELETE FROM settings WHERE key = 'agent_mail'`).run();
    // An address nobody proved gets nothing.
    await db()
      .prepare('UPDATE agents SET email_verified_at = NULL WHERE user_id = ?')
      .bind(agent)
      .run();
    expect(
      await notifyAgent(db(), box.send, 'https://saha.test', agent, { kind: 'payout_sent' }),
    ).toBe(false);
  });

  it('knows the plate of a claim', async () => {
    const { claim, plate } = await reported();
    expect((await claimPlate(db(), claim.id))?.replace(/\s/g, '')).toBe(plate);
  });
});

describe('the email frame', () => {
  const mail = agentMail(
    'tr',
    'a@example.com',
    { kind: 'delivery_refused', plate: '34 <b> 1', reason: 'x & y', strikes: null },
    'https://saha.test',
  );

  it('escapes what it shows and fetches nothing', () => {
    const page = html(mail);
    expect(page).toContain('34 &lt;b&gt; 1');
    expect(page).toContain('x &amp; y');
    expect(page).not.toMatch(/<img|<script|<link/);
    expect(page).toContain('lang="tr"');
    expect(page).toContain('Emanet<span');
  });

  it('says the same in plain text', () => {
    const plain = text({ ...mail, code: '123456' });
    expect(plain).toContain('Gerekçe: x & y');
    expect(plain).toContain('Kod: 123456');
    expect(plain).toContain('34 <b> 1');
  });
});

describe('service levels', () => {
  it('count what waits past its limit and record a breach once a day', async () => {
    const { claim } = await reported();
    const created = await db()
      .prepare(`SELECT created_at FROM review_items WHERE subject_id = ? AND kind = 'delivery'`)
      .bind(claim.id)
      .first<{ created_at: number }>();
    const start = created?.created_at ?? T0;
    const fresh = (await queues(db(), start + HOUR)).find((q) => q.key === 'delivery');
    expect(fresh?.open).toBeGreaterThan(0);
    expect(fresh?.limit_seconds).toBe(24 * HOUR);
    const later = start + 25 * HOUR;
    const late = (await queues(db(), later)).find((q) => q.key === 'delivery');
    expect(late?.overdue).toBeGreaterThan(0);
    expect(await watchServiceLevels(db(), later)).toBeGreaterThan(0);
    const events = async () =>
      (
        await db()
          .prepare(`SELECT count(*) AS n FROM ops_events WHERE event = 'sla.delivery'`)
          .first<{ n: number }>()
      )?.n ?? 0;
    const before = await events();
    await watchServiceLevels(db(), later + HOUR);
    expect(await events()).toBe(before);
  });
});
