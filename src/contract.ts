/**
 * The service agreement a company accepts while onboarding (docs/CONTRACT.md explains how it is
 * versioned and changed). Turkish is the binding text. Placeholders in {{double braces}} are
 * filled from the company's onboarding details, the price list and 2earl's own details, which staff
 * keep in Emanet Merkez (provider.ts).
 *
 * DRAFT for legal review: the text was written for 2earl by its engineering assistant, not a
 * lawyer. Change CONTRACT_VERSION with every change to the text: a signature records the version
 * and a SHA-256 of exactly what was shown.
 */

export const CONTRACT_VERSION = '2026-11-27-draft';

/** 2earl's Turkish company, as the agreement and invoices name it. */
export interface Provider {
  name: string;
  address: string;
  taxOffice: string;
  vkn: string;
  mersis: string;
  kep: string;
  email: string;
}

/** What the agreement shows until staff have entered 2earl's details; nobody can sign it then. */
export const PROVIDER_PLACEHOLDER: Provider = {
  name: '[2earl Türkiye şirketinin ticaret unvanı]',
  address: '[Merkez adresi]',
  taxOffice: '[Vergi dairesi]',
  vkn: '[Vergi kimlik numarası]',
  mersis: '[MERSİS numarası]',
  kep: '[KEP adresi]',
  email: 'legal@2earl.com',
};

export interface ContractParty {
  legalName: string;
  address: string;
  taxOffice: string;
  vkn: string;
  mersis: string | null;
  kep: string | null;
  signatoryName: string;
  signatoryTitle: string;
  billingEmail: string;
  operationsName: string;
  operationsEmail: string;
  operationsPhone: string;
}

export interface ContractPrice {
  default_kurus: number;
  rules: {
    make?: string;
    model?: string;
    year_from?: number;
    year_to?: number;
    fee_kurus: number;
  }[];
}

export interface Section {
  title: string;
  paragraphs: string[];
}

const lira = (kurus: number) =>
  `${(kurus / 100).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TL`;

