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

/** The two every applicant gives. */
export const DOCUMENT_KINDS = ['criminal_record', 'population_record'] as const;
/** Everything staff can ask for; the ones after the first two only on request. */
export const ALL_DOCUMENT_KINDS = [
  'criminal_record',
  'population_record',
  'residence_record',
  'driving_licence',
  'tax_certificate',
  'bank_proof',
  'other',
] as const;
export type DocumentKind = (typeof ALL_DOCUMENT_KINDS)[number];
/** Documents from e-Devlet carry a barcode number staff verify them by. */
export const BARCODED: readonly DocumentKind[] = [
  'criminal_record',
  'population_record',
  'residence_record',
];
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
  /** The request this document answers, if staff asked for it. */
  request_id: string | null;
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

/**
 * An applicant adds (or replaces) a document before a decision on it: one of the two every
 * applicant gives, or one staff asked for (then `request_id` says which request it answers, and
 * the request is answered in the same step).
 */
export async function addDocument(
  db: D1Database,
  agentId: string,
  input: { kind: string; file_ref: string; sha256: string; barcode?: string; request_id?: string },
  at: number,
): Promise<Result<{ id: string; replaced: string[] }>> {
  if (!ALL_DOCUMENT_KINDS.includes(input.kind as DocumentKind)) return fail('invalid_document');
  const kind = input.kind as DocumentKind;
  const barcode = typeof input.barcode === 'string' ? input.barcode.replace(/\s/g, '') : '';
  if (BARCODED.includes(kind) ? !BARCODE.test(barcode) : barcode !== '' && !BARCODE.test(barcode)) {
    return fail('invalid_barcode');
  }
  if (typeof input.file_ref !== 'string' || !input.file_ref || input.file_ref.length > 300) {
    return fail('invalid_file');
  }
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) return fail('invalid_file');
  const agent = await db
    .prepare('SELECT status, erased_at FROM agents WHERE user_id = ?')
    .bind(agentId)
    .first<{ status: string; erased_at: number | null }>();
  if (!agent || agent.erased_at !== null) return fail('not_found');
  const requestId =
    typeof input.request_id === 'string' && input.request_id ? input.request_id : null;
  if (requestId) {
    const request = await db
      .prepare(
        `SELECT 1 AS yes FROM agent_requests
         WHERE id = ? AND agent_id = ? AND kind = 'document' AND subject = ? AND status = 'open'`,
      )
      .bind(requestId, agentId, kind)
      .first();
    if (!request) return fail('request_not_open');
  } else {
    // Without a request: only the two every applicant gives, and only before a decision.
    if (!(DOCUMENT_KINDS as readonly string[]).includes(kind)) return fail('invalid_document');
    if (agent.status !== 'applied' && agent.status !== 'kyc_pending') return fail('profile_locked');
  }
  // An earlier upload nobody has decided yet is replaced: its file goes. A free-form document
  // belongs to its request, so only that request's earlier upload is replaced.
  const { results: old } = await db
    .prepare(
      `SELECT id, file_ref FROM agent_documents
       WHERE agent_id = ? AND kind = ? AND status = 'uploaded' AND (? != 'other' OR request_id IS ?)`,
    )
    .bind(agentId, kind, kind, requestId)
    .all<{ id: string; file_ref: string }>();
  const id = newId();
  await db.batch([
    ...old.flatMap((row) => [
      db.prepare('DELETE FROM agent_documents WHERE id = ?').bind(row.id),
      eraseFileStatement(db, row.file_ref, row.id, 'replaced', `agent:${agentId}`, at),
    ]),
    db
      .prepare(
        `INSERT INTO agent_documents (id, agent_id, kind, file_ref, sha256, barcode, uploaded_at, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, agentId, kind, input.file_ref, input.sha256, barcode, at, requestId),
    ...(requestId
      ? [
          db
            .prepare(
              `UPDATE agent_requests SET status = 'answered', document_id = ?, answered_at = ?
               WHERE id = ? AND status = 'open'`,
            )
            .bind(id, at, requestId),
        ]
      : []),
    auditStatement(db, at, `agent:${agentId}`, 'agent.document_added', `agent:${agentId}`, {
      kind,
      ...(requestId ? { request: requestId } : {}),
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
      `SELECT d.id, d.kind, d.barcode, d.uploaded_at, d.status, d.outcome, d.decided_at, d.note, d.request_id,
         CASE WHEN EXISTS (SELECT 1 FROM erased_files x WHERE x.file_ref = d.file_ref) THEN NULL ELSE d.file_ref END AS file_ref
       FROM agent_documents d WHERE d.agent_id = ? ORDER BY d.uploaded_at DESC`,
    )
    .bind(agentId)
    .all<AgentDocument>();
  // The latest of each kind; a free-form document is one per request.
  const seen = new Set<string>();
  return results.filter((row) => {
    const key = row.kind === 'other' ? `other:${row.request_id ?? ''}` : row.kind;
    return seen.has(key) ? false : (seen.add(key), true);
  });
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
): Promise<
  Result<{
    agent_id: string;
    kind: DocumentKind;
    outcome: DocumentOutcome;
    asked_again: boolean;
    request_id: string | null;
  }>
> {
  if (!OUTCOMES.includes(input.outcome as DocumentOutcome)) return fail('invalid_outcome');
  const outcome = input.outcome as DocumentOutcome;
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 200) : '';
  // A record that isn't clean is decided by a person, with a reason on file.
  if (outcome !== 'clear' && !note) return fail('invalid_reason');
  const doc = await db
    .prepare(
      'SELECT agent_id, kind, file_ref, status, request_id FROM agent_documents WHERE id = ?',
    )
    .bind(documentId)
    .first<{
      agent_id: string;
      kind: DocumentKind;
      file_ref: string;
      status: string;
      request_id: string | null;
    }>();
  if (!doc) return fail('not_found');
  if (doc.status !== 'uploaded') return fail('already_decided');
  const reask = outcome === 'mismatch' || outcome === 'invalid';
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
    // The request it answered: a document that can't be used is asked for again; any other
    // outcome settles the request (what a record means for the application is decided apart).
    ...(doc.request_id
      ? [
          reask
            ? db
                .prepare(
                  `UPDATE agent_requests SET status = 'open', document_id = NULL, answered_at = NULL
                   WHERE id = ? AND status = 'answered'`,
                )
                .bind(doc.request_id)
            : db
                .prepare(
                  `UPDATE agent_requests SET status = 'accepted', closed_by = ?, closed_at = ?
                   WHERE id = ? AND status = 'answered'`,
                )
                .bind(staffId, at, doc.request_id),
        ]
      : []),
    auditStatement(db, at, `staff:${staffId}`, 'agent.document_decided', `agent:${doc.agent_id}`, {
      kind: doc.kind,
      outcome,
    }),
  ]);
  if (results[0]?.meta.changes !== 1) return fail('conflict_retry');
  return ok({
    agent_id: doc.agent_id,
    kind: doc.kind,
    outcome,
    asked_again: doc.request_id !== null && reask,
    request_id: doc.request_id,
  });
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
