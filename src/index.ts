/**
 * Emanet core. No public address: each Emanet app binds to the one entrypoint it needs, so an app
 * can only do what its users may do (docs/DESIGN.md §3).
 *
 * - PartnerApi  ← emanet-partners (creditors): their cases, schema and events
 * - FieldApi    ← emanet-field (agents): hunts, claims, sightings, evidence
 * - ControlApi  ← emanet-control (2earl staff): partners, settings, review, money
 *
 * The apps authenticate people with login.2earl.com and pass who is acting. The core checks what
 * that person may do here: partner status, agent status, claim ownership, approvals.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  confirmCases,
  createPartner,
  expireCases,
  getCase,
  listCases,
  partnerByOrg,
  setPartnerStatus,
  setPriceList,
  upsertCase,
  withdrawCase,
  type CaseInput,
  type CaseStatus,
  type NewPartner,
  type Partner,
} from './cases';
import {
  addEvidence,
  claimDetails,
  claimVehicle,
  expireClaims,
  listHunts,
  recordSighting,
  registerAgent,
  releaseClaim,
  setAgentStatus,
  type AgentStatus,
  type EvidenceKind,
} from './claims';
import {
  checkDefinition,
  fieldsFor,
  insertDefinition,
  type FieldEntity,
  type NewField,
} from './fields';
import {
  confirmDelivery,
  issueInvoice,
  markPayoutSent,
  orderPayout,
  recordReceipt,
  setPayoutRule,
  trialBalance,
} from './ledger';
import { checkPayoutRule } from './pricing';
import { fail, now, ok, type Result } from './result';
import { SETTING_DEFAULTS, readSettings, writeSetting, type SettingKey } from './settings';

async function activePartner(db: D1Database, orgId: string): Promise<Result<Partner>> {
  const partner = await partnerByOrg(db, orgId);
  if (!partner) return fail('not_a_partner');
  if (partner.status !== 'active') return fail('partner_not_active');
  return ok(partner);
}

/** For emanet-partners. `orgId` is the login organization the signed-in person acts for. */
export class PartnerApi extends WorkerEntrypoint<Env> {
  async partner(orgId: string) {
    const partner = await partnerByOrg(this.env.DB, orgId);
    return partner ? ok(partner) : fail('not_a_partner');
  }

  async upsertCase(orgId: string, actor: string, input: CaseInput) {
    const partner = await activePartner(this.env.DB, orgId);
    if (!partner.ok) return partner;
    return upsertCase(
      this.env.DB,
      partner.value,
      input,
      `partner:${partner.value.id}/${actor}`,
      now(),
    );
  }

  async getCase(orgId: string, caseId: string) {
    const partner = await partnerByOrg(this.env.DB, orgId);
    if (!partner) return fail('not_a_partner');
    return getCase(this.env.DB, partner.id, caseId);
  }

  async listCases(
    orgId: string,
    query: { status?: CaseStatus; updatedSince?: number; cursor?: string; limit?: number },
  ) {
    const partner = await partnerByOrg(this.env.DB, orgId);
    if (!partner) return fail('not_a_partner');
    return listCases(this.env.DB, partner.id, query);
  }

  async confirmCases(orgId: string, actor: string, caseIds: string[]) {
    const partner = await activePartner(this.env.DB, orgId);
    if (!partner.ok) return partner;
    return confirmCases(
      this.env.DB,
      partner.value,
      caseIds,
      `partner:${partner.value.id}/${actor}`,
      now(),
    );
  }

  async withdrawCase(orgId: string, actor: string, caseId: string, reason: string) {
    const partner = await partnerByOrg(this.env.DB, orgId);
    if (!partner) return fail('not_a_partner');
    return withdrawCase(
      this.env.DB,
      partner,
      caseId,
      reason,
      `partner:${partner.id}/${actor}`,
      now(),
    );
  }

  /** The partner's fields (global and its own), for forms, CSV templates and the API schema. */
  async schema(orgId: string, entity: FieldEntity) {
    const partner = await partnerByOrg(this.env.DB, orgId);
    if (!partner) return fail('not_a_partner');
    const fields = await fieldsFor(this.env.DB, partner.id, entity);
    return ok(fields.filter((field) => field.visibility !== 'admin'));
  }

  /** Events since a time, for polling and for the webhook sender. */
  async events(orgId: string, since: number, limit = 100) {
    const partner = await partnerByOrg(this.env.DB, orgId);
    if (!partner) return fail('not_a_partner');
    const { results } = await this.env.DB.prepare(
      `SELECT id, type, payload, created_at FROM outbox
       WHERE partner_id = ? AND created_at > ? ORDER BY created_at, id LIMIT ?`,
    )
      .bind(partner.id, since, Math.min(Math.max(limit, 1), 500))
      .all<{ id: string; type: string; payload: string; created_at: number }>();
    return ok(
      results.map((row) => ({
        id: row.id,
        type: row.type,
        data: JSON.parse(row.payload) as Record<string, unknown>,
        created_at: row.created_at,
      })),
    );
  }
}

