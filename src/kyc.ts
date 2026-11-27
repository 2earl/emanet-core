/**
 * Who an agent is (docs/DESIGN.md §6, Joining). On the web an agent proves:
 * 1. an email address, with a code mailed to it;
 * 2. their T.C. kimlik no, checked for its check digits and, where the population registry's
 *    public service answers, against their name and birth year;
 * 3. to staff, on a video call with the ID card, that they are that person; and an IBAN in their
 *    own name.
 * One person, one account: the ID number (as a keyed hash; the number itself is never stored),
 * the email and the phone number each belong to a single agent.
 *
 * Reading the ID card's chip (NFC) and a liveness check need a native app: browsers can't talk to
 * the chip. A phone number is proved by SMS once an SMS provider is chosen (`phone_verified_at`
 * is there for it). Both are in DESIGN §6 as the next steps.
 */
import { auditStatement } from './audit';
import { emailCodeMail, type MailLocale, type Send } from './mail';
import { keyedHash } from './pii';
import { fail, newId, ok, type Result } from './result';

/** 11 digits, not starting with 0, with the two check digits the registry's algorithm gives. */
export function validTckn(value: string): boolean {
  if (!/^[1-9]\d{10}$/.test(value)) return false;
  const d = Array.from(value, Number);
  const odd = (d[0] ?? 0) + (d[2] ?? 0) + (d[4] ?? 0) + (d[6] ?? 0) + (d[8] ?? 0);
  const even = (d[1] ?? 0) + (d[3] ?? 0) + (d[5] ?? 0) + (d[7] ?? 0);
  const tenth = (((odd * 7 - even) % 10) + 10) % 10;
  const eleventh = d.slice(0, 10).reduce((sum, n) => sum + n, 0) % 10;
  return d[9] === tenth && d[10] === eleventh;
}

export const tcknHash = (tckn: string) => keyedHash('tckn', tckn);

export type RegistryAnswer = 'match' | 'no_match' | 'unavailable';
/** Asks the population registry whether this number belongs to this name and birth year. */
export type RegistryCheck = (person: {
  tckn: string;
  firstName: string;
  lastName: string;
  birthYear: number;
}) => Promise<RegistryAnswer>;

const xml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * NVİ's public KPS service (TCKimlikNoDogrula). It answers true or false and nothing else. It is
 * a courtesy service without a contract: slow, sometimes closed to data-centre addresses. Any
 * answer that isn't a clear true or false is "unavailable", and staff check the card on the
 * video call as before.
 */
export function nviRegistry(endpoint: string, fetcher: typeof fetch = fetch): RegistryCheck {
  return async (person) => {
    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
      '<TCKimlikNoDogrula xmlns="http://tckimlik.nvi.gov.tr/WS">' +
      `<TCKimlikNo>${person.tckn}</TCKimlikNo>` +
      `<Ad>${xml(person.firstName.toLocaleUpperCase('tr-TR'))}</Ad>` +
      `<Soyad>${xml(person.lastName.toLocaleUpperCase('tr-TR'))}</Soyad>` +
      `<DogumYili>${String(person.birthYear)}</DogumYili>` +
      '</TCKimlikNoDogrula></soap:Body></soap:Envelope>';
    try {
      const response = await fetcher(endpoint, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(6000),
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: '"http://tckimlik.nvi.gov.tr/WS/TCKimlikNoDogrula"',
        },
        body,
      });
      if (!response.ok) return 'unavailable';
      const text = (await response.text()).slice(0, 4000);
      const match = /<TCKimlikNoDogrulaResult>\s*(true|false)\s*<\/TCKimlikNoDogrulaResult>/.exec(
        text,
      );
      if (!match) return 'unavailable';
      return match[1] === 'true' ? 'match' : 'no_match';
    } catch {
      return 'unavailable';
    }
  };
}

export const noRegistry: RegistryCheck = () => Promise.resolve('unavailable');

