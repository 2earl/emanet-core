/**
 * Erasing an agent's personal data, and the sealed archive of what was erased
 * (docs/DESIGN.md §8; KVKK art. 7, 11, 13).
 *
 * An agent asks in Emanet Saha; the request enters the register with its thirty-day limit, and an
 * admin carries it out or refuses it with a reason. Closing the login account does the same
 * without asking.
 *
 * What erasing means here: everything that identifies the person leaves the working database and
 * storage. Money records stay, as the law requires (VUK 253, TTK 82). And one sealed copy of what
 * was removed is kept apart for a fixed time, so that Emanet can answer a court, an authority or
 * a claim: nothing in the product reads it, an admin opens one record at a time with a reason,
 * every opening is written down, and when its time is up the content is destroyed. That copy is
 * restricted storage, not deletion, and the privacy notice says so.
 *
 * The file of a criminal record is never archived: it is special-category data held on consent,
 * and a request to erase withdraws that consent.
 */
import { auditStatement } from './audit';
import { orphanReviewsStatement } from './claims';
import { isHeld } from './holds';
import { keyedHash, open, openBytes, seal, sealBytes } from './pii';
import { eraseAgentEvidenceStatement } from './privacy';
import { fail, newId, ok, type Result } from './result';
import { readSettings } from './settings';

const DAY = 86_400;

// ---- The agent's request --------------------------------------------------------------------------

export interface ErasureRequest {
  id: string;
  status: 'open' | 'done' | 'refused' | 'withdrawn';
  received_at: number;
  due_at: number;
  outcome: string | null;
  closed_at: number | null;
}

/** The agent's latest request to be erased, if any. */
export async function myErasure(db: D1Database, agentId: string): Promise<ErasureRequest | null> {
  return db
    .prepare(
      `SELECT id, status, received_at, due_at, outcome, closed_at FROM privacy_requests
       WHERE kind = 'erasure' AND subject_kind = 'agent' AND subject_ref = ?
       ORDER BY received_at DESC LIMIT 1`,
    )
    .bind(agentId)
    .first<ErasureRequest>();
}

export interface ErasureBlockers {
  open_claims: number;
  /** Payouts earned but not yet sent: erasing removes the IBAN they would be paid to. */
  payouts_pending: number;
  payouts_sent: number;
}

