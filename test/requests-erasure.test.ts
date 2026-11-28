import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { deleteUser } from '../src/account-events';
import {
  answerRequest,
  askAgent,
  pendingRequests,
  requestsOf,
  settleRequest,
} from '../src/agent-requests';
import { agentProfile, updateProfile } from '../src/agents';
import { registerAgent } from '../src/claims';
import {
  archiveFileStored,
  eraseAgent,
  listArchives,
  myErasure,
  openArchive,
  openArchiveFile,
  purgeArchives,
  refuseErasure,
  requestErasure,
  sealArchiveFile,
  withdrawErasure,
} from '../src/erasure';
import type { ControlApi, FieldApi } from '../src/index';
import { archiveFilesDue, filesDue } from '../src/privacy';
import { addDocument, decideDocument, documentsOf } from '../src/vetting';
import { upsertCase } from '../src/cases';
import {
  activeAgent,
  activePartner,
  caseInput,
  db,
  randomMobile,
  randomTckn,
  T0,
  unwrap,
  verifiedEmail,
} from './helpers';

const hash = (seed: string) => seed.repeat(64).slice(0, 64);
const DAY = 86_400;

async function applicant(): Promise<{ id: string; tckn: string }> {
  const id = crypto.randomUUID();
  const tckn = randomTckn();
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
        tckn,
        birthYear: 1990,
        address: 'Örnek Mah. Deneme Sk. No:1 D:2 Karşıyaka İzmir',
      },
      T0,
    ),
  );
  return { id, tckn };
}

const pending = (id: string) =>
  db().prepare(`UPDATE agents SET status = 'kyc_pending' WHERE user_id = ?`).bind(id).run();

