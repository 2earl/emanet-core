/**
 * What a field agent agrees to before they can apply (docs/DESIGN.md §6): the agent agreement, the
 * privacy notice for agents, and the explicit consent for the criminal-record check. Three texts,
 * accepted separately, because the law treats them separately: an agreement is accepted, a notice
 * is only read, and consent to special-category data must be specific and free (KVKK m.6).
 *
 * The Turkish text is the binding one; the English is a courtesy translation. An acceptance keeps
 * the version and the SHA-256 of the Turkish text as shown, so what a person agreed to can always
 * be shown again, word for word.
 *
 * DRAFT: written to be reviewed by a lawyer before the first agent is admitted. Changing a word
 * here means a new AGREEMENT_VERSION; agents who accepted an older version are asked again.
 */

export const AGREEMENT_VERSION = '2026-11-28-taslak-2';

export type AgreementLocale = 'tr' | 'en';

export interface AgreementSection {
  title: string;
  paragraphs: string[];
}

export interface AgreementText {
  title: string;
  intro: string;
  sections: AgreementSection[];
}

const AGREEMENT: Record<AgreementLocale, AgreementText> = {
  tr: {
    title: 'Emanet Saha Görevlisi Sözleşmesi',
    intro:
      'Bu sözleşme, Emanet hizmetini işleten 2earl (“Emanet”) ile Emanet Saha uygulamasına başvuran gerçek kişi (“Görevli”) arasında, Görevli’nin elektronik ortamda onaylamasıyla kurulur.',
    sections: [
      {
        title: '1. Konu',
        paragraphs: [
          'Emanet, alacaklı kurumların üzerinde yakalama şerhi bulunan araçlarının yerinin tespitine yardımcı olur. Görevli, Emanet Saha uygulamasında gösterilen araçları kamuya açık alanlarda arar; aracı gördüğünde uygulama üzerinden fotoğrafını ve konumunu gönderir ve 112’yi arayarak kolluğa bildirir.',
          'Aracın yakalanması, muhafaza altına alınması ve yediemine teslimi yalnızca kolluğun ve yetkili mercilerin işidir. Görevli bu işlemlerin hiçbirini yapmaz.',
        ],
      },
      {
        title: '2. İlişkinin niteliği',
        paragraphs: [
          'Görevli, işini kendi adına, kendi araç ve gereçleriyle, kendi belirlediği zamanda ve bağımsız olarak yapar. Taraflar arasında iş sözleşmesi, acentelik, ortaklık veya vekâlet ilişkisi yoktur. Emanet, Görevli’ye belirli bir iş, süre veya kazanç taahhüt etmez; Görevli de belirli bir süre çalışmayı taahhüt etmez.',
          'Görevli, Emanet’i veya alacaklı kurumu temsil edemez; onlar adına beyanda bulunamaz, taahhüt altına giremez, tahsilat yapamaz.',
          'Görevli kamu görevlisi değildir. Kendisini polis, icra memuru, avukat, banka görevlisi veya herhangi bir resmî sıfatla tanıtamaz.',
        ],
      },
      {
        title: '3. Kesin yasaklar',
        paragraphs: [
          'Görevli aşağıdakileri hiçbir koşulda yapmaz:',
          'a) Araca dokunmak, aracı açmak, çekmek, taşımak, yerinden oynatmak, önünü kesmek veya aracın hareketini engellemek.',
          'b) Bir kişiyi takip etmek, gözetlemek, beklemek veya ısrarla izlemek (TCK m.123/A).',
          'c) Araç sahibi, kullanıcısı veya yakınlarıyla borç, icra dosyası veya araç hakkında konuşmak; onlardan bilgi, belge, para veya herhangi bir menfaat istemek veya almak.',
          'ç) Konuta, işyerine, kapalı otoparka, siteye veya girişi izne bağlı herhangi bir yere izinsiz girmek.',
          'd) Kişilerin yüzünü, konutunun içini veya araçla ilgisi olmayan herhangi bir şeyi fotoğraflamak; uygulama dışında fotoğraf çekmek veya saklamak.',
          'e) Tehdit, baskı, hile veya zor kullanmak; gerginlik çıktığında olay yerinde kalmak.',
          'f) Adresleri veya dosyaya ilişkin herhangi bir bilgiyi yazmak, kopyalamak, ekran görüntüsünü almak, üçüncü kişilerle paylaşmak veya başka bir amaçla kullanmak.',
          'g) Hesabını başkasına kullandırmak veya başkasının hesabını kullanmak.',
          'Bu yasaklardan birinin ihlali sözleşmenin derhâl feshi sebebidir; Emanet ihlali yetkili mercilere bildirebilir.',
        ],
      },
      {
        title: '4. Kimlik doğrulama ve belgeler',
        paragraphs: [
          'Görevli; adını, T.C. kimlik numarasını, doğum yılını, adresini, cep telefonu numarasını ve kendi adına kayıtlı IBAN’ını doğru olarak bildirir. e-Devlet Kapısı’ndan alınmış barkodlu adli sicil kaydını ve nüfus kayıt örneğini yükler ve Emanet’in yapacağı görüntülü görüşmeye kimlik kartıyla katılır.',
          'Bir kişi yalnızca bir hesap açabilir. Yanlış veya yanıltıcı bilgi verilmesi, sahte veya değiştirilmiş belge sunulması hâlinde başvuru reddedilir veya sözleşme feshedilir.',
          'Emanet, başvuruyu gerekçe göstererek veya göstermeden reddedebilir.',
        ],
      },
      {
        title: '5. Gizlilik ve kişisel veriler',
        paragraphs: [
          'Görevli, uygulamada gördüğü adresleri ve diğer bilgileri yalnızca üstlendiği aracı aramak için, yalnızca üstlenme süresince kullanır. Bu bilgiler Görevli’ye, Emanet’in talimatıyla ve Emanet adına işlenmek üzere gösterilir; Görevli bunları kendi amacıyla işleyemez (6698 sayılı Kanun m.12).',
          'Görevli, bilgilerin yetkisiz kişilerce görülmesini önlemek için cihazını korur. Cihazının kaybolması, hesabına yetkisiz erişim veya bilgilerin açığa çıkması hâlinde durumu öğrendiği andan itibaren en geç 24 saat içinde iletisim@emanet.dev adresine bildirir.',
          'Gizlilik yükümlülüğü sözleşme sona erdikten sonra da süresiz olarak devam eder.',
          'Görevli’nin kendi kişisel verilerinin nasıl işlendiği Saha Görevlisi Aydınlatma Metni’nde açıklanmıştır.',
        ],
      },
      {
        title: '6. Ücret ve ödeme',
        paragraphs: [
          'Görevli’ye yalnızca, bildirdiği aracın kollukça yakalanıp yediemine teslim edildiğinin Emanet tarafından belgeler üzerinden onaylanması hâlinde ödeme yapılır. Arama, görme bildirimi veya onaylanmayan teslim için ödeme yapılmaz; Görevli’nin masrafları kendisine aittir.',
          'Ödeme tutarı, teslimin onaylandığı tarihte geçerli olan ve uygulamada araç için gösterilen tutardır. Ödeme, alacaklı kurumun ilgili faturayı ödemesinden sonra, Görevli’nin kendi adına kayıtlı ve Emanet’çe doğrulanmış IBAN’ına yapılır.',
          'Emanet, vergi mevzuatının gerektirdiği kesintileri (gelir vergisi stopajı dâhil) yapar ve gereken belgeyi düzenler. Görevli, vergi mükellefi ise mevzuatın gerektirdiği belgeyi (fatura veya serbest meslek makbuzu) düzenler. Kendi vergi ve sosyal güvenlik yükümlülükleri Görevli’ye aittir.',
        ],
      },
      {
        title: '7. İhtar, askıya alma ve fesih',
        paragraphs: [
          'Yanlış veya özensiz teslim bildirimi ihtar olarak kaydedilebilir. İhtar sayısı Emanet’in belirlediği sınıra ulaştığında hesap askıya alınır.',
          'Emanet, bu sözleşmenin veya saha kurallarının ihlali, yanlış beyan, şikâyet veya soruşturma hâlinde hesabı derhâl askıya alabilir veya sözleşmeyi feshedebilir. Karar ve gerekçesi Görevli’ye e-postayla bildirilir; Görevli aynı adrese yanıt vererek itiraz edebilir.',
          'Görevli, hesabını dilediği zaman kapatarak sözleşmeyi sona erdirebilir. Sona ermeden önce onaylanmış teslimlerin ödemesi yapılır.',
        ],
      },
      {
        title: '8. Sorumluluk',
        paragraphs: [
          'Görevli, kendi eylemlerinden ve bu sözleşmeye aykırı davranışlarından doğan her türlü hukukî, cezaî ve idarî sorumluluğun kendisine ait olduğunu kabul eder. Emanet’in veya alacaklı kurumun bu nedenle üçüncü kişilere ödemek zorunda kaldığı tutarlar Görevli’ye rücu edilir.',
          'Görevli, işini yaparken trafik kurallarına ve kendi güvenliğine ilişkin tedbirlere uymakla yükümlüdür; kendisinin veya üçüncü kişilerin uğrayacağı zararlardan Emanet sorumlu değildir.',
          'Emanet, uygulamanın kesintisiz çalışacağını, belirli sayıda araç gösterileceğini veya Görevli’nin kazanç elde edeceğini taahhüt etmez.',
        ],
      },
      {
        title: '9. Kayıtlar ve deliller',
        paragraphs: [
          'Görevli’nin uygulamadaki işlemleri (üstlenme, adres görüntüleme, konum, fotoğraf, onaylar) tarih ve saatiyle kaydedilir. Taraflar, Emanet’in elektronik kayıtlarının bu sözleşmeden doğan uyuşmazlıklarda delil olacağını kabul eder (HMK m.193).',
        ],
      },
      {
        title: '10. Değişiklik, bildirim, uygulanacak hukuk',
        paragraphs: [
          'Emanet bu sözleşmeyi değiştirdiğinde yeni metin uygulamada gösterilir; Görevli yeni metni onaylamadan çalışmaya devam edemez.',
          'Bildirimler Görevli’nin doğruladığı e-posta adresine yapılır.',
          'Bu sözleşmeye Türk hukuku uygulanır. Uyuşmazlıklarda Emanet’i işleten şirketin merkezinin bulunduğu yer mahkemeleri ve icra daireleri yetkilidir.',
        ],
      },
    ],
  },
  en: {
    title: 'Emanet Field Agent Agreement',
    intro:
      'This agreement is made between 2earl, which operates Emanet (“Emanet”), and the person applying to Emanet Saha (the “Agent”), when the Agent accepts it electronically. This English text is a translation for convenience; the Turkish text is the binding one.',
    sections: [
      {
        title: '1. Subject',
        paragraphs: [
          'Emanet helps creditors locate their vehicles that carry a seizure order. The Agent looks for the vehicles shown in Emanet Saha in public places; on seeing one, sends its photo and location through the app and reports it to the police by calling 112.',
          'Seizing the vehicle, taking it into custody and delivering it to a custodian are the work of the police and the competent authorities alone. The Agent does none of these.',
        ],
      },
      {
        title: '2. The nature of the relationship',
        paragraphs: [
          'The Agent works in their own name, with their own means, at times of their own choosing, and independently. There is no employment, agency, partnership or mandate between the parties. Emanet promises no particular work, period or income; the Agent promises no particular period of work.',
          'The Agent can’t represent Emanet or a creditor, make statements or commitments for them, or collect money.',
          'The Agent is not a public official and must not present themselves as police, an enforcement officer, a lawyer, a bank employee or in any official capacity.',
        ],
      },
      {
        title: '3. Absolute prohibitions',
        paragraphs: [
          'The Agent never does any of the following:',
          'a) Touch, open, tow, carry, move or block a vehicle, or hinder its movement.',
          'b) Follow, watch, wait for or persistently observe a person (Turkish Penal Code art. 123/A).',
          'c) Speak to the owner, the driver or their relatives about the debt, the enforcement file or the vehicle; ask for or accept information, documents, money or any benefit from them.',
          'ç) Enter a home, a workplace, a closed car park, a gated estate or any place that needs permission, without it.',
          'd) Photograph people’s faces, the inside of a home, or anything unrelated to the vehicle; take or keep photos outside the app.',
          'e) Use threats, pressure, deceit or force; stay at the scene when things become tense.',
          'f) Write down, copy, screenshot, share with others or use for any other purpose the addresses or any information about a case.',
          'g) Let someone else use their account, or use someone else’s.',
          'A breach of any of these is cause for immediate termination, and Emanet may report it to the authorities.',
        ],
      },
      {
        title: '4. Identity checks and documents',
        paragraphs: [
          'The Agent gives their name, national ID number, year of birth, address, mobile number and an IBAN in their own name, truthfully; uploads a barcoded criminal record and population register extract obtained from e-Devlet; and joins a video call with Emanet, with their ID card.',
          'One person may open one account only. False or misleading information, or a forged or altered document, leads to refusal or termination.',
          'Emanet may refuse an application with or without giving a reason.',
        ],
      },
      {
        title: '5. Confidentiality and personal data',
        paragraphs: [
          'The Agent uses the addresses and other information seen in the app only to look for the vehicle they have claimed, and only while the claim lasts. This information is shown to the Agent to be processed on Emanet’s instructions and on its behalf; the Agent may not process it for purposes of their own (Law no. 6698, art. 12).',
          'The Agent protects their device so that others can’t see the information, and reports a lost device, unauthorized access to the account or any disclosure to iletisim@emanet.dev within 24 hours of learning of it.',
          'Confidentiality continues without limit of time after the agreement ends.',
          'How the Agent’s own personal data is processed is set out in the Privacy Notice for Field Agents.',
        ],
      },
      {
        title: '6. Payment',
        paragraphs: [
          'The Agent is paid only when Emanet has confirmed, on the documents, that the vehicle they reported was seized by the police and delivered to a custodian. Nothing is paid for searching, for a sighting, or for a delivery that isn’t confirmed; the Agent bears their own costs.',
          'The amount is the one in force on the day the delivery is confirmed and shown for the vehicle in the app. It is paid, after the creditor has paid the related invoice, to the IBAN in the Agent’s own name that Emanet has verified.',
          'Emanet makes the deductions tax law requires (including income tax withholding) and issues the document required. An Agent who is a taxpayer issues the document the law requires of them (an invoice or a self-employment receipt). The Agent’s own tax and social security obligations are theirs.',
        ],
      },
      {
        title: '7. Strikes, suspension and termination',
        paragraphs: [
          'A false or careless delivery report may be recorded as a strike. When strikes reach the limit Emanet sets, the account is suspended.',
          'Emanet may suspend the account or terminate the agreement at once for a breach of this agreement or the field rules, a false statement, a complaint or an investigation. The decision and its reason are emailed to the Agent, who may object by replying.',
          'The Agent may end the agreement at any time by closing their account. Deliveries confirmed before then are paid.',
        ],
      },
      {
        title: '8. Liability',
        paragraphs: [
          'The Agent accepts that all legal, criminal and administrative liability arising from their own acts and from conduct contrary to this agreement is theirs. Amounts Emanet or a creditor has to pay third parties for that reason are recovered from the Agent.',
          'The Agent must obey traffic rules and look after their own safety; Emanet is not liable for harm to the Agent or to others.',
          'Emanet does not promise that the app will work without interruption, that any number of vehicles will be shown, or that the Agent will earn anything.',
        ],
      },
      {
        title: '9. Records and evidence',
        paragraphs: [
          'The Agent’s actions in the app (claims, address views, location, photos, acceptances) are recorded with their date and time. The parties agree that Emanet’s electronic records are evidence in disputes arising from this agreement (Code of Civil Procedure art. 193).',
        ],
      },
      {
        title: '10. Changes, notices, governing law',
        paragraphs: [
          'When Emanet changes this agreement the new text is shown in the app; the Agent can’t continue working without accepting it.',
          'Notices are sent to the email address the Agent has verified.',
          'Turkish law applies. The courts and enforcement offices of the place where the company operating Emanet has its seat have jurisdiction.',
        ],
      },
    ],
  },
};

