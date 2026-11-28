import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { redactClosedCasePlaces, upsertCase, withdrawCase } from '../src/cases';
import { purgeArchives } from '../src/erasure';
import type { ControlApi } from '../src/index';
import { scheduleRetention } from '../src/privacy';
import { retentionOverview, type RetentionOverview } from '../src/retention';
import { activePartner, caseInput, db, T0, unwrap } from './helpers';

const DAY = 86_400;
const control = () => exports.ControlApi as unknown as ControlApi;

describe('retention overview', () => {
  it('counts what the next run takes, and what a hold keeps back', async () => {
    const partner = await activePartner();
    const place = [
      { kind: 'work' as const, address: 'Sanayi Cad. No:5', district: 'Bornova', city: 'İzmir' },
    ];
    const first = unwrap(await upsertCase(db(), partner, caseInput({ places: place }), 'u', T0));
    unwrap(await withdrawCase(db(), partner, first.id, 'paid', 'u', T0 + DAY));
    const held = unwrap(await upsertCase(db(), partner, caseInput({ places: place }), 'u', T0));
    unwrap(await withdrawCase(db(), partner, held.id, 'paid', 'u', T0 + DAY));
    unwrap(await control().placeHold('staff-1', 'case', held.id, 'Borçlu itirazı'));

    const at = T0 + 4000 * DAY;
    const row = (o: RetentionOverview, key: string) => o.rows.find((r) => r.key === key);
    const overview = () => retentionOverview(db(), at);
    const before = await overview();
    expect(before.open_holds).toBeGreaterThanOrEqual(1);
    expect(before.rows.map((r) => r.key)).toEqual([
      'failed_evidence',
      'delivered_evidence',
      'abandoned_documents',
      'partner_documents',
      'agent_documents',
      'case_places',
      'archive',
      'support',
      'invitation_requests',
    ]);
    expect(row(before, 'case_places')?.held).toBeGreaterThanOrEqual(1);
    expect(row(before, 'case_places')?.days).toBe(30);

    const places = row(before, 'case_places')?.due ?? 0;
    expect(places).toBeGreaterThanOrEqual(1);
    expect(await redactClosedCasePlaces(db(), at)).toBe(places);
    // The held case is still untouched, so it is still counted as held, and nothing is due.
    const after = await overview();
    expect(row(after, 'case_places')).toMatchObject({ due: 0 });
    expect(row(after, 'case_places')?.held).toBe(row(before, 'case_places')?.held);

    const others = before.rows.filter(
      (r) =>
        r.key !== 'case_places' &&
        r.key !== 'archive' &&
        r.key !== 'support' &&
        r.key !== 'invitation_requests',
    );
    const queued = others.reduce((sum, r) => sum + r.due, 0);
    expect(await scheduleRetention(db(), at)).toBe(queued);
    expect(await purgeArchives(db(), at)).toBe(row(before, 'archive')?.due);
  });

  it('is served to staff', async () => {
    const overview = unwrap(await control().retentionOverview());
    expect(overview.rows).toHaveLength(9);
    expect(overview.files_waiting).toBeGreaterThanOrEqual(0);
  });
});
