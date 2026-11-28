import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { askAgent } from '../src/agent-requests';
import { updateProfile } from '../src/agents';
import { registerAgent } from '../src/claims';
import type { ControlApi } from '../src/index';
import { db, randomMobile, randomTckn, T0, unwrap, verifiedEmail } from './helpers';

const item = (list: { items: { key: string; ok: boolean; blocking: boolean }[] }, key: string) =>
  list.items.find((one) => one.key === key);

describe('what stands between an applicant and activation', () => {
  it('lists each point, flips as staff act, and says whether it blocks', async () => {
    const control = exports.ControlApi as unknown as ControlApi;
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
    const before = unwrap(await control.activationChecklist(id));
    expect(item(before, 'video_call')).toEqual({ key: 'video_call', ok: false, blocking: false });
    expect(item(before, 'iban')?.blocking).toBe(false);
    expect(item(before, 'requests')?.ok).toBe(true);

    unwrap(await control.recordVideoCall('staff-1', id, true));
    unwrap(
      await askAgent(
        db(),
        'staff-1',
        id,
        [{ kind: 'info', subject: 'city', note: 'Şehrinizi doğrulayın lütfen.' }],
        14,
        T0,
      ),
    );
    const after = unwrap(await control.activationChecklist(id));
    expect(item(after, 'video_call')?.ok).toBe(true);
    expect(item(after, 'requests')).toMatchObject({ ok: false, blocking: true, detail: 1 });
    expect(after.ready).toBe(false);
  });

  it('has nothing to say about an unknown agent', async () => {
    const control = exports.ControlApi as unknown as ControlApi;
    expect((await control.activationChecklist(crypto.randomUUID())).ok).toBe(false);
  });
});