const NOTICE: Record<AgreementLocale, AgreementText> = {
  tr: {
    title: 'Saha Görevlisi Aydınlatma Metni',
    intro:
      '6698 sayılı Kişisel Verilerin Korunması Kanunu’nun 10. maddesi uyarınca, veri sorumlusu sıfatıyla 2earl (“Emanet”) saha görevlisi adaylarının ve görevlilerinin kişisel verilerini aşağıda açıklandığı şekilde işler.',
    sections: [
      {
        title: 'Hangi veriler, hangi amaçla',
        paragraphs: [
          'Kimlik (ad soyad, T.C. kimlik numarası, doğum yılı, nüfus kayıt örneğindeki bilgiler) ve iletişim (e-posta, cep telefonu, adres): kimliğinizin doğrulanması, bir kişinin tek hesap açmasının sağlanması, sizinle iletişim kurulması ve vergi mevzuatının gerektirdiği belgelerin düzenlenmesi.',
          'Finans (IBAN, vergi durumu, ödeme ve kesinti tutarları): ödemelerin yapılması ve muhasebe kayıtlarının tutulması.',
          'İşlem güvenliği ve konum (üstlenme, adres görüntüleme kayıtları, görme bildirimindeki konum, fotoğraflar): hizmetin yürütülmesi, teslimlerin doğrulanması, kötüye kullanımın önlenmesi.',
          'Ceza mahkûmiyeti verisi (adli sicil kaydı): borçluların adreslerine erişecek kişinin bu göreve uygunluğunun değerlendirilmesi. Bu veri yalnızca açık rızanızla işlenir.',
        ],
      },
      {
        title: 'Hukuki sebepler',
        paragraphs: [
          'Sözleşmenin kurulması ve ifası (m.5/2-c), hukuki yükümlülüğün yerine getirilmesi (m.5/2-ç; vergi ve ticaret mevzuatı), meşru menfaat (m.5/2-f; güvenlik ve kötüye kullanımın önlenmesi) ve ceza mahkûmiyeti verisi için açık rıza (m.6).',
        ],
      },
      {
        title: 'Saklama süreleri',
        paragraphs: [
          'Adli sicil kaydı ve nüfus kayıt örneği dosyaları, Emanet inceleyip sonucu kaydettiği anda silinir; yalnızca inceleme sonucu ve tarihi tutulur. T.C. kimlik numaranız şifreli olarak ve yalnızca vergi belgelerinin düzenlenmesi için saklanır. Ödeme ve muhasebe kayıtları mevzuat gereği on yıl saklanır. Hesabınızı kapattığınızda veya silme talebiniz yerine getirildiğinde, saklanması zorunlu olmayan verileriniz çalışan sistemlerden silinir. Silinen verilerin şifreli bir kopyası; hukuki yükümlülüklerin yerine getirilmesi, bir hakkın tesisi, kullanılması veya korunması amacıyla, ayrı ve erişimi kısıtlı bir arşivde en çok on yıl saklanır ve süre sonunda yok edilir. Bu arşive yalnızca yetkili yöneticiler, gerekçe yazarak erişebilir; her erişim kayıt altına alınır. Adli sicil kaydı dosyası bu arşive alınmaz.',
        ],
      },
      {
        title: 'Aktarım',
        paragraphs: [
          'Verileriniz; ödeme yapılabilmesi için bankaya, yasal yükümlülükler kapsamında yetkili kamu kurumlarına ve mali müşavire, barındırma hizmeti için Avrupa Birliği’nde veri saklayan altyapı sağlayıcısına aktarılır. Alacaklı kurumlar kimliğinizi görmez.',
        ],
      },
      {
        title: 'Haklarınız',
        paragraphs: [
          'Kanun’un 11. maddesi uyarınca verilerinizin işlenip işlenmediğini öğrenme, bilgi isteme, düzeltilmesini veya silinmesini isteme, işlemeye itiraz etme ve zararın giderilmesini talep etme haklarına sahipsiniz. Silme talebinizi Emanet Saha’da “Verilerim” sayfasından, diğer başvurularınızı iletisim@emanet.dev adresine veya emanet.dev/kvkk-basvuru sayfasındaki yöntemlerle iletebilirsiniz; en geç otuz gün içinde yanıtlanır.',
        ],
      },
    ],
  },
  en: {
    title: 'Privacy Notice for Field Agents',
    intro:
      'Under article 10 of Law no. 6698 on the Protection of Personal Data, 2earl (“Emanet”), as data controller, processes the personal data of applicants and field agents as set out below. This English text is a translation for convenience.',
    sections: [
      {
        title: 'What data, and why',
        paragraphs: [
          'Identity (name, national ID number, year of birth, what the population register extract shows) and contact (email, mobile, address): to verify who you are, to keep one account per person, to reach you, and to issue the documents tax law requires.',
          'Financial (IBAN, tax status, amounts paid and withheld): to pay you and keep the accounts.',
          'Transaction security and location (claims, address views, the location in a sighting, photos): to run the service, verify deliveries and prevent misuse.',
          'Criminal conviction data (your criminal record): to assess whether a person who will see debtors’ addresses is suitable for the task. This is processed only with your explicit consent.',
        ],
      },
      {
        title: 'Legal grounds',
        paragraphs: [
          'Making and performing the contract (art. 5/2-c), legal obligation (art. 5/2-ç; tax and commercial law), legitimate interest (art. 5/2-f; security and preventing misuse), and explicit consent for criminal conviction data (art. 6).',
        ],
      },
      {
        title: 'How long',
        paragraphs: [
          'The files of your criminal record and population register extract are deleted the moment Emanet has checked them and recorded the result; only the result and its date are kept. Your national ID number is stored encrypted and only to issue tax documents. Payment and accounting records are kept ten years as the law requires. When you close your account or your request to erase is carried out, data that doesn’t have to be kept is removed from the working systems. A sealed (encrypted) copy of what was removed is kept in a separate, restricted archive for at most ten years, to meet legal obligations and to establish, exercise or defend a right, and is destroyed when that period ends. Only authorised administrators can open it, by writing a reason, and every opening is recorded. The file of a criminal record is never put in this archive.',
        ],
      },
      {
        title: 'Who receives it',
        paragraphs: [
          'Your bank, to pay you; public authorities and the accountant, as the law requires; and the infrastructure provider, which stores data in the European Union. Creditors never see who you are.',
        ],
      },
      {
        title: 'Your rights',
        paragraphs: [
          'Under article 11 you may learn whether your data is processed, ask for information, ask for it to be corrected or erased, object, and claim compensation. Ask for erasure on the “My data” page in Emanet Saha; for anything else write to iletisim@emanet.dev or use the ways listed at emanet.dev/kvkk-basvuru. You are answered within thirty days at most.',
        ],
      },
    ],
  },
};

