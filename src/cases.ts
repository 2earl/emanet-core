/**
 * Partners and their cases (docs/DESIGN.md §4.1–4.3, §5).
 *
 * Two rules shape everything here:
 * - A vehicle is one row, whoever asks for it; each creditor's claim is its own case.
 * - A partner learns nothing about other partners' cases. A partner adding a vehicle another
 *   creditor already pursues gets the same answer as for a vehicle nobody pursues: telling it
 *   otherwise would disclose someone's debt (Banking Law 73).
 */
import { auditStatement, auditStatementIf, outboxStatement } from './audit';
import { readSettings } from './settings';
import { orphanReviewsStatement } from './claims';
import { fieldsFor, validateAttributes, visibleAttributes } from './fields';
import { normalizePlate, normalizeVin } from './normalize';
import { openAttributes, sealAttributes } from './pii';
import { checkPriceList, feeFor, type PriceList } from './pricing';
import { fail, newId, ok, type Result } from './result';

const DAY = 24 * 60 * 60;
const MAX_PLACES = 10;

export type PartnerKind = 'bank' | 'vys' | 'law_firm' | 'leasing' | 'other';

export interface Partner {
  id: string;
  orgId: string;
  kind: PartnerKind;
  legalName: string;
  status: 'invited' | 'active' | 'suspended';
  reconfirmDays: number;
}

interface PartnerRow {
  id: string;
  org_id: string;
  kind: PartnerKind;
  legal_name: string;
  status: Partner['status'];
  reconfirm_days: number;
}

const toPartner = (row: PartnerRow): Partner => ({
  id: row.id,
  orgId: row.org_id,
  kind: row.kind,
  legalName: row.legal_name,
  status: row.status,
  reconfirmDays: row.reconfirm_days,
});

export async function partnerByOrg(db: D1Database, orgId: string): Promise<Partner | null> {
  const row = await db
    .prepare('SELECT * FROM partners WHERE org_id = ?')
    .bind(orgId)
    .first<PartnerRow>();
  return row ? toPartner(row) : null;
}

export async function partnerById(db: D1Database, id: string): Promise<Partner | null> {
  const row = await db.prepare('SELECT * FROM partners WHERE id = ?').bind(id).first<PartnerRow>();
  return row ? toPartner(row) : null;
}

export interface NewPartner {
  orgId: string;
  kind: PartnerKind;
  legalName: string;
  vkn?: string;
  taxOffice?: string;
  kepAddress?: string;
  eInvoice?: boolean;
  reconfirmDays?: number;
}