export async function erasureBlockers(db: D1Database, agentId: string): Promise<ErasureBlockers> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT count(*) FROM claims WHERE agent_id = ?1 AND closed_at IS NULL) AS open_claims,
         (SELECT count(*) FROM payouts WHERE agent_id = ?1 AND status IN ('awaiting_receipt', 'ready', 'approved')) AS payouts_pending,
         (SELECT count(*) FROM payouts WHERE agent_id = ?1 AND status = 'sent') AS payouts_sent`,
    )
    .bind(agentId)
    .first<ErasureBlockers>();
  return row ?? { open_claims: 0, payouts_pending: 0, payouts_sent: 0 };
}

/** The agent asks for their data to be erased. One open request at a time. */
export async function requestErasure(
  db: D1Database,
  agentId: string,
  note: string,
  at: number,
): Promise<Result<{ id: string; due_at: number; days: number }>> {
  const agent = await db
    .prepare('SELECT erased_at FROM agents WHERE user_id = ?')
    .bind(agentId)
    .first<{ erased_at: number | null }>();
  if (!agent || agent.erased_at !== null) return fail('not_found');
  const current = await myErasure(db, agentId);
  if (current?.status === 'open') return fail('already_requested');
  const days = (await readSettings(db)).privacy_request_days;
  const id = newId();
  const due = at + days * DAY;
  await db.batch([
    db
      .prepare(
        `INSERT INTO privacy_requests (id, kind, subject_kind, subject_ref, channel, note, received_at, due_at, created_by)
         VALUES (?, 'erasure', 'agent', ?, 'saha', ?, ?, ?, ?)`,
      )
      .bind(
        id,
        agentId,
        typeof note === 'string' && note.trim() ? note.trim().slice(0, 1000) : null,
        at,
        due,
        `agent:${agentId}`,
      ),
    auditStatement(db, at, `agent:${agentId}`, 'privacy.request_opened', `privacy:${id}`, {
      kind: 'erasure',
    }),
  ]);
  return ok({ id, due_at: due, days });
}

export async function withdrawErasure(
  db: D1Database,
  agentId: string,
  at: number,
): Promise<Result<null>> {
  const current = await myErasure(db, agentId);
  if (current?.status !== 'open') return fail('not_found');
  const results = await db.batch([
    db
      .prepare(
        `UPDATE privacy_requests SET status = 'withdrawn', closed_by = ?, closed_at = ?
         WHERE id = ? AND status = 'open'`,
      )
      .bind(`agent:${agentId}`, at, current.id),
    auditStatement(
      db,
      at,
      `agent:${agentId}`,
      'privacy.request_withdrawn',
      `privacy:${current.id}`,
    ),
  ]);
  return results[0]?.meta.changes === 1 ? ok(null) : fail('conflict_retry');
}

// ---- Erasing --------------------------------------------------------------------------------------

/** What the sealed record of an erased agent holds. */
export interface ArchivePayload {
  subject: 'agent';
  account_id: string;
  archived_at: number;
  reason: string;
  profile: Record<string, unknown>;
  identity_checks: Record<string, unknown>[];
  documents: Record<string, unknown>[];
  acceptances: Record<string, unknown>[];
  requests: Record<string, unknown>[];
  privacy_requests: Record<string, unknown>[];
}

const reasonOf = (value: unknown, min = 3): string | null => {
  const reason = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return reason.length >= min && reason.length <= 300 ? reason : null;
};

export interface Erased {
  archive_id: string | null;
  /** The address the person is told at, read before it was removed. */
  email: string | null;
  locale: string;
  years: number;
}

/**
 * Removes everything that identifies the agent and seals a copy of it. `by` is `staff:<id>` for
 * a request an admin carries out, or `system` when the login account was deleted (then payouts
 * that wait don't stop it: there is no account left to pay). Safe to call twice.
 */
export async function eraseAgent(
  db: D1Database,
  by: string,
  agentId: string,
  input: { reason: string; requestId?: string | null },
  at: number,
): Promise<Result<Erased>> {
  const reason = reasonOf(input.reason);
  if (!reason) return fail('invalid_reason');
  const agent = await db.prepare('SELECT * FROM agents WHERE user_id = ?').bind(agentId).first();
  const settings = await readSettings(db);
  const years = Math.max(1, Math.round(settings.erasure_archive_days / 365));
  if (!agent)
    return by === 'system'
      ? ok({ archive_id: null, email: null, locale: 'tr', years })
      : fail('not_found');
  if (agent.erased_at !== null && agent.erased_at !== undefined) {
    return by === 'system'
      ? ok({ archive_id: null, email: null, locale: 'tr', years })
      : fail('already_erased');
  }
  if (await isHeld(db, 'agent', agentId)) {
    // A legal hold wins over a request to erase. The request stays; staff answer it citing the hold.
    if (by !== 'system') return fail('legal_hold');
    await auditStatement(db, at, 'system', 'privacy.erasure_held', `agent:${agentId}`).run();
    return ok({ archive_id: null, email: null, locale: 'tr', years });
  }
  const blockers = await erasureBlockers(db, agentId);
  if (by !== 'system' && blockers.payouts_pending > 0) return fail('payouts_pending');

  const rows = async (sql: string) => (await db.prepare(sql).bind(agentId).all()).results;
  const [checks, documents, acceptances, requests, privacy] = await Promise.all([
    rows(
      'SELECT kind, provider, result, reviewed_by, created_at FROM kyc_checks WHERE agent_id = ? ORDER BY created_at',
    ),
    rows(
      `SELECT d.id, d.kind, d.barcode, d.sha256, d.uploaded_at, d.status, d.outcome, d.decided_by, d.decided_at, d.note,
         d.request_id, d.file_ref,
         EXISTS (SELECT 1 FROM erased_files x WHERE x.file_ref = d.file_ref) AS file_gone
       FROM agent_documents d WHERE d.agent_id = ? ORDER BY d.uploaded_at`,
    ),
    rows(
      'SELECT version, sha256, locale, accepted_at, withdrawn_at FROM agent_acceptances WHERE agent_id = ? ORDER BY accepted_at',
    ),
    rows(
      'SELECT kind, subject, note, status, answer, created_by, created_at, answered_at, closed_by, closed_at FROM agent_requests WHERE agent_id = ? ORDER BY created_at',
    ),
    rows(
      `SELECT id, kind, channel, note, received_at, due_at, status, outcome, closed_at FROM privacy_requests
       WHERE subject_kind = 'agent' AND subject_ref = ? ORDER BY received_at`,
    ),
  ]);

  const profile: Record<string, unknown> = { ...agent };
  const sealedId = profile.tckn_enc;
  delete profile.tckn_enc;
  delete profile.tckn_hash;
  // A number that can't be opened (a key that changed) doesn't stop the person being erased.
  let idNumber: unknown;
  try {
    idNumber = sealedId ? await open(sealedId, `agent:${agentId}:tckn`) : null;
  } catch {
    idNumber = 'unreadable';
  }
  const archiveId = newId();
  const payload: ArchivePayload = {
    subject: 'agent',
    account_id: agentId,
    archived_at: at,
    reason,
    profile: { ...profile, id_number: idNumber },
    identity_checks: checks,
    documents: documents.map((row) => {
      const rest = { ...row };
      delete rest.file_ref;
      delete rest.file_gone;
      return rest;
    }),
    acceptances,
    requests,
    privacy_requests: privacy,
  };
  const email = typeof agent.email === 'string' && agent.email ? agent.email : null;
  const keepsTax = blockers.payouts_sent > 0;
  const request =
    input.requestId ??
    (privacy.find((row) => row.kind === 'erasure' && row.status === 'open')?.id as
      string | undefined) ??
    null;

  await db.batch([
    db
      .prepare(
        `INSERT INTO erasure_archive (id, subject_kind, subject_ref, lookup_hash, request_id, reason, payload_enc, archived_by, archived_at, purge_at)
         VALUES (?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        archiveId,
        agentId,
        email ? await keyedHash('archive-email', email.toLowerCase()) : null,
        request,
        reason,
        await seal(payload, `archive:${archiveId}`),
        by,
        at,
        at + settings.erasure_archive_days * DAY,
      ),
    db
      .prepare(
        `UPDATE claims SET closed_at = ?, close_reason = 'revoked'
         WHERE agent_id = ? AND closed_at IS NULL`,
      )
      .bind(at, agentId),
    // Sent payouts need the ID number and address on their tax documents: those two stay sealed
    // in place until the books' retention ends. Everything else that names the person goes.
    db
      .prepare(
        `UPDATE agents SET status = 'banned', legal_name = NULL, tckn_hash = NULL, city = NULL,
           iban = NULL, iban_verified_at = NULL, vkn = NULL, phone = NULL, phone_verified_at = NULL,
           email = NULL, email_verified_at = NULL, birth_year = NULL, review_note = NULL,
           tckn_enc = CASE WHEN ?1 THEN tckn_enc ELSE NULL END,
           address = CASE WHEN ?1 THEN address ELSE NULL END,
           erased_at = ?2, updated_at = ?2
         WHERE user_id = ?3`,
      )
      .bind(keepsTax ? 1 : 0, at, agentId),
    db.prepare('DELETE FROM kyc_checks WHERE agent_id = ?').bind(agentId),
    db.prepare('DELETE FROM cooldowns WHERE agent_id = ?').bind(agentId),
    db.prepare('DELETE FROM agent_email_codes WHERE agent_id = ?').bind(agentId),
    orphanReviewsStatement(db, at),
    // After the claims are closed above: photos of every claim that delivered nothing.
    eraseAgentEvidenceStatement(db, agentId, at),
    // The agent's documents still in storage: sealed into the archive, except a criminal record,
    // which is destroyed.
    db
      .prepare(
        `INSERT INTO erased_files (file_ref, bucket, record_id, reason, requested_by, requested_at, archive_id, name)
         SELECT d.file_ref, 'evidence', d.id, 'erased', ?1, ?2,
           CASE WHEN d.kind = 'criminal_record' THEN NULL ELSE ?3 END, d.kind
         FROM agent_documents d
         WHERE d.agent_id = ?4 AND NOT EXISTS (SELECT 1 FROM erased_files x WHERE x.file_ref = d.file_ref)`,
      )
      .bind(by, at, archiveId, agentId),
    db.prepare('DELETE FROM agent_documents WHERE agent_id = ?').bind(agentId),
    db.prepare('DELETE FROM agent_requests WHERE agent_id = ?').bind(agentId),
    db
      .prepare(
        'UPDATE agent_acceptances SET withdrawn_at = ? WHERE agent_id = ? AND withdrawn_at IS NULL',
      )
      .bind(at, agentId),
    db
      .prepare(
        `UPDATE privacy_requests SET status = 'done', outcome = ?, closed_by = ?, closed_at = ?
         WHERE subject_kind = 'agent' AND subject_ref = ? AND kind = 'erasure' AND status = 'open'`,
      )
      .bind(`Erased. Sealed archive ${archiveId}.`, by, at, agentId),
    auditStatement(
      db,
      at,
      by,
      by === 'system' ? 'account.deleted' : 'privacy.agent_erased',
      `agent:${agentId}`,
      { archive: archiveId, tax_details_kept: keepsTax },
    ),
  ]);
  return ok({
    archive_id: archiveId,
    email,
    locale: agent.locale === 'en' ? 'en' : 'tr',
    years,
  });
}