describe('asking an applicant for more', () => {
  it('returns a sent application and lists what is asked', async () => {
    const { id } = await applicant();
    await pending(id);
    const asked = unwrap(
      await askAgent(
        db(),
        'staff-1',
        id,
        [
          { kind: 'info', subject: 'address', note: 'Adresinizde daire numarası eksik.' },
          {
            kind: 'document',
            subject: 'residence_record',
            note: 'e-Devlet yerleşim yeri belgesi yükleyin.',
          },
        ],
        14,
        T0,
      ),
    );
    expect(asked.returned).toBe(true);
    expect(asked.ids).toHaveLength(2);
    const profile = unwrap(await agentProfile(db(), id));
    expect(profile.status).toBe('applied');
    expect(profile.review_note).toContain('daire numarası');
    expect(await pendingRequests(db(), id)).toEqual({ open: 2, answered: 0 });
    expect((await requestsOf(db(), id))[0]?.due_at).toBe(T0 + 14 * DAY);
  });

  it('refuses a request without words, an unknown subject, or more than ten at once', async () => {
    const { id } = await applicant();
    const ask = (asks: { kind: string; subject: string; note: string }[]) =>
      askAgent(db(), 'staff-1', id, asks, 14, T0);
    expect((await ask([{ kind: 'info', subject: 'address', note: 'x' }])).ok).toBe(false);
    expect((await ask([{ kind: 'info', subject: 'shoe_size', note: 'Lütfen düzeltin.' }])).ok).toBe(
      false,
    );
    expect(
      (await ask([{ kind: 'document', subject: 'passport', note: 'Lütfen yükleyin.' }])).ok,
    ).toBe(false);
    expect((await ask([])).ok).toBe(false);
    expect(
      (
        await ask(
          Array.from({ length: 11 }, () => ({
            kind: 'info',
            subject: 'phone',
            note: 'Lütfen düzeltin.',
          })),
        )
      ).ok,
    ).toBe(false);
  });

  it('a requested document answers its request; an unusable one is asked for again', async () => {
    const { id } = await applicant();
    const [requestId = ''] = unwrap(
      await askAgent(
        db(),
        'staff-1',
        id,
        [{ kind: 'document', subject: 'bank_proof', note: 'IBAN dekontu yükleyin.' }],
        14,
        T0,
      ),
    ).ids;
    // Not without the request, and not for another kind.
    expect(
      await addDocument(
        db(),
        id,
        { kind: 'bank_proof', file_ref: `agents/${id}/a`, sha256: hash('a') },
        T0,
      ),
    ).toMatchObject({ ok: false, error: 'invalid_document' });
    expect(
      await addDocument(
        db(),
        id,
        { kind: 'other', file_ref: `agents/${id}/a`, sha256: hash('a'), request_id: requestId },
        T0,
      ),
    ).toMatchObject({ ok: false, error: 'request_not_open' });
    const doc = unwrap(
      await addDocument(
        db(),
        id,
        {
          kind: 'bank_proof',
          file_ref: `agents/${id}/b`,
          sha256: hash('b'),
          request_id: requestId,
        },
        T0,
      ),
    );
    expect(await pendingRequests(db(), id)).toEqual({ open: 0, answered: 1 });
    const decided = unwrap(
      await decideDocument(db(), 'staff-1', doc.id, { outcome: 'invalid', note: 'okunmuyor' }, T0),
    );
    expect(decided.asked_again).toBe(true);
    expect(await pendingRequests(db(), id)).toEqual({ open: 1, answered: 0 });
    const again = unwrap(
      await addDocument(
        db(),
        id,
        {
          kind: 'bank_proof',
          file_ref: `agents/${id}/c`,
          sha256: hash('c'),
          request_id: requestId,
        },
        T0,
      ),
    );
    unwrap(await decideDocument(db(), 'staff-1', again.id, { outcome: 'clear' }, T0));
    expect((await requestsOf(db(), id))[0]?.status).toBe('accepted');
  });

  it('an agent answers a detail; staff accept; only the owner can answer', async () => {
    const { id } = await applicant();
    const [requestId = ''] = unwrap(
      await askAgent(
        db(),
        'staff-1',
        id,
        [{ kind: 'info', subject: 'other', note: 'Hangi ilçelerde çalışacaksınız?' }],
        14,
        T0,
      ),
    ).ids;
    expect(await answerRequest(db(), 'someone-else', requestId, 'Bornova', T0)).toMatchObject({
      ok: false,
    });
    expect(await answerRequest(db(), id, requestId, '', T0)).toMatchObject({
      ok: false,
      error: 'answer_needed',
    });
    expect(await settleRequest(db(), 'staff-1', requestId, 'accepted', T0)).toMatchObject({
      ok: false,
    });
    unwrap(await answerRequest(db(), id, requestId, 'Bornova ve Karşıyaka', T0));
    unwrap(await settleRequest(db(), 'staff-1', requestId, 'accepted', T0));
    expect(await pendingRequests(db(), id)).toEqual({ open: 0, answered: 0 });
  });

  it('an active agent can change a locked detail only while staff ask for it', async () => {
    const id = await activeAgent();
    const before = unwrap(await agentProfile(db(), id));
    const input = {
      legalName: 'Yeni Soyad Saha',
      city: before.city ?? 'İzmir',
      phone: before.phone ?? randomMobile(),
      iban: before.iban ?? 'TR330006100519786457841326',
      taxProfile: before.tax_profile,
    };
    expect(await updateProfile(db(), id, input, T0)).toMatchObject({
      ok: false,
      error: 'profile_locked',
    });
    unwrap(
      await askAgent(
        db(),
        'staff-1',
        id,
        [{ kind: 'info', subject: 'legal_name', note: 'Soyadınız değişmiş, güncelleyin.' }],
        14,
        T0,
      ),
    );
    unwrap(await updateProfile(db(), id, input, T0));
    expect(unwrap(await agentProfile(db(), id)).status).toBe('active');
  });

  it('gates sending again and activation over the entrypoints', async () => {
    const field = exports.FieldApi as unknown as FieldApi;
    const control = exports.ControlApi as unknown as ControlApi;
    unwrap(await control.setSetting('staff-1', 'require_documents', 0));
    unwrap(await control.setSetting('staff-1', 'require_signoffs', 0));
    const { id } = await applicant();
    await pending(id);
    const asked = unwrap(
      await control.askAgent('staff-1', id, [
        { kind: 'info', subject: 'other', note: 'Ehliyet sınıfınız nedir?' },
      ]),
    );
    const consents = { agreement: true, notice: true, consent: true };
    const terms = unwrap(await field.profile(id)).current_terms;
    expect(await field.submit(id, terms, consents, 'tr')).toMatchObject({
      ok: false,
      error: 'requests_open',
    });
    unwrap(await field.answerRequest(id, asked.ids[0] ?? '', 'B sınıfı'));
    unwrap(await field.submit(id, terms, consents, 'tr'));
    expect(await control.setAgentStatus('staff-1', id, 'active', 'ok')).toMatchObject({
      ok: false,
      error: 'requests_pending',
    });
    expect(unwrap(await control.answeredRequests()).some((r) => r.agent_id === id)).toBe(true);
    unwrap(await control.settleAgentRequest('staff-1', asked.ids[0] ?? '', 'accepted'));
    unwrap(await control.setAgentStatus('staff-1', id, 'active', 'ok'));
    unwrap(await control.resetSetting('staff-1', 'require_documents'));
    unwrap(await control.resetSetting('staff-1', 'require_signoffs'));
  });
});

