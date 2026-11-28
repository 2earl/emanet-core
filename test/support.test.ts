import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { updateProfile } from '../src/agents';
import { registerAgent } from '../src/claims';
import type { ControlApi, FieldApi, PartnerApi } from '../src/index';
import { retentionOverview } from '../src/retention';
import { OPEN_LIMIT, purgeSupport } from '../src/support';
import { activePartner, db, randomMobile, randomTckn, T0, unwrap, verifiedEmail } from './helpers';

const DAY = 86_400;
const field = () => exports.FieldApi as unknown as FieldApi;
const partners = () => exports.PartnerApi as unknown as PartnerApi;
const control = () => exports.ControlApi as unknown as ControlApi;

async function agent(): Promise<string> {
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

const ticket = { subject: 'Ödemem gelmedi', category: 'payment', message: 'IBAN’ıma ödeme yok.' };

describe('the support desk', () => {
  it('lets an agent write, staff answer and note, and the agent read only the answer', async () => {
    const id = await agent();
    const { id: ticketId } = unwrap(await field().openTicket(id, ticket));
    expect(unwrap(await field().myTickets(id))[0]).toMatchObject({
      id: ticketId,
      status: 'open',
    });

    unwrap(
      await control().supportReply(
        'staff-1',
        ticketId,
        'Kontrol ediyorum, IBAN doğrulanmamış.',
        true,
      ),
    );
    unwrap(await control().supportReply('staff-1', ticketId, 'IBAN’ınızı doğrulayacağız.'));
    const staffView = unwrap(await control().supportTicket(ticketId));
    expect(staffView.messages.map((m) => m.author_kind)).toEqual(['requester', 'note', 'staff']);
    expect(staffView.ticket).toMatchObject({
      status: 'answered',
      who: 'Deneme Saha',
      assigned_to: 'staff-1',
    });
    expect(staffView.ticket.first_response_at).not.toBeNull();

    const mine = unwrap(await field().myTicket(id, ticketId));
    expect(mine.messages.map((m) => m.author_kind)).toEqual(['requester', 'staff']);
    expect(JSON.stringify(mine)).not.toContain('doğrulanmamış');

    // Writing back reopens it for staff; closing is the requester's too.
    unwrap(await field().replyTicket(id, ticketId, 'Teşekkürler, bekliyorum.'));
    expect(unwrap(await field().myTicket(id, ticketId)).ticket.status).toBe('open');
    unwrap(await field().closeTicket(id, ticketId));
    expect(unwrap(await field().myTicket(id, ticketId)).ticket.status).toBe('closed');
  });

  it('keeps one requester out of another’s tickets, and validates what is written', async () => {
    const a = await agent();
    const b = await agent();
    const { id } = unwrap(await field().openTicket(a, ticket));
    expect(await field().myTicket(b, id)).toMatchObject({ ok: false, error: 'not_found' });
    expect(await field().replyTicket(b, id, 'merhaba')).toMatchObject({ ok: false });
    expect(await field().closeTicket(b, id)).toMatchObject({ ok: false });
    expect(await field().openTicket(a, { ...ticket, subject: 'x' })).toMatchObject({
      ok: false,
      error: 'invalid_subject',
    });
    expect(await field().openTicket(a, { ...ticket, category: 'invoice' })).toMatchObject({
      ok: false,
      error: 'invalid_category',
    });
    expect(await field().openTicket(a, { ...ticket, message: ' ' })).toMatchObject({
      ok: false,
      error: 'invalid_message',
    });
    expect(await field().openTicket(a, { ...ticket, message: 'a'.repeat(4001) })).toMatchObject({
      ok: false,
      error: 'invalid_message',
    });
  });

  it('limits how many tickets one requester has open', async () => {
    const id = await agent();
    for (let i = 1; i < OPEN_LIMIT; i += 1) unwrap(await field().openTicket(id, ticket));
    const last = unwrap(await field().openTicket(id, ticket));
    expect(await field().openTicket(id, ticket)).toMatchObject({
      ok: false,
      error: 'too_many_open',
    });
    unwrap(await field().closeTicket(id, last.id));
    unwrap(await field().openTicket(id, ticket));
  });

  it('serves a company, by its own organization only', async () => {
    const partner = await activePartner();
    const other = await activePartner();
    const { id } = unwrap(
      await partners().openTicket(partner.orgId, 'user-1', {
        subject: 'Fatura sorusu',
        category: 'invoice',
        message: 'KDV tutarı yanlış görünüyor.',
      }),
    );
    expect(unwrap(await partners().myTickets(partner.orgId))).toHaveLength(1);
    expect(await partners().myTicket(other.orgId, id)).toMatchObject({ ok: false });
    expect(
      await partners().openTicket(partner.orgId, 'user-1', { ...ticket, category: 'payment' }),
    ).toMatchObject({ ok: false, error: 'invalid_category' });
    expect(await partners().myTickets('no-such-org')).toMatchObject({ ok: false });
    const queue = unwrap(await control().supportTickets({ status: 'active', kind: 'partner' }));
    expect(queue.find((t) => t.id === id)?.who).toBe(partner.legalName);
  });

  it('deletes closed tickets after the retention period, except under a hold', async () => {
    const free = await agent();
    const held = await agent();
    const a = unwrap(await field().openTicket(free, ticket)).id;
    const b = unwrap(await field().openTicket(held, ticket)).id;
    unwrap(await field().closeTicket(free, a));
    unwrap(await field().closeTicket(held, b));
    unwrap(await control().placeHold('staff-1', 'agent', held, 'Uyuşmazlık'));
    const at = Math.floor(Date.now() / 1000) + 800 * DAY;
    const row = (o: Awaited<ReturnType<typeof retentionOverview>>) =>
      o.rows.find((r) => r.key === 'support');
    const overview = await retentionOverview(db(), at);
    expect(row(overview)?.held).toBeGreaterThanOrEqual(1);
    const due = row(overview)?.due ?? 0;
    expect(due).toBeGreaterThanOrEqual(1);
    expect(await purgeSupport(db(), at)).toBe(due);
    expect(await field().myTicket(free, a)).toMatchObject({ ok: false });
    expect(unwrap(await field().myTicket(held, b)).ticket.id).toBe(b);
  });
});

describe('saved replies', () => {
  it('starts with the shipped set, then staff add, change and delete their own', async () => {
    const first = unwrap(await control().supportReplies());
    expect(first.map((r) => r.id)).toContain('payment-when');
    expect(first.find((r) => r.id === 'payment-when')?.audience).toBe('agent');
    expect(first[0]?.id).toBe('looking');

    expect(
      await control().saveSupportReply('staff-1', {
        title_en: 'x',
        title_tr: 'y',
        audience: 'all',
        body: 'Merhaba, kısa.',
      }),
    ).toMatchObject({ ok: false, error: 'invalid_title' });
    expect(
      await control().saveSupportReply('staff-1', {
        title_en: 'Thanks',
        title_tr: 'Teşekkürler',
        audience: 'nobody',
        body: 'Merhaba, teşekkürler.',
      }),
    ).toMatchObject({ ok: false, error: 'invalid_audience' });

    const { id } = unwrap(
      await control().saveSupportReply('staff-1', {
        title_en: 'Thanks',
        title_tr: 'Teşekkürler',
        audience: 'partner',
        body: 'Merhaba,\n\nTeşekkür ederiz.\n\n2earl Destek',
      }),
    );
    const added = unwrap(await control().supportReplies());
    expect(added.at(-1)?.id).toBe(id);

    unwrap(
      await control().saveSupportReply('staff-2', {
        id,
        title_en: 'Thank you',
        title_tr: 'Teşekkür',
        audience: 'all',
        body: 'Merhaba, çok teşekkürler.',
        position: 5,
      }),
    );
    const changed = unwrap(await control().supportReplies());
    expect(changed[0]).toMatchObject({
      id,
      title_en: 'Thank you',
      audience: 'all',
      updated_by: 'staff-2',
    });

    unwrap(await control().deleteSupportReply('staff-1', id));
    expect(unwrap(await control().supportReplies()).some((r) => r.id === id)).toBe(false);
    expect(await control().deleteSupportReply('staff-1', id)).toMatchObject({
      ok: false,
      error: 'not_found',
    });
    const audit = await db()
      .prepare('SELECT action FROM audit_events WHERE subject = ? ORDER BY rowid')
      .bind(`reply:${id}`)
      .all<{ action: string }>();
    expect(audit.results.map((r) => r.action)).toEqual([
      'support.reply_saved',
      'support.reply_saved',
      'support.reply_deleted',
    ]);
  });
});