/** An admin refuses a request to erase, with the reason the person is told. */
export async function refuseErasure(
  db: D1Database,
  staffId: string,
  requestId: string,
  reason: string,
  at: number,
): Promise<Result<{ agent_id: string; reason: string }>> {
  const why = reasonOf(reason, 10);
  if (!why) return fail('invalid_reason');
  const request = await db
    .prepare(
      `SELECT subject_ref FROM privacy_requests
       WHERE id = ? AND kind = 'erasure' AND subject_kind = 'agent' AND status = 'open'`,
    )
    .bind(requestId)
    .first<{ subject_ref: string }>();
  if (!request) return fail('not_found');
  const results = await db.batch([
    db
      .prepare(
        `UPDATE privacy_requests SET status = 'refused', outcome = ?, closed_by = ?, closed_at = ?
         WHERE id = ? AND status = 'open'`,
      )
      .bind(why, staffId, at, requestId),
    auditStatement(db, at, `staff:${staffId}`, 'privacy.request_refused', `privacy:${requestId}`),
  ]);
  return results[0]?.meta.changes === 1
    ? ok({ agent_id: request.subject_ref, reason: why })
    : fail('conflict_retry');
}

// ---- The archive ----------------------------------------------------------------------------------

export interface ArchiveFile {
  ref: string;
  name: string;
  type: string;
  size: number;
}