export function kycStatement(
  db: D1Database,
  agentId: string,
  kind: 'email' | 'id_registry' | 'video_call' | 'iban' | 'phone',
  provider: string,
  result: 'passed' | 'failed' | 'review',
  at: number,
  reviewedBy: string | null = null,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO kyc_checks (id, agent_id, kind, provider, result, reviewed_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(newId(), agentId, kind, provider, result, reviewedBy, at);
}

// ---- Email ---------------------------------------------------------------------------------------

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CODE_MINUTES = 15;
const RESEND_SECONDS = 60;
const MAX_ATTEMPTS = 5;

export const normalizeEmail = (value: string): string | null => {
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
};

/** Mails a six-digit code to an address the agent wants to use. Not after activation. */
export async function requestEmailCode(
  db: D1Database,
  send: Send,
  agentId: string,
  input: { email: string; locale: MailLocale },
  at: number,
): Promise<Result<{ email: string }>> {
  const email = typeof input.email === 'string' ? normalizeEmail(input.email) : null;
  if (!email) return fail('invalid_email');
  const agent = await db
    .prepare('SELECT status FROM agents WHERE user_id = ?')
    .bind(agentId)
    .first<{ status: string }>();
  if (!agent) return fail('not_found');
  if (agent.status === 'banned' || agent.status === 'suspended') return fail('agent_not_active');
  const taken = await db
    .prepare('SELECT 1 AS yes FROM agents WHERE lower(email) = ? AND user_id != ?')
    .bind(email, agentId)
    .first();
  if (taken) return fail('email_taken');
  const last = await db
    .prepare('SELECT sent_at FROM agent_email_codes WHERE agent_id = ?')
    .bind(agentId)
    .first<{ sent_at: number }>();
  if (last && at - last.sent_at < RESEND_SECONDS) return fail('sent_recently');
  const code = String((crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % 1_000_000).padStart(
    6,
    '0',
  );
  await db
    .prepare(
      `INSERT INTO agent_email_codes (agent_id, email, code_hash, attempts, sent_at, expires_at)
       VALUES (?, ?, ?, 0, ?, ?)
       ON CONFLICT (agent_id) DO UPDATE SET email = excluded.email, code_hash = excluded.code_hash,
         attempts = 0, sent_at = excluded.sent_at, expires_at = excluded.expires_at`,
    )
    .bind(
      agentId,
      email,
      await keyedHash(`email-code:${agentId}`, code),
      at,
      at + CODE_MINUTES * 60,
    )
    .run();
  const sent = await send(emailCodeMail(input.locale === 'en' ? 'en' : 'tr', email, code));
  return sent ? ok({ email }) : fail('email_not_sent');
}

/** The agent types the code: the address is theirs, and no other agent can use it. */
export async function confirmEmailCode(
  db: D1Database,
  agentId: string,
  code: string,
  at: number,
): Promise<Result<{ email: string }>> {
  const pending = await db
    .prepare(
      'SELECT email, code_hash, attempts, expires_at FROM agent_email_codes WHERE agent_id = ?',
    )
    .bind(agentId)
    .first<{ email: string; code_hash: string; attempts: number; expires_at: number }>();
  if (!pending || pending.expires_at <= at || pending.attempts >= MAX_ATTEMPTS) {
    return fail('code_expired');
  }
  const given = typeof code === 'string' ? code.replace(/\s/g, '') : '';
  if (
    !/^\d{6}$/.test(given) ||
    (await keyedHash(`email-code:${agentId}`, given)) !== pending.code_hash
  ) {
    await db
      .prepare('UPDATE agent_email_codes SET attempts = attempts + 1 WHERE agent_id = ?')
      .bind(agentId)
      .run();
    return fail('wrong_code');
  }
  try {
    await db.batch([
      db
        .prepare(
          'UPDATE agents SET email = ?, email_verified_at = ?, updated_at = ? WHERE user_id = ?',
        )
        .bind(pending.email, at, at, agentId),
      db.prepare('DELETE FROM agent_email_codes WHERE agent_id = ?').bind(agentId),
      kycStatement(db, agentId, 'email', 'emanet', 'passed', at),
      auditStatement(db, at, `agent:${agentId}`, 'agent.email_verified', `agent:${agentId}`),
    ]);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
      return fail('email_taken');
    }
    throw error;
  }
  return ok({ email: pending.email });
}

export interface KycCheck {
  kind: string;
  provider: string;
  result: 'passed' | 'failed' | 'review';
  reviewed_by: string | null;
  created_at: number;
}

/** The latest check of each kind, for the agent's page in Emanet Merkez. */
export async function kycChecks(db: D1Database, agentId: string): Promise<KycCheck[]> {
  const { results } = await db
    .prepare(
      `SELECT kind, provider, result, reviewed_by, created_at FROM kyc_checks k
       WHERE agent_id = ? AND created_at = (
         SELECT max(created_at) FROM kyc_checks WHERE agent_id = k.agent_id AND kind = k.kind)
       GROUP BY kind ORDER BY kind`,
    )
    .bind(agentId)
    .all<KycCheck>();
  return results;
}
