/**
 * Agents, hunts and claims (docs/DESIGN.md §4.5, §6).
 *
 * A hunt is a vehicle at least one creditor may have taken now: an active case, a known VIN, a
 * current plate, not in custody. Agents see one hunt per vehicle, never one per creditor, and
 * never a debtor's name or debt.
 *
 * A claim gives one agent the vehicle's places for a limited time. When it runs out or is given
 * up without a delivery, the same agent waits a cooldown before claiming that vehicle again, so
 * nobody can hold a vehicle forever by re-claiming it.
 */
import { auditStatement } from './audit';
import { fieldsFor, visibleAttributes } from './fields';
import { payoutFor, type PayoutRule } from './pricing';
import { fail, newId, ok, type Result } from './result';
import { readSettings } from './settings';

const HOUR = 60 * 60;

export type AgentStatus = 'applied' | 'kyc_pending' | 'active' | 'suspended' | 'banned';

export async function registerAgent(
  db: D1Database,
  userId: string,
  at: number,
): Promise<Result<null>> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO agents (user_id, created_at, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (user_id) DO NOTHING`,
      )
      .bind(userId, at, at),
    auditStatement(db, at, `agent:${userId}`, 'agent.applied', `agent:${userId}`),
  ]);
  return ok(null);
}

const AGENT_STATUSES: readonly AgentStatus[] = [
  'applied',
  'kyc_pending',
  'active',
  'suspended',
  'banned',
];

/**
 * Open delivery reviews whose claim has ended some other way (revoked, expired, account deleted):
 * nothing is left to confirm, so they leave the queue. Batched with whatever ended the claims.
 */
export function orphanReviewsStatement(db: D1Database, at: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE review_items SET status = 'resolved', resolved_by = 'system', resolved_at = ?
       WHERE kind = 'delivery' AND status = 'open'
         AND subject_id IN (SELECT id FROM claims WHERE closed_at IS NOT NULL)`,
    )
    .bind(at);
}

/**
 * Staff move an agent through KYC, or suspend and ban. Suspension ends the agent's claims.
 *
 * An agent becomes active only from the identity check (or back from a suspension), and only with
 * the application they sent: the rules accepted, and a name, phone and IBAN to check them against.
 * Staff can't skip the application by setting the status directly.
 */
export async function setAgentStatus(
  db: D1Database,
  agentId: string,
  status: AgentStatus,
  staffId: string,
  reason: string,
  at: number,
): Promise<Result<null>> {
  if (!AGENT_STATUSES.includes(status)) return fail('invalid_status');
  const cause = typeof reason === 'string' ? reason.trim().slice(0, 200) : '';
  if (!cause) return fail('invalid_reason');
  const current = await db
    .prepare(
      'SELECT status, legal_name, phone, iban, terms_accepted_at FROM agents WHERE user_id = ?',
    )
    .bind(agentId)
    .first<{
      status: AgentStatus;
      legal_name: string | null;
      phone: string | null;
      iban: string | null;
      terms_accepted_at: number | null;
    }>();
  if (!current) return fail('not_found');
  if (status === 'active') {
    if (current.status !== 'kyc_pending' && current.status !== 'suspended') {
      return fail('agent_not_ready', current.status);
    }
    if (
      current.terms_accepted_at === null ||
      !current.legal_name ||
      !current.phone ||
      !current.iban
    ) {
      return fail('agent_not_ready', 'application');
    }
  }
  const statements = [
    db
      .prepare('UPDATE agents SET status = ?, updated_at = ? WHERE user_id = ? AND status = ?')
      .bind(status, at, agentId, current.status),
    auditStatement(db, at, `staff:${staffId}`, `agent.${status}`, `agent:${agentId}`, {
      reason: cause,
      from: current.status,
    }),
  ];
  if (status === 'suspended' || status === 'banned') {
    statements.push(
      db
        .prepare(
          `UPDATE claims SET closed_at = ?, close_reason = 'revoked'
           WHERE agent_id = ? AND closed_at IS NULL`,
        )
        .bind(at, agentId),
      orphanReviewsStatement(db, at),
    );
  }
  const results = await db.batch(statements);
  return results[0]?.meta.changes === 1 ? ok(null) : fail('conflict_retry');
}