export interface ArchiveEntry {
  id: string;
  subject_kind: 'agent';
  subject_ref: string;
  request_id: string | null;
  reason: string;
  archived_by: string;
  archived_at: number;
  purge_at: number;
  purged_at: number | null;
  files: ArchiveFile[];
  /** Files still waiting to be sealed and moved by Emanet Merkez. */
  files_pending: number;
  views: number;
  last_viewed_at: number | null;
}

const filesOf = (json: string): ArchiveFile[] => {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as ArchiveFile[]) : [];
  } catch {
    return [];
  }
};

const ENTRY = `a.id, a.subject_kind, a.subject_ref, a.request_id, a.reason, a.archived_by, a.archived_at,
  a.purge_at, a.purged_at, a.files,
  (SELECT count(*) FROM erased_files x WHERE x.archive_id = a.id AND x.erased_at IS NULL) AS files_pending,
  (SELECT count(*) FROM erasure_archive_views v WHERE v.archive_id = a.id) AS views,
  (SELECT max(viewed_at) FROM erasure_archive_views v WHERE v.archive_id = a.id) AS last_viewed_at`;

type EntryRow = Omit<ArchiveEntry, 'files'> & { files: string };
const entryOf = (row: EntryRow): ArchiveEntry => ({
  id: row.id,
  subject_kind: row.subject_kind,
  subject_ref: row.subject_ref,
  request_id: row.request_id,
  reason: row.reason,
  archived_by: row.archived_by,
  archived_at: row.archived_at,
  purge_at: row.purge_at,
  purged_at: row.purged_at,
  files: filesOf(row.files),
  files_pending: row.files_pending,
  views: row.views,
  last_viewed_at: row.last_viewed_at,
});

