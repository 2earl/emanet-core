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
import { readSettings } from './settings';

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
const RESEND_SECONDS = 60;
const MAX_ATTEMPTS = 5;
/** Per agent and day: codes sent, and wrong codes typed across all of them. */
const DAY = 86_400;
export const CODES_PER_DAY = 5;
export const FAILURES_PER_DAY = 10;

export const normalizeEmail = (value: string): string | null => {
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
};

/**
 * A uniform six-digit code: values from the top of the 32-bit range, where 1,000,000 doesn't
 * fit a whole number of times, are drawn again so no code is likelier than another.
 */
export function sixDigits(): string {
  const limit = 4_294_000_000; // the largest multiple of 1,000,000 below 2^32
  for (;;) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0] ?? limit;
    if (n < limit) return String(n % 1_000_000).padStart(6, '0');
  }
}

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
    .prepare(
      `SELECT sent_at, window_start, window_requests, window_failures FROM agent_email_codes
       WHERE agent_id = ?`,
    )
    .bind(agentId)
    .first<{
      sent_at: number;
      window_start: number;
      window_requests: number;
      window_failures: number;
    }>();
  if (last && at - last.sent_at < RESEND_SECONDS) return fail('sent_recently');
  // A new code doesn't reset the day's count: at most five codes and ten wrong guesses a day, so
  // a six-digit code can't be worn down by asking again and again.
  const fresh = !last || at - last.window_start >= DAY;
  const windowStart = fresh ? at : last.window_start;
  const requests = fresh ? 0 : last.window_requests;
  const failures = fresh ? 0 : last.window_failures;
  if (requests >= CODES_PER_DAY || failures >= FAILURES_PER_DAY) return fail('too_many_codes');
  const minutes = (await readSettings(db)).email_code_minutes;
  const code = sixDigits();
  await db
    .prepare(
      `INSERT INTO agent_email_codes (agent_id, email, code_hash, attempts, sent_at, expires_at,
         window_start, window_requests, window_failures)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_id) DO UPDATE SET email = excluded.email, code_hash = excluded.code_hash,
         attempts = 0, sent_at = excluded.sent_at, expires_at = excluded.expires_at,
         window_start = excluded.window_start, window_requests = excluded.window_requests,
         window_failures = excluded.window_failures`,
    )
    .bind(
      agentId,
      email,
      await keyedHash(`email-code:${agentId}`, code),
      at,
      at + minutes * 60,
      windowStart,
      requests + 1,
      failures,
    )
    .run();
  const locale = input.locale === 'en' ? 'en' : 'tr';
  await db.prepare('UPDATE agents SET locale = ? WHERE user_id = ?').bind(locale, agentId).run();
  const sent = await send(emailCodeMail(locale, email, code, minutes));
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
      `SELECT email, code_hash, attempts, expires_at, window_failures FROM agent_email_codes
       WHERE agent_id = ?`,
    )
    .bind(agentId)
    .first<{
      email: string;
      code_hash: string;
      attempts: number;
      expires_at: number;
      window_failures: number;
    }>();
  if (
    !pending ||
    pending.expires_at <= at ||
    pending.attempts >= MAX_ATTEMPTS ||
    pending.window_failures >= FAILURES_PER_DAY
  ) {
    return fail('code_expired');
  }
  const given = typeof code === 'string' ? code.replace(/\s/g, '') : '';
  if (
    !/^\d{6}$/.test(given) ||
    (await keyedHash(`email-code:${agentId}`, given)) !== pending.code_hash
  ) {
    await db
      .prepare(
        `UPDATE agent_email_codes SET attempts = attempts + 1, window_failures = window_failures + 1
         WHERE agent_id = ?`,
      )
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
