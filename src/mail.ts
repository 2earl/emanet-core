/**
 * Emanet's email to companies being onboarded, and to 2earl's staff about them. Cloudflare Email
 * Service (the MAILER binding), from noreply@emanet.dev; replies reach iletisim@emanet.dev, the
 * one address Emanet gives everyone.
 *
 * Plain text and a small HTML version, in the language chosen when the company was invited. No
 * images, no tracking. Links go only to Emanet's own sites. Sending never throws.
 */

export type MailLocale = 'tr' | 'en';

/** A line of a list in an email: a vehicle, an error, a fact. */
export interface MailRow {
  label: string;
  /** Shown as a number plate. */
  plate?: boolean;
  note?: string;
  url?: string;
}

export interface Mail {
  to: string;
  subject: string;
  paragraphs: string[];
  /** Which app the email speaks for; shown beside the name. */
  product?: 'Kurumsal' | 'Saha' | 'Merkez';
  /** The language of the frame around the text (footer, link hint). Turkish unless said. */
  locale?: MailLocale;
  /** A one-time code, set large. */
  code?: string;
  rows?: MailRow[];
  action?: { label: string; url: string };
  after?: string[];
}

export type Send = (mail: Mail) => Promise<boolean>;

const SENDER = { email: 'noreply@emanet.dev', name: 'Emanet' };
export const REPLY_TO = 'iletisim@emanet.dev';

/** The apps' palette (their app.css): petrol for actions, a cool ground, vermilion for the mark. */
const INK = '#16212b';
const MUTED = '#5b6875';
const GROUND = '#eef1f4';
const LINE = '#d5dbe1';
const ACTION = '#0e4a5a';
const MARK = '#d8421d';
const FONT = "'Barlow','Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const MONO = "ui-monospace,'SF Mono',Menlo,Consolas,monospace";

const FRAME = {
  tr: {
    about: 'Emanet, 2earl’ün bir hizmetidir. Kamu kurumu değildir; icra işlemi yapmaz.',
    privacy: 'Aydınlatma metni',
    contact: 'İletişim',
    link: 'Düğme çalışmazsa bu adresi tarayıcınıza yapıştırın:',
    code: 'Kod',
  },
  en: {
    about:
      'Emanet is a service of 2earl. It is not a public authority and carries out no enforcement.',
    privacy: 'Privacy notice',
    contact: 'Contact',
    link: 'If the button doesn’t work, paste this address into your browser:',
    code: 'Code',
  },
} as const;

const esc = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const rowText = (row: MailRow) =>
  [row.label, row.note, row.url].filter((part) => part !== undefined && part !== '').join(' · ');

export function text(mail: Mail): string {
  const frame = FRAME[mail.locale ?? 'tr'];
  return [
    ...mail.paragraphs,
    ...(mail.code ? [`${frame.code}: ${mail.code}`] : []),
    ...(mail.rows?.length ? [mail.rows.map(rowText).join('\n')] : []),
    ...(mail.action ? [`${mail.action.label}: ${mail.action.url}`] : []),
    ...(mail.after ?? []),
    `—\nEmanet · emanet.dev · ${REPLY_TO}\n${frame.about}\n${frame.privacy}: https://emanet.dev/gizlilik`,
  ].join('\n\n');
}

/**
 * The HTML part: tables and inline styles, because that is what mail programs render. The same
 * card, plate and petrol button as the apps. No image is fetched: the mark is a drawn square.
 */
