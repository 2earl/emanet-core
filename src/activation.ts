/**
 * What stands between an applicant and activation (docs/DESIGN.md §6), in one list for Emanet
 * Merkez: each point says whether it is met and whether it blocks. It reads the same rules
 * `setAgentStatus` enforces, so the list and the button never disagree.
 */
import { pendingRequests } from './agent-requests';
import { kycChecks } from './kyc';
import { missingForAgents, readiness } from './readiness';
import { readSettings } from './settings';
import { documentsComplete } from './vetting';

export interface ActivationItem {
  key: 'application' | 'documents' | 'requests' | 'signoffs' | 'video_call' | 'iban';
  ok: boolean;
  /** Activation is refused while a blocking point is unmet. */
  blocking: boolean;
  /** For `signoffs`: the readiness checks still open. For `requests`: how many are unsettled. */
  detail?: string[] | number;
}

export interface ActivationChecklist {
  items: ActivationItem[];
  /** Every blocking point is met: the button will work. */
  ready: boolean;
}

export async function activationChecklist(
  db: D1Database,
  agentId: string,
  hasPiiKey: boolean,
): Promise<ActivationChecklist | null> {
  const agent = await db
    .prepare(
      `SELECT legal_name, phone, iban, terms_accepted_at, email_verified_at, tckn_hash,
              iban_verified_at, erased_at FROM agents WHERE user_id = ?`,
    )
    .bind(agentId)
    .first<{
      legal_name: string | null;
      phone: string | null;
      iban: string | null;
      terms_accepted_at: number | null;
      email_verified_at: number | null;
      tckn_hash: string | null;
      iban_verified_at: number | null;
      erased_at: number | null;
    }>();
  if (!agent || agent.erased_at !== null) return null;
  const [settings, pending, checks, ready] = await Promise.all([
    readSettings(db),
    pendingRequests(db, agentId),
    kycChecks(db, agentId),
    readiness(db, hasPiiKey),
  ]);
  const documentsOk =
    settings.require_documents === 1 ? await documentsComplete(db, agentId, 'verified') : true;
  const unsettled = pending.open + pending.answered;
  const missing = missingForAgents(ready);
  const items: ActivationItem[] = [
    {
      key: 'application',
      ok:
        agent.terms_accepted_at !== null &&
        Boolean(agent.legal_name) &&
        Boolean(agent.phone) &&
        Boolean(agent.iban) &&
        agent.email_verified_at !== null &&
        agent.tckn_hash !== null,
      blocking: true,
    },
    { key: 'documents', ok: documentsOk, blocking: true },
    { key: 'requests', ok: unsettled === 0, blocking: true, detail: unsettled },
    {
      key: 'signoffs',
      ok: settings.require_signoffs !== 1 || missing.length === 0,
      blocking: true,
      detail: settings.require_signoffs === 1 ? missing : [],
    },
    {
      key: 'video_call',
      ok: checks.some((check) => check.kind === 'video_call' && check.result === 'passed'),
      blocking: false,
    },
    { key: 'iban', ok: agent.iban_verified_at !== null, blocking: false },
  ];
  return { items, ready: items.every((item) => item.ok || !item.blocking) };
}
