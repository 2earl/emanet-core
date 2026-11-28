/**
 * Vetting an applicant beyond the identity check (docs/DESIGN.md §6): what they accepted, and the
 * two e-Devlet documents they upload, a criminal record and a population register extract.
 *
 * A criminal record is special-category data (KVKK m.6). It is handled on explicit consent, by
 * as few people as possible, for as short a time as possible: staff verify the document at
 * e-Devlet, record one of four outcomes, and the file is queued for deletion in the same step.
 * What the record says is never written down.
 */
import { agreementDigest, AGREEMENT_VERSION } from './agent-agreement';
import { auditStatement } from './audit';
import { fail, newId, ok, type Result } from './result';

export const DOCUMENT_KINDS = ['criminal_record', 'population_record'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export type DocumentOutcome = 'clear' | 'has_record' | 'mismatch' | 'invalid';

export interface AgentDocument {
  id: string;
  kind: DocumentKind;
  barcode: string;
  uploaded_at: number;
  status: 'uploaded' | 'verified' | 'rejected';
  outcome: DocumentOutcome | null;
  decided_at: number | null;
  note: string | null;
  /** Null once the file has been queued for deletion. */
  file_ref: string | null;
}

export interface Consents {
  agreement: boolean;
  notice: boolean;
  consent: boolean;
}

/** Records what the applicant accepted. All three, or nothing. */
export async function recordAcceptance(
  db: D1Database,
  agentId: string,
  consents: Consents,
  locale: string,
  at: number,
): Promise<Result<{ version: string; sha256: string }>> {
  // Over RPC a flag may be anything: only a real `true` is an acceptance.
  const yes = (value: unknown) => value === true;
  if (!yes(consents.agreement) || !yes(consents.notice) || !yes(consents.consent)) {
    return fail('consents_missing');
  }
  const sha256 = await agreementDigest();
  await db.batch([
    db
      .prepare(
        `INSERT INTO agent_acceptances (id, agent_id, version, sha256, locale, agreement, notice, consent, accepted_at)
         VALUES (?, ?, ?, ?, ?, 1, 1, 1, ?)`,
      )
      .bind(newId(), agentId, AGREEMENT_VERSION, sha256, locale === 'en' ? 'en' : 'tr', at),
    auditStatement(db, at, `agent:${agentId}`, 'agent.accepted', `agent:${agentId}`, {
      version: AGREEMENT_VERSION,
      sha256,
    }),
  ]);
  return ok({ version: AGREEMENT_VERSION, sha256 });
}

export interface Acceptance {
  version: string;
  sha256: string;
  locale: string;
  accepted_at: number;
  /** Whether it is the text in force now. */
  current: boolean;
}

export async function latestAcceptance(
  db: D1Database,
  agentId: string,
): Promise<Acceptance | null> {
  const row = await db
    .prepare(
      `SELECT version, sha256, locale, accepted_at FROM agent_acceptances
       WHERE agent_id = ? AND withdrawn_at IS NULL ORDER BY accepted_at DESC LIMIT 1`,
    )
    .bind(agentId)
    .first<Omit<Acceptance, 'current'>>();
  if (!row) return null;
  return {
    ...row,
    current: row.version === AGREEMENT_VERSION && row.sha256 === (await agreementDigest()),
  };
}

const BARCODE = /^[A-Za-z0-9-]{6,40}$/;

/** An applicant adds (or replaces) one of the two documents, before a decision on it. */
export async function addDocument(
  db: D1Database,
  agentId: string,
  input: { kind: string; file_ref: string; sha256: string; barcode: string },
  at: number,
): Promise<Result<{ id: string; replaced: string[] }>> {
  if (!DOCUMENT_KINDS.includes(input.kind as DocumentKind)) return fail('invalid_document');
  const barcode = typeof input.barcode === 'string' ? input.barcode.replace(/\s/g, '') : '';
  if (!BARCODE.test(barcode)) return fail('invalid_barcode');
  if (typeof input.file_ref !== 'string' || !input.file_ref || input.file_ref.length > 300) {
    return fail('invalid_file');
  }
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) return fail('invalid_file');
  const agent = await db
    .prepare('SELECT status FROM agents WHERE user_id = ?')
    .bind(agentId)
    .first<{ status: string }>();
  if (!agent) return fail('not_found');
  if (agent.status !== 'applied' && agent.status !== 'kyc_pending') return fail('profile_locked');
  // An earlier upload of the same kind that nobody has decided yet is replaced: its file goes.
  const { results: old } = await db
    .prepare(
      `SELECT id, file_ref FROM agent_documents WHERE agent_id = ? AND kind = ? AND status = 'uploaded'`,
    )
    .bind(agentId, input.kind)
    .all<{ id: string; file_ref: string }>();
  const id = newId();
  await db.batch([
    ...old.flatMap((row) => [
      db.prepare('DELETE FROM agent_documents WHERE id = ?').bind(row.id),
      eraseFileStatement(db, row.file_ref, row.id, 'replaced', `agent:${agentId}`, at),
    ]),
    db
      .prepare(
        `INSERT INTO agent_documents (id, agent_id, kind, file_ref, sha256, barcode, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, agentId, input.kind, input.file_ref, input.sha256, barcode, at),
    auditStatement(db, at, `agent:${agentId}`, 'agent.document_added', `agent:${agentId}`, {
      kind: input.kind,
    }),
  ]);
  return ok({ id, replaced: old.map((row) => row.id) });
}

function eraseFileStatement(
  db: D1Database,
  fileRef: string,
  recordId: string,
  reason: string,
  by: string,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO erased_files (file_ref, bucket, record_id, reason, requested_by, requested_at)
       SELECT ?, 'evidence', ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM erased_files WHERE file_ref = ?)`,
    )
    .bind(fileRef, recordId, reason, by, at, fileRef);
}

/** The latest document of each kind, and whether its file is still there to open. */
export async function documentsOf(db: D1Database, agentId: string): Promise<AgentDocument[]> {
  const { results } = await db
    .prepare(
      `SELECT d.id, d.kind, d.barcode, d.uploaded_at, d.status, d.outcome, d.decided_at, d.note,
         CASE WHEN EXISTS (SELECT 1 FROM erased_files x WHERE x.file_ref = d.file_ref) THEN NULL ELSE d.file_ref END AS file_ref
       FROM agent_documents d WHERE d.agent_id = ? ORDER BY d.uploaded_at DESC`,
    )
    .bind(agentId)
    .all<AgentDocument>();
  const seen = new Set<string>();
  return results.filter((row) => (seen.has(row.kind) ? false : (seen.add(row.kind), true)));
}

/** Whether both documents are there (uploaded or already verified). */
export async function documentsComplete(
  db: D1Database,
  agentId: string,
  need: 'present' | 'verified',
): Promise<boolean> {
  const docs = await documentsOf(db, agentId);
  return DOCUMENT_KINDS.every((kind) =>
    docs.some(
      (d) =>
        d.kind === kind &&
        (need === 'present'
          ? d.status !== 'rejected'
          : d.status === 'verified' && d.outcome === 'clear'),
    ),
  );
}

const OUTCOMES: DocumentOutcome[] = ['clear', 'has_record', 'mismatch', 'invalid'];

/**
 * Staff verified the document at e-Devlet and say what they found. Whatever the outcome, the file
 * is queued for deletion now: after this only the outcome and its date exist.
 */
export async function decideDocument(
  db: D1Database,
  staffId: string,
  documentId: string,
  input: { outcome: string; note?: string },
  at: number,
): Promise<Result<{ agent_id: string; kind: DocumentKind; outcome: DocumentOutcome }>> {
  if (!OUTCOMES.includes(input.outcome as DocumentOutcome)) return fail('invalid_outcome');
  const outcome = input.outcome as DocumentOutcome;
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 200) : '';
  // A record that isn't clean is decided by a person, with a reason on file.
  if (outcome !== 'clear' && !note) return fail('invalid_reason');
  const doc = await db
    .prepare('SELECT agent_id, kind, file_ref, status FROM agent_documents WHERE id = ?')
    .bind(documentId)
    .first<{ agent_id: string; kind: DocumentKind; file_ref: string; status: string }>();
  if (!doc) return fail('not_found');
  if (doc.status !== 'uploaded') return fail('already_decided');
  const results = await db.batch([
    db
      .prepare(
        `UPDATE agent_documents SET status = ?, outcome = ?, decided_by = ?, decided_at = ?, note = ?
         WHERE id = ? AND status = 'uploaded'`,
      )
      .bind(
        outcome === 'clear' ? 'verified' : 'rejected',
        outcome,
        staffId,
        at,
        note || null,
        documentId,
      ),
    eraseFileStatement(db, doc.file_ref, documentId, 'verified', `staff:${staffId}`, at),
    auditStatement(db, at, `staff:${staffId}`, 'agent.document_decided', `agent:${doc.agent_id}`, {
      kind: doc.kind,
      outcome,
    }),
  ]);
  if (results[0]?.meta.changes !== 1) return fail('conflict_retry');
  return ok({ agent_id: doc.agent_id, kind: doc.kind, outcome });
}

/** The file of an undecided document, for staff to open; null once decided. */
export async function documentFile(
  db: D1Database,
  documentId: string,
): Promise<{ file_ref: string; agent_id: string; kind: DocumentKind } | null> {
  return db
    .prepare(
      `SELECT file_ref, agent_id, kind FROM agent_documents WHERE id = ? AND status = 'uploaded'`,
    )
    .bind(documentId)
    .first();
}