export function html(mail: Mail): string {
  const locale = mail.locale ?? 'tr';
  const frame = FRAME[locale];
  const p = (t: string) =>
    `<p style="margin:0 0 16px;font-size:16px;line-height:1.55;color:${INK}">${esc(t)}</p>`;
  const small = (t: string) =>
    `<p style="margin:0 0 10px;font-size:13px;line-height:1.5;color:${MUTED}">${esc(t)}</p>`;
  const code = mail.code
    ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:4px 0 20px"><tr><td align="center" style="background:${GROUND};border:1px solid ${LINE};border-radius:10px;padding:18px 12px;font-family:${MONO};font-size:32px;font-weight:700;letter-spacing:8px;color:${INK}">${esc(mail.code)}</td></tr></table>`
    : '';
  const rows = mail.rows?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:4px 0 20px;border:1px solid ${LINE};border-radius:10px;border-collapse:separate">${mail.rows
        .map((row, index) => {
          const label = row.plate
            ? `<span style="display:inline-block;border:2px solid ${INK};border-left:10px solid #0b3d91;border-radius:5px;padding:2px 8px;font-family:${MONO};font-size:15px;font-weight:700;letter-spacing:1px;color:${INK};background:#ffffff">${esc(row.label)}</span>`
            : `<span style="font-size:15px;font-weight:600;color:${INK}">${esc(row.label)}</span>`;
          const note = row.note
            ? `<span style="font-size:14px;color:${MUTED}"> &nbsp;${esc(row.note)}</span>`
            : '';
          const link = row.url
            ? `<td align="right" style="padding:12px 14px;white-space:nowrap${index ? `;border-top:1px solid ${LINE}` : ''}"><a href="${esc(row.url)}" style="font-size:14px;font-weight:600;color:${ACTION};text-decoration:underline">${locale === 'tr' ? 'Aç' : 'Open'}</a></td>`
            : '';
          return `<tr><td style="padding:12px 14px${index ? `;border-top:1px solid ${LINE}` : ''}">${label}${note}</td>${link}</tr>`;
        })
        .join('')}</table>`
    : '';
  const button = mail.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 18px"><tr><td style="background:${ACTION};border-radius:8px"><a href="${esc(mail.action.url)}" style="display:inline-block;padding:13px 22px;font-family:${FONT};font-size:16px;font-weight:600;color:#ffffff;text-decoration:none">${esc(mail.action.label)}</a></td></tr></table><p style="margin:0 0 18px;font-size:12px;line-height:1.5;color:${MUTED}">${frame.link}<br><span style="word-break:break-all;color:${ACTION}">${esc(mail.action.url)}</span></p>`
    : '';
  const after = mail.after?.length
    ? `<div style="border-top:1px solid ${LINE};margin-top:8px;padding-top:16px">${mail.after.map(small).join('')}</div>`
    : '';
  const product = mail.product
    ? `<span style="font-weight:500;color:${MUTED}"> ${mail.product}</span>`
    : '';
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(mail.subject)}</title></head><body style="margin:0;padding:0;background:${GROUND};font-family:${FONT};color:${INK}"><div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(mail.paragraphs[0] ?? '')}</div><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${GROUND}"><tr><td align="center" style="padding:28px 12px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:580px"><tr><td style="padding:0 4px 14px"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="width:26px;height:26px;background:${MARK};border-radius:7px;font-size:0;line-height:0">&nbsp;</td><td style="padding-left:10px;font-family:${FONT};font-size:19px;font-weight:700;color:${INK}">Emanet${product}</td></tr></table></td></tr><tr><td style="background:#ffffff;border:1px solid ${LINE};border-top:4px solid ${ACTION};border-radius:12px;padding:28px 28px 20px"><h1 style="margin:0 0 18px;font-family:${FONT};font-size:21px;line-height:1.3;font-weight:700;color:${INK}">${esc(mail.subject)}</h1>${mail.paragraphs.map(p).join('')}${code}${rows}${button}${after}</td></tr><tr><td style="padding:16px 4px 0;font-size:12px;line-height:1.6;color:${MUTED}">${frame.about}<br><a href="https://emanet.dev" style="color:${MUTED}">emanet.dev</a> · <a href="https://emanet.dev/gizlilik" style="color:${MUTED}">${frame.privacy}</a> · <a href="mailto:${REPLY_TO}" style="color:${MUTED}">${frame.contact}</a></td></tr></table></td></tr></table></body></html>`;
}

export function mailer(env: Env): Send {
  return async (mail) => {
    try {
      await env.MAILER.send({
        to: mail.to,
        from: SENDER,
        replyTo: REPLY_TO,
        subject: mail.subject,
        text: text(mail),
        html: html(mail),
      });
      return true;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      console.error('email failed', typeof code === 'string' ? code : 'unknown');
      return false;
    }
  };
}

// ---- Messages ----------------------------------------------------------------------------------

