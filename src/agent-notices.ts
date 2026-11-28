/**
 * Telling agents what was decided (docs/DESIGN.md §6): their application, a reported delivery, a
 * payout. One email per decision, to the address they proved, in the language they applied in.
 * Staff can switch these off (the `agent_mail` setting). Sending never fails the decision.
 */
import { agentMail, type AgentNotice, type MailLocale, type Send } from './mail';
import { readSettings } from './settings';

export async function notifyAgent(
  db: D1Database,
  send: Send,
  saha: string,
  agentId: string,
  notice: AgentNotice,
): Promise<boolean> {
  try {
    const settings = await readSettings(db);
    if (settings.agent_mail !== 1) return false;
    const agent = await db
      .prepare('SELECT email, email_verified_at, locale FROM agents WHERE user_id = ?')
      .bind(agentId)
      .first<{ email: string | null; email_verified_at: number | null; locale: string }>();
    if (!agent?.email || agent.email_verified_at === null) return false;
    const locale: MailLocale = agent.locale === 'en' ? 'en' : 'tr';
    return await send(agentMail(locale, agent.email, notice, saha));
  } catch {
    return false;
  }
}

/** The plate an agent knows a claimed vehicle by. */
export async function claimPlate(db: D1Database, claimId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT p.plate FROM claims c
       LEFT JOIN vehicle_plates p ON p.vehicle_id = c.vehicle_id AND p.valid_to IS NULL
       WHERE c.id = ?`,
    )
    .bind(claimId)
    .first<{ plate: string | null }>();
  return row?.plate ?? null;
}
