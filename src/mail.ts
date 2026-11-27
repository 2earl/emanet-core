/**
 * Emanet's email to companies being onboarded, and to 2earl's staff about them. Cloudflare Email
 * Service (the MAILER binding), from noreply@emanet.dev; replies reach iletisim@emanet.dev, the
 * one address Emanet gives everyone.
 *
 * Plain text and a small HTML version, in the language chosen when the company was invited. No
 * images, no tracking. Links go only to Emanet's own sites. Sending never throws.
 */

export type MailLocale = 'tr' | 'en';

export interface Mail {
  to: string;
  subject: string;
  paragraphs: string[];
  action?: { label: string; url: string };
  after?: string[];
}

export type Send = (mail: Mail) => Promise<boolean>;

const SENDER = { email: 'noreply@emanet.dev', name: 'Emanet' };
export const REPLY_TO = 'iletisim@emanet.dev';
const FOOTER = 'Emanet · emanet.dev · iletisim@emanet.dev';

const esc = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function text(mail: Mail): string {
  return [
    ...mail.paragraphs,
    ...(mail.action ? [`${mail.action.label}: ${mail.action.url}`] : []),
    ...(mail.after ?? []),
    `—\n${FOOTER}\nGizlilik: https://emanet.dev/gizlilik`,
  ].join('\n\n');
}