/** The articles, with placeholders. Kept as data so the app and the document render the same text. */
export const ARTICLES: Section[] = [
  {
    title: 'Madde 1 – Taraflar',
    paragraphs: [
      'Bu Hizmet Sözleşmesi ("Sözleşme"), bir tarafta {{provider.name}} ({{provider.address}}; {{provider.taxOffice}} V.D. {{provider.vkn}}; MERSİS {{provider.mersis}}; KEP {{provider.kep}}) ("Hizmet Sağlayıcı" veya "2earl") ile diğer tarafta {{customer.legalName}} ({{customer.address}}; {{customer.taxOffice}} V.D. {{customer.vkn}}{{customer.mersis}}{{customer.kep}}) ("Müşteri") arasında, aşağıdaki şartlarla akdedilmiştir. Hizmet Sağlayıcı ve Müşteri ayrı ayrı "Taraf", birlikte "Taraflar" olarak anılacaktır.',
    ],
  },
  {
    title: 'Madde 2 – Tanımlar',
    paragraphs: [
      '"Platform": Hizmet Sağlayıcı tarafından işletilen Emanet hizmetini, Emanet Kurumsal arayüzünü (emanet-kurumsal.2earl.com), uygulama programlama arayüzünü (API) ve bildirim (webhook) altyapısını ifade eder.',
      '"Dosya": Müşterinin Platforma kaydettiği, hakkında yetkili icra dairesince yakalama şerhi konulmuş veya yakalama kararı verilmiş bir aracı ve buna ilişkin icra dosyası bilgilerini ifade eder.',
      '"Saha Ajanı": Kimliği ve banka hesabı Hizmet Sağlayıcı tarafından doğrulanmış, Platform üzerinden Dosyalara konu araçları arayan ve gördüğünde kolluk kuvvetlerine bildiren bağımsız kişiyi ifade eder.',
      '"Teslim": Dosyaya konu aracın kolluk kuvvetlerince yakalanarak bir yediemin otoparkına teslim edildiğinin, yediemin teslim tutanağı ve Platform kayıtlarıyla Hizmet Sağlayıcı tarafından teyit edilmesini ifade eder.',
      '"Ücret": Her Teslim için Ek-2’deki tarifeye göre belirlenen hizmet bedelini ifade eder.',
      '"Kişisel Veri", "Veri Sorumlusu" ve "Veri İşleyen": 6698 sayılı Kişisel Verilerin Korunması Kanunu ("KVKK") kapsamındaki anlamlarını ifade eder.',
    ],
  },
  {
    title: 'Madde 3 – Sözleşmenin Konusu',
    paragraphs: [
      'Sözleşmenin konusu; Müşterinin, hakkında yakalama şerhi bulunan araçlarını Platforma kaydetmesi, Hizmet Sağlayıcının bu araçların Saha Ajanları aracılığıyla tespit edilmesini ve kolluk kuvvetlerine bildirilmesini sağlaması, aracın yediemine teslimine ilişkin belgeleri Müşteriye sunması ve bunun karşılığında Müşterinin Ücreti ödemesidir.',
      'Hizmet Sağlayıcı ve Saha Ajanları hiçbir surette icra takibi işlemi yapmaz, araca el koymaz, aracı çekmez, taşımaz veya yerinden oynatmaz, borçlu veya üçüncü kişilerle borç hakkında görüşmez ve tahsilat yapmaz. Aracın yakalanması ve yediemine teslimi yalnızca kolluk kuvvetlerince, 2004 sayılı İcra ve İflas Kanunu ve ilgili mevzuat çerçevesinde yapılır. İcra dosyasına ilişkin tüm işlemler Müşteri ve yetkili icra dairesi tarafından yürütülür.',
    ],
  },
  {
    title: 'Madde 4 – Müşterinin Yükümlülükleri',
    paragraphs: [
      'Müşteri, Platforma yalnızca hakkında geçerli bir yakalama şerhi bulunan araçları kaydedeceğini; plaka, şasi numarası, icra dairesi ve dosya numarası dahil tüm bilgilerin doğru ve güncel olduğunu kabul ve taahhüt eder.',
      'Yakalama şerhinin kaldırılması, borcun ödenmesi, takibin durması veya Dosyanın başka bir nedenle geçerliliğini yitirmesi halinde Müşteri, ilgili Dosyayı en geç 24 (yirmi dört) saat içinde Platformdan geri çeker. Bu yükümlülüğün ihlalinden doğan her türlü zarardan Müşteri sorumludur.',
      'Müşteri, Dosyaları Ek-1’de belirtilen sürelerde yeniden teyit eder; teyit edilmeyen Dosyalar Platform tarafından otomatik olarak aramaya kapatılır.',
      'Müşteri, Platformu kullanan çalışanlarını ve yetkilerini yönetmekten, kullanıcı hesaplarının ve API anahtarlarının gizliliğinden ve bunlarla yapılan işlemlerden sorumludur. Yetkisiz kullanım şüphesini derhal Hizmet Sağlayıcıya bildirir.',
      'Müşteri, Platforma yalnızca Dosyanın amacı için gerekli Kişisel Verileri girer; borçlunun borç tutarı, sağlık bilgisi veya özel nitelikli kişisel verileri Platforma girilmez.',
    ],
  },
  {
    title: 'Madde 5 – Hizmet Sağlayıcının Yükümlülükleri',
    paragraphs: [
      'Hizmet Sağlayıcı; Platformu Ek-1’deki hizmet seviyelerine uygun olarak işletir, Saha Ajanlarını kimlik, iletişim ve kendi adına banka hesabı yönünden doğrular ve Ek-1’de yer alan davranış kurallarına uymalarını sağlar.',
      'Hizmet Sağlayıcı, Saha Ajanlarına Dosyaya ilişkin adres bilgilerini yalnızca aracı aradıkları süreyle sınırlı olarak gösterir, her görüntülemeyi kayıt altına alır ve borçluya ilişkin borç bilgisini hiçbir surette paylaşmaz.',
      'Hizmet Sağlayıcı, her Teslim için yediemin teslim tutanağı, çekici tutanağı ve varsa kolluk tutanağı ile tespit fotoğraflarını Müşteriye Platform üzerinden sunar ve Teslimi Platform ile Müşterinin tanımladığı bildirim adreslerine bildirir.',
      'Davranış kurallarını ihlal eden Saha Ajanının Platform erişimi derhal askıya alınır; ihlalin suç teşkil etmesi halinde yetkili makamlara bildirim yapılır.',
    ],
  },
  {
    title: 'Madde 6 – Ücret, Faturalama ve Ödeme',
    paragraphs: [
      'Müşteri, yalnızca Teslim gerçekleşen her Dosya için Ek-2’deki tarifeye göre belirlenen Ücreti öder. Teslim gerçekleşmeyen Dosyalar için herhangi bir ücret talep edilmez.',
      'Bir Dosyanın Ücreti, Dosyanın Platforma kaydedildiği anda yürürlükte olan tarifeye göre sabitlenir; tarifenin sonradan değişmesi açık Dosyaları etkilemez. Hizmet Sağlayıcı tarifeyi en az 30 (otuz) gün önceden yazılı olarak bildirmek kaydıyla değiştirebilir.',
      'Aynı araç hakkında birden fazla alacaklının Dosyası bulunması halinde her alacaklı kendi Dosyasının Ücretinden sorumludur.',
      'Hizmet Sağlayıcı, Teslimden itibaren 7 (yedi) gün içinde Vergi Usul Kanunu’na uygun olarak e-Fatura veya e-Arşiv fatura düzenler. Ücretlere KDV ayrıca eklenir. Faturalar, düzenlenme tarihinden itibaren 15 (on beş) gün içinde Müşteri tarafından ödenir.',
      'Süresinde ödenmeyen tutarlara, 3095 sayılı Kanuni Faiz ve Temerrüt Faizine İlişkin Kanun uyarınca ticari işlerde uygulanan avans faizi oranında temerrüt faizi uygulanır.',
    ],
  },
  {
    title: 'Madde 7 – Kişisel Verilerin Korunması',
    paragraphs: [
      'Müşterinin Platforma girdiği Dosyalara ilişkin Kişisel Veriler bakımından Müşteri Veri Sorumlusu, Hizmet Sağlayıcı Veri İşleyendir. Hizmet Sağlayıcı bu verileri yalnızca Sözleşmenin ifası amacıyla ve Ek-3’teki şartlara uygun olarak işler.',
      'Saha Ajanlarına ve Platform kullanıcılarına ilişkin Kişisel Veriler bakımından Hizmet Sağlayıcı Veri Sorumlusudur.',
      'Taraflar, KVKK ve ikincil mevzuat kapsamındaki yükümlülüklerine uyar; veri ihlali halinde birbirlerini gecikmeksizin ve en geç 24 (yirmi dört) saat içinde bilgilendirir ve Kişisel Verileri Koruma Kurulu’na yapılacak bildirimlerde işbirliği yapar.',
    ],
  },
  {
    title: 'Madde 8 – Gizlilik ve Sır Saklama',
    paragraphs: [
      'Taraflar, Sözleşme kapsamında öğrendikleri ticari, teknik ve mali bilgileri ile Kişisel Verileri gizli tutar, yalnızca Sözleşmenin ifası için kullanır ve karşı Tarafın yazılı izni olmadan üçüncü kişilere açıklamaz. Bu yükümlülük, Sözleşmenin sona ermesinden sonra da süresiz olarak devam eder.',
      'Müşterinin 5411 sayılı Bankacılık Kanunu’na tabi bir kuruluş olması halinde Hizmet Sağlayıcı, aynı Kanunun 73. maddesi kapsamındaki sır saklama yükümlülüğüne uyar ve Ek-4’te yer alan destek hizmeti şartlarını kabul eder.',
      'Kanunen yetkili merci ve kurumların talepleri bu madde kapsamında açıklama yasağına aykırılık oluşturmaz; bu halde talep, mevzuatın izin verdiği ölçüde karşı Tarafa bildirilir.',
    ],
  },
  {
    title: 'Madde 9 – Bilgi Güvenliği',
    paragraphs: [
      'Hizmet Sağlayıcı, Platformu ve verileri Ek-4’te belirtilen teknik ve idari tedbirlerle korur. Veriler Avrupa Birliği yetki alanındaki veri merkezlerinde, aktarım ve saklama sırasında şifreli olarak tutulur.',
      'Müşteri, Platforma erişen kullanıcıları için iki adımlı doğrulamayı kullanmayı ve API anahtarlarını yalnızca güvenli sistemlerde saklamayı kabul eder.',
    ],
  },
  {
    title: 'Madde 10 – Fikri Mülkiyet',
    paragraphs: [
      'Platform ve buna ilişkin tüm yazılım, tasarım ve belgeler üzerindeki fikri ve sınai haklar Hizmet Sağlayıcıya aittir. Müşteriye, Sözleşme süresince ve yalnızca Sözleşme amacıyla sınırlı, devredilemez ve münhasır olmayan bir kullanım hakkı tanınır.',
      'Müşterinin Platforma girdiği veriler Müşteriye aittir.',
    ],
  },
  {
    title: 'Madde 11 – Sorumluluk',
    paragraphs: [
      'Hizmet Sağlayıcı, bir aracın bulunacağını veya belirli bir sürede yediemine teslim edileceğini taahhüt etmez.',
      'Saha Ajanları Hizmet Sağlayıcının işçisi değildir; bağımsız olarak çalışır. Hizmet Sağlayıcı, Saha Ajanlarının seçiminde, doğrulanmasında ve davranış kurallarının uygulanmasında gerekli özeni gösterir.',
      'Kast ve ağır ihmal halleri ile Kişisel Verilerin korunmasına ilişkin yükümlülüklerin ihlali saklı kalmak kaydıyla, Tarafların Sözleşmeden doğan toplam sorumluluğu, zarara yol açan olaydan önceki 12 (on iki) ay içinde Müşterinin Hizmet Sağlayıcıya ödediği Ücretlerin toplamı ile sınırlıdır. Taraflar dolaylı zararlardan ve kâr kaybından sorumlu değildir.',
    ],
  },
  {
    title: 'Madde 12 – Mücbir Sebep',
    paragraphs: [
      'Tarafların kontrolü dışında gelişen doğal afet, salgın, savaş, genel grev, kamu otoritesinin kararları ve altyapı sağlayıcılarının genel kesintileri gibi mücbir sebepler süresince Tarafların ilgili yükümlülükleri askıya alınır. Mücbir sebep 60 (altmış) günden uzun sürerse Taraflardan her biri Sözleşmeyi bildirimle feshedebilir.',
    ],
  },
  {
    title: 'Madde 13 – Süre ve Fesih',
    paragraphs: [
      'Sözleşme, Hizmet Sağlayıcının onayıyla yürürlüğe girer ve 1 (bir) yıl sürelidir. Taraflardan biri süre bitiminden en az 30 (otuz) gün önce aksini bildirmedikçe aynı şartlarla birer yıl uzar.',
      'Taraflardan her biri, 30 (otuz) gün önceden yazılı bildirimde bulunarak Sözleşmeyi gerekçe göstermeksizin feshedebilir. Karşı Tarafın Sözleşmeye esaslı aykırılığı ve bildirimden itibaren 15 (on beş) gün içinde aykırılığı gidermemesi halinde Sözleşme derhal feshedilebilir.',
      'Sözleşmenin sona ermesiyle açık Dosyalar aramaya kapatılır; sona erme tarihinden önce gerçekleşen Teslimlerin Ücretleri ödenmeye devam eder. Hizmet Sağlayıcı, kanuni saklama süreleri saklı kalmak üzere, Müşteri Kişisel Verilerini sona ermeden itibaren 30 (otuz) gün içinde Müşterinin talebi üzerine iade eder veya siler.',
    ],
  },
  {
    title: 'Madde 14 – Devir ve Alt Yükleniciler',
    paragraphs: [
      'Taraflar, karşı Tarafın yazılı onayı olmadan Sözleşmeden doğan hak ve yükümlülüklerini üçüncü kişilere devredemez.',
      'Hizmet Sağlayıcı, Platformun barındırılması ve e-posta gönderimi gibi altyapı hizmetleri için Ek-3’te listelenen alt yüklenicilerle çalışabilir. Alt yüklenici değişiklikleri Müşteriye önceden bildirilir.',
    ],
  },
  {
    title: 'Madde 15 – Bildirimler',
    paragraphs: [
      'Sözleşme kapsamındaki hukuki bildirimler Tarafların Madde 1’de yer alan KEP adreslerine veya adreslerine yapılır. Operasyonel bildirimler Platform, e-posta ve Ek-5’te belirtilen irtibat kişileri üzerinden yapılabilir. Adres değişiklikleri karşı Tarafa bildirilmedikçe eski adrese yapılan bildirimler geçerlidir.',
    ],
  },
  {
    title: 'Madde 16 – Uygulanacak Hukuk, Delil ve Yetki',
    paragraphs: [
      'Sözleşme Türkiye Cumhuriyeti hukukuna tabidir. Sözleşmeden doğan uyuşmazlıklarda İstanbul (Çağlayan) Mahkemeleri ve İcra Daireleri yetkilidir.',
      'Taraflar, 6100 sayılı Hukuk Muhakemeleri Kanunu’nun 193. maddesi uyarınca Platform kayıtlarının, elektronik onay kayıtlarının ve e-posta yazışmalarının kesin delil teşkil edeceğini kabul eder; karşı delil ikamesi hakkı saklıdır.',
    ],
  },
  {
    title: 'Madde 17 – Çeşitli Hükümler',
    paragraphs: [
      'Sözleşme ve ekleri Taraflar arasındaki anlaşmanın tamamıdır. Değişiklikler yazılı olarak veya Platform üzerinden elektronik olarak kabul edilmedikçe geçerli değildir. Bir hükmün geçersizliği diğer hükümlerin geçerliliğini etkilemez.',
      'Sözleşme, Müşteri adına imzaya yetkili kişi tarafından Platform üzerinden elektronik olarak kabul edilmiş ve/veya ıslak ya da güvenli elektronik imza ile imzalanmıştır. Müşteri adına onay veren kişi, Müşteriyi temsil ve ilzama yetkili olduğunu beyan eder.',
      'Sözleşme Türkçe olarak düzenlenmiştir; başka dillerdeki metinler yalnızca bilgi amaçlıdır.',
    ],
  },
];

