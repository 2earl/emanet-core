/**
 * What 2earl staff see and decide in Emanet Merkez (docs/DESIGN.md §7), beyond the writes in
 * cases.ts, claims.ts and ledger.ts: lists for the console, and the identity reviews that hold a
 * case back from agents (a missing VIN, a plate on another vehicle, a plate change).
 */
import { auditStatement, outboxStatement } from './audit';
import { normalizeVin } from './normalize';
import { fail, newId, ok, type Result } from './result';

export interface PartnerRow {
  id: string;
  org_id: string;
  kind: string;
  legal_name: string;
  vkn: string | null;
  tax_office: string | null;
  kep_address: string | null;
  e_invoice: number;
  status: string;
  reconfirm_days: number;
  created_at: number;
  active_cases: number;
  delivered_cases: number;
  contact_email: string | null;
  billing_email: string | null;
  mail_notices: number;
}

export async function listPartners(db: D1Database): Promise<PartnerRow[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.org_id, p.kind, p.legal_name, p.vkn, p.tax_office, p.kep_address, p.e_invoice,
         p.status, p.reconfirm_days, p.created_at, p.contact_email, p.billing_email, p.mail_notices,
         (SELECT count(*) FROM cases c WHERE c.partner_id = p.id AND c.status IN ('active', 'pending_identity')) AS active_cases,
         (SELECT count(*) FROM cases c WHERE c.partner_id = p.id AND c.status = 'delivered') AS delivered_cases
       FROM partners p ORDER BY p.legal_name`,
    )
    .all<PartnerRow>();
  return results;
}

export async function partnerDetail(
  db: D1Database,
  partnerId: string,
  at: number,
): Promise<
  Result<{
    partner: PartnerRow;
    priceList: unknown;
    priceListFrom: number | null;
    fields: unknown[];
  }>
> {
  const partner = (await listPartners(db)).find((p) => p.id === partnerId);
  if (!partner) return fail('not_found');
  const [price, fields] = await Promise.all([
    db
      .prepare(
        `SELECT rules, valid_from FROM price_lists WHERE partner_id = ? AND valid_from <= ?
         ORDER BY valid_from DESC, created_at DESC LIMIT 1`,
      )
      .bind(partnerId, at)
      .first<{ rules: string; valid_from: number }>(),
    db
      .prepare(
        `SELECT id, partner_id, entity, key, label_tr, label_en, type, enum_values, required, visibility, deprecated_at
         FROM field_definitions WHERE partner_id = ? OR partner_id IS NULL ORDER BY entity, position, key`,
      )
      .bind(partnerId)
      .all(),
  ]);
  return ok({
    partner,
    priceList: price ? (JSON.parse(price.rules) as unknown) : null,
    priceListFrom: price?.valid_from ?? null,
    fields: fields.results,
  });
}

export async function listAgents(db: D1Database, status: string | null): Promise<unknown[]> {
  const { results } = await db
    .prepare(
      `SELECT a.user_id, a.status, a.legal_name, a.city, a.phone, a.iban, a.tax_profile, a.vkn,
         a.strikes, a.created_at, a.submitted_at, a.terms_version, a.birth_year,
         CASE WHEN a.email_verified_at IS NOT NULL THEN a.email END AS email,
         a.tckn_hash IS NOT NULL AS id_given,
         a.iban_verified_at IS NOT NULL AS iban_verified,
         (SELECT count(*) FROM claims c WHERE c.agent_id = a.user_id AND c.closed_at IS NULL) AS open_claims,
         (SELECT count(*) FROM claims c WHERE c.agent_id = a.user_id AND c.close_reason = 'delivered') AS deliveries
       FROM agents a WHERE (? IS NULL OR a.status = ?) ORDER BY a.created_at DESC LIMIT 500`,
    )
    .bind(status, status)
    .all();
  return results;
}

export async function listPayouts(db: D1Database, status: string | null): Promise<unknown[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.agent_id, a.legal_name, p.case_id, p.gross_kurus, p.withholding_kurus,
         p.net_kurus, p.status, p.ordered_by, p.approved_by, p.bank_ref, p.created_at, p.updated_at
       FROM payouts p LEFT JOIN agents a ON a.user_id = p.agent_id
       WHERE (? IS NULL OR p.status = ?) ORDER BY p.created_at DESC LIMIT 500`,
    )
    .bind(status, status)
    .all();
  return results;
}

