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
import { auditStatement } from './audit';
import { deleteOrganization, deleteUser, exportUser } from './account-events';
import {
  answeredRequests,
  answerRequest,
  askAgain,
  askAgent,
  pendingRequests,
  remindRequests,
  requestsOf,
  settleRequest,
  type Ask,
} from './agent-requests';
import {
  archiveFileStored,
  archiveHasFile,
  archiveViews,
  eraseAgent,
  erasureBlockers,
  listArchives,
  myErasure,
  openArchive,
  openArchiveFile,
  purgeArchives,
  refuseErasure,
  requestErasure,
  sealArchiveFile,
  withdrawErasure,
} from './erasure';
import { listHolds, placeHold, releaseHold } from './holds';
import { retentionOverview } from './retention';
import {
  assignTicket,
  closeAsRequester,
  myTicket,
  myTickets,
  openTicket,
  purgeSupport,
  replyAsRequester,
  requesterContact,
  setTicketStatus,
  staffReply,
  staffTicket,
  staffTickets,
  type RequesterKind,
  type TicketStatus,
} from './support';
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
  expireCases,
  getCase,
  redactClosedCasePlaces,
  listCases,
  partnerByOrg,
  setPartnerStatus,
  setPriceList,
  upsertCase,
  withdrawCase,
  type CaseInput,
  type CaseStatus,
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
  returnApplication,
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
  rejectDelivery,
  setInvoiceNumber,
  markPayoutSent,
  orderPayout,
  recordReceipt,
  setPayoutRule,
  trialBalance,
} from './ledger';
import {
  auditLog,
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
import {
  confirmEmailCode,
  kycChecks,
  kycStatement,
  nviRegistry,
  noRegistry,
  requestEmailCode,
} from './kyc';
import {
  agentMail,
  mailer,
  supportReplyMail,
  supportStaffMail,
  webhookDisabledMail,
  type MailLocale,
  type Send,
} from './mail';
import {
  alertOps,
  heartbeat,
  opsOverview,
  queues,
  recordOps,
  watchServiceLevels,
  type OpsSource,
} from './ops';
import {
  closeRequest,
  archiveFilesDue,
  eraseDocument,
  eraseEvidence,
  filesDue,
  filesErased,
  inventory,
  listRequests,
  openRequest,
  redactCasePlaces,
  scheduleRetention,
} from './privacy';
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
import {
  caseDocument,
  caseDocuments,
  invoice as partnerInvoice,
  invoices as partnerInvoices,
  report,
  timeline,
} from './partner-views';
import { sendNotices } from './notices';
import { checkPayoutRule } from './pricing';
import { provider, providerForStaff, setProvider } from './provider';
import { fail, now, ok, type Result } from './result';
import {
  devModeStatus,
  readSettings,
  resetSetting,
  SETTINGS,
  settingAllowed,
  settingsInfo,
  writeSetting,
  type SettingKey,
} from './settings';
import { activationChecklist, approvalChecklist } from './activation';
import { checkUptime, targets as uptimeTargets } from './uptime';
import { archiveOpenedNotice, isDigestTime, lateRequestsNotice } from './staff-notices';
import { claimPlate, notifyAgent } from './agent-notices';
import { agreementBundle, type AgreementLocale } from './agent-agreement';
import { accountingMonth, accountingMonths, closeMonth } from './accounting';
import { readiness, signOff, withdrawSignoff } from './readiness';
import {
  addDocument as addAgentDocument,
  decideDocument,
  documentFile,
  documentsComplete,
  documentsOf,
  latestAcceptance,
  recordAcceptance,
  type Consents,
} from './vetting';

const INTEGRATION_ACTIONS: readonly string[] = [
  'key_created',
  'key_revoked',
  'webhook_created',
  'webhook_deleted',
  'webhook_enabled',
];

/** An app tells the core something failed: a route's pattern and an error's name, never data. */
async function reportOps(
  env: Env,
  source: OpsSource,
  event: string,
  detail: string,
): Promise<void> {
  await recordOps(env.DB, source, 'error', event, detail, now());
}

async function activePartner(db: D1Database, orgId: string): Promise<Result<Partner>> {
  const partner = await partnerByOrg(db, orgId);
  if (!partner) return fail('not_a_partner');
  if (partner.status !== 'active') return fail('partner_not_active');
  return ok(partner);
}

/** For emanet-partners. `orgId` is the login organization the signed-in person acts for. */
/** What staff confirm before a delivery is accepted (Merkez shows each with its explanation). */
export const DELIVERY_CHECKS = [
  'plate_matches',
  'custody_receipt',
  'place_plausible',
  'photos_original',
] as const;

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

  /** States and times of a case; never who on 2earl's side. */
  async caseTimeline(orgId: string, caseId: string) {
    const partner = await partnerByOrg(this.env.DB, orgId);
    if (!partner) return fail('not_a_partner');
    return timeline(this.env.DB, partner, caseId);
  }

  /** The custody documents of a delivered case. */
  async caseDocuments(orgId: string, caseId: string) {
    const partner = await partnerByOrg(this.env.DB, orgId);
    if (!partner) return fail('not_a_partner');
    return caseDocuments(this.env.DB, partner, caseId);
  }

  /** Where one of those documents is stored; the look is recorded. */
  async caseDocument(orgId: string, actor: string, caseId: string, documentId: string) {
    const partner = await partnerByOrg(this.env.DB, orgId);
    if (!partner) return fail('not_a_partner');
    return caseDocument(
      this.env.DB,
      partner,
      `partner:${partner.id}/${actor}`,
      caseId,
      documentId,
      now(),
    );
  }

  async invoices(orgId: string) {
    const partner = await partnerByOrg(this.env.DB, orgId);
    if (!partner) return fail('not_a_partner');
    return partnerInvoices(this.env.DB, partner);
  }

  // ---- Support desk (docs/DESIGN.md §20) ----

  async openTicket(
    orgId: string,
    userId: string,
    input: { subject: string; category: string; message: string },
  ) {
    const partner = await partnerByOrg(this.env.DB, orgId);
    if (!partner) return fail('not_a_partner');
    const result = await openTicket(this.env.DB, 'partner', partner.id, userId, input, now());
    if (result.ok) {
      await tellStaffOfTicket(
        this.env,
        this.send,
        result.value.id,
        'partner',
        true,
        input.category,
      );
    }
    return result;
  }

  async myTickets(orgId: string) {
    const partner = await partnerByOrg(this.env.DB, orgId);
    if (!partner) return fail('not_a_partner');
    return ok(await myTickets(this.env.DB, 'partner', partner.id));
  }

  async myTicket(orgId: string, ticketId: string) {
    const partner = await partnerByOrg(this.env.DB, orgId);
    if (!partner) return fail('not_a_partner');
    return myTicket(this.env.DB, 'partner', partner.id, ticketId);
  }

  async replyTicket(orgId: string, userId: string, ticketId: string, body: string) {
    const partner = await partnerByOrg(this.env.DB, orgId);
    if (!partner) return fail('not_a_partner');
    const result = await replyAsRequester(
      this.env.DB,
      'partner',
      partner.id,
      userId,
      ticketId,
      body,
      now(),
    );
    if (result.ok) await tellStaffOfTicket(this.env, this.send, ticketId, 'partner', false, '');
    return result;
  }

  async closeTicket(orgId: string, userId: string, ticketId: string) {
    const partner = await partnerByOrg(this.env.DB, orgId);
    if (!partner) return fail('not_a_partner');
    return closeAsRequester(this.env.DB, 'partner', partner.id, userId, ticketId, now());
  }

  async invoice(orgId: string, invoiceId: string) {
    const partner = await partnerByOrg(this.env.DB, orgId);
    if (!partner) return fail('not_a_partner');
    return partnerInvoice(this.env.DB, partner, invoiceId);
  }

  async report(orgId: string) {
    const partner = await partnerByOrg(this.env.DB, orgId);
    if (!partner) return fail('not_a_partner');
    return report(this.env.DB, partner, now());
  }

  async listCases(
    orgId: string,
    query: {
      status?: CaseStatus;
      updatedSince?: number;
      cursor?: string;
      limit?: number;
      search?: string;
      newest?: boolean;
    },
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

  /**
   * Emanet Kurumsal keeps API keys and webhooks itself; the core's audit log is where a change to
   * them is recorded, beside everything else done in the partner's name.
   */
  async recordIntegration(orgId: string, actor: string, action: string, what: string) {
    const partner = await partnerByOrg(this.env.DB, orgId);
    if (!partner) return fail('not_a_partner');
    if (!INTEGRATION_ACTIONS.includes(action)) return fail('invalid_action');
    await auditStatement(
      this.env.DB,
      now(),
      `partner:${partner.id}/${typeof actor === 'string' ? actor.slice(0, 64) : ''}`,
      `integration.${action}`,
      `partner:${partner.id}`,
      { what: typeof what === 'string' ? what.slice(0, 100) : '' },
    ).run();
    return ok(null);
  }

  async reportError(event: string, detail: string) {
    await reportOps(this.env, 'kurumsal', event, detail);
  }

  /**
   * A webhook was switched off after failing repeatedly: the company's operations contact is
   * told, in its language, and staff see it on the System page. Events keep being recorded and
   * stay readable from the API meanwhile.
   */
  async webhookDisabled(orgId: string, host: string) {
    const row = await this.env.DB.prepare(
      `SELECT p.legal_name, p.contact_email, o.locale FROM partners p
       LEFT JOIN onboardings o ON o.id = p.onboarding_id WHERE p.org_id = ?`,
    )
      .bind(orgId)
      .first<{ legal_name: string; contact_email: string | null; locale: MailLocale | null }>();
    if (!row) return fail('not_a_partner');
    const name = typeof host === 'string' ? host.replace(/[^A-Za-z0-9.-]/g, '').slice(0, 120) : '';
    await recordOps(this.env.DB, 'kurumsal', 'warn', 'webhook.disabled', name, now());
    if (!row.contact_email) return ok({ emailed: false });
    const emailed = await this.send(
      webhookDisabledMail(
        row.locale ?? 'tr',
        row.contact_email,
        row.legal_name,
        name,
        `${this.env.KURUMSAL_ORIGIN}/o/${orgId}/webhooks`,
      ),
    );
    return ok({ emailed });
  }

  /** How many of the partner's cases are in each status. */
  /** The limits staff set for integrations. */
  async limits() {
    const settings = await readSettings(this.env.DB);
    return ok({
      webhook_disable_after: settings.webhook_disable_after,
      max_webhooks: settings.max_webhooks,
    });
  }

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
  /** Tests replace this; everything else sends through the MAILER binding. */
  protected send: Send = mailer(this.env);

  async register(agentId: string) {
    return registerAgent(this.env.DB, agentId, now());
  }

  async profile(agentId: string) {
    return agentProfile(this.env.DB, agentId);
  }

  async updateProfile(agentId: string, input: ProfileInput) {
    const url: string = this.env.ID_REGISTRY_URL;
    return updateProfile(
      this.env.DB,
      agentId,
      input,
      now(),
      url === '' ? noRegistry : nviRegistry(url),
    );
  }

  /** Mails a code to the address the agent wants to prove is theirs. */
  async requestEmailCode(agentId: string, input: { email: string; locale: MailLocale }) {
    return requestEmailCode(this.env.DB, mailer(this.env), agentId, input, now());
  }

  async confirmEmailCode(agentId: string, code: string) {
    return confirmEmailCode(this.env.DB, agentId, code, now());
  }

  async reportError(event: string, detail: string) {
    await reportOps(this.env, 'saha', event, detail);
  }

  /** The agent agreement, the privacy notice and the consent text, with their version and digest. */
  async agreement(locale: AgreementLocale) {
    return ok(await agreementBundle(locale === 'en' ? 'en' : 'tr'));
  }

  /** What this agent accepted last, and whether it is the text in force. */
  async acceptance(agentId: string) {
    return ok(await latestAcceptance(this.env.DB, agentId));
  }

  async documents(agentId: string) {
    return ok(await documentsOf(this.env.DB, agentId));
  }

  /** A document already stored by Emanet Saha: one of the two every applicant gives, or one staff asked for. */
  async addDocument(
    agentId: string,
    input: {
      kind: string;
      file_ref: string;
      sha256: string;
      barcode?: string;
      request_id?: string;
    },
  ) {
    return addAgentDocument(this.env.DB, agentId, input, now());
  }

  // ---- What staff asked for (src/agent-requests.ts) ----

  async requests(agentId: string) {
    return ok(await requestsOf(this.env.DB, agentId));
  }

  /** The agent says a detail is corrected; a document request is answered by the upload. */
  async answerRequest(agentId: string, requestId: string, answer: string) {
    return answerRequest(this.env.DB, agentId, requestId, answer, now());
  }

  // ---- The agent's own data (src/erasure.ts) ----

  /** The agent's latest request to be erased, and what erasing would stop. */
  async erasure(agentId: string) {
    const [request, blockers, settings] = await Promise.all([
      myErasure(this.env.DB, agentId),
      erasureBlockers(this.env.DB, agentId),
      readSettings(this.env.DB),
    ]);
    return ok({
      request,
      blockers,
      answer_days: settings.privacy_request_days,
      archive_years: Math.max(1, Math.round(settings.erasure_archive_days / 365)),
    });
  }

  async requestErasure(agentId: string, note: string) {
    const result = await requestErasure(this.env.DB, agentId, note, now());
    if (result.ok) {
      await notifyAgent(this.env.DB, this.send, this.env.SAHA_ORIGIN, agentId, {
        kind: 'erasure_received',
        days: result.value.days,
      });
    }
    return result;
  }

  async withdrawErasure(agentId: string) {
    return withdrawErasure(this.env.DB, agentId, now());
  }

  /**
   * Sends the application. The applicant must have accepted the agreement, read the notice and
   * given the explicit consent, each on its own, and (while the setting is on) uploaded both
   * documents and given an address.
   */
  async submit(agentId: string, termsVersion: string, consents?: Consents, locale = 'tr') {
    const at = now();
    const settings = await readSettings(this.env.DB);
    const profile = await agentProfile(this.env.DB, agentId);
    if (!profile.ok) return profile;
    if (!consents || !consents.agreement || !consents.notice || !consents.consent) {
      return fail('consents_missing');
    }
    if (!profile.value.address) return fail('profile_incomplete', 'address');
    if (
      settings.require_documents === 1 &&
      !(await documentsComplete(this.env.DB, agentId, 'present'))
    ) {
      return fail('documents_missing');
    }
    // Everything staff asked for is answered before the application goes back to them.
    if ((await pendingRequests(this.env.DB, agentId)).open > 0) return fail('requests_open');
    const result = await submitApplication(this.env.DB, agentId, termsVersion, at);
    if (result.ok) {
      await recordAcceptance(this.env.DB, agentId, consents, locale, at);
      const settings = await readSettings(this.env.DB);
      await notifyAgent(this.env.DB, this.send, this.env.SAHA_ORIGIN, agentId, {
        kind: 'received',
        days: Math.max(1, Math.ceil(settings.agent_sla_hours / 24)),
      });
    }
    return result;
  }

  async myClaims(agentId: string) {
    return myClaims(this.env.DB, agentId, now());
  }

  async earnings(agentId: string) {
    return earnings(this.env.DB, agentId);
  }

  // ---- Support desk (docs/DESIGN.md §20) ----

  async openTicket(agentId: string, input: { subject: string; category: string; message: string }) {
    const result = await openTicket(this.env.DB, 'agent', agentId, agentId, input, now());
    if (result.ok) {
      await tellStaffOfTicket(this.env, this.send, result.value.id, 'agent', true, input.category);
    }
    return result;
  }

  async myTickets(agentId: string) {
    return ok(await myTickets(this.env.DB, 'agent', agentId));
  }

  async myTicket(agentId: string, ticketId: string) {
    return myTicket(this.env.DB, 'agent', agentId, ticketId);
  }

  async replyTicket(agentId: string, ticketId: string, body: string) {
    const result = await replyAsRequester(
      this.env.DB,
      'agent',
      agentId,
      agentId,
      ticketId,
      body,
      now(),
    );
    if (result.ok) await tellStaffOfTicket(this.env, this.send, ticketId, 'agent', false, '');
    return result;
  }

  async closeTicket(agentId: string, ticketId: string) {
    return closeAsRequester(this.env.DB, 'agent', agentId, agentId, ticketId, now());
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

  /**
   * A staff member opened a company's document or an agent's evidence: personal data, so every
   * look is recorded (KVKK; docs/DESIGN.md §8).
   */
  async recordView(staffId: string, subject: string, what: string) {
    if (!/^(onboarding|claim|review):[A-Za-z0-9_-]{1,64}$/.test(subject))
      return fail('invalid_subject');
    await auditStatement(this.env.DB, now(), `staff:${staffId}`, 'staff.viewed', subject, {
      what: what.slice(0, 100),
    }).run();
    return ok(null);
  }

  /** 2earl's own company details, as the agreement names it. */
  async provider() {
    return providerForStaff(this.env.DB);
  }

  async setProvider(staffId: string, input: Record<string, unknown>) {
    return setProvider(this.env.DB, staffId, input, now(), {
      send: this.send,
      kurumsal: this.env.KURUMSAL_ORIGIN,
    });
  }

  /** Whether a partner's operations contact gets delivery and expiry emails. */
  async setPartnerNotices(staffId: string, partnerId: string, on: boolean) {
    const at = now();
    const result = await this.env.DB.batch([
      this.env.DB.prepare('UPDATE partners SET mail_notices = ?, updated_at = ? WHERE id = ?').bind(
        on ? 1 : 0,
        at,
        partnerId,
      ),
      auditStatement(
        this.env.DB,
        at,
        `staff:${staffId}`,
        on ? 'partner.notices_on' : 'partner.notices_off',
        `partner:${partnerId}`,
      ),
    ]);
    return result[0]?.meta.changes === 1 ? ok(null) : fail('not_found');
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
    const settings = await readSettings(this.env.DB);
    if (settings.require_signoffs === 1) {
      const ready = await readiness(this.env.DB, Boolean(this.env.PII_KEY));
      if (!ready.partners_ready) return fail('not_ready', 'partners');
    }
    return approve(this.env.DB, this.send, origins(this.env), staffId, onboardingId, now());
  }

  /** What stands between a signed agreement and approval, for the company's page in Merkez. */
  async approvalChecklist(staffId: string, onboardingId: string) {
    const list = await approvalChecklist(
      this.env.DB,
      onboardingId,
      staffId,
      Boolean(this.env.PII_KEY),
    );
    return list ? ok(list) : fail('not_found');
  }

  async returnOnboarding(staffId: string, onboardingId: string, reason: string) {
    return reopen(this.env.DB, this.send, origins(this.env), staffId, onboardingId, reason, now());
  }

  async rejectOnboarding(staffId: string, onboardingId: string, reason: string) {
    return reject(this.env.DB, this.send, staffId, onboardingId, reason, now());
  }

  // ---- Partners ----

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

  /** Every setting with its value, default, range, unit, group and last change. */
  async settingsInfo() {
    return ok(await settingsInfo(this.env.DB));
  }

  /** Changes a setting. The old and new values go into the audit log. */
  async setSetting(staffId: string, key: SettingKey, value: number) {
    // Development mode has its own entry: it ends by itself and is recorded as such.
    if (key === 'dev_mode' || !settingAllowed(key, value)) return fail('invalid_setting');
    const at = now();
    const before = (await readSettings(this.env.DB))[key];
    if (before === value) return ok(null);
    await this.env.DB.batch([
      writeSetting(this.env.DB, key, value, staffId, at),
      auditStatement(this.env.DB, at, `staff:${staffId}`, 'setting.changed', `setting:${key}`, {
        from: before,
        to: value,
      }),
    ]);
    return ok(null);
  }

  /** Development mode: on for twelve hours, or off. Staff's role is checked in Emanet Merkez. */
  async setDevMode(staffId: string, on: boolean) {
    const at = now();
    const before = (await devModeStatus(this.env.DB, at)).active;
    if (before === on) return ok(await devModeStatus(this.env.DB, at));
    await this.env.DB.batch([
      writeSetting(this.env.DB, 'dev_mode', on ? 1 : 0, staffId, at),
      auditStatement(
        this.env.DB,
        at,
        `staff:${staffId}`,
        on ? 'dev_mode.on' : 'dev_mode.off',
        'setting:dev_mode',
      ),
    ]);
    return ok(await devModeStatus(this.env.DB, at));
  }

  async devMode() {
    return ok(await devModeStatus(this.env.DB));
  }

  /** Puts a setting back to its default. */
  async resetSetting(staffId: string, key: SettingKey) {
    if (key === 'dev_mode' || !Object.hasOwn(SETTINGS, key)) return fail('invalid_setting');
    const at = now();
    const before = (await readSettings(this.env.DB))[key];
    await this.env.DB.batch([
      resetSetting(this.env.DB, key),
      auditStatement(this.env.DB, at, `staff:${staffId}`, 'setting.reset', `setting:${key}`, {
        from: before,
        to: SETTINGS[key].default,
      }),
    ]);
    return ok(null);
  }

  async setAgentStatus(staffId: string, agentId: string, status: AgentStatus, reason: string) {
    const before = await this.env.DB.prepare('SELECT status FROM agents WHERE user_id = ?')
      .bind(agentId)
      .first<{ status: AgentStatus }>();
    if (status === 'active' && before?.status === 'kyc_pending') {
      const settings = await readSettings(this.env.DB);
      if (
        settings.require_documents === 1 &&
        !(await documentsComplete(this.env.DB, agentId, 'verified'))
      ) {
        return fail('documents_not_verified');
      }
      const pending = await pendingRequests(this.env.DB, agentId);
      if (pending.open + pending.answered > 0) return fail('requests_pending');
      if (settings.require_signoffs === 1) {
        const ready = await readiness(this.env.DB, Boolean(this.env.PII_KEY));
        if (!ready.agents_ready) return fail('not_ready', 'agents');
      }
    }
    const result = await setAgentStatus(this.env.DB, agentId, status, staffId, reason, now());
    if (result.ok && before && before.status !== status) {
      const cause = reason.trim().slice(0, 200);
      const notice =
        status === 'active'
          ? before.status === 'suspended'
            ? ({ kind: 'reinstated' } as const)
            : ({ kind: 'approved' } as const)
          : status === 'suspended'
            ? ({ kind: 'suspended', reason: cause } as const)
            : status === 'banned'
              ? ({ kind: 'banned', reason: cause } as const)
              : null;
      if (notice) {
        await notifyAgent(this.env.DB, this.send, this.env.SAHA_ORIGIN, agentId, notice);
      }
    }
    return result;
  }

  /** Sends an application back to the applicant with what to correct. */
  async returnApplication(staffId: string, agentId: string, reason: string) {
    const result = await returnApplication(this.env.DB, agentId, staffId, reason, now());
    if (result.ok) {
      await notifyAgent(this.env.DB, this.send, this.env.SAHA_ORIGIN, agentId, {
        kind: 'returned',
        reason: reason.trim().slice(0, 300),
      });
    }
    return result;
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

  /**
   * Confirms a reported delivery. While the checklist setting is on, staff must have ticked every
   * point in DELIVERY_CHECKS; what they ticked is kept on the claim and in the audit log.
   */
  async confirmDelivery(staffId: string, claimId: string, checks: string[] = []) {
    const settings = await readSettings(this.env.DB);
    const ticked = DELIVERY_CHECKS.filter(
      (check) => Array.isArray(checks) && checks.includes(check),
    );
    if (settings.review_checklist === 1 && ticked.length !== DELIVERY_CHECKS.length) {
      return fail(
        'checklist_incomplete',
        DELIVERY_CHECKS.filter((check) => !ticked.includes(check)).join(','),
      );
    }
    const agent = await this.env.DB.prepare('SELECT agent_id FROM claims WHERE id = ?')
      .bind(claimId)
      .first<{ agent_id: string }>();
    const at = now();
    const result = await confirmDelivery(this.env.DB, staffId, claimId, at);
    if (result.ok) {
      await this.env.DB.batch([
        this.env.DB.prepare('UPDATE claims SET checks = ? WHERE id = ?').bind(
          JSON.stringify(ticked),
          claimId,
        ),
        auditStatement(
          this.env.DB,
          at,
          `staff:${staffId}`,
          'delivery.checked',
          `claim:${claimId}`,
          {
            checks: ticked,
          },
        ),
      ]);
      if (agent) {
        await notifyAgent(this.env.DB, this.send, this.env.SAHA_ORIGIN, agent.agent_id, {
          kind: 'delivery_accepted',
          plate: await claimPlate(this.env.DB, claimId),
        });
      }
    }
    return result;
  }

  /** The evidence doesn't hold up: the claim ends, the agent reads why, nothing is booked. */
  async rejectDelivery(
    staffId: string,
    claimId: string,
    input: { reason: string; strike: boolean },
  ) {
    const result = await rejectDelivery(this.env.DB, staffId, claimId, input, now());
    if (result.ok) {
      const struck = (input.strike as unknown) === true;
      await notifyAgent(this.env.DB, this.send, this.env.SAHA_ORIGIN, result.value.agent_id, {
        kind: 'delivery_refused',
        plate: await claimPlate(this.env.DB, claimId),
        reason: input.reason.trim(),
        strikes: struck ? result.value.strikes : null,
      });
      if (result.value.suspended) {
        await notifyAgent(this.env.DB, this.send, this.env.SAHA_ORIGIN, result.value.agent_id, {
          kind: 'suspended',
          reason: `strike limit (${String(result.value.strikes)})`,
        });
      }
    }
    return result;
  }

  async issueInvoice(staffId: string, partnerId: string) {
    return issueInvoice(this.env.DB, staffId, partnerId, now());
  }

  /** The number the e-invoice provider gave an invoice. */
  async setInvoiceNumber(
    staffId: string,
    invoiceId: string,
    input: { number: string; uuid?: string | null },
  ) {
    return setInvoiceNumber(this.env.DB, staffId, invoiceId, input, now());
  }

  /** Who did what, newest first. Reading it is itself recorded. */
  async audit(
    staffId: string,
    query: { subject?: string; actor?: string; before?: number; limit?: number },
  ) {
    const result = await auditLog(this.env.DB, query);
    if (result.ok && (query.subject ?? query.actor)) {
      await auditStatement(this.env.DB, now(), `staff:${staffId}`, 'staff.viewed', 'audit', {
        subject: query.subject ?? null,
        actor: query.actor ?? null,
      }).run();
    }
    return result;
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
    const result = await markPayoutSent(this.env.DB, staffId, payoutId, bankRef, now());
    if (result.ok) {
      const payout = await this.env.DB.prepare('SELECT agent_id FROM payouts WHERE id = ?')
        .bind(payoutId)
        .first<{ agent_id: string }>();
      if (payout) {
        await notifyAgent(this.env.DB, this.send, this.env.SAHA_ORIGIN, payout.agent_id, {
          kind: 'payout_sent',
        });
      }
    }
    return result;
  }

  // ---- Agents' identity (docs/DESIGN.md §6) ----

  async kycChecks(agentId: string) {
    return ok(await kycChecks(this.env.DB, agentId));
  }

  /** Staff saw the person and their ID card on a video call. */
  async recordVideoCall(staffId: string, agentId: string, passed: boolean, activate = false) {
    const at = now();
    const agent = await this.env.DB.prepare('SELECT status FROM agents WHERE user_id = ?')
      .bind(agentId)
      .first<{ status: AgentStatus }>();
    if (!agent) return fail('not_found');
    await this.env.DB.batch([
      kycStatement(
        this.env.DB,
        agentId,
        'video_call',
        'staff',
        passed ? 'passed' : 'failed',
        at,
        staffId,
      ),
      auditStatement(this.env.DB, at, `staff:${staffId}`, 'agent.video_call', `agent:${agentId}`, {
        passed,
      }),
    ]);
    // Recording a call changes no status by itself. With `activate`, a passed call on an
    // application also tries the normal activation, so every rule there still applies.
    if (passed && activate && agent.status === 'kyc_pending') {
      const result = await this.setAgentStatus(
        staffId,
        agentId,
        'active',
        'Video call passed, ID matched',
      );
      return ok({ activated: result.ok, blocked: result.ok ? null : result.error });
    }
    return ok({ activated: false, blocked: null as string | null });
  }

  /** What stands between an applicant and activation, for the agent's page in Emanet Merkez. */
  async activationChecklist(agentId: string) {
    const list = await activationChecklist(this.env.DB, agentId, Boolean(this.env.PII_KEY));
    return list ? ok(list) : fail('not_found');
  }

  // ---- Personal data on request (docs/DESIGN.md §8) ----

  /** Everything held for a plate, a chassis number, an agent or an email address. The search is recorded. */
  async privacySearch(staffId: string, term: string) {
    const result = await inventory(this.env.DB, term);
    if (result.ok) {
      await auditStatement(this.env.DB, now(), `staff:${staffId}`, 'staff.viewed', 'privacy', {
        found:
          Boolean(result.value.vehicle ?? result.value.agent) ||
          result.value.onboardings.length > 0,
      }).run();
    }
    return result;
  }

  async eraseEvidence(staffId: string, evidenceId: string, reason: string) {
    return eraseEvidence(this.env.DB, staffId, evidenceId, reason, now());
  }

  async eraseDocument(staffId: string, documentId: string, reason: string) {
    return eraseDocument(this.env.DB, staffId, documentId, reason, now());
  }

  async redactCasePlaces(staffId: string, caseId: string, reason: string) {
    return redactCasePlaces(this.env.DB, staffId, caseId, reason, now());
  }

  async privacyRequests() {
    return ok(await listRequests(this.env.DB));
  }

  async openPrivacyRequest(staffId: string, input: Parameters<typeof openRequest>[2]) {
    return openRequest(this.env.DB, staffId, input, now());
  }

  async closePrivacyRequest(
    staffId: string,
    requestId: string,
    input: { status: string; outcome: string },
  ) {
    return closeRequest(this.env.DB, staffId, requestId, input, now());
  }

  /** Files Emanet Merkez's cron deletes from R2, and its report that it did. */
  async filesDue(limit = 100) {
    return ok(await filesDue(this.env.DB, limit));
  }

  /** Files Emanet Merkez's cron seals into an archive and moves. */
  async archiveFilesDue(limit = 50) {
    return ok(await archiveFilesDue(this.env.DB, limit));
  }

  async filesErased(refs: string[]) {
    return ok({ erased: await filesErased(this.env.DB, refs, now()) });
  }

  // ---- Operations (docs/DESIGN.md §12) ----

  // ---- Vetting applicants (docs/DESIGN.md §6) ----

  async agentDocuments(agentId: string) {
    return ok(await documentsOf(this.env.DB, agentId));
  }

  async agentAcceptance(agentId: string) {
    return ok(await latestAcceptance(this.env.DB, agentId));
  }

  /** Where an undecided document's file is, for staff to open. The view is recorded. */
  async documentFile(staffId: string, documentId: string) {
    const file = await documentFile(this.env.DB, documentId);
    if (!file) return fail('not_found');
    await auditStatement(
      this.env.DB,
      now(),
      `staff:${staffId}`,
      'agent.document_viewed',
      `agent:${file.agent_id}`,
      { kind: file.kind },
    ).run();
    return ok(file);
  }

  /** Staff verified the document; the file is deleted with the decision. */
  async decideDocument(
    staffId: string,
    documentId: string,
    input: { outcome: string; note?: string },
  ) {
    const result = await decideDocument(this.env.DB, staffId, documentId, input, now());
    // A requested document that can't be used is asked for again: the agent is told.
    if (result.ok && result.value.asked_again && result.value.request_id) {
      const request = await this.env.DB.prepare('SELECT note FROM agent_requests WHERE id = ?')
        .bind(result.value.request_id)
        .first<{ note: string }>();
      const settings = await readSettings(this.env.DB);
      await notifyAgent(this.env.DB, this.send, this.env.SAHA_ORIGIN, result.value.agent_id, {
        kind: 'requested',
        items: request ? [request.note] : [],
        days: settings.agent_request_days,
      });
    }
    return result;
  }

  // ---- Asking an agent for more (src/agent-requests.ts) ----

  /** Asks for details or documents; a sent application returns to the applicant. The agent is mailed. */
  async askAgent(staffId: string, agentId: string, asks: Ask[]) {
    const settings = await readSettings(this.env.DB);
    const result = await askAgent(
      this.env.DB,
      staffId,
      agentId,
      asks,
      settings.agent_request_days,
      now(),
    );
    if (result.ok) {
      await notifyAgent(this.env.DB, this.send, this.env.SAHA_ORIGIN, agentId, {
        kind: 'requested',
        items: result.value.notes,
        days: settings.agent_request_days,
      });
    }
    return result;
  }

  async agentRequests(agentId: string) {
    return ok(await requestsOf(this.env.DB, agentId));
  }

  /** Accepts an answer (`accepted`) or withdraws a request (`cancelled`). */
  async settleAgentRequest(staffId: string, requestId: string, status: string) {
    return settleRequest(this.env.DB, staffId, requestId, status, now());
  }

  async askAgentAgain(staffId: string, requestId: string, note: string) {
    const settings = await readSettings(this.env.DB);
    const result = await askAgain(
      this.env.DB,
      staffId,
      requestId,
      note,
      settings.agent_request_days,
      now(),
    );
    if (result.ok) {
      await notifyAgent(this.env.DB, this.send, this.env.SAHA_ORIGIN, result.value.agent_id, {
        kind: 'requested',
        items: [result.value.note],
        days: settings.agent_request_days,
      });
    }
    return result;
  }

  /** Answers from agents that wait for staff. */
  async answeredRequests() {
    return ok(await answeredRequests(this.env.DB));
  }

  // ---- Erasing an agent, and the sealed archive (src/erasure.ts). Admins only: the app checks. ----

  /** What erasing this agent would stop, and their request if they made one. */
  async erasureOverview(agentId: string) {
    const [request, blockers] = await Promise.all([
      myErasure(this.env.DB, agentId),
      erasureBlockers(this.env.DB, agentId),
    ]);
    return ok({ request, blockers });
  }

  /** Erases the agent's personal data and seals a copy. The person is told at the address they had. */
  async eraseAgent(
    staffId: string,
    agentId: string,
    input: { reason: string; requestId?: string },
  ) {
    const result = await eraseAgent(this.env.DB, `staff:${staffId}`, agentId, input, now());
    if (result.ok && result.value.email) {
      try {
        const settings = await readSettings(this.env.DB);
        if (settings.agent_mail === 1) {
          await this.send(
            agentMail(
              result.value.locale === 'en' ? 'en' : 'tr',
              result.value.email,
              { kind: 'erasure_done', years: result.value.years },
              this.env.SAHA_ORIGIN,
            ),
          );
        }
      } catch {
        // The erasure stands whether or not the mail went.
      }
    }
    return result.ok ? ok({ archive_id: result.value.archive_id }) : result;
  }

  /** Stops automatic deletion for one agent, case or onboarding while a dispute is open. */
  async placeHold(staffId: string, kind: string, ref: string, reason: string) {
    return placeHold(this.env.DB, staffId, kind, ref, reason, now());
  }

  async releaseHold(staffId: string, holdId: string, reason: string) {
    return releaseHold(this.env.DB, staffId, holdId, reason, now());
  }

  // ---- Support desk (docs/DESIGN.md §20) ----

  async supportTickets(filter: {
    status?: TicketStatus | 'active';
    kind?: RequesterKind;
    mine?: string;
  }) {
    return ok(await staffTickets(this.env.DB, filter));
  }

  async supportTicket(ticketId: string) {
    return staffTicket(this.env.DB, ticketId);
  }

  /** Writes to the requester, or, with `note`, only for staff. The mail never carries the text. */
  async supportReply(staffId: string, ticketId: string, body: string, note = false) {
    const result = await staffReply(this.env.DB, staffId, ticketId, body, note, now());
    if (result.ok && result.value.notify) {
      try {
        const to = await requesterContact(this.env.DB, ticketId);
        const url = await supportUrl(this.env, ticketId);
        if (to && url) {
          await this.send(
            supportReplyMail(to.locale, to.email, url, to.kind === 'agent' ? 'Saha' : 'Kurumsal'),
          );
        }
      } catch {
        // The answer stands whether or not the mail went.
      }
    }
    return result.ok ? ok(null) : result;
  }

  async supportAssign(staffId: string, ticketId: string, to: string | null) {
    return assignTicket(this.env.DB, staffId, ticketId, to, now());
  }

  async supportClose(staffId: string, ticketId: string, closed: boolean) {
    return setTicketStatus(this.env.DB, staffId, ticketId, closed, now());
  }

  /** What the cron deletes on its own, by kind of data, and how many records the next run takes. */
  async retentionOverview() {
    return ok(await retentionOverview(this.env.DB, now()));
  }

  async holds() {
    return ok(await listHolds(this.env.DB));
  }

  async refuseErasure(staffId: string, requestId: string, reason: string) {
    const result = await refuseErasure(this.env.DB, staffId, requestId, reason, now());
    if (result.ok) {
      await notifyAgent(this.env.DB, this.send, this.env.SAHA_ORIGIN, result.value.agent_id, {
        kind: 'erasure_refused',
        reason: result.value.reason,
      });
    }
    return result;
  }

  /** The archive's lines, never their content. */
  async archives(term = '') {
    return ok(await listArchives(this.env.DB, term));
  }

  async archiveViews(archiveId: string) {
    return ok(await archiveViews(this.env.DB, archiveId));
  }

  /** Opens one sealed record; the reason is recorded first. */
  async openArchive(staffId: string, archiveId: string, reason: string) {
    const at = now();
    const result = await openArchive(this.env.DB, staffId, archiveId, reason, at);
    if (result.ok) {
      await archiveOpenedNotice(this.send, this.env.STAFF_EMAIL, this.env.MERKEZ_ORIGIN, {
        kind: 'record',
        staffId,
        archiveId,
        at,
      });
    }
    return result;
  }

  async archiveHasFile(archiveId: string, ref: string) {
    return ok(await archiveHasFile(this.env.DB, archiveId, ref));
  }

  /** Opens one sealed file Emanet Merkez read from storage; the reason is recorded first. */
  async openArchiveFile(
    staffId: string,
    archiveId: string,
    ref: string,
    reason: string,
    bytes: ArrayBuffer,
  ) {
    const at = now();
    const result = await openArchiveFile(this.env.DB, staffId, archiveId, ref, reason, bytes, at);
    if (result.ok) {
      await archiveOpenedNotice(this.send, this.env.STAFF_EMAIL, this.env.MERKEZ_ORIGIN, {
        kind: 'file',
        staffId,
        archiveId,
        at,
      });
    }
    return result;
  }

  /** For Emanet Merkez's cron: seals a file on its way into the archive. */
  async sealArchiveFile(archiveId: string, fileRef: string, bytes: ArrayBuffer) {
    return sealArchiveFile(this.env.DB, archiveId, fileRef, bytes);
  }

  async archiveFileStored(
    archiveId: string,
    fileRef: string,
    stored: { ref: string; type: string; size: number },
  ) {
    return archiveFileStored(this.env.DB, archiveId, fileRef, stored, now());
  }

  // ---- Ready for the first customer (docs/DESIGN.md §13) ----

  async readiness() {
    return ok(await readiness(this.env.DB, Boolean(this.env.PII_KEY)));
  }

  async signOff(staffId: string, key: string, input: { signer: string; note?: string }) {
    return signOff(this.env.DB, staffId, key, input, now());
  }

  async withdrawSignoff(staffId: string, key: string) {
    return withdrawSignoff(this.env.DB, staffId, key, now());
  }

  // ---- The accountant's month (docs/DESIGN.md §4.6) ----

  async accountingMonths() {
    return ok(await accountingMonths(this.env.DB));
  }

  /** Everything booked in a month, with what payment documents need. Opening it is recorded. */
  async accountingMonth(staffId: string, month: string) {
    return accountingMonth(this.env.DB, staffId, month, now());
  }

  async closeMonth(staffId: string, month: string) {
    return closeMonth(this.env.DB, staffId, month, now());
  }

  /** The work waiting for staff, each queue against its service level. */
  async queues() {
    return ok(await queues(this.env.DB, now()));
  }

  async ops() {
    return ok(await opsOverview(this.env.DB, now()));
  }

  async reportError(event: string, detail: string) {
    await reportOps(this.env, 'merkez', event, detail);
  }

  async heartbeat(name: string, error: string | null) {
    await heartbeat(
      this.env.DB,
      `merkez.${name.replace(/[^a-z_]/g, '').slice(0, 30)}`,
      error,
      now(),
    );
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

/**
 * For emanet.dev, the public site: what its legal pages must name (KVKK's data controller, TTK
 * 1524's company details). Only what 2earl publishes anyway; null until staff have set it.
 */
export class PublicApi extends WorkerEntrypoint<Env> {
  async reportError(event: string, detail: string) {
    await reportOps(this.env, 'web', event, detail);
  }

  async company() {
    return ok(await provider(this.env.DB));
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
    // Each job on its own: one that fails doesn't stop the ones after it, is recorded for the
    // System page and the alert email, and the rest still run.
    const jobs: [string, () => Promise<unknown>][] = [
      ['expireClaims', () => expireClaims(env.DB, at)],
      ['expireCases', () => expireCases(env.DB, at)],
      ['onboarding', () => remindAndExpire(env.DB, mailer(env), origins(env), at)],
      ['notices', () => sendNotices(env.DB, mailer(env), env.KURUMSAL_ORIGIN, at)],
      ['retention', () => redactClosedCasePlaces(env.DB, at)],
      ['fileRetention', () => scheduleRetention(env.DB, at)],
      ['archiveRetention', () => purgeArchives(env.DB, at)],
      [
        'requestReminders',
        () =>
          remindRequests(
            env.DB,
            (agentId, items, days) =>
              notifyAgent(env.DB, mailer(env), env.SAHA_ORIGIN, agentId, {
                kind: 'request_reminder',
                items,
                days,
              }),
            at,
          ),
      ],
      ['serviceLevels', () => watchServiceLevels(env.DB, at)],
      ['supportRetention', () => purgeSupport(env.DB, at)],
      [
        'lateRequests',
        async () =>
          isDigestTime(at)
            ? lateRequestsNotice(env.DB, mailer(env), env.STAFF_EMAIL, env.MERKEZ_ORIGIN, at)
            : 0,
      ],
      [
        'uptime',
        () =>
          checkUptime(
            env.DB,
            uptimeTargets({
              kurumsal: env.KURUMSAL_ORIGIN,
              merkez: env.MERKEZ_ORIGIN,
              saha: env.SAHA_ORIGIN,
            }),
            (url, init) => fetch(url, init),
            at,
          ),
      ],
      ['alerts', () => alertOps(env.DB, mailer(env), env.STAFF_EMAIL, env.MERKEZ_ORIGIN, at)],
    ];
    ctx.waitUntil(
      (async () => {
        for (const [name, job] of jobs) {
          try {
            await job();
            await heartbeat(env.DB, `core.${name}`, null, at);
          } catch (error) {
            // The job's name and the error's name; never data.
            const what = error instanceof Error ? error.name : 'error';
            try {
              await recordOps(env.DB, 'core', 'error', `cron.${name}`, what, at);
              await heartbeat(env.DB, `core.${name}`, what, at);
            } catch {
              console.error(
                JSON.stringify({ level: 'error', event: `cron.${name}`, detail: what }),
              );
            }
          }
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;

/** Where a requester reads their ticket, or null when it has no home any more. */
async function supportUrl(env: Env, ticketId: string): Promise<string | null> {
  const t = await env.DB.prepare(
    'SELECT requester_kind, requester_ref FROM support_tickets WHERE id = ?',
  )
    .bind(ticketId)
    .first<{ requester_kind: RequesterKind; requester_ref: string }>();
  if (!t) return null;
  if (t.requester_kind === 'agent') return `${env.SAHA_ORIGIN}/support/${ticketId}`;
  const p = await env.DB.prepare('SELECT org_id FROM partners WHERE id = ?')
    .bind(t.requester_ref)
    .first<{ org_id: string }>();
  return p ? `${env.KURUMSAL_ORIGIN}/o/${p.org_id}/support/${ticketId}` : null;
}

/** One email to staff per new ticket or new message: who and what kind, never the text. */
async function tellStaffOfTicket(
  env: Env,
  send: Send,
  ticketId: string,
  kind: RequesterKind,
  fresh: boolean,
  category: string,
): Promise<void> {
  try {
    let what = category;
    if (!what) {
      const t = await env.DB.prepare('SELECT category FROM support_tickets WHERE id = ?')
        .bind(ticketId)
        .first<{ category: string }>();
      what = t?.category ?? '';
    }
    await send(
      supportStaffMail(
        env.STAFF_EMAIL,
        { kind, fresh, category: what },
        `${env.MERKEZ_ORIGIN}/support/${ticketId}`,
      ),
    );
  } catch {
    // A ticket is saved whether or not staff were mailed; the inbox shows it either way.
  }
}
