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
import { deleteOrganization, deleteUser, exportUser } from './account-events';
import {
  agentProfile,
  earnings,
  myClaims,
  submitApplication,
  updateProfile,
  type ProfileInput,
} from './agents';
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
import {
  deprecateField,
  listAgents,
  verifyAgentIban,
  listInvoices,
  listPartners,
  listPayouts,
  partnerDetail,
  resolveIdentity,
  reviewDetail,
  uninvoiced,
  updatePartner,
} from './control';
import { mailer, type Send } from './mail';
import {
  addDocument,
  approve,
  cancel,
  claim,
  contractFor,
  invitationByToken,
  invite,
  linkOrganization,
  listOnboardings,
  mine,
  onboardingForStaff,
  onboardingForUser,
  reject,
  remindAndExpire,
  reopen,
  resend,
  saveDetails,
  sign,
  type DocumentKind,
  type Invitation,
  type OnboardingStatus,
  type Origins,
} from './onboarding';
import { checkPayoutRule } from './pricing';
import { providerForStaff, setProvider } from './provider';
import { fail, now, ok, type Result } from './result';
import { SETTING_DEFAULTS, readSettings, writeSetting, type SettingKey } from './settings';

async function activePartner(db: D1Database, orgId: string): Promise<Result<Partner>> {
  const partner = await partnerByOrg(db, orgId);
  if (!partner) return fail('not_a_partner');
  if (partner.status !== 'active') return fail('partner_not_active');
  return ok(partner);
}

/** For emanet-partners. `orgId` is the login organization the signed-in person acts for. */
function origins(env: Env): Origins {
  return { kurumsal: env.KURUMSAL_ORIGIN, merkez: env.MERKEZ_ORIGIN, staffEmail: env.STAFF_EMAIL };
}

export class PartnerApi extends WorkerEntrypoint<Env> {
  /** Tests replace this; everything else sends through the MAILER binding. */
  protected send: Send = mailer(this.env);

  // ---- Onboarding: the invited company, before it is a partner (docs/DESIGN.md §5) ----

  async onboardingInvitation(token: string) {
    return invitationByToken(this.env.DB, token, now());
  }

  async claimOnboarding(token: string, userId: string) {
    return claim(this.env.DB, token, userId, now());
  }

  async myOnboardings(userId: string) {
    return mine(this.env.DB, userId);
  }

  async onboarding(onboardingId: string, userId: string) {
    return onboardingForUser(this.env.DB, onboardingId, userId, now());
  }

  async linkOnboardingOrganization(onboardingId: string, userId: string, orgId: string) {
    return linkOrganization(this.env.DB, onboardingId, userId, orgId, now());
  }

  async saveOnboardingDetails(
    onboardingId: string,
    userId: string,
    details: Record<string, unknown>,
  ) {
    return saveDetails(this.env.DB, onboardingId, userId, details, now());
  }

  async addOnboardingDocument(
    onboardingId: string,
    userId: string,
    document: {
      kind: DocumentKind;
      file_ref: string;
      sha256: string;
      file_name: string;
      content_type: string;
      size: number;
    },
  ) {
    return addDocument(this.env.DB, onboardingId, userId, document, now());
  }

  async onboardingContract(onboardingId: string, userId: string) {
    return contractFor(this.env.DB, onboardingId, userId, now());
  }

  async signOnboarding(
    onboardingId: string,
    userId: string,
    input: {
      version: string;
      sha256: string;
      name: string;
      title: string;
      ip: string | null;
      authorised: boolean;
    },
  ) {
    return sign(this.env.DB, this.send, origins(this.env), onboardingId, userId, input, now());
  }

  // ---- Partners ----

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

  /** How many of the partner's cases are in each status. */
  async counts(orgId: string) {
    const partner = await partnerByOrg(this.env.DB, orgId);
    if (!partner) return fail('not_a_partner');
    const { results } = await this.env.DB.prepare(
      'SELECT status, count(*) AS n FROM cases WHERE partner_id = ? GROUP BY status',
    )
      .bind(partner.id)
      .all<{ status: CaseStatus; n: number }>();
    const counts: Record<CaseStatus, number> = {
      pending_identity: 0,
      active: 0,
      delivered: 0,
      withdrawn: 0,
      expired: 0,
    };
    for (const row of results) counts[row.status] = row.n;
    return ok(counts);
  }

  /** The partner's fields (global and its own), for forms, CSV templates and the API schema. */
  async schema(orgId: string, entity: FieldEntity) {
    const partner = await partnerByOrg(this.env.DB, orgId);
    if (!partner) return fail('not_a_partner');
    const fields = await fieldsFor(this.env.DB, partner.id, entity);
    return ok(fields.filter((field) => field.visibility !== 'admin'));
  }