export async function listInvoices(db: D1Database, partnerId: string | null): Promise<unknown[]> {
  const { results } = await db
    .prepare(
      `SELECT i.id, i.partner_id, p.legal_name, i.number, i.issued_at, i.net_kurus, i.kdv_kurus,
         i.total_kurus, i.paid_kurus, i.status,
         (SELECT count(*) FROM invoice_lines l WHERE l.invoice_id = i.id) AS cases
       FROM invoices i JOIN partners p ON p.id = i.partner_id
       WHERE (? IS NULL OR i.partner_id = ?) ORDER BY i.issued_at DESC LIMIT 500`,
    )
    .bind(partnerId, partnerId)
    .all();
  return results;
}

/** Delivered cases per partner that have no invoice yet, oldest delivery first (VUK: 7 days). */
export async function uninvoiced(db: D1Database): Promise<unknown[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id AS partner_id, p.legal_name, count(*) AS cases, sum(c.fee_kurus) AS net_kurus,
         min(c.delivered_at) AS oldest_delivery
       FROM cases c JOIN partners p ON p.id = c.partner_id
       WHERE c.status = 'delivered' AND NOT EXISTS (SELECT 1 FROM invoice_lines l WHERE l.case_id = c.id)
       GROUP BY p.id ORDER BY oldest_delivery`,
    )
    .all();
  return results;
}

export interface ReviewDetail {
  item: {
    id: string;
    kind: string;
    subject_id: string;
    detail: Record<string, unknown>;
    created_at: number;
  };
  /** For identity reviews: the case and its vehicle as recorded. */
  case?: unknown;
  vehicle?: unknown;
  /** For deliveries: the claim, its sightings and evidence, and the cases it would deliver. */
  claim?: unknown;
  sightings?: unknown[];
  evidence?: unknown[];
  cases?: unknown[];
  /** For deliveries: what to look at twice before confirming (docs/DESIGN.md §6, anti-fraud). */
  signals?: DeliverySignals;
}

export interface DeliverySignals {
  /** From the claim to the first sighting; a report minutes after claiming deserves a look. */
  seconds_to_sighting: number | null;
  /** From the nearest sighting to the nearest place a creditor gave with coordinates. */
  nearest_place_m: number | null;
  agent_deliveries: number;
  agent_strikes: number;
}

/** Great-circle distance in metres. */
export function distanceMetres(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h))));
}

export async function reviewDetail(
  db: D1Database,
  reviewId: string,
): Promise<Result<ReviewDetail>> {
  const item = await db
    .prepare(
      `SELECT id, kind, subject_id, detail, created_at FROM review_items WHERE id = ? AND status = 'open'`,
    )
    .bind(reviewId)
    .first<{ id: string; kind: string; subject_id: string; detail: string; created_at: number }>();
  if (!item) return fail('not_found');
  const base = { ...item, detail: JSON.parse(item.detail) as Record<string, unknown> };
  if (item.kind === 'delivery') {
    const claim = await db
      .prepare(
        `SELECT c.id, c.vehicle_id, c.agent_id, a.legal_name AS agent_name, c.state, c.claimed_at, c.expires_at,
           v.make, v.model, v.vin, (SELECT plate FROM vehicle_plates WHERE vehicle_id = v.id AND valid_to IS NULL) AS plate
         FROM claims c JOIN vehicles v ON v.id = c.vehicle_id LEFT JOIN agents a ON a.user_id = c.agent_id
         WHERE c.id = ?`,
      )
      .bind(item.subject_id)
      .first<{ vehicle_id: string; agent_id: string; claimed_at: number }>();
    if (!claim) return fail('not_found');
    const [sightings, evidence, cases, places, agent] = await Promise.all([
      db
        .prepare(
          'SELECT lat, lng, accuracy_m, taken_at, received_at FROM sightings WHERE claim_id = ? ORDER BY received_at',
        )
        .bind(item.subject_id)
        .all(),
      db
        .prepare(
          `SELECT e.id, e.kind, e.file_ref, e.sha256, e.exif_time, e.exif_lat, e.exif_lng, e.status, e.created_at,
             x.file_ref IS NOT NULL AS erased
           FROM evidence e LEFT JOIN erased_files x ON x.file_ref = e.file_ref
           WHERE e.claim_id = ? ORDER BY e.created_at`,
        )
        .bind(item.subject_id)
        .all(),
      db
        .prepare(
          `SELECT c.id, p.legal_name, c.external_ref, c.fee_kurus, c.icra_office, c.icra_file_no
           FROM cases c JOIN partners p ON p.id = c.partner_id WHERE c.vehicle_id = ? AND c.status = 'active'`,
        )
        .bind(claim.vehicle_id)
        .all(),
      db
        .prepare(
          `SELECT cp.lat, cp.lng FROM case_places cp JOIN cases c ON c.id = cp.case_id
           WHERE c.vehicle_id = ? AND c.status = 'active' AND cp.lat IS NOT NULL AND cp.lng IS NOT NULL`,
        )
        .bind(claim.vehicle_id)
        .all<{ lat: number; lng: number }>(),
      db
        .prepare(
          `SELECT a.strikes,
             (SELECT count(*) FROM claims c WHERE c.agent_id = a.user_id AND c.close_reason = 'delivered') AS deliveries
           FROM agents a WHERE a.user_id = ?`,
        )
        .bind(claim.agent_id)
        .first<{ strikes: number; deliveries: number }>(),
    ]);
    const seen = sightings.results as { lat: number; lng: number; received_at: number }[];
    let nearest: number | null = null;
    for (const sighting of seen) {
      for (const place of places.results) {
        const metres = distanceMetres(sighting, place);
        if (nearest === null || metres < nearest) nearest = metres;
      }
    }
    const first = seen[0];
    return ok({
      item: base,
      claim,
      sightings: sightings.results,
      evidence: evidence.results,
      cases: cases.results,
      signals: {
        seconds_to_sighting: first ? Math.max(0, first.received_at - claim.claimed_at) : null,
        nearest_place_m: nearest,
        agent_deliveries: agent?.deliveries ?? 0,
        agent_strikes: agent?.strikes ?? 0,
      },
    });
  }
  const row = await db
    .prepare(
      `SELECT c.id, c.partner_id, p.legal_name, c.vehicle_id, c.external_ref, c.vehicle_snapshot, c.status
       FROM cases c JOIN partners p ON p.id = c.partner_id WHERE c.id = ?`,
    )
    .bind(item.subject_id)
    .first<{ vehicle_id: string; vehicle_snapshot: string }>();
  if (!row) return fail('not_found');
  const vehicle = await db
    .prepare(
      `SELECT v.id, v.vin, v.make, v.model, v.year, v.colour,
         (SELECT plate FROM vehicle_plates WHERE vehicle_id = v.id AND valid_to IS NULL) AS plate
       FROM vehicles v WHERE v.id = ?`,
    )
    .bind(row.vehicle_id)
    .first();
  return ok({
    item: base,
    case: { ...row, vehicle_snapshot: JSON.parse(row.vehicle_snapshot) as unknown },
    vehicle,
  });
}

/**
 * Staff settle an identity review.
 * - accept: the partner's account is right. The plate moves to the case's vehicle (closing it on
 *   any other); a missing VIN is set from `vin`, joining the vehicle that already has it.
 * - reject: the case is closed as withdrawn and the partner told why.
 */
export async function resolveIdentity(
  db: D1Database,
  staffId: string,
  reviewId: string,
  decision: { action: 'accept'; vin?: string } | { action: 'reject'; reason: string },
  at: number,
): Promise<Result<{ case_status: string }>> {
  const item = await db
    .prepare(`SELECT id, kind, subject_id FROM review_items WHERE id = ? AND status = 'open'`)
    .bind(reviewId)
    .first<{ id: string; kind: string; subject_id: string }>();
  if (!item || item.kind === 'delivery') return fail('not_found');
  const kase = await db
    .prepare(
      'SELECT id, partner_id, vehicle_id, external_ref, vehicle_snapshot, status FROM cases WHERE id = ?',
    )
    .bind(item.subject_id)
    .first<{
      id: string;
      partner_id: string;
      vehicle_id: string;
      external_ref: string;
      vehicle_snapshot: string;
      status: string;
    }>();
  if (kase?.status !== 'pending_identity') return fail('case_not_pending');
  const resolve = db
    .prepare(
      `UPDATE review_items SET status = 'resolved', resolved_by = ?, resolved_at = ? WHERE id = ?`,
    )
    .bind(staffId, at, reviewId);

  if (decision.action === 'reject') {
    const reason = decision.reason.trim();
    if (!reason || reason.length > 200) return fail('invalid_reason');
    await db.batch([
      db
        .prepare(
          `UPDATE cases SET status = 'withdrawn', closed_reason = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(`identity rejected: ${reason}`, at, kase.id),
      resolve,
      outboxStatement(db, at, kase.partner_id, 'case.rejected', {
        case_id: kase.id,
        external_ref: kase.external_ref,
        reason,
      }),
      auditStatement(db, at, `staff:${staffId}`, 'identity.rejected', `case:${kase.id}`, {
        reason,
      }),
    ]);
    return ok({ case_status: 'withdrawn' });
  }

  const snapshot = JSON.parse(kase.vehicle_snapshot) as {
    vin: string | null;
    plate: string;
    make: string;
    model: string;
    year: number | null;
    colour: string | null;
  };
  const statements: D1PreparedStatement[] = [];
  const current = await db
    .prepare('SELECT vin FROM vehicles WHERE id = ?')
    .bind(kase.vehicle_id)
    .first<{ vin: string | null }>();
  // The VIN staff confirm: theirs, else the partner's, else the one the vehicle already has.
  const vin = normalizeVin(decision.vin ?? snapshot.vin ?? current?.vin ?? '');
  if (!vin) return fail('invalid_vin');
  let vehicleId: string;
  const holder = await db
    .prepare('SELECT id FROM vehicles WHERE vin = ?')
    .bind(vin)
    .first<{ id: string }>();
  if (holder) {
    // The vehicle is known under this VIN: the case joins it.
    vehicleId = holder.id;
  } else if (!current?.vin) {
    vehicleId = kase.vehicle_id;
    statements.push(
      db
        .prepare('UPDATE vehicles SET vin = ?, updated_at = ? WHERE id = ?')
        .bind(vin, at, vehicleId),
    );
  } else {
    // Linked by plate to another vehicle, but staff say it is a different one.
    vehicleId = newId();
    statements.push(
      db
        .prepare(
          'INSERT INTO vehicles (id, vin, make, model, year, colour, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          vehicleId,
          vin,
          snapshot.make,
          snapshot.model,
          snapshot.year,
          snapshot.colour,
          at,
          at,
        ),
    );
  }
  // The plate goes to this vehicle, and off any other, unless it is already there.
  const plateHere = await db
    .prepare(
      'SELECT 1 AS yes FROM vehicle_plates WHERE vehicle_id = ? AND plate = ? AND valid_to IS NULL',
    )
    .bind(vehicleId, snapshot.plate)
    .first();
  if (!plateHere) {
    statements.push(
      db
        .prepare(
          'UPDATE vehicle_plates SET valid_to = ? WHERE valid_to IS NULL AND (plate = ? OR vehicle_id = ?)',
        )
        .bind(at, snapshot.plate, vehicleId),
      db
        .prepare('INSERT INTO vehicle_plates (vehicle_id, plate, valid_from) VALUES (?, ?, ?)')
        .bind(vehicleId, snapshot.plate, at),
    );
  }
  statements.push(
    db
      .prepare(`UPDATE cases SET vehicle_id = ?, status = 'active', updated_at = ? WHERE id = ?`)
      .bind(vehicleId, at, kase.id),
    resolve,
    // Other reviews of the same case are settled by the same decision.
    db
      .prepare(
        `UPDATE review_items SET status = 'resolved', resolved_by = ?, resolved_at = ? WHERE subject_id = ? AND status = 'open'`,
      )
      .bind(staffId, at, kase.id),
    auditStatement(db, at, `staff:${staffId}`, 'identity.accepted', `case:${kase.id}`, {
      vehicle: vehicleId,
    }),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
      // The partner already has an open case on the vehicle this one would join.
      return fail('duplicate_case');
    }
    throw error;
  }
  return ok({ case_status: 'active' });
}