/** Staff create a partner for a login organization; it starts as `invited`. */
export async function createPartner(
  db: D1Database,
  input: NewPartner,
  staffId: string,
  at: number,
): Promise<Result<Partner>> {
  if (!input.legalName.trim()) return fail('missing_legal_name');
  if (input.vkn !== undefined && !/^\d{10,11}$/.test(input.vkn)) return fail('invalid_vkn');
  if (await partnerByOrg(db, input.orgId)) return fail('partner_exists');
  const id = newId();
  await db.batch([
    db
      .prepare(
        `INSERT INTO partners (id, org_id, kind, legal_name, vkn, tax_office, kep_address,
           e_invoice, reconfirm_days, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.orgId,
        input.kind,
        input.legalName.trim(),
        input.vkn ?? null,
        input.taxOffice ?? null,
        input.kepAddress ?? null,
        input.eInvoice === false ? 0 : 1,
        input.reconfirmDays ?? 14,
        staffId,
        at,
        at,
      ),
    auditStatement(db, at, `staff:${staffId}`, 'partner.created', `partner:${id}`, {
      org: input.orgId,
    }),
  ]);
  const partner = await partnerById(db, id);
  return partner ? ok(partner) : fail('not_found');
}

export async function setPartnerStatus(
  db: D1Database,
  partnerId: string,
  status: Partner['status'],
  staffId: string,
  at: number,
): Promise<Result<null>> {
  if (!['invited', 'active', 'suspended'].includes(status)) return fail('invalid_status');
  if (status === 'active') {
    // A company is a partner only through its onboarding: the agreement it accepted and a second
    // staff member's approval. Nothing else makes one active.
    const signed = await db
      .prepare('SELECT contract_signed_at, onboarding_id FROM partners WHERE id = ?')
      .bind(partnerId)
      .first<{ contract_signed_at: number | null; onboarding_id: string | null }>();
    if (!signed) return fail('not_found');
    if (signed.contract_signed_at === null || signed.onboarding_id === null) {
      return fail('no_agreement');
    }
  }
  const result = await db.batch([
    db
      .prepare('UPDATE partners SET status = ?, updated_at = ? WHERE id = ?')
      .bind(status, at, partnerId),
    auditStatement(db, at, `staff:${staffId}`, `partner.${status}`, `partner:${partnerId}`),
  ]);
  return result[0]?.meta.changes === 1 ? ok(null) : fail('not_found');
}

/** A new price list, in force from `validFrom`. Cases already created keep their fee. */
export async function setPriceList(
  db: D1Database,
  partnerId: string,
  input: unknown,
  actor: string,
  validFrom: number,
  at: number,
): Promise<Result<PriceList>> {
  const list = checkPriceList(input);
  if (!list.ok) return list;
  await db.batch([
    db
      .prepare(
        `INSERT INTO price_lists (id, partner_id, valid_from, rules, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(newId(), partnerId, validFrom, JSON.stringify(list.value), actor, at),
    auditStatement(db, at, actor, 'price_list.set', `partner:${partnerId}`, { validFrom }),
  ]);
  return list;
}

async function priceListAt(
  db: D1Database,
  partnerId: string,
  at: number,
): Promise<PriceList | null> {
  const row = await db
    .prepare(
      `SELECT rules FROM price_lists WHERE partner_id = ? AND valid_from <= ?
       ORDER BY valid_from DESC, created_at DESC LIMIT 1`,
    )
    .bind(partnerId, at)
    .first<{ rules: string }>();
  return row ? (JSON.parse(row.rules) as PriceList) : null;
}

// ---------------------------------------------------------------------------------------------
// Cases

export type CaseStatus = 'pending_identity' | 'active' | 'delivered' | 'withdrawn' | 'expired';

export interface PlaceInput {
  kind: 'owner_home' | 'work' | 'last_seen' | 'other';
  address: string;
  district: string;
  city: string;
  lat?: number;
  lng?: number;
  note?: string;
  attributes?: Record<string, unknown>;
}

export interface CaseInput {
  external_ref: string;
  vin?: string;
  plate: string;
  make: string;
  model: string;
  year?: number;
  colour?: string;
  icra_office: string;
  icra_file_no: string;
  serh_date: string;
  legal_basis: 'rehin' | 'haciz';
  places?: PlaceInput[];
  attributes?: Record<string, unknown>;
  vehicle_attributes?: Record<string, unknown>;
}

/** What the partner said about the vehicle, kept on its case. */
interface Snapshot {
  vin: string | null;
  plate: string;
  make: string;
  model: string;
  year: number | null;
  colour: string | null;
  attributes: Record<string, unknown>;
}

/** A case as its partner sees it: only what the partner itself sent, and the case's state. */
export interface CaseView {
  id: string;
  external_ref: string;
  status: CaseStatus;
  vehicle: Snapshot;
  icra_office: string;
  icra_file_no: string;
  serh_date: string;
  legal_basis: 'rehin' | 'haciz';
  places: (PlaceInput & { id: string })[];
  attributes: Record<string, unknown>;
  fee_kurus: number;
  last_confirmed_at: number;
  expires_at: number;
  delivered_at: number | null;
  created_at: number;
  updated_at: number;
}

interface CaseRow {
  id: string;
  partner_id: string;
  vehicle_id: string;
  external_ref: string;
  icra_office: string;
  icra_file_no: string;
  serh_date: string;
  legal_basis: 'rehin' | 'haciz';
  vehicle_snapshot: string;
  attributes: string;
  status: CaseStatus;
  fee_kurus: number;
  last_confirmed_at: number;
  expires_at: number;
  delivered_at: number | null;
  created_at: number;
  updated_at: number;
}

interface PlaceRow {
  id: string;
  kind: PlaceInput['kind'];
  address: string;
  district: string;
  city: string;
  lat: number | null;
  lng: number | null;
  note: string | null;
  attributes: string;
}

const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

function checkCaseInput(input: CaseInput): Result<{ vin: string | null; plate: string }> {
  // Values arrive over RPC from a partner's upload: check types, not only the TypeScript shape.
  const raw = input as unknown as Record<string, unknown> | null;
  if (typeof raw !== 'object' || raw === null) return fail('invalid_case');
  if (!text(input.external_ref, 100)) return fail('invalid_external_ref');
  if (typeof raw.plate !== 'string') return fail('invalid_plate');
  const plate = normalizePlate(input.plate);
  if (!plate) return fail('invalid_plate');
  let vin: string | null = null;
  if (input.vin !== undefined && input.vin !== '') {
    if (typeof raw.vin !== 'string') return fail('invalid_vin');
    vin = normalizeVin(input.vin);
    if (!vin) return fail('invalid_vin');
  }
  if (!text(input.make, 60) || !text(input.model, 60)) return fail('invalid_vehicle');
  if (
    input.year !== undefined &&
    !(Number.isInteger(input.year) && input.year >= 1950 && input.year <= 2100)
  ) {
    return fail('invalid_year');
  }
  if (input.colour !== undefined && !text(input.colour, 40)) return fail('invalid_colour');
  if (!text(input.icra_office, 120) || !text(input.icra_file_no, 40))
    return fail('invalid_icra_file');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.serh_date) || Number.isNaN(Date.parse(input.serh_date))) {
    return fail('invalid_serh_date');
  }
  if (raw.legal_basis !== 'rehin' && raw.legal_basis !== 'haciz') {
    return fail('invalid_legal_basis');
  }
  const places = input.places ?? [];
  if (!Array.isArray(places) || places.length > MAX_PLACES) return fail('invalid_places');
  for (const place of places) {
    if (!['owner_home', 'work', 'last_seen', 'other'].includes(place.kind)) {
      return fail('invalid_place', 'kind');
    }
    if (!text(place.address, 300) || !text(place.district, 60) || !text(place.city, 60)) {
      return fail('invalid_place', 'address');
    }
    const hasLat = place.lat !== undefined;
    if (hasLat !== (place.lng !== undefined)) return fail('invalid_place', 'lat/lng');
    if (hasLat && !(Math.abs(place.lat ?? 99) <= 90 && Math.abs(place.lng ?? 999) <= 180)) {
      return fail('invalid_place', 'lat/lng');
    }
    if (place.note !== undefined && place.note.length > 500) return fail('invalid_place', 'note');
  }
  return ok({ vin, plate });
}

