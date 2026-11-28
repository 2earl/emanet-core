/**
 * Personal data on request and over time (docs/DESIGN.md §8; KVKK art. 7, 11, 13).
 *
 * Where personal data sits in Emanet:
 * - a vehicle's cases: the places a creditor gave (a debtor's addresses), custom fields marked
 *   `pii` (sealed, src/pii.ts);
 * - an agent: their profile, sightings (where they were), and the photos they took;
 * - photos (R2 emanet-evidence): `scene` and `yediemin_vehicle` show a vehicle and its plate;
 *   `police_report`, `tow_report` and `yediemin_receipt` are documents that can name people;
 * - a company's onboarding: its contact people, and the documents it gave (R2 emanet-documents).
 *
 * Staff find all of it by a plate, a chassis number, an agent or an email address, and remove
 * what a request (or the law) says must go. A file is never deleted from the database's side
 * only: it is queued in `erased_files`, and Emanet Merkez, which holds the buckets, deletes the
 * object and reports back. The row the file belonged to stays, without the file.
 *
 * Without a request, files go when their purpose ends: photos of a claim that didn't lead to a
 * delivery after 30 days; photos of a delivery, and a partner's documents, when the retention
 * period for commercial records ends; documents of a company that never became a partner after
 * 90 days.
 */
import { auditStatement } from './audit';
import { normalizePlate, normalizeVin } from './normalize';
import { fail, newId, ok, type Result } from './result';
import { readSettings } from './settings';

const DAY = 86_400;
export const FAILED_CLAIM_EVIDENCE_DAYS = 30;
export const ABANDONED_ONBOARDING_DAYS = 90;
/** KVKK art. 13: a request is answered within thirty days. */
export const REQUEST_DAYS = 30;

/** Who a photo of this kind can be about. */
export const EVIDENCE_PII: Record<string, 'vehicle' | 'document'> = {
  scene: 'vehicle',
  yediemin_vehicle: 'vehicle',
  police_report: 'document',
  tow_report: 'document',
  yediemin_receipt: 'document',
};

const reasonOf = (value: unknown): string | null => {
  const reason = typeof value === 'string' ? value.trim() : '';
  return reason && reason.length <= 200 ? reason : null;
};

function eraseStatement(
  db: D1Database,
  file: { file_ref: string; bucket: 'evidence' | 'documents'; record_id: string },
  reason: string,
  by: string,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO erased_files (file_ref, bucket, record_id, reason, requested_by, requested_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (file_ref) DO NOTHING`,
    )
    .bind(file.file_ref, file.bucket, file.record_id, reason, by, at);
}

// ---- The queue Emanet Merkez empties -------------------------------------------------------------

export interface DueFile {
  file_ref: string;
  bucket: 'evidence' | 'documents';
}

export async function filesDue(db: D1Database, limit = 100): Promise<DueFile[]> {
  const { results } = await db
    .prepare(
      'SELECT file_ref, bucket FROM erased_files WHERE erased_at IS NULL ORDER BY requested_at LIMIT ?',
    )
    .bind(Math.min(Math.max(limit, 1), 500))
    .all<DueFile>();
  return results;
}

/** Emanet Merkez deleted these objects from R2. */
export async function filesErased(
  db: D1Database,
  refs: readonly string[],
  at: number,
): Promise<number> {
  const clean = refs.filter((ref) => typeof ref === 'string' && ref.length <= 300).slice(0, 500);
  if (clean.length === 0) return 0;
  const results = await db.batch(
    clean.map((ref) =>
      db
        .prepare('UPDATE erased_files SET erased_at = ? WHERE file_ref = ? AND erased_at IS NULL')
        .bind(at, ref),
    ),
  );
  const erased = results.reduce((sum, result) => sum + result.meta.changes, 0);
  if (erased > 0) {
    await auditStatement(db, at, 'system', 'privacy.files_erased', 'erased_files', {
      files: erased,
    }).run();
  }
  return erased;
}

// ---- Retention -----------------------------------------------------------------------------------

/** Cron: queues the files whose time is up. */
export async function scheduleRetention(db: D1Database, at: number): Promise<number> {
  const settings = await readSettings(db);
  const kept = settings.evidence_retention_days * DAY;
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO erased_files (file_ref, bucket, record_id, reason, requested_by, requested_at)
         SELECT e.file_ref, 'evidence', e.id, 'retention', 'system', ?
         FROM evidence e JOIN claims c ON c.id = e.claim_id
         WHERE c.closed_at IS NOT NULL
           AND ((c.close_reason != 'delivered' AND c.closed_at <= ?)
             OR (c.close_reason = 'delivered' AND c.closed_at <= ?))
           AND NOT EXISTS (SELECT 1 FROM erased_files x WHERE x.file_ref = e.file_ref)
         LIMIT 500`,
      )
      .bind(at, at - settings.failed_claim_evidence_days * DAY, at - kept),
    db
      .prepare(
        `INSERT INTO erased_files (file_ref, bucket, record_id, reason, requested_by, requested_at)
         SELECT d.file_ref, 'documents', d.id, 'retention', 'system', ?
         FROM onboarding_documents d JOIN onboardings o ON o.id = d.onboarding_id
         WHERE ((o.status IN ('rejected', 'cancelled', 'expired') AND o.updated_at <= ?)
             OR (o.status = 'approved' AND o.updated_at <= ?))
           AND NOT EXISTS (SELECT 1 FROM erased_files x WHERE x.file_ref = d.file_ref)
         LIMIT 500`,
      )
      .bind(at, at - settings.abandoned_onboarding_days * DAY, at - kept),
    // An applicant's e-Devlet documents nobody decided on: they don't wait forever.
    db
      .prepare(
        `INSERT INTO erased_files (file_ref, bucket, record_id, reason, requested_by, requested_at)
         SELECT d.file_ref, 'evidence', d.id, 'retention', 'system', ?
         FROM agent_documents d
         WHERE d.status = 'uploaded' AND d.uploaded_at <= ?
           AND NOT EXISTS (SELECT 1 FROM erased_files x WHERE x.file_ref = d.file_ref)
         LIMIT 500`,
      )
      .bind(at, at - settings.abandoned_onboarding_days * DAY),
  ]);
  return results.reduce((sum, result) => sum + result.meta.changes, 0);
}