async function agentOf(
  db: D1Database,
  agentId: string,
): Promise<{ status: AgentStatus; max_active_claims: number | null } | null> {
  return db
    .prepare('SELECT status, max_active_claims FROM agents WHERE user_id = ?')
    .bind(agentId)
    .first();
}

const HUNTABLE = `
  v.vin IS NOT NULL AND v.custody_since IS NULL
  AND EXISTS (SELECT 1 FROM cases c WHERE c.vehicle_id = v.id AND c.status = 'active')`;

async function currentPayoutRule(db: D1Database, at: number): Promise<PayoutRule | null> {
  const row = await db
    .prepare(
      'SELECT rule FROM payout_rules WHERE valid_from <= ? ORDER BY valid_from DESC, created_at DESC LIMIT 1',
    )
    .bind(at)
    .first<{ rule: string }>();
  return row ? (JSON.parse(row.rule) as PayoutRule) : null;
}

export interface Hunt {
  vehicle_id: string;
  plate: string;
  make: string;
  model: string;
  year: number | null;
  colour: string | null;
  /** Where to look, at district level only until the vehicle is claimed. */
  areas: { district: string; city: string }[];
  /** What the agent earns if the vehicle reaches custody. */
  earn_kurus: number;
}

/** Open hunts for an agent, optionally in one city. Claimed vehicles and cooldowns are left out. */
export async function listHunts(
  db: D1Database,
  agentId: string,
  query: { city?: string; limit?: number },
  at: number,
): Promise<Result<Hunt[]>> {
  const agent = await agentOf(db, agentId);
  if (agent?.status !== 'active') return fail('agent_not_active');
  const rule = await currentPayoutRule(db, at);
  if (!rule) return fail('no_payout_rule');
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  const { results } = await db
    .prepare(
      `SELECT v.id, p.plate, v.make, v.model, v.year, v.colour,
         (SELECT max(fee_kurus) FROM cases c WHERE c.vehicle_id = v.id AND c.status = 'active') AS fee,
         (SELECT json_group_array(DISTINCT json_object('district', cp.district, 'city', cp.city))
            FROM case_places cp JOIN cases c ON c.id = cp.case_id
            WHERE c.vehicle_id = v.id AND c.status = 'active') AS areas
       FROM vehicles v
       JOIN vehicle_plates p ON p.vehicle_id = v.id AND p.valid_to IS NULL
       WHERE ${HUNTABLE}
         AND NOT EXISTS (SELECT 1 FROM claims cl WHERE cl.vehicle_id = v.id AND cl.closed_at IS NULL AND cl.expires_at > ?)
         AND NOT EXISTS (SELECT 1 FROM cooldowns cd WHERE cd.vehicle_id = v.id AND cd.agent_id = ? AND cd.until > ?)
         AND (? IS NULL OR EXISTS (
           SELECT 1 FROM case_places cp JOIN cases c ON c.id = cp.case_id
           WHERE c.vehicle_id = v.id AND c.status = 'active' AND cp.city = ?))
       ORDER BY fee DESC, v.id LIMIT ?`,
    )
    .bind(at, agentId, at, query.city ?? null, query.city ?? null, limit)
    .all<{
      id: string;
      plate: string;
      make: string;
      model: string;
      year: number | null;
      colour: string | null;
      fee: number;
      areas: string;
    }>();
  return ok(
    results.map((row) => ({
      vehicle_id: row.id,
      plate: row.plate,
      make: row.make,
      model: row.model,
      year: row.year,
      colour: row.colour,
      areas: JSON.parse(row.areas) as { district: string; city: string }[],
      earn_kurus: payoutFor(rule, row.fee),
    })),
  );
}

export interface Claim {
  id: string;
  vehicle_id: string;
  state: 'searching' | 'reporting';
  claimed_at: number;
  expires_at: number;
}