const CONSENT: Record<AgreementLocale, string> = {
  tr: 'e-Devlet Kapısı’ndan aldığım adli sicil kaydımın (ceza mahkûmiyeti ve güvenlik tedbirlerine ilişkin verilerimin), saha görevliliğine uygunluğumun değerlendirilmesi amacıyla Emanet tarafından incelenmesine ve inceleme sonucunun kaydedilmesine açık rıza veriyorum. Belgenin, inceleme tamamlandığında silineceğini; rızamı dilediğim zaman geri alabileceğimi, bu durumda başvurumun değerlendirilemeyeceğini biliyorum.',
  en: 'I give my explicit consent to Emanet examining the criminal record I obtained from e-Devlet (my data on criminal convictions and security measures) to assess whether I am suitable to be a field agent, and recording the result. I know the document is deleted when the check is done, and that I can withdraw my consent at any time, in which case my application can’t be assessed.',
};

export const agreementText = (locale: AgreementLocale): AgreementText => AGREEMENT[locale];
export const noticeText = (locale: AgreementLocale): AgreementText => NOTICE[locale];
export const consentText = (locale: AgreementLocale): string => CONSENT[locale];

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The digest of everything an applicant accepts, in the binding (Turkish) text. */
export async function agreementDigest(): Promise<string> {
  return sha256(JSON.stringify([AGREEMENT.tr, NOTICE.tr, CONSENT.tr]));
}

/** What Emanet Saha shows before the application is sent. */
export async function agreementBundle(locale: AgreementLocale) {
  return {
    version: AGREEMENT_VERSION,
    sha256: await agreementDigest(),
    agreement: AGREEMENT[locale],
    notice: NOTICE[locale],
    consent: CONSENT[locale],
    binding: AGREEMENT.tr.title,
  };
}