/** An agent's account is deleted: the photos of claims that delivered nothing go at once. */
export function eraseAgentEvidenceStatement(
  db: D1Database,
  agentId: string,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO erased_files (file_ref, bucket, record_id, reason, requested_by, requested_at)
       SELECT e.file_ref, 'evidence', e.id, 'account deleted', 'system', ?
       FROM evidence e JOIN claims c ON c.id = e.claim_id
       WHERE c.agent_id = ? AND (c.close_reason IS NULL OR c.close_reason != 'delivered')
         AND NOT EXISTS (SELECT 1 FROM erased_files x WHERE x.file_ref = e.file_ref)`,
    )
    .bind(at, agentId);
}

// ---- Finding a person's data ---------------------------------------------------------------------

export interface Inventory {
  vehicle: {
    id: string;
    plate: string | null;
    vin: string | null;
    cases: {
      id: string;
      partner: string;
      external_ref: string;
      status: string;
      places: number;
      addresses: number;
    }[];
  } | null;
  agent: {
    user_id: string;
    status: string;
    legal_name: string | null;
    email: string | null;
    phone: string | null;
    sightings: number;
    payouts: number;
  } | null;
  evidence: {
    id: string;
    claim_id: string;
    kind: string;
    about: 'vehicle' | 'document';
    created_at: number;
    delivered: boolean;
    erased: 'no' | 'due' | 'yes';
  }[];
  onboardings: {
    id: string;
    company: string;
    contact_name: string;
    contact_email: string;
    status: string;
    documents: { id: string; kind: string; file_name: string; erased: 'no' | 'due' | 'yes' }[];
  }[];
}

const ERASED = `CASE WHEN x.file_ref IS NULL THEN 'no' WHEN x.erased_at IS NULL THEN 'due' ELSE 'yes' END`;

/**
 * Everything Emanet holds for one search term: a plate or chassis number (a debtor's vehicle), an
 * agent's account ID, or an email address (an agent's, or a company contact's).
 */
export async function inventory(db: D1Database, term: string): Promise<Result<Inventory>> {
  const q = typeof term === 'string' ? term.trim() : '';
  if (q.length < 3 || q.length > 254) return fail('invalid_search');
  const out: Inventory = { vehicle: null, agent: null, evidence: [], onboardings: [] };
  const evidenceOf = async (where: string, bind: string) => {
    const { results } = await db
      .prepare(
        `SELECT e.id, e.claim_id, e.kind, e.created_at, c.close_reason = 'delivered' AS delivered,
           ${ERASED} AS erased
         FROM evidence e JOIN claims c ON c.id = e.claim_id
         LEFT JOIN erased_files x ON x.file_ref = e.file_ref
         WHERE ${where} ORDER BY e.created_at LIMIT 500`,
      )
      .bind(bind)
      .all<{
        id: string;
        claim_id: string;
        kind: string;
        created_at: number;
        delivered: number | null;
        erased: 'no' | 'due' | 'yes';
      }>();
    return results.map((row) => ({
      ...row,
      delivered: row.delivered === 1,
      about: EVIDENCE_PII[row.kind] ?? 'document',
    }));
  };

  const plate = normalizePlate(q);
  const vin = normalizeVin(q);
  if (plate || vin) {
    const vehicle = await db
      .prepare(
        `SELECT v.id, v.vin, (SELECT plate FROM vehicle_plates WHERE vehicle_id = v.id AND valid_to IS NULL) AS plate
         FROM vehicles v WHERE v.vin = ? OR v.id IN (SELECT vehicle_id FROM vehicle_plates WHERE plate = ?)
         LIMIT 1`,
      )
      .bind(vin ?? '', plate ?? '')
      .first<{ id: string; vin: string | null; plate: string | null }>();
    if (vehicle) {
      const { results: cases } = await db
        .prepare(
          `SELECT c.id, p.legal_name AS partner, c.external_ref, c.status,
             (SELECT count(*) FROM case_places cp WHERE cp.case_id = c.id) AS places,
             (SELECT count(*) FROM case_places cp WHERE cp.case_id = c.id AND cp.address != '') AS addresses
           FROM cases c JOIN partners p ON p.id = c.partner_id WHERE c.vehicle_id = ? ORDER BY c.created_at`,
        )
        .bind(vehicle.id)
        .all<NonNullable<Inventory['vehicle']>['cases'][number]>();
      out.vehicle = { ...vehicle, cases };
      out.evidence = await evidenceOf('c.vehicle_id = ?', vehicle.id);
    }
    return ok(out);
  }

  const agent = await db
    .prepare(
      `SELECT a.user_id, a.status, a.legal_name, a.email, a.phone,
         (SELECT count(*) FROM sightings s JOIN claims c ON c.id = s.claim_id WHERE c.agent_id = a.user_id) AS sightings,
         (SELECT count(*) FROM payouts po WHERE po.agent_id = a.user_id) AS payouts
       FROM agents a WHERE a.user_id = ? OR lower(a.email) = ? LIMIT 1`,
    )
    .bind(q, q.toLowerCase())
    .first<NonNullable<Inventory['agent']>>();
  if (agent) {
    out.agent = agent;
    out.evidence = await evidenceOf('c.agent_id = ?', agent.user_id);
  }
  if (q.includes('@')) {
    const { results: found } = await db
      .prepare(
        `SELECT id, company, contact_name, contact_email, status FROM onboardings
         WHERE lower(contact_email) = ? ORDER BY invited_at DESC LIMIT 20`,
      )
      .bind(q.toLowerCase())
      .all<Omit<Inventory['onboardings'][number], 'documents'>>();
    for (const row of found) {
      const { results: documents } = await db
        .prepare(
          `SELECT d.id, d.kind, d.file_name, ${ERASED} AS erased FROM onboarding_documents d
           LEFT JOIN erased_files x ON x.file_ref = d.file_ref WHERE d.onboarding_id = ? ORDER BY d.uploaded_at`,
        )
        .bind(row.id)
        .all<Inventory['onboardings'][number]['documents'][number]>();
      out.onboardings.push({ ...row, documents });
    }
  }
  return ok(out);
}

// ---- Removing it ---------------------------------------------------------------------------------

/** One photo: its file is queued for deletion. The row and its hash stay, so it can't be reused. */
export async function eraseEvidence(
  db: D1Database,
  staffId: string,
  evidenceId: string,
  reason: string,
  at: number,
): Promise<Result<null>> {
  const why = reasonOf(reason);
  if (!why) return fail('invalid_reason');
  const row = await db
    .prepare('SELECT id, file_ref, claim_id FROM evidence WHERE id = ?')
    .bind(evidenceId)
    .first<{ id: string; file_ref: string; claim_id: string }>();
  if (!row) return fail('not_found');
  await db.batch([
    eraseStatement(
      db,
      { file_ref: row.file_ref, bucket: 'evidence', record_id: row.id },
      why,
      `staff:${staffId}`,
      at,
    ),
    auditStatement(db, at, `staff:${staffId}`, 'privacy.evidence_erased', `claim:${row.claim_id}`, {
      evidence: row.id,
      reason: why,
    }),
  ]);
  return ok(null);
}

export async function eraseDocument(
  db: D1Database,
  staffId: string,
  documentId: string,
  reason: string,
  at: number,
): Promise<Result<null>> {
  const why = reasonOf(reason);
  if (!why) return fail('invalid_reason');
  const row = await db
    .prepare('SELECT id, file_ref, onboarding_id FROM onboarding_documents WHERE id = ?')
    .bind(documentId)
    .first<{ id: string; file_ref: string; onboarding_id: string }>();
  if (!row) return fail('not_found');
  await db.batch([
    eraseStatement(
      db,
      { file_ref: row.file_ref, bucket: 'documents', record_id: row.id },
      why,
      `staff:${staffId}`,
      at,
    ),
    auditStatement(
      db,
      at,
      `staff:${staffId}`,
      'privacy.document_erased',
      `onboarding:${row.onboarding_id}`,
      { document: row.id, reason: why },
    ),
  ]);
  return ok(null);
}

/**
 * A closed case's addresses, now instead of after thirty days. An open case keeps them: agents
 * are looking there, and its partner (the data's controller) changes or withdraws it.
 */
export async function redactCasePlaces(
  db: D1Database,
  staffId: string,
  caseId: string,
  reason: string,
  at: number,
): Promise<Result<{ places: number }>> {
  const why = reasonOf(reason);
  if (!why) return fail('invalid_reason');
  const kase = await db
    .prepare('SELECT status FROM cases WHERE id = ?')
    .bind(caseId)
    .first<{ status: string }>();
  if (!kase) return fail('not_found');
  if (kase.status === 'active' || kase.status === 'pending_identity') return fail('case_open');
  const results = await db.batch([
    db
      .prepare(
        `UPDATE case_places SET address = '', lat = NULL, lng = NULL, note = NULL, attributes = '{}'
         WHERE case_id = ? AND address != ''`,
      )
      .bind(caseId),
    auditStatement(db, at, `staff:${staffId}`, 'privacy.places_redacted', `case:${caseId}`, {
      reason: why,
    }),
  ]);
  return ok({ places: results[0]?.meta.changes ?? 0 });
}

// ---- The register of requests --------------------------------------------------------------------

export interface PrivacyRequest {
  id: string;
  kind: 'access' | 'erasure' | 'correction' | 'objection';
  subject_kind: 'agent' | 'vehicle' | 'contact' | 'other';
  subject_ref: string;
  channel: string;
  note: string | null;
  received_at: number;
  due_at: number;
  status: 'open' | 'done' | 'refused';
  outcome: string | null;
  created_by: string;
  closed_by: string | null;
  closed_at: number | null;
}

const KINDS = ['access', 'erasure', 'correction', 'objection'];
const SUBJECTS = ['agent', 'vehicle', 'contact', 'other'];

export async function openRequest(
  db: D1Database,
  staffId: string,
  input: {
    kind: string;
    subjectKind: string;
    subjectRef: string;
    channel: string;
    note?: string;
    receivedAt?: number;
  },
  at: number,
): Promise<Result<{ id: string; due_at: number }>> {
  const subject = typeof input.subjectRef === 'string' ? input.subjectRef.trim() : '';
  const channel = typeof input.channel === 'string' ? input.channel.trim() : '';
  if (!KINDS.includes(input.kind) || !SUBJECTS.includes(input.subjectKind)) {
    return fail('invalid_request');
  }
  if (!subject || subject.length > 254 || !channel || channel.length > 60) {
    return fail('invalid_request');
  }
  const received =
    input.receivedAt !== undefined &&
    Number.isFinite(input.receivedAt) &&
    input.receivedAt <= at &&
    input.receivedAt > at - 365 * DAY
      ? Math.floor(input.receivedAt)
      : at;
  const id = newId();
  const due = received + (await readSettings(db)).privacy_request_days * DAY;
  await db.batch([
    db
      .prepare(
        `INSERT INTO privacy_requests (id, kind, subject_kind, subject_ref, channel, note, received_at, due_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.kind,
        input.subjectKind,
        subject,
        channel,
        typeof input.note === 'string' && input.note.trim()
          ? input.note.trim().slice(0, 1000)
          : null,
        received,
        due,
        staffId,
      ),
    auditStatement(db, at, `staff:${staffId}`, 'privacy.request_opened', `privacy:${id}`, {
      kind: input.kind,
    }),
  ]);
  return ok({ id, due_at: due });
}

export async function listRequests(db: D1Database): Promise<PrivacyRequest[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM privacy_requests ORDER BY status != 'open', due_at, received_at DESC LIMIT 200`,
    )
    .all<PrivacyRequest>();
  return results;
}

export async function closeRequest(
  db: D1Database,
  staffId: string,
  requestId: string,
  input: { status: string; outcome: string },
  at: number,
): Promise<Result<null>> {
  const outcome = typeof input.outcome === 'string' ? input.outcome.trim() : '';
  if (
    (input.status !== 'done' && input.status !== 'refused') ||
    !outcome ||
    outcome.length > 1000
  ) {
    return fail('invalid_request');
  }
  const results = await db.batch([
    db
      .prepare(
        `UPDATE privacy_requests SET status = ?, outcome = ?, closed_by = ?, closed_at = ?
         WHERE id = ? AND status = 'open'`,
      )
      .bind(input.status, outcome, staffId, at, requestId),
    auditStatement(
      db,
      at,
      `staff:${staffId}`,
      `privacy.request_${input.status}`,
      `privacy:${requestId}`,
    ),
  ]);
  return results[0]?.meta.changes === 1 ? ok(null) : fail('not_found');
}