/** Cron, and before every claim: ends claims whose time is up and starts their cooldowns. */
export async function expireClaims(db: D1Database, at: number): Promise<number> {
  const settings = await readSettings(db);
  const { results } = await db
    .prepare(
      'SELECT id, agent_id, vehicle_id FROM claims WHERE closed_at IS NULL AND expires_at <= ? LIMIT 500',
    )
    .bind(at)
    .all<{ id: string; agent_id: string; vehicle_id: string }>();
  if (results.length === 0) return 0;
  await db.batch(
    results.flatMap((claim) => [
      db
        .prepare(
          `UPDATE claims SET closed_at = expires_at, close_reason = 'expired'
           WHERE id = ? AND closed_at IS NULL`,
        )
        .bind(claim.id),
      cooldownStatement(db, claim.agent_id, claim.vehicle_id, at + settings.cooldown_hours * HOUR),
      auditStatement(db, at, 'system', 'claim.expired', `claim:${claim.id}`),
    ]),
  );
  await orphanReviewsStatement(db, at).run();
  return results.length;
}

export function cooldownStatement(
  db: D1Database,
  agentId: string,
  vehicleId: string,
  until: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO cooldowns (agent_id, vehicle_id, until) VALUES (?, ?, ?)
       ON CONFLICT (agent_id, vehicle_id) DO UPDATE SET until = max(until, excluded.until)`,
    )
    .bind(agentId, vehicleId, until);
}

export async function claimVehicle(
  db: D1Database,
  agentId: string,
  vehicleId: string,
  at: number,
): Promise<Result<Claim>> {
  const agent = await agentOf(db, agentId);
  if (agent?.status !== 'active') return fail('agent_not_active');
  await expireClaims(db, at);
  const settings = await readSettings(db);

  const huntable = await db
    .prepare(`SELECT 1 AS yes FROM vehicles v WHERE v.id = ? AND ${HUNTABLE}`)
    .bind(vehicleId)
    .first();
  if (!huntable) return fail('not_huntable');
  const cooldown = await db
    .prepare('SELECT until FROM cooldowns WHERE agent_id = ? AND vehicle_id = ? AND until > ?')
    .bind(agentId, vehicleId, at)
    .first<{ until: number }>();
  if (cooldown) return fail('cooldown', String(cooldown.until));
  const open = await db
    .prepare('SELECT count(*) AS n FROM claims WHERE agent_id = ? AND closed_at IS NULL')
    .bind(agentId)
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= (agent.max_active_claims ?? settings.max_active_claims)) {
    return fail('too_many_claims');
  }

  const claim: Claim = {
    id: newId(),
    vehicle_id: vehicleId,
    state: 'searching',
    claimed_at: at,
    expires_at: at + settings.claim_hours * HOUR,
  };
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO claims (id, vehicle_id, agent_id, state, claimed_at, expires_at)
           VALUES (?, ?, ?, 'searching', ?, ?)`,
        )
        .bind(claim.id, vehicleId, agentId, at, claim.expires_at),
      auditStatement(db, at, `agent:${agentId}`, 'claim.created', `claim:${claim.id}`, {
        vehicle: vehicleId,
      }),
    ]);
  } catch (error) {
    // Another agent claimed it a moment ago (claims_open_per_vehicle).
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
      return fail('already_claimed');
    }
    throw error;
  }
  return ok(claim);
}

/** The agent gives a claim up. Cooldown as for an expiry, so releasing can't reset the clock. */
export async function releaseClaim(
  db: D1Database,
  agentId: string,
  claimId: string,
  at: number,
): Promise<Result<null>> {
  const claim = await openClaim(db, agentId, claimId, at);
  if (!claim) return fail('not_found');
  const settings = await readSettings(db);
  await db.batch([
    db
      .prepare(`UPDATE claims SET closed_at = ?, close_reason = 'released' WHERE id = ?`)
      .bind(at, claimId),
    cooldownStatement(db, agentId, claim.vehicle_id, at + settings.cooldown_hours * HOUR),
    auditStatement(db, at, `agent:${agentId}`, 'claim.released', `claim:${claimId}`),
  ]);
  return ok(null);
}

async function openClaim(
  db: D1Database,
  agentId: string,
  claimId: string,
  at: number,
): Promise<(Claim & { agent_id: string }) | null> {
  return db
    .prepare(
      `SELECT id, vehicle_id, agent_id, state, claimed_at, expires_at FROM claims
       WHERE id = ? AND agent_id = ? AND closed_at IS NULL AND expires_at > ?`,
    )
    .bind(claimId, agentId, at)
    .first();
}

