import { describe, expect, it } from 'vitest';
import {
  answerTimes,
  openTicket,
  rateTicket,
  setTicketStatus,
  staffReply,
  typicalAnswer,
} from '../src/support';
import { db, T0, unwrap } from './helpers';

const HOUR = 3600;
const AT = T0 + 40 * 86_400;

async function ask(kind: 'agent' | 'partner', category: string, opened: number): Promise<string> {
  const ref = crypto.randomUUID();
  const { id } = unwrap(
    await openTicket(
      db(),
      kind,
      ref,
      ref,
      { subject: 'Bir sorum var', category, message: 'Merhaba, yardım eder misiniz?' },
      opened,
    ),
  );
  return id;
}

async function answered(
  kind: 'agent' | 'partner',
  category: string,
  opened: number,
  after: number,
) {
  const id = await ask(kind, category, opened);
  unwrap(await staffReply(db(), 'staff-1', id, 'Bakıyoruz.', false, opened + after));
  return id;
}

describe('answer times', () => {
  it('counts first answers per side and category, waiting tickets with their wait so far', async () => {
    // Older than the window: never counted.
    await answered('agent', 'payment', AT - 31 * 86_400, HOUR);
    await answered('agent', 'payment', AT - 5 * 86_400, 1 * HOUR);
    await answered('agent', 'payment', AT - 5 * 86_400, 3 * HOUR);
    await answered('agent', 'account', AT - 4 * 86_400, 30 * HOUR);
    // Still waiting, 10 h so far.
    await ask('agent', 'account', AT - 10 * HOUR);
    // A note is not an answer.
    const noted = await ask('agent', 'technical', AT - 2 * HOUR);
    unwrap(await staffReply(db(), 'staff-1', noted, 'İç not.', true, AT - HOUR));
    // Closed by the requester before anyone answered: says nothing about us.
    const gave = await ask('agent', 'other', AT - 3 * 86_400);
    unwrap(await setTicketStatus(db(), 'staff-1', gave, true, AT - 2 * 86_400));

    const times = await answerTimes(db(), AT);
    const side = times.find((t) => t.kind === 'agent' && t.category === null);
    // Times: 1 h, 2 h (noted, waiting), 3 h, 10 h (waiting), 30 h.
    expect(side).toMatchObject({
      opened: 6,
      answered: 3,
      waiting: 2,
      median: 3 * HOUR,
      p75: 10 * HOUR,
    });
    expect(side?.within_day).toBeCloseTo(4 / 5);
    expect(times.find((t) => t.kind === 'agent' && t.category === 'payment')).toMatchObject({
      opened: 2,
      answered: 2,
      median: HOUR,
    });
    expect(times.find((t) => t.kind === 'agent' && t.category === 'delivery')).toBeUndefined();
    expect(times.find((t) => t.kind === 'partner' && t.category === null)).toMatchObject({
      opened: 0,
      median: null,
      within_day: null,
    });
  });

  it('tells requesters a number only once enough questions were answered', async () => {
    for (let i = 0; i < 9; i += 1)
      await answered('partner', 'invoice', AT - 2 * 86_400, (i + 1) * HOUR);
    expect(await typicalAnswer(db(), 'partner', AT)).toEqual({ p75: null, days: 30 });
    await answered('partner', 'case', AT - 86_400, 2 * HOUR);
    // Ten answers: 1, 2, 2, 3 … 9 h; three in four within 7 h.
    expect(await typicalAnswer(db(), 'partner', AT)).toEqual({ p75: 7 * HOUR, days: 30 });
  });
});

describe('did the answer help', () => {
  it('takes one changeable mark per answered ticket from its own requester, and counts it', async () => {
    const ref = crypto.randomUUID();
    const { id } = unwrap(
      await openTicket(
        db(),
        'agent',
        ref,
        ref,
        { subject: 'Ödeme', category: 'delivery', message: 'Merhaba, ne zaman?' },
        AT - HOUR * 5,
      ),
    );
    // Nothing to mark before staff answered, and never on someone else's ticket.
    expect(await rateTicket(db(), 'agent', ref, ref, id, true, AT - HOUR * 4)).toEqual({
      ok: false,
      error: 'not_answered',
    });
    unwrap(await staffReply(db(), 'staff-1', id, 'Yarın.', false, AT - HOUR * 3));
    expect(await rateTicket(db(), 'agent', 'someone-else', 'x', id, true, AT)).toEqual({
      ok: false,
      error: 'not_found',
    });
    unwrap(await rateTicket(db(), 'agent', ref, ref, id, false, AT - HOUR * 2));
    unwrap(await rateTicket(db(), 'agent', ref, ref, id, true, AT - HOUR));
    const delivery = (await answerTimes(db(), AT)).find(
      (t) => t.kind === 'agent' && t.category === 'delivery',
    );
    expect(delivery).toMatchObject({ rated: 1, helped: 1 });
  });
});