export function invitationMail(
  locale: MailLocale,
  to: string,
  company: string,
  contactName: string,
  url: string,
  expiresAt: number,
  reminder: boolean,
): Mail {
  const until = new Date(expiresAt * 1000).toLocaleDateString(locale === 'tr' ? 'tr-TR' : 'en-GB', {
    timeZone: 'Europe/Istanbul',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return locale === 'tr'
    ? {
        to,
        locale: 'tr',
        product: 'Kurumsal',
        subject: `${reminder ? 'Hatırlatma: ' : ''}${company} için Emanet daveti`,
        paragraphs: [
          `Sayın ${contactName},`,
          `2earl, ${company} kurumunu Emanet’e davet ediyor. Emanet, yakalama şerhli araçlarınızı doğrulanmış saha ajanlarıyla bulur, kolluğa bildirir ve yediemine teslim belgelerini size sunar; yalnızca yediemine ulaşan araçlar için ücret ödersiniz.`,
          'Başlamak için bağlantıyı açın, 2earl hesabınızla (bu e-posta adresiyle) giriş yapın, kurum bilgilerinizi girin ve sözleşmeyi inceleyip onaylayın.',
        ],
        action: { label: 'Davete git', url },
        after: [
          `Bağlantı ${until} tarihine kadar geçerlidir ve yalnızca bu e-posta adresiyle giriş yapan hesap için çalışır.`,
          'Bu daveti beklemiyorsanız bu e-postayı dikkate almayın veya yanıtlayarak bize bildirin.',
        ],
      }
    : {
        to,
        locale: 'en',
        product: 'Kurumsal',
        subject: `${reminder ? 'Reminder: ' : ''}Emanet invitation for ${company}`,
        paragraphs: [
          `Dear ${contactName},`,
          `2earl invites ${company} to Emanet. Emanet finds your vehicles that carry seizure orders with verified field agents, reports them to the police and gives you the custodian’s documents; you pay only for vehicles that reach custody.`,
          'To start, open the link, sign in with your 2earl account (with this email address), enter your company’s details, and review and accept the agreement.',
        ],
        action: { label: 'Open the invitation', url },
        after: [
          `The link works until ${until}, and only for an account that signs in with this address.`,
          'If you didn’t expect this invitation, ignore this email or reply to tell us.',
        ],
      };
}

export function approvedMail(locale: MailLocale, to: string, company: string, url: string): Mail {
  return locale === 'tr'
    ? {
        to,
        locale: 'tr',
        product: 'Kurumsal',
        subject: `${company} Emanet’te etkin`,
        paragraphs: [
          `${company} için Emanet hesabı onaylandı. Artık araçlarınızı form, CSV veya API ile ekleyebilir, ekip arkadaşlarınızı davet edebilir ve bildirim adreslerinizi tanımlayabilirsiniz.`,
        ],
        action: { label: 'Emanet Kurumsal’a git', url },
        after: ['Sorularınız için bu e-postayı yanıtlayabilirsiniz.'],
      }
    : {
        to,
        locale: 'en',
        product: 'Kurumsal',
        subject: `${company} is active on Emanet`,
        paragraphs: [
          `Emanet is now active for ${company}. You can add your vehicles by form, CSV or API, invite your colleagues and set up your webhooks.`,
        ],
        action: { label: 'Go to Emanet Kurumsal', url },
        after: ['Reply to this email with any questions.'],
      };
}

export function rejectedMail(
  locale: MailLocale,
  to: string,
  company: string,
  reason: string,
): Mail {
  return locale === 'tr'
    ? {
        to,
        locale: 'tr',
        product: 'Kurumsal',
        subject: `${company} için Emanet başvurusu`,
        paragraphs: [
          `${company} için Emanet başvurusunu şu anda onaylayamıyoruz.`,
          `Neden: ${reason}`,
          'Sorularınız için bu e-postayı yanıtlayabilirsiniz.',
        ],
      }
    : {
        to,
        locale: 'en',
        product: 'Kurumsal',
        subject: `Emanet application for ${company}`,
        paragraphs: [
          `We can’t approve the Emanet application for ${company} at the moment.`,
          `Reason: ${reason}`,
          'Reply to this email with any questions.',
        ],
      };
}

/** To the signer: what they accepted, so they have their own record of it. */
export function receiptMail(
  locale: MailLocale,
  to: string,
  company: string,
  version: string,
  sha256: string,
  url: string,
): Mail {
  return locale === 'tr'
    ? {
        to,
        locale: 'tr',
        product: 'Kurumsal',
        subject: `${company}: Emanet sözleşmesi onaylandı`,
        paragraphs: [
          `${company} adına Emanet Hizmet Sözleşmesi’ni onayladınız. 2earl kurum bilgilerinizi ve belgelerinizi inceleyip hesabınızı etkinleştirdiğinde size yeniden yazacağız.`,
          `Sözleşme sürümü: ${version}`,
          `Metnin SHA-256 özeti: ${sha256}`,
        ],
        action: { label: 'Onaylanan metni gör', url },
        after: ['Bu onayı siz vermediyseniz hemen bu e-postayı yanıtlayın.'],
      }
    : {
        to,
        locale: 'en',
        product: 'Kurumsal',
        subject: `${company}: Emanet agreement accepted`,
        paragraphs: [
          `You accepted the Emanet service agreement for ${company}. We’ll write again once 2earl has checked your details and documents and activated your account.`,
          `Agreement version: ${version}`,
          `SHA-256 of the text: ${sha256}`,
        ],
        action: { label: 'See the accepted text', url },
        after: ['If you didn’t give this acceptance, reply to this email at once.'],
      };
}

/** Staff sent a signed onboarding back for changes; the earlier acceptance no longer counts. */
export function returnedMail(
  locale: MailLocale,
  to: string,
  company: string,
  reason: string,
  url: string,
): Mail {
  return locale === 'tr'
    ? {
        to,
        locale: 'tr',
        product: 'Kurumsal',
        subject: `${company}: Emanet başvurusunda düzeltme gerekiyor`,
        paragraphs: [
          `${company} için Emanet başvurusunda bir düzeltme gerekiyor: ${reason}`,
          'Bilgileri düzelttikten sonra sözleşmeyi yeniden onaylamanız gerekir; önceki onay geçersiz sayılmıştır.',
        ],
        action: { label: 'Başvuruya git', url },
      }
    : {
        to,
        locale: 'en',
        product: 'Kurumsal',
        subject: `${company}: your Emanet application needs a change`,
        paragraphs: [
          `Your Emanet application for ${company} needs a change: ${reason}`,
          'Once you’ve made it, accept the agreement again; the earlier acceptance no longer counts.',
        ],
        action: { label: 'Open the application', url },
      };
}

const turkeyDay = (unix: number, locale: MailLocale) =>
  new Date(unix * 1000).toLocaleDateString(locale === 'tr' ? 'tr-TR' : 'en-GB', {
    timeZone: 'Europe/Istanbul',
    day: 'numeric',
    month: 'long',
  });

/** To a company waiting on the agreement: 2earl's details are in, it can be accepted now. */
export function agreementReadyMail(
  locale: MailLocale,
  to: string,
  company: string,
  url: string,
): Mail {
  return locale === 'tr'
    ? {
        to,
        locale: 'tr',
        product: 'Kurumsal',
        subject: `${company}: Emanet sözleşmesi onaya hazır`,
        paragraphs: [
          '2earl sözleşmedeki kendi bilgilerini tamamladı. Emanet Hizmet Sözleşmesi’ni artık okuyup onaylayabilirsiniz.',
        ],
        action: { label: 'Sözleşmeye git', url },
      }
    : {
        to,
        locale: 'en',
        product: 'Kurumsal',
        subject: `${company}: the Emanet agreement is ready to accept`,
        paragraphs: [
          '2earl has completed its own details in the agreement. You can read and accept the Emanet service agreement now.',
        ],
        action: { label: 'Open the agreement', url },
      };
}

/** To a company's operations contact: one of its webhooks was switched off after failing. */
export function webhookDisabledMail(
  locale: MailLocale,
  to: string,
  company: string,
  host: string,
  url: string,
): Mail {
  return locale === 'tr'
    ? {
        to,
        locale: 'tr',
        product: 'Kurumsal',
        subject: `${company}: Emanet webhook’u kapatıldı`,
        paragraphs: [
          `${host} adresindeki webhook’unuz art arda başarısız olduğu için kapatıldı. Yeni olaylar bu adrese gönderilmiyor.`,
          'Adresinizin yanıt verdiğini kontrol edin, ardından webhook’u Emanet Kurumsal’dan yeniden açın. Bu sürede olaylara API üzerinden (GET /api/v1/events) erişebilirsiniz.',
        ],
        action: { label: 'Webhook’ları aç', url },
      }
    : {
        to,
        locale: 'en',
        product: 'Kurumsal',
        subject: `${company}: an Emanet webhook was switched off`,
        paragraphs: [
          `Your webhook at ${host} failed repeatedly and was switched off. New events are not being sent to it.`,
          'Check that your endpoint answers, then switch the webhook back on in Emanet Kurumsal. Meanwhile the events are available from the API (GET /api/v1/events).',
        ],
        action: { label: 'Open webhooks', url },
      };
}

/** To 2earl's staff: a company accepted the agreement and waits for approval. */
export function signedMail(to: string, company: string, url: string): Mail {
  return {
    to,
    locale: 'tr',
    product: 'Merkez',
    subject: `Emanet: ${company} sözleşmeyi onayladı`,
    paragraphs: [
      `${company} Emanet Hizmet Sözleşmesi’ni onayladı. Bilgilerini ve belgelerini kontrol edin, ardından Emanet Merkez’de onaylayın, düzeltme isteyin ya da reddedin.`,
    ],
    action: { label: 'Emanet Merkez’de aç', url },
  };
}

const NOTICE_WHY = {
  tr: 'Bu bildirimleri kurumunuzun operasyon iletişim adresi olarak alıyorsunuz. Kapatmak için bu e-postayı yanıtlayın.',
  en: 'You get these notices as your company’s operations contact. Reply to this email to turn them off.',
} as const;

/** To a partner's operations contact: vehicles that reached custody. */
export function deliveredMail(
  locale: MailLocale,
  to: string,
  company: string,
  vehicles: { plate: string; ref: string; url: string }[],
): Mail {
  const one = vehicles.length === 1;
  const more = vehicles.length > 20 ? vehicles.length - 20 : 0;
  const rows: MailRow[] = vehicles
    .slice(0, 20)
    .map((v) => ({ label: v.plate, plate: true, note: v.ref, url: v.url }));
  return locale === 'tr'
    ? {
        to,
        locale,
        product: 'Kurumsal',
        subject: one
          ? `${company}: ${vehicles[0]?.plate ?? ''} yedieminde`
          : `${company}: ${String(vehicles.length)} araç yedieminde`,
        paragraphs: [
          one
            ? 'Aşağıdaki araç kolluk tarafından yakalanarak yediemine teslim edildi. Teslim belgeleri dosyada.'
            : `${String(vehicles.length)} araç kolluk tarafından yakalanarak yediemine teslim edildi. Teslim belgeleri dosyalarda.`,
        ],
        rows,
        after: [...(more ? [`ve ${String(more)} araç daha.`] : []), NOTICE_WHY.tr],
      }
    : {
        to,
        locale,
        product: 'Kurumsal',
        subject: one
          ? `${company}: ${vehicles[0]?.plate ?? ''} is in custody`
          : `${company}: ${String(vehicles.length)} vehicles in custody`,
        paragraphs: [
          one
            ? 'The police seized this vehicle and delivered it to a custodian car park. The documents are on the case.'
            : `The police seized ${String(vehicles.length)} vehicles and delivered them to a custodian car park. The documents are on the cases.`,
        ],
        rows,
        after: [...(more ? [`and ${String(more)} more.`] : []), NOTICE_WHY.en],
      };
}

/** To a partner's operations contact: cases that expire soon unless confirmed. */
export function expiringMail(
  locale: MailLocale,
  to: string,
  company: string,
  count: number,
  first: number,
  url: string,
  days = 3,
): Mail {
  return locale === 'tr'
    ? {
        to,
        locale,
        product: 'Kurumsal',
        subject: `${company}: ${String(count)} dosyanın süresi doluyor`,
        paragraphs: [
          `${String(count)} dosyanın süresi ${String(days)} gün içinde doluyor; ilki ${turkeyDay(first, locale)}. Süresi dolan dosyada saha görevlileri aramayı bırakır.`,
          'Yakalama şerhi hâlâ geçerli olanları Genel bakış sayfasında tek seferde onaylayabilirsiniz.',
        ],
        action: { label: 'Dosyaları onayla', url },
        after: [NOTICE_WHY.tr],
      }
    : {
        to,
        locale,
        product: 'Kurumsal',
        subject: `${company}: ${String(count)} cases are about to expire`,
        paragraphs: [
          `${String(count)} cases expire within ${String(days)} days, the first on ${turkeyDay(first, locale)}. Agents stop looking when a case expires.`,
          'Confirm the ones whose seizure order still stands, all at once, on the Overview page.',
        ],
        action: { label: 'Confirm cases', url },
        after: [NOTICE_WHY.en],
      };
}

// ---- To agents ----------------------------------------------------------------------------------

/** To an agent: the code that proves this address is theirs. */
export function emailCodeMail(locale: MailLocale, to: string, code: string, minutes = 15): Mail {
  return locale === 'tr'
    ? {
        to,
        locale,
        product: 'Saha',
        subject: `Emanet Saha doğrulama kodunuz: ${code}`,
        paragraphs: ['Emanet Saha başvurunuz için e-posta adresinizi bu kodla doğrulayın.'],
        code,
        after: [
          `Kod ${String(minutes)} dakika geçerlidir. Bu isteği siz yapmadıysanız bu e-postayı yok sayabilirsiniz.`,
        ],
      }
    : {
        to,
        locale,
        product: 'Saha',
        subject: `Your Emanet Saha code: ${code}`,
        paragraphs: ['Confirm your email address for your Emanet Saha application with this code.'],
        code,
        after: [
          `The code is valid for ${String(minutes)} minutes. If you didn’t ask for it, ignore this email.`,
        ],
      };
}

export type AgentNotice =
  | { kind: 'received'; days: number }
  | { kind: 'approved' }
  | { kind: 'returned'; reason: string }
  | { kind: 'suspended'; reason: string }
  | { kind: 'banned'; reason: string }
  | { kind: 'reinstated' }
  | { kind: 'delivery_accepted'; plate: string | null }
  | { kind: 'delivery_refused'; plate: string | null; reason: string; strikes: number | null }
  | { kind: 'payout_sent' }
  /** Staff ask for details or documents: one line per thing asked, in staff's words. */
  | { kind: 'requested'; items: string[]; days: number }
  /** A request is nearly out of time. */
  | { kind: 'request_reminder'; items: string[]; days: number }
  | { kind: 'erasure_received'; days: number }
  | { kind: 'erasure_done'; years: number }
  | { kind: 'erasure_refused'; reason: string };

const AGENT_WHY = {
  tr: 'Bu e-postayı Emanet Saha hesabınızla ilgili bir karar verildiği için alıyorsunuz. Sorularınız için bu e-postayı yanıtlayın.',
  en: 'You get this email because a decision was made on your Emanet Saha account. Reply to this email with any question.',
} as const;

/** To an agent: what was decided about their application, a delivery or a payout. Never why in more words than staff wrote. */
export function agentMail(locale: MailLocale, to: string, notice: AgentNotice, saha: string): Mail {
  const tr = locale === 'tr';
  const base = { to, locale, product: 'Saha' as const, after: [AGENT_WHY[locale]] };
  const plate = (value: string | null): MailRow[] => (value ? [{ label: value, plate: true }] : []);
  switch (notice.kind) {
    case 'received':
      return {
        ...base,
        subject: tr ? 'Emanet Saha başvurunuz alındı' : 'We have your Emanet Saha application',
        paragraphs: tr
          ? [
              'Başvurunuz bize ulaştı. Sıradaki adım kısa bir görüntülü görüşme: kimliğinizi ve banka hesabınızı doğrularız.',
              `Görüşme için sizi ${String(notice.days)} gün içinde arayacağız. Bu sürede bir şey yapmanız gerekmez.`,
            ]
          : [
              'Your application has reached us. The next step is a short video call in which we check your identity and bank account.',
              `We will call you within ${String(notice.days)} days. There is nothing you need to do until then.`,
            ],
        action: { label: tr ? 'Başvurumu gör' : 'See my application', url: `${saha}/apply` },
      };
    case 'approved':
      return {
        ...base,
        subject: tr ? 'Emanet Saha hesabınız etkin' : 'Your Emanet Saha account is active',
        paragraphs: tr
          ? [
              'Kimliğiniz doğrulandı ve hesabınız etkinleştirildi. Artık şehrinizdeki araçları görebilir ve üstlenebilirsiniz.',
              'Kural değişmez: araca dokunmazsınız, kimseyle borç konuşmazsınız; aracı görünce fotoğraflar ve 112’yi ararsınız.',
            ]
          : [
              'Your identity is confirmed and your account is active. You can now see and claim vehicles in your city.',
              'The rule doesn’t change: you never touch the vehicle or discuss the debt; when you see it, you photograph it and call 112.',
            ],
        action: { label: tr ? 'Araçları gör' : 'See vehicles', url: `${saha}/` },
      };
    case 'returned':
      return {
        ...base,
        subject: tr
          ? 'Emanet Saha başvurunuzda düzeltme gerekiyor'
          : 'Your Emanet Saha application needs a change',
        paragraphs: tr
          ? [
              'Başvurunuzu inceledik; devam edebilmemiz için bir düzeltme gerekiyor:',
              notice.reason,
              'Bilgilerinizi düzeltip başvurunuzu yeniden gönderebilirsiniz.',
            ]
          : [
              'We looked at your application and need one thing changed before we can go on:',
              notice.reason,
              'Correct your details and send the application again.',
            ],
        action: {
          label: tr ? 'Başvuruyu düzelt' : 'Correct the application',
          url: `${saha}/apply`,
        },
      };
    case 'suspended':
    case 'banned': {
      const banned = notice.kind === 'banned';
      return {
        ...base,
        subject: tr
          ? banned
            ? 'Emanet Saha hesabınız kapatıldı'
            : 'Emanet Saha hesabınız askıya alındı'
          : banned
            ? 'Your Emanet Saha account was closed'
            : 'Your Emanet Saha account was suspended',
        paragraphs: tr
          ? [
              banned
                ? 'Emanet Saha hesabınız kapatıldı. Yeni araç üstlenemezsiniz; üstlendiğiniz araçlar bırakıldı.'
                : 'Emanet Saha hesabınız askıya alındı. Bu sürede araç üstlenemezsiniz; üstlendiğiniz araçlar bırakıldı.',
              `Gerekçe: ${notice.reason}`,
              'Onaylanmış teslimlerinizin ödemesi bundan etkilenmez. Karara itiraz etmek için bu e-postayı yanıtlayın.',
            ]
          : [
              banned
                ? 'Your Emanet Saha account was closed. You can’t claim vehicles, and the ones you held were released.'
                : 'Your Emanet Saha account was suspended. Meanwhile you can’t claim vehicles, and the ones you held were released.',
              `Reason: ${notice.reason}`,
              'Payment for deliveries already confirmed is not affected. To object, reply to this email.',
            ],
      };
    }
    case 'reinstated':
      return {
        ...base,
        subject: tr
          ? 'Emanet Saha hesabınız yeniden etkin'
          : 'Your Emanet Saha account is active again',
        paragraphs: tr
          ? ['Hesabınız yeniden etkinleştirildi. Araçları görebilir ve üstlenebilirsiniz.']
          : ['Your account is active again. You can see and claim vehicles.'],
        action: { label: tr ? 'Araçları gör' : 'See vehicles', url: `${saha}/` },
      };
    case 'delivery_accepted':
      return {
        ...base,
        subject: tr ? 'Tesliminiz onaylandı' : 'Your delivery was confirmed',
        paragraphs: tr
          ? [
              'Bildirdiğiniz teslim incelendi ve onaylandı. Ödemeniz hazırlanıyor; durumunu Kazançlar sayfasında görebilirsiniz.',
            ]
          : [
              'The delivery you reported was checked and confirmed. Your payment is being prepared; follow it on the Earnings page.',
            ],
        rows: plate(notice.plate),
        action: { label: tr ? 'Kazançlarım' : 'My earnings', url: `${saha}/earnings` },
      };
    case 'delivery_refused':
      return {
        ...base,
        subject: tr ? 'Tesliminiz onaylanmadı' : 'Your delivery was not confirmed',
        paragraphs: tr
          ? [
              'Bildirdiğiniz teslim incelendi ve onaylanmadı. Bu teslim için ödeme yapılmayacak.',
              `Gerekçe: ${notice.reason}`,
              ...(notice.strikes !== null
                ? [
                    `Bu bildirim hesabınıza bir ihtar olarak işlendi (toplam ${String(notice.strikes)}). İhtarlar hesabın askıya alınmasına yol açabilir.`,
                  ]
                : []),
              'Kararın yanlış olduğunu düşünüyorsanız bu e-postayı yanıtlayın.',
            ]
          : [
              'The delivery you reported was checked and not confirmed. There will be no payment for it.',
              `Reason: ${notice.reason}`,
              ...(notice.strikes !== null
                ? [
                    `This report was recorded as a strike on your account (${String(notice.strikes)} in total). Strikes can lead to suspension.`,
                  ]
                : []),
              'If you think the decision is wrong, reply to this email.',
            ],
        rows: plate(notice.plate),
      };
    case 'payout_sent':
      return {
        ...base,
        subject: tr ? 'Ödemeniz gönderildi' : 'Your payment was sent',
        paragraphs: tr
          ? [
              'Bir ödemeniz kayıtlı IBAN’ınıza gönderildi. Bankanıza göre hesabınıza geçmesi bir iş günü sürebilir.',
            ]
          : [
              'A payment was sent to your registered IBAN. Depending on your bank it can take a working day to arrive.',
            ],
        action: { label: tr ? 'Kazançlarım' : 'My earnings', url: `${saha}/earnings` },
      };
    case 'requested':
      return {
        ...base,
        subject: tr
          ? 'Emanet Saha: sizden bilgi veya belge bekliyoruz'
          : 'Emanet Saha: we need something from you',
        paragraphs: tr
          ? [
              'Hesabınızla ilgili işleme devam edebilmemiz için aşağıdakilere ihtiyacımız var:',
              ...notice.items.map((item) => `• ${item}`),
              `Lütfen ${String(notice.days)} gün içinde Emanet Saha’da “Sizden beklenenler” bölümünden yanıtlayın. Belgeleri e-postayla göndermeyin.`,
            ]
          : [
              'To go on with your account we need the following from you:',
              ...notice.items.map((item) => `• ${item}`),
              `Please answer within ${String(notice.days)} days under “What we need from you” in Emanet Saha. Don’t send documents by email.`,
            ],
        action: { label: tr ? 'Yanıtla' : 'Answer', url: `${saha}/requests` },
      };
    case 'request_reminder':
      return {
        ...base,
        subject: tr
          ? 'Emanet Saha: bekleyen isteğimiz için süre azalıyor'
          : 'Emanet Saha: time is running out on what we asked for',
        paragraphs: tr
          ? [
              'Aşağıdakileri hâlâ bekliyoruz:',
              ...notice.items.map((item) => `• ${item}`),
              `Yanıtlamanız için en fazla ${String(notice.days)} gün kaldı. Süre dolarsa başvurunuz ya da hesabınız bu yüzden bekletilebilir.`,
            ]
          : [
              'We are still waiting for the following:',
              ...notice.items.map((item) => `• ${item}`),
              `You have ${String(notice.days)} days left to answer. If the time runs out, your application or account may be held for this reason.`,
            ],
        action: { label: tr ? 'Yanıtla' : 'Answer', url: `${saha}/requests` },
      };
    case 'erasure_received':
      return {
        ...base,
        subject: tr ? 'Veri silme talebiniz alındı' : 'We have your request to erase your data',
        paragraphs: tr
          ? [
              'Kişisel verilerinizin silinmesi talebiniz bize ulaştı.',
              `Talebinizi en geç ${String(notice.days)} gün içinde sonuçlandırıp size bildireceğiz. Karar verilene kadar talebinizi Emanet Saha’dan geri alabilirsiniz.`,
            ]
          : [
              'Your request to have your personal data erased has reached us.',
              `We will decide and tell you within ${String(notice.days)} days at the latest. Until then you can withdraw the request in Emanet Saha.`,
            ],
        action: { label: tr ? 'Talebimi gör' : 'See my request', url: `${saha}/privacy` },
      };
    case 'erasure_done':
      return {
        ...base,
        subject: tr ? 'Kişisel verileriniz silindi' : 'Your personal data was erased',
        paragraphs: tr
          ? [
              'Talebiniz üzerine Emanet Saha hesabınızdaki kişisel verileriniz silindi ve hesabınız kapatıldı.',
              'Mevzuat gereği saklanması zorunlu olan ödeme ve muhasebe kayıtları süresi dolana kadar tutulur.',
              `Silinen verilerin şifreli bir kopyası, yalnızca hukuki yükümlülükler ve olası uyuşmazlıklar için, erişimi kısıtlı ve kayıt altında olacak biçimde en çok ${String(notice.years)} yıl saklanır; süre sonunda yok edilir. Bu e-posta, bu adrese göndereceğimiz son e-postadır.`,
            ]
          : [
              'As you asked, the personal data in your Emanet Saha account was erased and the account closed.',
              'Payment and accounting records the law requires us to keep stay until their period ends.',
              `A sealed copy of what was erased is kept for at most ${String(notice.years)} years, only for legal obligations and possible disputes, with restricted and recorded access; it is destroyed when the period ends. This is the last email we send to this address.`,
            ],
      };
    case 'erasure_refused':
      return {
        ...base,
        subject: tr
          ? 'Veri silme talebiniz hakkında karar'
          : 'A decision on your request to erase your data',
        paragraphs: tr
          ? [
              'Kişisel verilerinizin silinmesi talebiniz şu an yerine getirilemedi.',
              `Gerekçe: ${notice.reason}`,
              'Karara itiraz etmek için bu e-postayı yanıtlayabilir veya Kişisel Verileri Koruma Kurulu’na şikâyette bulunabilirsiniz.',
            ]
          : [
              'Your request to have your personal data erased could not be carried out now.',
              `Reason: ${notice.reason}`,
              'To object, reply to this email; you can also complain to the Personal Data Protection Board.',
            ],
        action: { label: tr ? 'Talebimi gör' : 'See my request', url: `${saha}/privacy` },
      };
  }
}

// ---- To staff -----------------------------------------------------------------------------------

/** To 2earl's staff: something failed and nobody has been told yet. Names of events, never data. */
export function opsAlertMail(to: string, lines: string[], url: string): Mail {
  return {
    to,
    locale: 'tr',
    product: 'Merkez',
    subject: `Emanet: ${String(lines.length)} konuda uyarı`,
    paragraphs: ['Son uyarıdan bu yana kaydedilenler:'],
    rows: lines.map((label) => ({ label })),
    action: { label: 'Sistem sayfasını aç', url },
  };
}