  /**
   * Events after a cursor, oldest first, for polling and for the webhook sender. The cursor is
   * "<created_at>.<id>" of the last event seen; events written in the same second are not skipped.
   */
  async events(orgId: string, cursor: string | null, limit = 100) {
    const partner = await partnerByOrg(this.env.DB, orgId);
    if (!partner) return fail('not_a_partner');
    let afterAt = 0;
    let afterId = '';
    if (cursor !== null) {
      const match = /^(\d+)\.([0-9a-f-]{36})$/.exec(cursor);
      if (!match) return fail('invalid_cursor');
      afterAt = Number(match[1]);
      afterId = match[2] ?? '';
    }
    const { results } = await this.env.DB.prepare(
      `SELECT id, type, payload, created_at FROM outbox
       WHERE partner_id = ? AND (created_at > ? OR (created_at = ? AND id > ?))
       ORDER BY created_at, id LIMIT ?`,
    )
      .bind(partner.id, afterAt, afterAt, afterId, Math.min(Math.max(limit, 1), 500))
      .all<{ id: string; type: string; payload: string; created_at: number }>();
    const last = results.at(-1);
    return ok({
      events: results.map((row) => ({
        id: row.id,
        type: row.type,
        data: JSON.parse(row.payload) as Record<string, unknown>,
        created_at: row.created_at,
      })),
      next_cursor: last ? `${String(last.created_at)}.${last.id}` : cursor,
    });
  }
}

/** For emanet-field. `agentId` is the signed-in person's 2earl user ID. */
export class FieldApi extends WorkerEntrypoint<Env> {
  async register(agentId: string) {
    return registerAgent(this.env.DB, agentId, now());
  }

  async profile(agentId: string) {
    return agentProfile(this.env.DB, agentId);
  }

  async updateProfile(agentId: string, input: ProfileInput) {
    return updateProfile(this.env.DB, agentId, input, now());
  }

  async submit(agentId: string, termsVersion: string) {
    return submitApplication(this.env.DB, agentId, termsVersion, now());
  }

  async myClaims(agentId: string) {
    return myClaims(this.env.DB, agentId, now());
  }

  async earnings(agentId: string) {
    return earnings(this.env.DB, agentId);
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
  protected send: Send = mailer(this.env);

  // ---- Onboarding (docs/DESIGN.md §5) ----

  /** 2earl's own company details, as the agreement names it. */
  async provider() {
    return providerForStaff(this.env.DB);
  }

  async setProvider(staffId: string, input: Record<string, unknown>) {
    return setProvider(this.env.DB, staffId, input, now());
  }

  async inviteCompany(staffId: string, input: Invitation) {
    return invite(this.env.DB, this.send, origins(this.env), staffId, input, now());
  }

  async onboardings(status: OnboardingStatus | null = null) {
    return listOnboardings(this.env.DB, status);
  }

  async onboarding(onboardingId: string) {
    return onboardingForStaff(this.env.DB, onboardingId);
  }

  async resendInvitation(staffId: string, onboardingId: string) {
    return resend(this.env.DB, this.send, origins(this.env), staffId, onboardingId, now());
  }

  async cancelOnboarding(staffId: string, onboardingId: string, reason: string) {
    return cancel(this.env.DB, staffId, onboardingId, reason, now());
  }

  async approveOnboarding(staffId: string, onboardingId: string) {
    return approve(this.env.DB, this.send, origins(this.env), staffId, onboardingId, now());
  }

  async returnOnboarding(staffId: string, onboardingId: string, reason: string) {
    return reopen(this.env.DB, this.send, origins(this.env), staffId, onboardingId, reason, now());
  }

  async rejectOnboarding(staffId: string, onboardingId: string, reason: string) {
    return reject(this.env.DB, this.send, staffId, onboardingId, reason, now());
  }

  // ---- Partners ----

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

  async partners() {
    return ok(await listPartners(this.env.DB));
  }

  async partner(partnerId: string) {
    return partnerDetail(this.env.DB, partnerId, now());
  }

  async updatePartner(
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
  ) {
    return updatePartner(this.env.DB, staffId, partnerId, input, now());
  }

  async deprecateField(staffId: string, fieldId: string) {
    return deprecateField(this.env.DB, staffId, fieldId, now());
  }

  async verifyIban(staffId: string, agentId: string, iban: string) {
    return verifyAgentIban(this.env.DB, staffId, agentId, iban, now());
  }

  async agents(status: string | null = null) {
    return ok(await listAgents(this.env.DB, status));
  }

  async payouts(status: string | null = null) {
    return ok(await listPayouts(this.env.DB, status));
  }

  async invoices(partnerId: string | null = null) {
    return ok(await listInvoices(this.env.DB, partnerId));
  }

  async uninvoiced() {
    return ok(await uninvoiced(this.env.DB));
  }

  async review(reviewId: string) {
    return reviewDetail(this.env.DB, reviewId);
  }

  async resolveIdentity(
    staffId: string,
    reviewId: string,
    decision: { action: 'accept'; vin?: string } | { action: 'reject'; reason: string },
  ) {
    return resolveIdentity(this.env.DB, staffId, reviewId, decision, now());
  }

  async payoutRule() {
    const row = await this.env.DB.prepare(
      'SELECT rule, valid_from FROM payout_rules WHERE valid_from <= ? ORDER BY valid_from DESC, created_at DESC LIMIT 1',
    )
      .bind(now())
      .first<{ rule: string; valid_from: number }>();
    return ok(row ? { rule: JSON.parse(row.rule) as unknown, valid_from: row.valid_from } : null);
  }
}

/** For login: account and organization deletion, and "Download your data". */
export class AccountEvents extends WorkerEntrypoint<Env> {
  async deleteUser(userId: string): Promise<void> {
    await deleteUser(this.env.DB, userId, now());
  }

  async exportUser(userId: string): Promise<Record<string, unknown>> {
    return exportUser(this.env.DB, userId);
  }

  async deleteOrganization(orgId: string): Promise<void> {
    await deleteOrganization(this.env.DB, orgId, now());
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
        await remindAndExpire(env.DB, mailer(env), origins(env), at);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