export const ANNEXES: Section[] = [
  {
    title: 'Ek-1 – Hizmet Tanımı, Hizmet Seviyeleri ve Davranış Kuralları',
    paragraphs: [
      'Platform kullanılabilirliği: aylık en az %99,5 (planlı bakım hariç). Planlı bakımlar en az 48 saat önceden bildirilir.',
      'Dosya yeniden teyit süresi: Müşteri için {{customer.reconfirmDays}} günde bir. Teyit edilmeyen Dosyalar aramaya kapatılır.',
      'Teslim bildirimi: Teslimin Hizmet Sağlayıcı tarafından teyidinden itibaren en geç 1 (bir) saat içinde Platform ve bildirim adresleri üzerinden.',
      'Destek: iş günlerinde 09:00–18:00 arasında e-posta ile; kritik güvenlik olaylarında 7/24.',
      'Saha Ajanı davranış kuralları: kişi değil araç aranır; kimse takip edilmez veya gözetlenmez (TCK 123/A); araca dokunulmaz, araç çekilmez veya taşınmaz; araç görüldüğünde 112 aranır ve kolluğun talimatlarına uyulur; borçluyla borç konuşulmaz, gerginlik halinde ortam terk edilir; fotoğraflar yalnızca araç, plaka ve belgelerden ibarettir; adresler gizlidir; kimseden para alınmaz.',
    ],
  },
  {
    title: 'Ek-2 – Ücret Tarifesi',
    paragraphs: ['{{prices}}', 'Ücretlere KDV dahil değildir.'],
  },
  {
    title: 'Ek-3 – Kişisel Verilerin İşlenmesine İlişkin Şartlar',
    paragraphs: [
      'İşlenen veri kategorileri: araç bilgileri (plaka, şasi numarası, marka, model, renk), araç sahibinin adres bilgileri (ev, iş, son görüldüğü yer), icra dairesi ve dosya numarası.',
      'İşleme amacı ve süresi: yalnızca araçların tespiti ve yediemine teslim sürecinin belgelenmesi amacıyla, Dosya açık olduğu sürece; Dosya kapandıktan sonra kanuni saklama süreleri boyunca erişimi kısıtlanmış olarak.',
      'Erişim: adres bilgileri yalnızca ilgili aracı aramakta olan Saha Ajanına, arama süresiyle sınırlı olarak gösterilir; her erişim kayıt altına alınır.',
      'Alt yükleniciler: Cloudflare, Inc. ve bağlı şirketleri (barındırma, veri tabanı, dosya depolama ve e-posta gönderimi; veriler AB yetki alanında saklanır). Yurt dışına aktarım KVKK’nın 9. maddesi kapsamında standart sözleşme ile yapılır ve Kurula bildirilir.',
      'Veri ihlali: Hizmet Sağlayıcı, öğrendiği andan itibaren en geç 24 saat içinde Müşteriyi bilgilendirir.',
      'Denetim: Müşteri, makul süre önceden bildirmek kaydıyla, Hizmet Sağlayıcının bu Ek’e uyumunu yılda bir kez denetleyebilir veya bağımsız denetim raporu talep edebilir.',
      'Sona erme: Sözleşme sona erdiğinde veriler Madde 13 uyarınca iade edilir veya silinir.',
    ],
  },
  {
    title: 'Ek-4 – Bilgi Güvenliği ve Destek Hizmeti Şartları',
    paragraphs: [
      'Erişim kontrolü: tüm kullanıcılar için tek oturum açma; Hizmet Sağlayıcı personelinin yönetim konsoluna erişimi iki adımlı doğrulama ve rol bazlı yetkilendirme ile; para ve kural değişiklikleri için son 15 dakika içinde yapılmış ikinci doğrulama ve belirli tutarın üzerindeki ödemeler için iki farklı yöneticinin onayı.',
      'Şifreleme: aktarımda TLS 1.2 ve üzeri; saklamada sağlayıcı düzeyinde şifreleme. API anahtarları ve oturumlar yalnızca özet (HMAC) olarak saklanır.',
      'Kayıt: Dosya, adres görüntüleme, teslim, faturalama ve ödeme işlemleri değiştirilemez denetim kayıtlarıyla tutulur; muhasebe kayıtları çift taraflı ve değiştirilemezdir.',
      'Bankalar için: Hizmet Sağlayıcı, Bankaların Destek Hizmeti Almalarına İlişkin Yönetmelik kapsamında Müşterinin ve Bankacılık Düzenleme ve Denetleme Kurumu’nun denetim ve bilgi talebi haklarını, iş sürekliliği ve çıkış planı yükümlülüklerini kabul eder; Müşterinin talebi halinde gerekli beyan ve taahhütnameleri verir.',
      'Güvenlik açıkları: legal@2earl.com adresine bildirilir; kritik açıklar en geç 7 gün içinde giderilir.',
    ],
  },
  {
    title: 'Ek-5 – Yetkili Kişiler',
    paragraphs: [
      'Müşteri adına imza yetkilisi: {{customer.signatoryName}}, {{customer.signatoryTitle}}.',
      'Fatura irtibatı: {{customer.billingEmail}}.',
      'Operasyon irtibatı: {{customer.operationsName}}, {{customer.operationsEmail}}, {{customer.operationsPhone}}.',
      'Hizmet Sağlayıcı irtibatı: {{provider.email}}.',
    ],
  },
];