/** Partner details staff keep up to date: tax data for invoices, the re-confirm window. */
export async function updatePartner(
  db: D1Database,
  staffId: string,
  partnerId: string,
  input: {
    legalName: string;
    vkn: string | null;
    taxOffice: string | null;
    kepAddress: string | null;
    eInvoice: boolean;
    reconfirmDays: number;
  },
  at: number,
): Promise<Result<null>> {
  if (!input.legalName.trim()) return fail('missing_legal_name');
  if (input.vkn !== null && !/^\d{10,11}$/.test(input.vkn)) return fail('invalid_vkn');
  if (!(
    Number.isInteger(input.reconfirmDays) &&
    input.reconfirmDays >= 1 &&
    input.reconfirmDays <= 90
  )) {
    return fail('invalid_reconfirm_days');
  }
  const result = await db.batch([
    db
      .prepare(
        `UPDATE partners SET legal_name = ?, vkn = ?, tax_office = ?, kep_address = ?, e_invoice = ?,
           reconfirm_days = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(
        input.legalName.trim(),
        input.vkn,
        input.taxOffice,
        input.kepAddress,
        input.eInvoice ? 1 : 0,
        input.reconfirmDays,
        at,
        partnerId,
      ),
    auditStatement(db, at, `staff:${staffId}`, 'partner.updated', `partner:${partnerId}`),
  ]);
  return result[0]?.meta.changes === 1 ? ok(null) : fail('not_found');
}

/** A field is never deleted (stored values keep their meaning); it is retired. */
export async function deprecateField(
  db: D1Database,
  staffId: string,
  fieldId: string,
  at: number,
): Promise<Result<null>> {
  const result = await db.batch([
    db
      .prepare(
        'UPDATE field_definitions SET deprecated_at = ? WHERE id = ? AND deprecated_at IS NULL',
      )
      .bind(at, fieldId),
    auditStatement(db, at, `staff:${staffId}`, 'field.deprecated', `field:${fieldId}`),
  ]);
  return result[0]?.meta.changes === 1 ? ok(null) : fail('not_found');
}

/**
 * Staff confirm the agent's IBAN is in the agent's own name (bank name check, or a test transfer
 * the agent read back). Payouts are ordered only to a verified IBAN.
 */
export async function verifyAgentIban(
  db: D1Database,
  staffId: string,
  agentId: string,
  iban: string,
  at: number,
): Promise<Result<null>> {
  // The IBAN the staff member checked: if the agent changed it meanwhile, nothing is verified.
  const results = await db.batch([
    db
      .prepare(
        `UPDATE agents SET iban_verified_at = ?, updated_at = ?
         WHERE user_id = ? AND iban = ? AND iban IS NOT NULL`,
      )
      .bind(at, at, agentId, iban),
    auditStatement(db, at, `staff:${staffId}`, 'agent.iban_verified', `agent:${agentId}`),
  ]);
  return results[0]?.meta.changes === 1 ? ok(null) : fail('iban_changed');
}

export interface AuditRow {
  id: string;
  at: number;
  actor: string;
  action: string;
  subject: string;
  detail: Record<string, unknown>;
}

const AUDIT_FILTER = /^[A-Za-z0-9_.:/@-]{1,120}$/;

/**
 * The audit log, newest first: who did what to what (docs/DESIGN.md §7, Audit). Filter by the
 * exact subject ("partner:<id>", "claim:<id>") or actor ("staff:<id>", "agent:<id>"); page with
 * `before`, the `at` of the last row seen.
 */
export async function auditLog(
  db: D1Database,
  query: { subject?: string; actor?: string; before?: number; limit?: number },
): Promise<Result<{ events: AuditRow[]; next_before: number | null }>> {
  const subject = query.subject?.trim() ? query.subject.trim() : null;
  const actor = query.actor?.trim() ? query.actor.trim() : null;
  if (
    (subject !== null && !AUDIT_FILTER.test(subject)) ||
    (actor !== null && !AUDIT_FILTER.test(actor))
  ) {
    return fail('invalid_filter');
  }
  const before =
    query.before !== undefined && Number.isFinite(query.before) ? Math.floor(query.before) : null;
  const limit = Math.min(Math.max(Math.floor(query.limit ?? 100) || 100, 1), 200);
  const { results } = await db
    .prepare(
      `SELECT id, at, actor, action, subject, detail FROM audit_events
       WHERE (? IS NULL OR subject = ?) AND (? IS NULL OR actor = ?) AND (? IS NULL OR at < ?)
       ORDER BY at DESC, id LIMIT ?`,
    )
    .bind(subject, subject, actor, actor, before, before, limit + 1)
    .all<Omit<AuditRow, 'detail'> & { detail: string }>();
  const page = results.slice(0, limit);
  const parse = (text: string): Record<string, unknown> => {
    try {
      const value = JSON.parse(text) as unknown;
      return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  return ok({
    events: page.map((row) => ({ ...row, detail: parse(row.detail) })),
    next_before: results.length > limit ? (page.at(-1)?.at ?? null) : null,
  });
}