/**
 * The archive's lines, newest first; never their content. `term` narrows to an account ID, an
 * archive ID, or the email address the person had.
 */
export async function listArchives(db: D1Database, term = ''): Promise<ArchiveEntry[]> {
  const q = typeof term === 'string' ? term.trim().slice(0, 254) : '';
  if (!q) {
    const { results } = await db
      .prepare(`SELECT ${ENTRY} FROM erasure_archive a ORDER BY a.archived_at DESC LIMIT 200`)
      .all<EntryRow>();
    return results.map(entryOf);
  }
  const hash = q.includes('@') ? await keyedHash('archive-email', q.toLowerCase()) : '';
  const { results } = await db
    .prepare(
      `SELECT ${ENTRY} FROM erasure_archive a
       WHERE a.subject_ref = ?1 OR a.id = ?1 OR (?2 != '' AND a.lookup_hash = ?2)
       ORDER BY a.archived_at DESC LIMIT 50`,
    )
    .bind(q, hash)
    .all<EntryRow>();
  return results.map(entryOf);
}

export interface ArchiveView {
  staff_id: string;
  what: string;
  reason: string;
  viewed_at: number;
}

export async function archiveViews(db: D1Database, archiveId: string): Promise<ArchiveView[]> {
  const { results } = await db
    .prepare(
      `SELECT staff_id, what, reason, viewed_at FROM erasure_archive_views
       WHERE archive_id = ? ORDER BY viewed_at DESC LIMIT 100`,
    )
    .bind(archiveId)
    .all<ArchiveView>();
  return results;
}

async function recordView(
  db: D1Database,
  staffId: string,
  archiveId: string,
  what: 'record' | 'file',
  reason: string,
  at: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO erasure_archive_views (id, archive_id, staff_id, what, reason, viewed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(newId(), archiveId, staffId, what, reason, at),
    auditStatement(db, at, `staff:${staffId}`, 'privacy.archive_opened', `archive:${archiveId}`, {
      what,
      reason,
    }),
  ]);
}

/**
 * An admin opens one sealed record. The reason is required and written down before the content
 * leaves: who, when, why.
 */
export async function openArchive(
  db: D1Database,
  staffId: string,
  archiveId: string,
  reason: string,
  at: number,
): Promise<Result<{ entry: ArchiveEntry; payload: ArchivePayload }>> {
  const why = reasonOf(reason, 10);
  if (!why) return fail('invalid_reason');
  const row = await db
    .prepare(`SELECT ${ENTRY}, a.payload_enc FROM erasure_archive a WHERE a.id = ?`)
    .bind(archiveId)
    .first<EntryRow & { payload_enc: string | null }>();
  if (!row) return fail('not_found');
  if (row.payload_enc === null) return fail('archive_destroyed');
  const payload = (await open(row.payload_enc, `archive:${archiveId}`)) as ArchivePayload;
  await recordView(db, staffId, archiveId, 'record', why, at);
  return ok({ entry: entryOf(row), payload });
}

/** Emanet Merkez seals a file on its way into the archive; it holds the storage, not the key. */
export async function sealArchiveFile(
  db: D1Database,
  archiveId: string,
  fileRef: string,
  bytes: ArrayBuffer,
): Promise<Result<Uint8Array>> {
  const due = await db
    .prepare(
      'SELECT 1 AS yes FROM erased_files WHERE file_ref = ? AND archive_id = ? AND erased_at IS NULL',
    )
    .bind(fileRef, archiveId)
    .first();
  if (!due) return fail('not_found');
  return ok(await sealBytes(bytes, `archive:${archiveId}:file`));
}