/** The price annex as sentences. */
export function priceText(prices: ContractPrice | null): string {
  if (!prices) return 'Tarife, Hizmet Sağlayıcı tarafından onay sırasında belirlenecektir.';
  const lines = [`Varsayılan ücret: her Teslim için ${lira(prices.default_kurus)}.`];
  for (const rule of prices.rules) {
    const what = [rule.make, rule.model].filter(Boolean).join(' ') || 'Tüm araçlar';
    const years =
      rule.year_from !== undefined || rule.year_to !== undefined
        ? ` (${rule.year_from === undefined ? '' : String(rule.year_from)}–${rule.year_to === undefined ? '' : String(rule.year_to)} model yılı)`
        : '';
    lines.push(`${what}${years}: ${lira(rule.fee_kurus)}.`);
  }
  return lines.join(' ');
}

function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{([a-zA-Z.]+)\}\}/g, (_, key: string) => values[key] ?? `[${key}]`);
}

export interface RenderedContract {
  version: string;
  sections: Section[];
  /** Plain text, exactly what is hashed and kept with a signature. */
  text: string;
  sha256: string;
  /** False while 2earl's own details are missing: the text can be read, not accepted. */
  final: boolean;
}

export async function renderContract(
  customer: ContractParty,
  prices: ContractPrice | null,
  reconfirmDays: number,
  provider: Provider | null = null,
): Promise<RenderedContract> {
  const p = provider ?? PROVIDER_PLACEHOLDER;
  const values: Record<string, string> = {
    'provider.name': p.name,
    'provider.address': p.address,
    'provider.taxOffice': p.taxOffice,
    'provider.vkn': p.vkn,
    'provider.mersis': p.mersis,
    'provider.kep': p.kep,
    'provider.email': p.email,
    'customer.legalName': customer.legalName,
    'customer.address': customer.address,
    'customer.taxOffice': customer.taxOffice,
    'customer.vkn': customer.vkn,
    'customer.mersis': customer.mersis ? `; MERSİS ${customer.mersis}` : '',
    'customer.kep': customer.kep ? `; KEP ${customer.kep}` : '',
    'customer.signatoryName': customer.signatoryName,
    'customer.signatoryTitle': customer.signatoryTitle,
    'customer.billingEmail': customer.billingEmail,
    'customer.operationsName': customer.operationsName,
    'customer.operationsEmail': customer.operationsEmail,
    'customer.operationsPhone': customer.operationsPhone,
    'customer.reconfirmDays': String(reconfirmDays),
    prices: priceText(prices),
  };
  const sections = [
    { title: 'EMANET HİZMET SÖZLEŞMESİ', paragraphs: [`Sürüm ${CONTRACT_VERSION}`] },
    ...ARTICLES,
    ...ANNEXES,
  ].map((s) => ({ title: s.title, paragraphs: s.paragraphs.map((p) => fill(p, values)) }));
  const text = sections.map((s) => `${s.title}\n\n${s.paragraphs.join('\n\n')}`).join('\n\n\n');
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  );
  const sha256 = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  return { version: CONTRACT_VERSION, sections, text, sha256, final: provider !== null };
}
