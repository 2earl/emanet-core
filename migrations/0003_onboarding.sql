-- Companies invited by 2earl staff, until they are partners (docs/DESIGN.md §5, Onboarding).
CREATE TABLE onboardings (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,            -- SHA-256 of the link's secret; the secret is only in the email
  kind TEXT NOT NULL CHECK (kind IN ('bank', 'vys', 'law_firm', 'leasing', 'other')),
  company TEXT NOT NULL,                      -- the name staff invited, until the company gives its own
  contact_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'tr' CHECK (locale IN ('tr', 'en')),
  price_list TEXT,                            -- JSON PriceList proposed to the company (Annex 2)
  reconfirm_days INTEGER NOT NULL DEFAULT 14,
  note TEXT,                                  -- staff only
  status TEXT NOT NULL CHECK (status IN ('invited', 'in_progress', 'signed', 'approved', 'rejected', 'cancelled', 'expired')),
  invited_by TEXT NOT NULL,
  invited_at INTEGER NOT NULL,
  sent_at INTEGER NOT NULL,
  reminders INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  claimed_by TEXT,                            -- login user who opened the link with the invited address
  claimed_at INTEGER,
  org_id TEXT,
  details TEXT,                               -- JSON ContractParty + eInvoice
  details_at INTEGER,
  contract_version TEXT,
  contract_sha256 TEXT,
  contract_text TEXT,                         -- exactly what was shown and accepted
  signed_by TEXT,
  signer_name TEXT,
  signer_title TEXT,
  signer_ip TEXT,
  signed_at INTEGER,
  decided_by TEXT,
  decided_at INTEGER,
  decision_reason TEXT,
  partner_id TEXT REFERENCES partners(id),
  updated_at INTEGER NOT NULL
);
CREATE INDEX onboardings_status ON onboardings (status, updated_at);
CREATE INDEX onboardings_claimed ON onboardings (claimed_by);
-- One open onboarding per address at a time.
CREATE UNIQUE INDEX onboardings_open_email ON onboardings (lower(contact_email))
  WHERE status IN ('invited', 'in_progress', 'signed');

CREATE TABLE onboarding_documents (
  id TEXT PRIMARY KEY,
  onboarding_id TEXT NOT NULL REFERENCES onboardings(id),
  kind TEXT NOT NULL CHECK (kind IN ('signed_contract', 'signature_circular', 'tax_certificate', 'trade_registry', 'other')),
  file_ref TEXT NOT NULL,                     -- R2 key in emanet-documents
  sha256 TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_by TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL
);
CREATE INDEX onboarding_documents_by ON onboarding_documents (onboarding_id, uploaded_at);

-- What invoices and notices need, from onboarding.
ALTER TABLE partners ADD COLUMN address TEXT;
ALTER TABLE partners ADD COLUMN mersis TEXT;
ALTER TABLE partners ADD COLUMN billing_email TEXT;
ALTER TABLE partners ADD COLUMN contact_email TEXT;
ALTER TABLE partners ADD COLUMN contract_version TEXT;
ALTER TABLE partners ADD COLUMN contract_signed_at INTEGER;
ALTER TABLE partners ADD COLUMN onboarding_id TEXT;