/** The sealed copy is stored: the archive lists it, and the original is marked as removed. */
export async function archiveFileStored(
  db: D1Database,
  archiveId: string,
  fileRef: string,
  stored: { ref: string; type: string; size: number },
  at: number,
): Promise<Result<null>> {
  const due = await db
    .prepare(
      'SELECT name FROM erased_files WHERE file_ref = ? AND archive_id = ? AND erased_at IS NULL',
    )
    .bind(fileRef, archiveId)
    .first<{ name: string | null }>();
  const archive = await db
    .prepare('SELECT files FROM erasure_archive WHERE id = ? AND purged_at IS NULL')
    .bind(archiveId)
    .first<{ files: string }>();
  if (!due || !archive) return fail('not_found');
  if (
    typeof stored.ref !== 'string' ||
    !stored.ref.startsWith(`archive/${archiveId}/`) ||
    stored.ref.length > 300
  ) {
    return fail('invalid_file');
  }
  const files = filesOf(archive.files);
  files.push({
    ref: stored.ref,
    name: due.name ?? 'file',
    type: typeof stored.type === 'string' ? stored.type.slice(0, 100) : 'application/octet-stream',
    size: Number.isFinite(stored.size) ? Math.max(0, Math.floor(stored.size)) : 0,
  });
  await db.batch([
    db
      .prepare('UPDATE erasure_archive SET files = ? WHERE id = ?')
      .bind(JSON.stringify(files), archiveId),
    db.prepare('UPDATE erased_files SET erased_at = ? WHERE file_ref = ?').bind(at, fileRef),
  ]);
  return ok(null);
}

/** An admin opens one sealed file: Emanet Merkez hands over the sealed bytes, with a reason. */
export async function openArchiveFile(
  db: D1Database,
  staffId: string,
  archiveId: string,
  ref: string,
  reason: string,
  bytes: ArrayBuffer,
  at: number,
): Promise<Result<{ name: string; type: string; bytes: Uint8Array }>> {
  const why = reasonOf(reason, 10);
  if (!why) return fail('invalid_reason');
  const archive = await db
    .prepare('SELECT files FROM erasure_archive WHERE id = ? AND purged_at IS NULL')
    .bind(archiveId)
    .first<{ files: string }>();
  const file = archive ? filesOf(archive.files).find((f) => f.ref === ref) : undefined;
  if (!file) return fail('not_found');
  const plain = await openBytes(bytes, `archive:${archiveId}:file`);
  await recordView(db, staffId, archiveId, 'file', why, at);
  return ok({ name: file.name, type: file.type, bytes: plain });
}

/** Whether a sealed file belongs to an archive that still exists; for Emanet Merkez before it reads storage. */
export async function archiveHasFile(
  db: D1Database,
  archiveId: string,
  ref: string,
): Promise<boolean> {
  const archive = await db
    .prepare('SELECT files FROM erasure_archive WHERE id = ? AND purged_at IS NULL')
    .bind(archiveId)
    .first<{ files: string }>();
  return archive ? filesOf(archive.files).some((f) => f.ref === ref) : false;
}

/** Cron: an archive whose time is up loses its content and its files; the line stays. */
export async function purgeArchives(db: D1Database, at: number): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT id, files FROM erasure_archive a WHERE purged_at IS NULL AND purge_at <= ?
         AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.released_at IS NULL
                           AND h.subject_kind = 'agent' AND h.subject_ref = a.subject_ref)
       LIMIT 50`,
    )
    .bind(at)
    .all<{ id: string; files: string }>();
  for (const row of results) {
    await db.batch([
      ...filesOf(row.files).map((file) =>
        db
          .prepare(
            `INSERT INTO erased_files (file_ref, bucket, record_id, reason, requested_by, requested_at)
             VALUES (?, 'evidence', ?, 'archive retention', 'system', ?) ON CONFLICT (file_ref) DO NOTHING`,
          )
          .bind(file.ref, row.id, at),
      ),
      // A file that never made it into the archive is destroyed where it is.
      db
        .prepare(
          'UPDATE erased_files SET archive_id = NULL WHERE archive_id = ? AND erased_at IS NULL',
        )
        .bind(row.id),
      db
        .prepare(
          `UPDATE erasure_archive SET payload_enc = NULL, files = '[]', lookup_hash = NULL, purged_at = ? WHERE id = ?`,
        )
        .bind(at, row.id),
      auditStatement(db, at, 'system', 'privacy.archive_destroyed', `archive:${row.id}`),
    ]);
  }
  return results.length;
}