async function placesOf(db: D1Database, caseId: string): Promise<PlaceRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM case_places WHERE case_id = ? ORDER BY rowid')
    .bind(caseId)
    .all<PlaceRow>();
  return results;
}

async function toView(db: D1Database, row: CaseRow): Promise<CaseView> {
  const [caseFields, placeFields, places] = await Promise.all([
    fieldsFor(db, row.partner_id, 'case'),
    fieldsFor(db, row.partner_id, 'place'),
    placesOf(db, row.id),
  ]);
  // Sealed values are opened only after the audience filter: what a partner may not see stays shut.
  const placeAttributes = await Promise.all(
    places.map((place) =>
      openAttributes(
        visibleAttributes(
          placeFields,
          JSON.parse(place.attributes) as Record<string, unknown>,
          'partner',
        ),
      ),
    ),
  );
  const snapshot = JSON.parse(row.vehicle_snapshot) as Snapshot;
  return {
    id: row.id,
    external_ref: row.external_ref,
    status: row.status,
    vehicle: { ...snapshot, attributes: await openAttributes(snapshot.attributes) },
    icra_office: row.icra_office,
    icra_file_no: row.icra_file_no,
    serh_date: row.serh_date,
    legal_basis: row.legal_basis,
    places: places.map((place, index) => ({
      id: place.id,
      kind: place.kind,
      address: place.address,
      district: place.district,
      city: place.city,
      ...(place.lat === null ? {} : { lat: place.lat }),
      ...(place.lng === null ? {} : { lng: place.lng }),
      ...(place.note === null ? {} : { note: place.note }),
      attributes: placeAttributes[index] ?? {},
    })),
    attributes: await openAttributes(
      visibleAttributes(
        caseFields,
        JSON.parse(row.attributes) as Record<string, unknown>,
        'partner',
      ),
    ),
    fee_kurus: row.fee_kurus,
    last_confirmed_at: row.last_confirmed_at,
    expires_at: row.expires_at,
    delivered_at: row.delivered_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function getCase(
  db: D1Database,
  partnerId: string,
  caseId: string,
): Promise<Result<CaseView>> {
  const row = await db
    .prepare('SELECT * FROM cases WHERE id = ? AND partner_id = ?')
    .bind(caseId, partnerId)
    .first<CaseRow>();
  return row ? ok(await toView(db, row)) : fail('not_found');
}

export async function listCases(
  db: D1Database,
  partnerId: string,
  query: { status?: CaseStatus; updatedSince?: number; cursor?: string; limit?: number },
): Promise<Result<{ cases: CaseView[]; next_cursor: string | null }>> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  // Cursor: "<updated_at>.<id>", ordered by both so pages don't skip or repeat.
  let afterAt = query.updatedSince ?? 0;
  let afterId = '';
  if (query.cursor !== undefined) {
    const match = /^(\d+)\.([0-9a-f-]{36})$/.exec(query.cursor);
    if (!match) return fail('invalid_cursor');
    afterAt = Number(match[1]);
    afterId = match[2] ?? '';
  }
  const { results } = await db
    .prepare(
      `SELECT * FROM cases
       WHERE partner_id = ? AND (? IS NULL OR status = ?) AND (updated_at > ? OR (updated_at = ? AND id > ?))
       ORDER BY updated_at, id LIMIT ?`,
    )
    .bind(
      partnerId,
      query.status ?? null,
      query.status ?? null,
      afterAt,
      afterAt,
      afterId,
      limit + 1,
    )
    .all<CaseRow>();
  const page = results.slice(0, limit);
  const last = page.at(-1);
  return ok({
    cases: await Promise.all(page.map((row) => toView(db, row))),
    next_cursor: results.length > limit && last ? `${String(last.updated_at)}.${last.id}` : null,
  });
}

/**
 * Finds or creates the vehicle a case is about, and says whether the case can go to agents now or
 * must wait for staff (a missing VIN, a plate on another vehicle, a plate change).
 */
async function resolveVehicle(
  db: D1Database,
  vin: string | null,
  plate: string,
  input: CaseInput,
  at: number,
): Promise<{
  vehicleId: string;
  statements: D1PreparedStatement[];
  review: { kind: 'plate_conflict' | 'missing_vin'; detail: Record<string, unknown> } | null;
}> {
  const holder = await db
    .prepare('SELECT vehicle_id FROM vehicle_plates WHERE plate = ? AND valid_to IS NULL')
    .bind(plate)
    .first<{ vehicle_id: string }>();

  const insertVehicle = (id: string, withVin: string | null) =>
    db
      .prepare(
        `INSERT INTO vehicles (id, vin, make, model, year, colour, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (vin) DO NOTHING`,
      )
      .bind(
        id,
        withVin,
        input.make.trim(),
        input.model.trim(),
        input.year ?? null,
        input.colour ?? null,
        at,
        at,
      );
  const insertPlate = (vehicleId: string) =>
    db
      .prepare('INSERT INTO vehicle_plates (vehicle_id, plate, valid_from) VALUES (?, ?, ?)')
      .bind(vehicleId, plate, at);

  if (vin === null) {
    // Without a VIN the plate is all we have: link to the vehicle holding it, or a new one, and
    // let staff confirm before agents see it.
    if (holder) {
      return {
        vehicleId: holder.vehicle_id,
        statements: [],
        review: { kind: 'missing_vin', detail: { plate } },
      };
    }
    const id = newId();
    return {
      vehicleId: id,
      statements: [insertVehicle(id, null), insertPlate(id)],
      review: { kind: 'missing_vin', detail: { plate } },
    };
  }

  // Insert-or-get by VIN, safe when two partners add the same vehicle at once.
  await insertVehicle(newId(), vin).run();
  const vehicle = await db
    .prepare('SELECT id FROM vehicles WHERE vin = ?')
    .bind(vin)
    .first<{ id: string }>();
  if (!vehicle) throw new Error('vehicle vanished after insert');
  const current = await db
    .prepare('SELECT plate FROM vehicle_plates WHERE vehicle_id = ? AND valid_to IS NULL')
    .bind(vehicle.id)
    .first<{ plate: string }>();

  if (holder && holder.vehicle_id !== vehicle.id) {
    return {
      vehicleId: vehicle.id,
      statements: [],
      review: { kind: 'plate_conflict', detail: { plate, vin, reason: 'plate_on_other_vehicle' } },
    };
  }
  if (current && current.plate !== plate) {
    // A different plate than the one on record: re-registered, or a mistake. Staff decide; a
    // wrong change would hide the vehicle from agents working other cases.
    return {
      vehicleId: vehicle.id,
      statements: [],
      review: {
        kind: 'plate_conflict',
        detail: { plate, vin, reason: 'plate_change', recorded: current.plate },
      },
    };
  }
  return {
    vehicleId: vehicle.id,
    statements: current ? [] : [insertPlate(vehicle.id)],
    review: null,
  };
}

function placeStatements(
  db: D1Database,
  caseId: string,
  places: readonly PlaceInput[],
  placeAttributes: readonly Record<string, unknown>[],
): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM case_places WHERE case_id = ?').bind(caseId),
    ...places.map((place, index) =>
      db
        .prepare(
          `INSERT INTO case_places (id, case_id, kind, address, district, city, lat, lng, note, attributes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          newId(),
          caseId,
          place.kind,
          place.address.trim(),
          place.district.trim(),
          place.city.trim(),
          place.lat ?? null,
          place.lng ?? null,
          place.note ?? null,
          JSON.stringify(placeAttributes[index] ?? {}),
        ),
    ),
  ];
}

/**
 * Adds a case, or updates the partner's case with the same `external_ref` (so retries and repeated
 * uploads are safe). Sending a case again also confirms it is still active.
 */
export async function upsertCase(
  db: D1Database,
  partner: Partner,
  input: CaseInput,
  actor: string,
  at: number,
): Promise<Result<CaseView>> {
  if (partner.status !== 'active') return fail('partner_not_active');
  const checked = checkCaseInput(input);
  if (!checked.ok) return checked;
  const { vin, plate } = checked.value;

  const [caseFields, vehicleFields, placeFields] = await Promise.all([
    fieldsFor(db, partner.id, 'case'),
    fieldsFor(db, partner.id, 'vehicle'),
    fieldsFor(db, partner.id, 'place'),
  ]);
  const existing = await db
    .prepare('SELECT * FROM cases WHERE partner_id = ? AND external_ref = ?')
    .bind(partner.id, input.external_ref)
    .first<CaseRow>();
  const storedSnapshot = existing ? (JSON.parse(existing.vehicle_snapshot) as Snapshot) : null;
  // What is stored is sealed where its field is personal data: opened to merge, sealed again below.
  const storedAttributes = existing
    ? await openAttributes(JSON.parse(existing.attributes) as Record<string, unknown>)
    : {};
  const storedVehicleAttributes = await openAttributes(storedSnapshot?.attributes ?? {});

  const attributes = validateAttributes(caseFields, input.attributes, 'partner', storedAttributes);
  if (!attributes.ok) return attributes;
  const vehicleAttributes = validateAttributes(
    vehicleFields,
    input.vehicle_attributes,
    'partner',
    storedVehicleAttributes,
  );
  if (!vehicleAttributes.ok) return vehicleAttributes;
  const placeAttributes: Record<string, unknown>[] = [];
  for (const place of input.places ?? []) {
    const checkedPlace = validateAttributes(placeFields, place.attributes, 'partner');
    if (!checkedPlace.ok) return checkedPlace;
    placeAttributes.push(await sealAttributes(placeFields, checkedPlace.value));
  }
  const sealedAttributes = await sealAttributes(caseFields, attributes.value);

  const snapshot: Snapshot = {
    vin,
    plate,
    make: input.make.trim(),
    model: input.model.trim(),
    year: input.year ?? null,
    colour: input.colour?.trim() ?? null,
    attributes: await sealAttributes(vehicleFields, vehicleAttributes.value),
  };
  const expiresAt = at + partner.reconfirmDays * DAY;
  const statements: D1PreparedStatement[] = [];
  let caseId: string;
  let status: CaseStatus;

  if (existing) {
    if (existing.status === 'delivered') return fail('case_closed');
    if (existing.status === 'active' && (await inDeliveryReview(db, existing.id))) {
      return fail('delivery_in_review');
    }
    if (storedSnapshot?.vin && storedSnapshot.vin !== vin) return fail('vin_mismatch');
    caseId = existing.id;
    status = existing.status === 'pending_identity' ? 'pending_identity' : 'active';
    let vehicleId = existing.vehicle_id;
    if (
      existing.status === 'pending_identity' ||
      storedSnapshot?.plate !== plate ||
      storedSnapshot.vin !== vin
    ) {
      // Identity changed or still open: resolve it again with what the partner sends now.
      const resolved = await resolveVehicle(db, vin, plate, input, at);
      vehicleId = resolved.vehicleId;
      statements.push(...resolved.statements);
      status = resolved.review ? 'pending_identity' : 'active';
      if (resolved.review) {
        statements.push(
          reviewStatement(db, resolved.review.kind, caseId, resolved.review.detail, at),
        );
      }
    }
    statements.push(
      db
        .prepare(
          `UPDATE cases SET vehicle_id = ?, icra_office = ?, icra_file_no = ?, serh_date = ?,
             legal_basis = ?, vehicle_snapshot = ?, attributes = ?, status = ?, last_confirmed_at = ?,
             expires_at = ?, closed_reason = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .bind(
          vehicleId,
          input.icra_office.trim(),
          input.icra_file_no.trim(),
          input.serh_date,
          input.legal_basis,
          JSON.stringify(snapshot),
          JSON.stringify(sealedAttributes),
          status,
          at,
          expiresAt,
          at,
          caseId,
        ),
    );
  } else {
    const list = await priceListAt(db, partner.id, at);
    if (!list) return fail('no_price_list');
    const resolved = await resolveVehicle(db, vin, plate, input, at);
    caseId = newId();
    status = resolved.review ? 'pending_identity' : 'active';
    statements.push(...resolved.statements);
    statements.push(
      db
        .prepare(
          `INSERT INTO cases (id, partner_id, vehicle_id, external_ref, icra_office, icra_file_no,
             serh_date, legal_basis, vehicle_snapshot, attributes, status, fee_kurus,
             last_confirmed_at, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          caseId,
          partner.id,
          resolved.vehicleId,
          input.external_ref,
          input.icra_office.trim(),
          input.icra_file_no.trim(),
          input.serh_date,
          input.legal_basis,
          JSON.stringify(snapshot),
          JSON.stringify(sealedAttributes),
          status,
          feeFor(list, snapshot),
          at,
          expiresAt,
          at,
          at,
        ),
    );
    if (resolved.review) {
      statements.push(
        reviewStatement(db, resolved.review.kind, caseId, resolved.review.detail, at),
      );
    }
  }

  if (input.places !== undefined) {
    statements.push(...placeStatements(db, caseId, input.places, placeAttributes));
  }
  statements.push(
    auditStatement(db, at, actor, existing ? 'case.updated' : 'case.created', `case:${caseId}`, {
      status,
    }),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    if (
      error instanceof Error &&
      /UNIQUE constraint failed: cases\.partner_id, cases\.vehicle_id|cases_open_per_partner/.test(
        error.message,
      )
    ) {
      // The partner already has an open case for this vehicle under another reference.
      return fail('duplicate_case');
    }
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
      // Another write took the same plate a moment ago: the caller retries.
      return fail('conflict_retry');
    }
    throw error;
  }
  return getCase(db, partner.id, caseId);
}

/**
 * True while staff are checking a reported delivery of this vehicle: the custodian's receipt is
 * in, so the vehicle is (as far as anyone knows) already in the car park. Until staff decide, a
 * case on it can't be changed, withdrawn or left to expire: taking the case away at that moment
 * would cancel a delivery the agent has already made, and the fee with it.
 *
 * Only for the partner's active case, which that delivery is about to close. A case still waiting
 * for its identity isn't part of the delivery, and holding it would tell its partner something
 * about another creditor's vehicle (the no-oracle rule, DESIGN §4.3).
 */
const IN_DELIVERY_REVIEW = `cases.status = 'active' AND EXISTS (
  SELECT 1 FROM claims cl JOIN review_items r
    ON r.kind = 'delivery' AND r.subject_id = cl.id AND r.status = 'open'
  WHERE cl.vehicle_id = cases.vehicle_id AND cl.closed_at IS NULL)`;

async function inDeliveryReview(db: D1Database, caseId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS yes FROM cases WHERE id = ? AND ${IN_DELIVERY_REVIEW}`)
    .bind(caseId)
    .first();
  return row !== null;
}

function reviewStatement(
  db: D1Database,
  kind: 'plate_conflict' | 'missing_vin',
  caseId: string,
  detail: Record<string, unknown>,
  at: number,
): D1PreparedStatement {
  // One open item per case and kind: sending the case again doesn't pile up duplicates.
  return db
    .prepare(
      `INSERT INTO review_items (id, kind, subject_id, detail, created_at)
       SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (
         SELECT 1 FROM review_items WHERE subject_id = ? AND kind = ? AND status = 'open')`,
    )
    .bind(newId(), kind, caseId, JSON.stringify(detail), at, caseId, kind);
}

/** The partner confirms its cases are still enforceable; each stays active another period. */
export async function confirmCases(
  db: D1Database,
  partner: Partner,
  caseIds: readonly string[],
  actor: string,
  at: number,
): Promise<Result<{ confirmed: number }>> {
  if (caseIds.length === 0 || caseIds.length > 1000) return fail('invalid_case_ids');
  const expiresAt = at + partner.reconfirmDays * DAY;
  const statements = caseIds.map((id) =>
    db
      .prepare(
        `UPDATE cases SET last_confirmed_at = ?, expires_at = ?, updated_at = ?
         WHERE id = ? AND partner_id = ? AND status IN ('active', 'pending_identity')`,
      )
      .bind(at, expiresAt, at, id, partner.id),
  );
  const results = await db.batch(statements);
  const confirmed = results.reduce((sum, result) => sum + result.meta.changes, 0);
  await auditStatement(db, at, actor, 'cases.confirmed', `partner:${partner.id}`, {
    confirmed,
  }).run();
  return ok({ confirmed });
}

/** The partner takes a case back: the debt was paid, the order lifted, or it was a mistake. */
export async function withdrawCase(
  db: D1Database,
  partner: Partner,
  caseId: string,
  reason: string,
  actor: string,
  at: number,
): Promise<Result<CaseView>> {
  if (!text(reason, 200)) return fail('invalid_reason');
  const result = await db.batch([
    db
      .prepare(
        `UPDATE cases SET status = 'withdrawn', closed_reason = ?, updated_at = ?
         WHERE id = ? AND partner_id = ? AND status IN ('active', 'pending_identity')
           AND NOT (${IN_DELIVERY_REVIEW})`,
      )
      .bind(reason.trim(), at, caseId, partner.id),
    auditStatementIf(
      db,
      at,
      actor,
      'case.withdrawn',
      `case:${caseId}`,
      { reason: reason.trim() },
      `EXISTS (SELECT 1 FROM cases WHERE id = ? AND partner_id = ? AND status = 'withdrawn' AND updated_at = ?)`,
      caseId,
      partner.id,
      at,
    ),
  ]);
  if (result[0]?.meta.changes !== 1) {
    const current = await getCase(db, partner.id, caseId);
    if (!current.ok) return current;
    if (current.value.status === 'active' && (await inDeliveryReview(db, caseId))) {
      return fail('delivery_in_review');
    }
    return fail('case_closed');
  }
  await releaseClaimsWithoutHunt(db, at);
  return getCase(db, partner.id, caseId);
}

/** Cron: cases not confirmed in time leave agents' lists; their partners hear about it. */
export async function expireCases(db: D1Database, at: number): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT id, partner_id, external_ref FROM cases
       WHERE status IN ('active', 'pending_identity') AND expires_at <= ?
         AND NOT (${IN_DELIVERY_REVIEW}) LIMIT 500`,
    )
    .bind(at)
    .all<{ id: string; partner_id: string; external_ref: string }>();
  if (results.length === 0) return 0;
  await db.batch(
    results.flatMap((row) => [
      db
        .prepare(
          `UPDATE cases SET status = 'expired', closed_reason = 'not confirmed', updated_at = ?
           WHERE id = ? AND status IN ('active', 'pending_identity')`,
        )
        .bind(at, row.id),
      outboxStatement(db, at, row.partner_id, 'case.expired', {
        case_id: row.id,
        external_ref: row.external_ref,
      }),
    ]),
  );
  await releaseClaimsWithoutHunt(db, at);
  return results.length;
}

/**
 * Ends claims on vehicles that no longer have an active case, so no agent keeps looking for a
 * vehicle nobody may take. No cooldown: the agent did nothing wrong.
 */
export async function releaseClaimsWithoutHunt(db: D1Database, at: number): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE claims SET closed_at = ?, close_reason = 'revoked'
         WHERE closed_at IS NULL AND NOT EXISTS (
           SELECT 1 FROM cases c WHERE c.vehicle_id = claims.vehicle_id AND c.status = 'active')`,
      )
      .bind(at),
    orphanReviewsStatement(db, at),
  ]);
}

/** How long a closed case keeps its street addresses (docs/DESIGN.md §8, Retention). */
export const PLACE_RETENTION_DAYS = 30;

/**
 * Cron: thirty days after a case closes (delivered, withdrawn or expired), the debtor's addresses
 * it carried are erased: street address, coordinates, note and custom fields. District and city
 * stay, so the partner's reports by city still add up. A case the partner sends again becomes
 * active and is left alone; it brings its places with it.
 */
export async function redactClosedCasePlaces(db: D1Database, at: number): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE case_places SET address = '', lat = NULL, lng = NULL, note = NULL, attributes = '{}'
       WHERE address != '' AND case_id IN (
         SELECT c.id FROM cases c WHERE c.status IN ('delivered', 'withdrawn', 'expired')
           AND c.updated_at <= ?
           AND EXISTS (SELECT 1 FROM case_places p WHERE p.case_id = c.id AND p.address != '')
         LIMIT 500)`,
    )
    .bind(at - (await readSettings(db)).place_retention_days * DAY)
    .run();
  const redacted = result.meta.changes;
  if (redacted > 0) {
    await auditStatement(db, at, 'system', 'retention.places_redacted', 'case_places', {
      places: redacted,
    }).run();
  }
  return redacted;
}
