import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { deleteUser } from '../src/account-events';
import { updateProfile } from '../src/agents';
import { getCase, upsertCase, withdrawCase, redactClosedCasePlaces } from '../src/cases';
import { registerAgent } from '../src/claims';
import { eraseAgent, listArchives, purgeArchives } from '../src/erasure';
import type { ControlApi } from '../src/index';
import { filesDue, scheduleRetention } from '../src/privacy';
import { addDocument } from '../src/vetting';
import {
  activePartner,
  caseInput,
  db,
  randomMobile,
  randomTckn,
  T0,
  unwrap,
  verifiedEmail,
} from './helpers';

const DAY = 86_400;
const control = () => exports.ControlApi as unknown as ControlApi;

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

const erasedAt = async (id: string) =>
  (
    await db()
      .prepare('SELECT erased_at FROM agents WHERE user_id = ?')
      .bind(id)
      .first<{ erased_at: number | null }>()
  )?.erased_at;

describe('legal holds', () => {
  it('keeps an agent’s files, account and archive while a hold is open', async () => {
    const id = await applicant();
    const ref = `agents/${id}/pr`;
    unwrap(
      await addDocument(
        db(),
        id,
        { kind: 'population_record', file_ref: ref, sha256: '2'.repeat(64), barcode: 'DEF123456' },
        T0,
      ),
    );
    expect(await control().placeHold('staff-1', 'agent', id, 'x')).toMatchObject({ ok: false });
    const hold = unwrap(await control().placeHold('staff-1', 'agent', id, 'Savcılık soruşturması'));
    expect(await control().placeHold('staff-1', 'agent', id, 'again')).toMatchObject({
      ok: false,
      error: 'already_held',
    });

    // An undecided document is queued after ninety days, unless the agent is held.
    await scheduleRetention(db(), T0 + 100 * DAY);
    const due = async () => (await filesDue(db(), 500)).some((f) => f.file_ref === ref);
    expect(await due()).toBe(false);

    // Neither staff nor the identity provider's deletion event can erase a held agent.
    expect(await eraseAgent(db(), 'staff:admin-1', id, { reason: 'talep' }, T0)).toMatchObject({
      ok: false,
      error: 'legal_hold',
    });
    await deleteUser(db(), id, T0);
    expect(await erasedAt(id)).toBeNull();
    const logged = await db()
      .prepare(
        `SELECT count(*) AS n FROM audit_events WHERE action = 'privacy.erasure_held' AND subject = ?`,
      )
      .bind(`agent:${id}`)
      .first<{ n: number }>();
    expect(logged?.n).toBe(1);

    // Lifting it lets the same run queue the file.
    unwrap(await control().releaseHold('staff-1', hold.id, 'Dava kapandı'));
    await scheduleRetention(db(), T0 + 100 * DAY);
    expect(await due()).toBe(true);
    expect(unwrap(await control().holds()).find((h) => h.id === hold.id)).toMatchObject({
      released_by: 'staff:staff-1',
      release_reason: 'Dava kapandı',
    });
  });

  it('does not destroy the sealed archive of a held agent', async () => {
    const id = await applicant();
    const archiveId =
      unwrap(await eraseAgent(db(), 'staff:admin-1', id, { reason: 'talep' }, T0)).archive_id ?? '';
    expect(archiveId).not.toBe('');
    const hold = unwrap(await control().placeHold('staff-1', 'agent', id, 'Uyuşmazlık sürüyor'));
    await purgeArchives(db(), T0 + 3700 * DAY);
    expect((await listArchives(db(), id))[0]?.purged_at ?? null).toBeNull();
    unwrap(await control().releaseHold('staff-1', hold.id, 'Kapandı'));
    expect(await purgeArchives(db(), T0 + 3700 * DAY)).toBeGreaterThanOrEqual(1);
  });

  it('keeps a held case’s addresses', async () => {
    const partner = await activePartner();
    const kase = unwrap(
      await upsertCase(
        db(),
        partner,
        caseInput({
          places: [
            { kind: 'work', address: 'Sanayi Cad. No:5', district: 'Bornova', city: 'İzmir' },
          ],
        }),
        'u',
        T0,
      ),
    );
    unwrap(await withdrawCase(db(), partner, kase.id, 'paid', 'u', T0 + DAY));
    const hold = unwrap(await control().placeHold('staff-1', 'case', kase.id, 'Borçlu itirazı'));
    await redactClosedCasePlaces(db(), T0 + 40 * DAY);
    expect(unwrap(await getCase(db(), partner.id, kase.id)).places[0]?.address).toBe(
      'Sanayi Cad. No:5',
    );
    unwrap(await control().releaseHold('staff-1', hold.id, 'İtiraz reddedildi'));
    await redactClosedCasePlaces(db(), T0 + 40 * DAY);
    expect(unwrap(await getCase(db(), partner.id, kase.id)).places[0]?.address).toBe('');
    expect(await control().placeHold('staff-1', 'case', 'no-such-case', 'neden')).toMatchObject({
      ok: false,
      error: 'not_found',
    });
  });
});