/** For emanet-field. `agentId` is the signed-in person's 2earl user ID. */
export class FieldApi extends WorkerEntrypoint<Env> {
  async register(agentId: string) {
    return registerAgent(this.env.DB, agentId, now());
  }

  async hunts(agentId: string, query: { city?: string; limit?: number }) {
    return listHunts(this.env.DB, agentId, query, now());
  }

  async claim(agentId: string, vehicleId: string) {
    return claimVehicle(this.env.DB, agentId, vehicleId, now());
  }

  async release(agentId: string, claimId: string) {
    return releaseClaim(this.env.DB, agentId, claimId, now());
  }

  async claimDetails(agentId: string, claimId: string) {
    return claimDetails(this.env.DB, agentId, claimId, now());
  }

  async sighting(
    agentId: string,
    claimId: string,
    sighting: { lat: number; lng: number; accuracy_m?: number; taken_at: number },
  ) {
    return recordSighting(this.env.DB, agentId, claimId, sighting, now());
  }

  async evidence(
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
  ) {
    return addEvidence(this.env.DB, agentId, claimId, evidence, now());
  }
}

/** For emanet-control. `staffId` is a login staff member; the app has checked the role. */
export class ControlApi extends WorkerEntrypoint<Env> {
  async createPartner(staffId: string, input: NewPartner) {
    return createPartner(this.env.DB, input, staffId, now());
  }

  async setPartnerStatus(staffId: string, partnerId: string, status: Partner['status']) {
    return setPartnerStatus(this.env.DB, partnerId, status, staffId, now());
  }

  async setPriceList(staffId: string, partnerId: string, list: unknown, validFrom?: number) {
    const at = now();
    return setPriceList(this.env.DB, partnerId, list, `staff:${staffId}`, validFrom ?? at, at);
  }

  async defineField(staffId: string, field: NewField) {
    const checked = checkDefinition(field);
    if (!checked.ok) return checked;
    try {
      await insertDefinition(this.env.DB, checked.value, now()).run();
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
        return fail('field_exists');
      }
      throw error;
    }
    return ok(null);
  }

  async settings() {
    return ok(await readSettings(this.env.DB));
  }

  async setSetting(staffId: string, key: SettingKey, value: number) {
    if (!(key in SETTING_DEFAULTS) || !Number.isFinite(value) || value < 0) {
      return fail('invalid_setting');
    }
    await writeSetting(this.env.DB, key, value, staffId, now()).run();
    return ok(null);
  }

  async setAgentStatus(staffId: string, agentId: string, status: AgentStatus, reason: string) {
    return setAgentStatus(this.env.DB, agentId, status, staffId, reason, now());
  }

  async setPayoutRule(staffId: string, rule: unknown, validFrom?: number) {
    const checked = checkPayoutRule(rule);
    if (!checked.ok) return checked;
    const at = now();
    return setPayoutRule(this.env.DB, checked.value, staffId, validFrom ?? at, at);
  }

  async reviewQueue(limit = 100) {
    const { results } = await this.env.DB.prepare(
      `SELECT id, kind, subject_id, detail, created_at FROM review_items
       WHERE status = 'open' ORDER BY created_at LIMIT ?`,
    )
      .bind(Math.min(Math.max(limit, 1), 500))
      .all();
    return ok(results);
  }

  async confirmDelivery(staffId: string, claimId: string) {
    return confirmDelivery(this.env.DB, staffId, claimId, now());
  }

  async issueInvoice(staffId: string, partnerId: string) {
    return issueInvoice(this.env.DB, staffId, partnerId, now());
  }

  async recordReceipt(
    staffId: string,
    receipt: {
      partnerId: string;
      invoiceId?: string;
      amountKurus: number;
      valueDate: string;
      bankRef: string;
      source: 'manual' | 'statement' | 'bank_api';
    },
  ) {
    return recordReceipt(this.env.DB, staffId, receipt, now());
  }

  async orderPayout(staffId: string, payoutId: string) {
    return orderPayout(this.env.DB, staffId, payoutId, now());
  }

  async markPayoutSent(staffId: string, payoutId: string, bankRef: string) {
    return markPayoutSent(this.env.DB, staffId, payoutId, bankRef, now());
  }

  async trialBalance() {
    return ok(await trialBalance(this.env.DB));
  }
}

export default {
  // Nothing is served on the Internet; a request that reaches the Worker another way gets nothing.
  fetch(): Response {
    return new Response(null, { status: 404 });
  },

  scheduled(_controller, env, ctx): void {
    const at = now();
    ctx.waitUntil(
      (async () => {
        await expireClaims(env.DB, at);
        await expireCases(env.DB, at);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
