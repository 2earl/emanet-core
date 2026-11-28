-- Saved replies for the support desk: answers staff give often, kept and edited in Merkez.
CREATE TABLE support_replies (
  id TEXT PRIMARY KEY,
  title_en TEXT NOT NULL,
  title_tr TEXT NOT NULL,
  -- Who it is offered for: everyone, agents (Saha) or companies (Kurumsal).
  audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'agent', 'partner')),
  body TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX support_replies_order ON support_replies (position, title_en);

-- The first set, as Merkez shipped them (Turkish: the people who write to us are).
INSERT INTO support_replies (id, title_en, title_tr, audience, body, position, updated_by, updated_at) VALUES
('looking', 'We are looking into it', 'İnceliyoruz', 'all',
'Merhaba,

Mesajınızı aldık ve inceliyoruz. Sonucu buradan bildireceğiz.

2earl Destek', 10, 'system', 1795870000),
('payment-when', 'When a payment arrives', 'Ödeme ne zaman gelir', 'agent',
'Merhaba,

Ödemeniz, araç yediemine teslim edildikten ve alacaklı ödemesini yaptıktan sonra adınıza kayıtlı IBAN’a gönderilir. Güncel durumu Emanet Saha’da Kazançlar bölümünde görebilirsiniz; her ödemenin özeti oradan indirilebilir.

2earl Destek', 20, 'system', 1795870000),
('documents', 'A document is missing or unreadable', 'Belge eksik ya da okunmuyor', 'agent',
'Merhaba,

Teslimi onaylayabilmemiz için çekici tutanağı ve yediemin makbuzunun, plaka ve şasi numarası okunacak şekilde çekilmiş fotoğraflarına ihtiyacımız var. Lütfen İşlerim bölümünden aracı açıp belgeleri yeniden yükleyin.

2earl Destek', 30, 'system', 1795870000),
('application', 'Where an application stands', 'Başvuru ne durumda', 'agent',
'Merhaba,

Başvurunuz bize ulaştı. Sıradaki adım kısa bir görüntülü görüşme: sizi kayıtlı cep telefonunuzdan arayacağız. Görüşmede T.C. kimlik kartınızı ve IBAN’ın adınıza olduğunu gösteren banka uygulamanızı hazır bulundurun.

2earl Destek', 40, 'system', 1795870000),
('e-invoice', 'The e-invoice', 'e-Fatura', 'partner',
'Merhaba,

Resmî fatura e-Fatura sistemi üzerinden muhasebenize iletilir. Emanet Kurumsal’daki Faturalar sayfası faturalanan araçları listeler; aynı listeyi CSV olarak indirebilirsiniz. e-Fatura size ulaşmadıysa fatura numarasını yazın, kontrol edelim.

2earl Destek', 50, 'system', 1795870000),
('case-status', 'Where a case stands', 'Dosya ne durumda', 'partner',
'Merhaba,

Dosyanın güncel aşamasını ve olanların zaman çizelgesini Emanet Kurumsal’da dosya sayfasında görebilirsiniz. Araç yediemine teslim edildiğinde tutanaklar aynı sayfaya eklenir ve sisteminize bildirim gider.

2earl Destek', 60, 'system', 1795870000),
('solved', 'Solved, closing', 'Çözüldü, kapatıyoruz', 'all',
'Merhaba,

Konu çözüldüğü için bu mesajı kapatıyoruz. Başka bir sorunuz olursa 30 gün içinde buradan yanıt yazarak yeniden açabilirsiniz.

2earl Destek', 70, 'system', 1795870000);