export interface ClaimDetails {
  claim: Claim;
  plate: string;
  make: string;
  model: string;
  year: number | null;
  colour: string | null;
  places: {
    kind: string;
    address: string;
    district: string;
    city: string;
    lat: number | null;
    lng: number | null;
    note: string | null;
    attributes: Record<string, unknown>;
  }[];
}

/**
 * Street-level places, only to the agent holding the claim and only while it lasts. Every read is
 * logged: these are debtors' addresses.
 */
export async function claimDetails(
  db: D1Database,
  agentId: string,
  claimId: string,
  at: number,
): Promise<Result<ClaimDetails>> {
  const claim = await openClaim(db, agentId, claimId, at);
  if (!claim) return fail('not_found');
  const vehicle = await db
    .prepare(
      `SELECT p.plate, v.make, v.model, v.year, v.colour FROM vehicles v
       JOIN vehicle_plates p ON p.vehicle_id = v.id AND p.valid_to IS NULL WHERE v.id = ?`,
    )
    .bind(claim.vehicle_id)
    .first<{
      plate: string;
      make: string;
      model: string;
      year: number | null;
      colour: string | null;
    }>();
  if (!vehicle) return fail('not_found');
  const { results } = await db
    .prepare(
      `SELECT cp.kind, cp.address, cp.district, cp.city, cp.lat, cp.lng, cp.note, cp.attributes,
         c.partner_id
       FROM case_places cp JOIN cases c ON c.id = cp.case_id
       WHERE c.vehicle_id = ? AND c.status = 'active' ORDER BY c.created_at, cp.rowid`,
    )
    .bind(claim.vehicle_id)
    .all<{
      kind: string;
      address: string;
      district: string;
      city: string;
      lat: number | null;
      lng: number | null;
      note: string | null;
      attributes: string;
      partner_id: string;
    }>();
  const fieldCache = new Map<string, Awaited<ReturnType<typeof fieldsFor>>>();
  const places: ClaimDetails['places'] = [];
  const seen = new Set<string>();
  for (const row of results) {
    // Two creditors often know the same address; the agent needs it once.
    const key = `${row.address}|${row.district}|${row.city}`.toLocaleLowerCase('tr-TR');
    if (seen.has(key)) continue;
    seen.add(key);
    let fields = fieldCache.get(row.partner_id);
    if (!fields) {
      fields = await fieldsFor(db, row.partner_id, 'place');
      fieldCache.set(row.partner_id, fields);
    }
    places.push({
      kind: row.kind,
      address: row.address,
      district: row.district,
      city: row.city,
      lat: row.lat,
      lng: row.lng,
      note: row.note,
      attributes: visibleAttributes(
        fields,
        JSON.parse(row.attributes) as Record<string, unknown>,
        'agent',
      ),
    });
  }
  await auditStatement(db, at, `agent:${agentId}`, 'claim.places_viewed', `claim:${claimId}`).run();
  return ok({
    claim: {
      id: claim.id,
      vehicle_id: claim.vehicle_id,
      state: claim.state,
      claimed_at: claim.claimed_at,
      expires_at: claim.expires_at,
    },
    ...vehicle,
    places,
  });
}

/**
 * The agent has seen the vehicle and is calling the police. The claim switches to reporting, with
 * its own time limit, so it doesn't run out while the tow truck is on its way.
 */