function html(mail: Mail): string {
  const p = (t: string, small = false) =>
    `<p style="margin:0 0 16px;font-size:${small ? '13px' : '15px'};line-height:1.5;color:${small ? '#5c5a60' : '#1c1b1f'}">${esc(t)}</p>`;
  const button = mail.action
    ? `<p style="margin:24px 0"><a href="${esc(mail.action.url)}" style="background:#b9381b;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px">${esc(mail.action.label)}</a></p><p style="margin:0 0 16px;font-size:12px;color:#5c5a60;word-break:break-all">${esc(mail.action.url)}</p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f7f7f8;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif"><div style="max-width:560px;margin:0 auto;padding:32px 24px;background:#ffffff"><p style="margin:0 0 24px;font-weight:700;font-size:16px">Emanet</p>${mail.paragraphs.map((t) => p(t)).join('')}${button}${(mail.after ?? []).map((t) => p(t, true)).join('')}<p style="margin:32px 0 0;font-size:12px;color:#5c5a60">${esc(FOOTER)} · <a href="https://emanet.dev/gizlilik" style="color:#5c5a60">Gizlilik</a></p></div></body></html>`;
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

export function signedMail(to: string, company: string, url: string): Mail {
  return {
    to,
    subject: `Emanet: ${company} signed the agreement`,
    paragraphs: [
      `${company} has accepted the Emanet agreement. Check their details and documents, then approve or reject them in Emanet Merkez.`,
    ],
    action: { label: 'Open in Emanet Merkez', url },
  };
}

export function approvedMail(locale: MailLocale, to: string, company: string, url: string): Mail {
  return locale === 'tr'
    ? {
        to,
        subject: `${company} Emanet’te etkin`,
        paragraphs: [
          `${company} için Emanet hesabı onaylandı. Artık araçlarınızı form, CSV veya API ile ekleyebilir, ekip arkadaşlarınızı davet edebilir ve bildirim adreslerinizi tanımlayabilirsiniz.`,
        ],
        action: { label: 'Emanet Kurumsal’a git', url },
        after: ['Sorularınız için bu e-postayı yanıtlayabilirsiniz.'],
      }
    : {
        to,
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
        subject: `${company} için Emanet başvurusu`,
        paragraphs: [
          `${company} için Emanet başvurusunu şu anda onaylayamıyoruz.`,
          `Neden: ${reason}`,
          'Sorularınız için bu e-postayı yanıtlayabilirsiniz.',
        ],
      }
    : {
        to,
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
        subject: `${company}: Emanet başvurusunda düzeltme gerekiyor`,
        paragraphs: [
          `${company} için Emanet başvurusunda bir düzeltme gerekiyor: ${reason}`,
          'Bilgileri düzelttikten sonra sözleşmeyi yeniden onaylamanız gerekir; önceki onay geçersiz sayılmıştır.',
        ],
        action: { label: 'Başvuruya git', url },
      }
    : {
        to,
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

/** To a partner's operations contact: vehicles that reached custody. */
export function deliveredMail(
  locale: MailLocale,
  to: string,
  company: string,
  vehicles: { plate: string; ref: string; url: string }[],
): Mail {
  const one = vehicles.length === 1;
  const lines = vehicles.slice(0, 20).map((v) => `${v.plate} · ${v.ref} · ${v.url}`);
  const more = vehicles.length > 20 ? vehicles.length - 20 : 0;
  return locale === 'tr'
    ? {
        to,
        subject: one
          ? `${company}: ${vehicles[0]?.plate ?? ''} yedieminde`
          : `${company}: ${String(vehicles.length)} araç yedieminde`,
        paragraphs: [
          one
            ? 'Aşağıdaki araç kolluk tarafından yakalanarak yediemine teslim edildi. Teslim belgeleri dosyada.'
            : `${String(vehicles.length)} araç kolluk tarafından yakalanarak yediemine teslim edildi. Teslim belgeleri dosyalarda.`,
          ...lines,
          ...(more ? [`ve ${String(more)} araç daha.`] : []),
        ],
        after: [
          'Bu bildirimleri kurumunuzun operasyon iletişim adresi olarak alıyorsunuz. Kapatmak için bu e-postayı yanıtlayın.',
        ],
      }
    : {
        to,
        subject: one
          ? `${company}: ${vehicles[0]?.plate ?? ''} is in custody`
          : `${company}: ${String(vehicles.length)} vehicles in custody`,
        paragraphs: [
          one
            ? 'The police seized this vehicle and delivered it to a custodian car park. The documents are on the case.'
            : `The police seized ${String(vehicles.length)} vehicles and delivered them to a custodian car park. The documents are on the cases.`,
          ...lines,
          ...(more ? [`and ${String(more)} more.`] : []),
        ],
        after: [
          'You get these notices as your company’s operations contact. Reply to this email to turn them off.',
        ],
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
): Mail {
  return locale === 'tr'
    ? {
        to,
        subject: `${company}: ${String(count)} dosyanın süresi doluyor`,
        paragraphs: [
          `${String(count)} dosyanın süresi üç gün içinde doluyor; ilki ${turkeyDay(first, locale)}. Süresi dolan dosyada saha görevlileri aramayı bırakır.`,
          'Yakalama şerhi hâlâ geçerli olanları Genel bakış sayfasında tek seferde onaylayabilirsiniz.',
        ],
        action: { label: 'Dosyaları onayla', url },
        after: [
          'Bu bildirimleri kurumunuzun operasyon iletişim adresi olarak alıyorsunuz. Kapatmak için bu e-postayı yanıtlayın.',
        ],
      }
    : {
        to,
        subject: `${company}: ${String(count)} cases are about to expire`,
        paragraphs: [
          `${String(count)} cases expire within three days, the first on ${turkeyDay(first, locale)}. Agents stop looking when a case expires.`,
          'Confirm the ones whose seizure order still stands, all at once, on the Overview page.',
        ],
        action: { label: 'Confirm cases', url },
        after: [
          'You get these notices as your company’s operations contact. Reply to this email to turn them off.',
        ],
      };
}

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
        subject: `${company}: Emanet sözleşmesi onaya hazır`,
        paragraphs: [
          '2earl sözleşmedeki kendi bilgilerini tamamladı. Emanet Hizmet Sözleşmesi’ni artık okuyup onaylayabilirsiniz.',
        ],
        action: { label: 'Sözleşmeye git', url },
      }
    : {
        to,
        subject: `${company}: the Emanet agreement is ready to accept`,
        paragraphs: [
          '2earl has completed its own details in the agreement. You can read and accept the Emanet service agreement now.',
        ],
        action: { label: 'Open the agreement', url },
      };
}

/** To an agent: the code that proves this address is theirs. */
export function emailCodeMail(locale: MailLocale, to: string, code: string): Mail {
  return locale === 'tr'
    ? {
        to,
        subject: `Emanet Saha doğrulama kodunuz: ${code}`,
        paragraphs: [
          'Emanet Saha başvurunuz için e-posta adresinizi doğrulayın.',
          `Kodunuz: ${code}`,
          'Kod 15 dakika geçerlidir. Bu isteği siz yapmadıysanız bu e-postayı yok sayabilirsiniz.',
        ],
      }
    : {
        to,
        subject: `Your Emanet Saha code: ${code}`,
        paragraphs: [
          'Confirm your email address for your Emanet Saha application.',
          `Your code: ${code}`,
          'The code is valid for 15 minutes. If you didn’t ask for it, ignore this email.',
        ],
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
        subject: `${company}: Emanet webhook’u kapatıldı`,
        paragraphs: [
          `${host} adresindeki webhook’unuz art arda başarısız olduğu için kapatıldı. Yeni olaylar bu adrese gönderilmiyor.`,
          'Adresinizin yanıt verdiğini kontrol edin, ardından webhook’u Emanet Kurumsal’dan yeniden açın. Bu sürede olaylara API üzerinden (GET /api/v1/events) erişebilirsiniz.',
        ],
        action: { label: 'Webhook’ları aç', url },
      }
    : {
        to,
        subject: `${company}: an Emanet webhook was switched off`,
        paragraphs: [
          `Your webhook at ${host} failed repeatedly and was switched off. New events are not being sent to it.`,
          'Check that your endpoint answers, then switch the webhook back on in Emanet Kurumsal. Meanwhile the events are available from the API (GET /api/v1/events).',
        ],
        action: { label: 'Open webhooks', url },
      };
}

/** To 2earl's staff: something failed and nobody has been told yet. Names of events, never data. */
export function opsAlertMail(to: string, lines: string[], url: string): Mail {
  return {
    to,
    subject: `Emanet: ${String(lines.length)} kind(s) of error`,
    paragraphs: ['Errors since the last alert:', ...lines],
    action: { label: 'Open the System page', url },
  };
}