describe('erasure on request and the sealed archive', () => {
  it('an agent asks once, can withdraw, and can ask again', async () => {
    const { id } = await applicant();
    const first = unwrap(await requestErasure(db(), id, 'Artık çalışmayacağım', T0));
    expect(first.due_at).toBe(T0 + 30 * DAY);
    expect(await requestErasure(db(), id, '', T0)).toMatchObject({
      ok: false,
      error: 'already_requested',
    });
    unwrap(await withdrawErasure(db(), id, T0 + 1));
    expect((await myErasure(db(), id))?.status).toBe('withdrawn');
    unwrap(await requestErasure(db(), id, '', T0 + 2));
  });

  it('a refusal needs a reason and closes the request', async () => {
    const { id } = await applicant();
    const request = unwrap(await requestErasure(db(), id, '', T0));
    expect(await refuseErasure(db(), 'admin-1', request.id, 'no', T0)).toMatchObject({ ok: false });
    unwrap(
      await refuseErasure(
        db(),
        'admin-1',
        request.id,
        'Bekleyen ödemeniz gönderilince silinecek.',
        T0,
      ),
    );
    expect((await myErasure(db(), id))?.status).toBe('refused');
  });

  it('erasing removes the person, seals a copy, and an admin opens it with a reason', async () => {
    const { id, tckn } = await applicant();
    const email = unwrap(await agentProfile(db(), id)).email ?? '';
    unwrap(
      await addDocument(
        db(),
        id,
        {
          kind: 'criminal_record',
          file_ref: `agents/${id}/cr`,
          sha256: hash('1'),
          barcode: 'ABC123456',
        },
        T0,
      ),
    );
    unwrap(
      await addDocument(
        db(),
        id,
        {
          kind: 'population_record',
          file_ref: `agents/${id}/pr`,
          sha256: hash('2'),
          barcode: 'DEF123456',
        },
        T0,
      ),
    );
    const request = unwrap(await requestErasure(db(), id, '', T0));
    const erased = unwrap(
      await eraseAgent(
        db(),
        'staff:admin-1',
        id,
        { reason: 'İlgili kişinin talebi', requestId: request.id },
        T0 + 10,
      ),
    );
    expect(erased.email).toBe(email);
    const archiveId = erased.archive_id ?? '';

    // The working database no longer names the person.
    const row = await db().prepare('SELECT * FROM agents WHERE user_id = ?').bind(id).first();
    expect(row).toMatchObject({
      status: 'banned',
      legal_name: null,
      email: null,
      phone: null,
      iban: null,
      tckn_hash: null,
      tckn_enc: null,
      address: null,
    });
    expect(row?.erased_at).toBe(T0 + 10);
    expect(await documentsOf(db(), id)).toHaveLength(0);
    expect((await myErasure(db(), id))?.status).toBe('done');
    expect(await eraseAgent(db(), 'staff:admin-1', id, { reason: 'again' }, T0 + 11)).toMatchObject(
      { ok: false, error: 'already_erased' },
    );
    expect(unwrap(await agentProfile(db(), id)).erased).toBe(true);

    // The sealed line holds nothing readable.
    const stored = await db()
      .prepare('SELECT payload_enc, lookup_hash FROM erasure_archive WHERE id = ?')
      .bind(archiveId)
      .first<{ payload_enc: string; lookup_hash: string }>();
    expect(stored?.payload_enc.startsWith('enc:v1:')).toBe(true);
    expect(stored?.payload_enc).not.toContain('Deneme');
    expect(stored?.lookup_hash).not.toContain('@');

    // Files: the criminal record is destroyed, the other document goes to the archive.
    const due = (await filesDue(db(), 500)).filter((f) => f.file_ref.startsWith(`agents/${id}/`));
    expect(due.find((f) => f.file_ref.endsWith('/cr'))?.archive_id).toBeNull();
    expect(due.some((f) => f.file_ref.endsWith('/pr'))).toBe(false);
    const bound = await archiveFilesDue(db(), 200);
    expect(bound.find((f) => f.file_ref === `agents/${id}/pr`)?.archive_id).toBe(archiveId);

    // Found by the address the person had; opened only with a reason; the opening is recorded.
    expect((await listArchives(db(), email)).map((a) => a.id)).toEqual([archiveId]);
    expect(await openArchive(db(), 'admin-1', archiveId, 'bakmak', T0 + 20)).toMatchObject({
      ok: false,
      error: 'invalid_reason',
    });
    const opened = unwrap(
      await openArchive(db(), 'admin-1', archiveId, 'Mahkeme yazısı 2026/123 için', T0 + 20),
    );
    expect(opened.payload.profile).toMatchObject({
      legal_name: 'Deneme Saha',
      id_number: tckn,
      email,
    });
    expect(opened.payload.documents).toHaveLength(2);
    expect((await listArchives(db(), id))[0]).toMatchObject({
      views: 1,
      last_viewed_at: T0 + 20,
      files_pending: 1,
    });
    const audit = await db()
      .prepare(
        `SELECT count(*) AS n FROM audit_events WHERE action = 'privacy.archive_opened' AND subject = ?`,
      )
      .bind(`archive:${archiveId}`)
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it('seals a file into the archive, opens it again, and destroys everything when time is up', async () => {
    const { id } = await applicant();
    unwrap(
      await addDocument(
        db(),
        id,
        {
          kind: 'population_record',
          file_ref: `agents/${id}/pr`,
          sha256: hash('2'),
          barcode: 'DEF123456',
        },
        T0,
      ),
    );
    const archiveId =
      unwrap(await eraseAgent(db(), 'staff:admin-1', id, { reason: 'talep' }, T0)).archive_id ?? '';
    const plain = new TextEncoder().encode('%PDF-1.7 nüfus kayıt örneği');
    const sealed = unwrap(
      await sealArchiveFile(db(), archiveId, `agents/${id}/pr`, plain.buffer as ArrayBuffer),
    );
    expect(new TextDecoder().decode(sealed)).not.toContain('PDF');
    expect(
      await sealArchiveFile(db(), archiveId, 'agents/other/file', plain.buffer as ArrayBuffer),
    ).toMatchObject({ ok: false });
    const ref = `archive/${archiveId}/one`;
    expect(
      await archiveFileStored(
        db(),
        archiveId,
        `agents/${id}/pr`,
        { ref: 'elsewhere/one', type: 'application/pdf', size: sealed.length },
        T0,
      ),
    ).toMatchObject({ ok: false });
    unwrap(
      await archiveFileStored(
        db(),
        archiveId,
        `agents/${id}/pr`,
        { ref, type: 'application/pdf', size: sealed.length },
        T0,
      ),
    );
    const entry = (await listArchives(db(), archiveId))[0];
    expect(entry?.files).toEqual([
      { ref, name: 'population_record', type: 'application/pdf', size: sealed.length },
    ]);
    expect(entry?.files_pending).toBe(0);
    const file = unwrap(
      await openArchiveFile(
        db(),
        'admin-1',
        archiveId,
        ref,
        'Savcılık talebi 2026/9',
        sealed.buffer as ArrayBuffer,
        T0,
      ),
    );
    expect(new TextDecoder().decode(file.bytes)).toBe('%PDF-1.7 nüfus kayıt örneği');

    expect(await purgeArchives(db(), T0 + 3649 * DAY)).toBe(0);
    expect(await purgeArchives(db(), T0 + 3651 * DAY)).toBeGreaterThanOrEqual(1);
    expect(
      await openArchive(db(), 'admin-1', archiveId, 'Mahkeme yazısı 2026/123 için', T0),
    ).toMatchObject({ ok: false, error: 'archive_destroyed' });
    expect(
      (await filesDue(db(), 500)).some((f) => f.file_ref === ref && f.archive_id === null),
    ).toBe(true);
  });

  it('waits for payouts on a request, keeps tax details after a sent one, and never stops an account deletion', async () => {
    const partner = await activePartner();
    const view = unwrap(await upsertCase(db(), partner, caseInput(), 'u', T0));
    const kase = await db()
      .prepare('SELECT vehicle_id FROM cases WHERE id = ?')
      .bind(view.id)
      .first<{ vehicle_id: string }>();
    const id = await activeAgent();
    await db()
      .prepare(
        `UPDATE agents SET tckn_enc = 'enc:v1:broken', address = 'Bir adres, İzmir' WHERE user_id = ?`,
      )
      .bind(id)
      .run();
    await db()
      .prepare(
        `INSERT INTO payouts (id, agent_id, vehicle_id, case_id, gross_kurus, withholding_kurus, net_kurus, status, created_at, updated_at) VALUES (?, ?, ?, ?, 100, 0, 100, 'ready', ?, ?)`,
      )
      .bind(crypto.randomUUID(), id, kase?.vehicle_id ?? '', view.id, T0, T0)
      .run();
    expect(await eraseAgent(db(), 'staff:admin-1', id, { reason: 'talep' }, T0)).toMatchObject({
      ok: false,
      error: 'payouts_pending',
    });
    await db().prepare(`UPDATE payouts SET status = 'sent' WHERE agent_id = ?`).bind(id).run();
    await deleteUser(db(), id, T0);
    await deleteUser(db(), id, T0 + 1);
    const row = await db()
      .prepare('SELECT legal_name, address, tckn_enc, erased_at FROM agents WHERE user_id = ?')
      .bind(id)
      .first<{
        legal_name: string | null;
        address: string | null;
        tckn_enc: string | null;
        erased_at: number;
      }>();
    expect(row).toEqual({
      legal_name: null,
      address: 'Bir adres, İzmir',
      tckn_enc: 'enc:v1:broken',
      erased_at: T0,
    });
    expect(await listArchives(db(), id)).toHaveLength(1);
  });
});