export async function recordSighting(
  db: D1Database,
  agentId: string,
  claimId: string,
  sighting: { lat: number; lng: number; accuracy_m?: number; taken_at: number },
  at: number,
): Promise<Result<Claim>> {
  const claim = await openClaim(db, agentId, claimId, at);
  if (!claim) return fail('not_found');
  // Values arrive over RPC from a phone: NaN passes a plain range check.
  if (
    !Number.isFinite(sighting.lat) ||
    !Number.isFinite(sighting.lng) ||
    Math.abs(sighting.lat) > 90 ||
    Math.abs(sighting.lng) > 180
  ) {
    return fail('invalid_location');
  }
  if (!Number.isFinite(sighting.taken_at)) return fail('invalid_time');
  const accuracy =
    sighting.accuracy_m !== undefined &&
    Number.isFinite(sighting.accuracy_m) &&
    sighting.accuracy_m >= 0
      ? Math.min(sighting.accuracy_m, 100_000)
      : null;
  // A device clock more than ten minutes off, or a time before the claim, isn't believable.
  if (sighting.taken_at > at + 600 || sighting.taken_at < claim.claimed_at - 600) {
    return fail('invalid_time');
  }
  const settings = await readSettings(db);
  const expiresAt = Math.max(claim.expires_at, at + settings.reporting_hours * HOUR);
  await db.batch([
    db
      .prepare(
        `INSERT INTO sightings (id, claim_id, lat, lng, accuracy_m, taken_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newId(),
        claimId,
        sighting.lat,
        sighting.lng,
        accuracy,
        Math.floor(sighting.taken_at),
        at,
      ),
    db
      .prepare(`UPDATE claims SET state = 'reporting', expires_at = ? WHERE id = ?`)
      .bind(expiresAt, claimId),
    auditStatement(db, at, `agent:${agentId}`, 'claim.sighting', `claim:${claimId}`),
  ]);
  return ok({ ...claim, state: 'reporting', expires_at: expiresAt });
}

export type EvidenceKind =
  'scene' | 'police_report' | 'tow_report' | 'yediemin_receipt' | 'yediemin_vehicle';
const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  'scene',
  'police_report',
  'tow_report',
  'yediemin_receipt',
  'yediemin_vehicle',
];
/** Photos one claim can hold: far more than a delivery needs, far fewer than would fill storage. */
export const MAX_EVIDENCE_PER_CLAIM = 40;
const finiteOrNull = (value: number | undefined, limit: number): number | null =>
  value !== undefined && Number.isFinite(value) && Math.abs(value) <= limit ? value : null;

/** A photo the agent took in the app. The same file can't be used twice, on any claim. */
export async function addEvidence(
  db: D1Database,
  agentId: string,
  claimId: string,
  evidence: {
    kind: EvidenceKind;
    file_ref: string;
    sha256: string;
    exif_time?: number;
    exif_lat?: number;
    exif_lng?: number;
  },
  at: number,
): Promise<Result<{ id: string }>> {
  const claim = await openClaim(db, agentId, claimId, at);
  if (!claim) return fail('not_found');
  if (claim.state !== 'reporting') return fail('no_sighting');
  if (!EVIDENCE_KINDS.includes(evidence.kind)) return fail('invalid_kind');
  if (typeof evidence.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(evidence.sha256)) {
    return fail('invalid_hash');
  }
  if (
    typeof evidence.file_ref !== 'string' ||
    !evidence.file_ref ||
    evidence.file_ref.length > 300
  ) {
    return fail('invalid_file');
  }
  const held = await db
    .prepare('SELECT count(*) AS n FROM evidence WHERE claim_id = ?')
    .bind(claimId)
    .first<{ n: number }>();
  if ((held?.n ?? 0) >= MAX_EVIDENCE_PER_CLAIM) return fail('too_much_evidence');
  const id = newId();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO evidence (id, claim_id, kind, file_ref, sha256, exif_time, exif_lat, exif_lng, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          claimId,
          evidence.kind,
          evidence.file_ref,
          evidence.sha256,
          finiteOrNull(evidence.exif_time, 1e11),
          finiteOrNull(evidence.exif_lat, 90),
          finiteOrNull(evidence.exif_lng, 180),
          at,
        ),
      auditStatement(db, at, `agent:${agentId}`, 'evidence.added', `claim:${claimId}`, {
        kind: evidence.kind,
      }),
    ]);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
      return fail('duplicate_photo');
    }
    throw error;
  }
  // Once the custody receipt is in, the claim waits for staff, however long that takes.
  if (evidence.kind === 'yediemin_receipt') {
    await db
      .prepare(
        `INSERT INTO review_items (id, kind, subject_id, created_at)
         SELECT ?, 'delivery', ?, ? WHERE NOT EXISTS (
           SELECT 1 FROM review_items WHERE kind = 'delivery' AND subject_id = ? AND status = 'open')`,
      )
      .bind(newId(), claimId, at, claimId)
      .run();
    await db
      .prepare('UPDATE claims SET expires_at = ? WHERE id = ?')
      .bind(at + 30 * 24 * HOUR, claimId)
      .run();
  }
  return ok({ id });
}
