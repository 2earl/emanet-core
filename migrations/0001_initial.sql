-- Emanet core schema (docs/DESIGN.md §4). Times are Unix seconds, money is integer kuruş, rates
-- are basis points (1/100 of a percent). IDs are random UUIDs.

-- Settings that 2earl staff change in Emanet Control. Typed defaults live in src/settings.ts;
-- a row here overrides one.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------------------------
-- Partners: creditors (banks, asset management companies, their law firms). One per login
-- organization; members and their roles come from login.
CREATE TABLE partners (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('bank', 'vys', 'law_firm', 'leasing', 'other')),
  legal_name TEXT NOT NULL,
  vkn TEXT,
  tax_office TEXT,
  kep_address TEXT,
  e_invoice INTEGER NOT NULL DEFAULT 1 CHECK (e_invoice IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'suspended')),
  -- Days a case stays visible to agents without the partner confirming it again.
  reconfirm_days INTEGER NOT NULL DEFAULT 14 CHECK (reconfirm_days BETWEEN 1 AND 90),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------------------------
-- Custom fields: what each partner sends beyond the core columns (DESIGN §4.4).
CREATE TABLE field_definitions (
  id TEXT PRIMARY KEY,
  -- NULL: every partner; otherwise one partner's own field.
  partner_id TEXT REFERENCES partners (id),
  entity TEXT NOT NULL CHECK (entity IN ('vehicle', 'case', 'place')),
  key TEXT NOT NULL CHECK (key GLOB '[a-z]*' AND length(key) <= 40),
  label_tr TEXT NOT NULL,
  label_en TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'number', 'date', 'enum', 'bool', 'phone', 'money')),
  enum_values TEXT, -- JSON array, for type enum
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  max_length INTEGER,
  visibility TEXT NOT NULL DEFAULT 'partner'
    CHECK (visibility IN ('partner', 'admin', 'agent_after_claim')),
  pii INTEGER NOT NULL DEFAULT 0 CHECK (pii IN (0, 1)),
  position INTEGER NOT NULL DEFAULT 0,
  deprecated_at INTEGER,
  created_at INTEGER NOT NULL
);
-- A key means one thing per entity: a partner can't redefine a global key.
CREATE UNIQUE INDEX field_definitions_key ON field_definitions (entity, key, ifnull(partner_id, ''));

-- ---------------------------------------------------------------------------------------------
-- Vehicles: one row per physical vehicle. The VIN (şasi no) is its identity; plates change.
CREATE TABLE vehicles (
  id TEXT PRIMARY KEY,
  vin TEXT UNIQUE, -- NULL until known; such a vehicle is never shown to agents
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  year INTEGER,
  colour TEXT,
  attributes TEXT NOT NULL DEFAULT '{}',
  -- Set when the vehicle reaches a custodian car park; agents don't see it while set.
  custody_since INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE vehicle_plates (
  vehicle_id TEXT NOT NULL REFERENCES vehicles (id),
  plate TEXT NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  PRIMARY KEY (vehicle_id, plate, valid_from)
);
-- A plate is on one vehicle at a time.
CREATE UNIQUE INDEX vehicle_plates_current ON vehicle_plates (plate) WHERE valid_to IS NULL;
CREATE UNIQUE INDEX vehicle_plates_one_current ON vehicle_plates (vehicle_id) WHERE valid_to IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Cases: one creditor's claim on one vehicle, backed by an enforcement file with a seizure
-- order (yakalama şerhi).
CREATE TABLE cases (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners (id),
  vehicle_id TEXT NOT NULL REFERENCES vehicles (id),
  external_ref TEXT NOT NULL,
  icra_office TEXT NOT NULL,
  icra_file_no TEXT NOT NULL,
  serh_date TEXT NOT NULL, -- YYYY-MM-DD
  legal_basis TEXT NOT NULL CHECK (legal_basis IN ('rehin', 'haciz')),
  -- What the partner says about the vehicle; the vehicle row keeps the first account.
  vehicle_snapshot TEXT NOT NULL,
  attributes TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN (
    'pending_identity', -- no VIN, or a plate that conflicts: waits for staff
    'active',           -- agents can look for the vehicle
    'delivered',        -- in a custodian car park, confirmed by staff
    'withdrawn',        -- the partner took it back (debt paid, şerh lifted, …)
    'expired'           -- not confirmed again in time
  )),
  fee_kurus INTEGER NOT NULL CHECK (fee_kurus >= 0), -- frozen when the case is created
  last_confirmed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  delivered_at INTEGER,
  closed_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (partner_id, external_ref)
);
-- One open case per partner per vehicle.
CREATE UNIQUE INDEX cases_open_per_partner ON cases (partner_id, vehicle_id)
  WHERE status IN ('pending_identity', 'active');
CREATE INDEX cases_vehicle ON cases (vehicle_id, status);
CREATE INDEX cases_partner_status ON cases (partner_id, status, updated_at);
CREATE INDEX cases_expiry ON cases (status, expires_at);

CREATE TABLE case_places (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases (id),
  kind TEXT NOT NULL CHECK (kind IN ('owner_home', 'work', 'last_seen', 'other')),
  address TEXT NOT NULL,
  district TEXT NOT NULL,
  city TEXT NOT NULL,
  lat REAL,
  lng REAL,
  note TEXT,
  attributes TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX case_places_case ON case_places (case_id);

-- ---------------------------------------------------------------------------------------------
-- Field agents. Identity comes from login; KYC results from Emanet's checks.
CREATE TABLE agents (
  user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'applied'
    CHECK (status IN ('applied', 'kyc_pending', 'active', 'suspended', 'banned')),
  legal_name TEXT,          -- from the ID card's chip
  tckn_hash TEXT UNIQUE,    -- HMAC of the T.C. kimlik no: one account per person
  city TEXT,
  iban TEXT,
  iban_verified_at INTEGER,
  tax_profile TEXT NOT NULL DEFAULT 'individual'
    CHECK (tax_profile IN ('individual', 'sole_trader', 'company')),
  vkn TEXT,
  max_active_claims INTEGER, -- NULL: the global setting
  strikes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE kyc_checks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (user_id),
  kind TEXT NOT NULL CHECK (kind IN ('id_nfc', 'liveness', 'iban', 'criminal_record', 'phone')),
  provider TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('passed', 'failed', 'review')),
  evidence_ref TEXT,
  reviewed_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX kyc_checks_agent ON kyc_checks (agent_id, kind);

-- An agent's hold on a vehicle (DESIGN §6). One open claim per vehicle.
CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles (id),
  agent_id TEXT NOT NULL REFERENCES agents (user_id),
  state TEXT NOT NULL DEFAULT 'searching' CHECK (state IN ('searching', 'reporting')),
  claimed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  closed_at INTEGER,
  close_reason TEXT CHECK (close_reason IN ('expired', 'released', 'delivered', 'revoked', 'rejected'))
);
CREATE UNIQUE INDEX claims_open_per_vehicle ON claims (vehicle_id) WHERE closed_at IS NULL;
CREATE INDEX claims_open_by_agent ON claims (agent_id) WHERE closed_at IS NULL;
CREATE INDEX claims_expiry ON claims (expires_at) WHERE closed_at IS NULL;

-- After a claim ends without a delivery, its agent can't claim that vehicle again until `until`.
CREATE TABLE cooldowns (
  agent_id TEXT NOT NULL,
  vehicle_id TEXT NOT NULL,
  until INTEGER NOT NULL,
  PRIMARY KEY (agent_id, vehicle_id)
);

CREATE TABLE sightings (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims (id),
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  accuracy_m REAL,
  taken_at INTEGER NOT NULL,   -- the device's clock
  received_at INTEGER NOT NULL -- ours
);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims (id),
  kind TEXT NOT NULL CHECK (kind IN (
    'scene', 'police_report', 'tow_report', 'yediemin_receipt', 'yediemin_vehicle'
  )),
  file_ref TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  exif_time INTEGER,
  exif_lat REAL,
  exif_lng REAL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'accepted', 'rejected')),
  reviewed_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX evidence_claim ON evidence (claim_id);
-- The same photo can't serve two claims.
CREATE UNIQUE INDEX evidence_unique_file ON evidence (sha256);

-- ---------------------------------------------------------------------------------------------
-- Things a person must look at: plate conflicts, vehicles without a VIN, evidence.
CREATE TABLE review_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('plate_conflict', 'missing_vin', 'delivery')),
  subject_id TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_by TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX review_items_open ON review_items (status, created_at);

-- ---------------------------------------------------------------------------------------------
-- Money (DESIGN §4.6). Double entry; accounts follow the Turkish uniform chart (Tek Düzen Hesap
-- Planı) so the accountant reads the books as they are: 102 banks, 120 receivables, 191 VAT to
-- deduct, 320 payables, 360 taxes payable, 391 VAT charged, 600 sales, 740 service cost.
CREATE TABLE ledger_accounts (
  code TEXT PRIMARY KEY, -- e.g. '120' or '120.<partner id>'
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('asset', 'liability', 'revenue', 'expense')),
  created_at INTEGER NOT NULL
);

CREATE TABLE journal_entries (
  id TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  case_id TEXT,
  ref_id TEXT, -- invoice, receipt or payout
  memo TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX journal_entries_case ON journal_entries (case_id);

CREATE TABLE journal_lines (
  entry_id TEXT NOT NULL REFERENCES journal_entries (id),
  line INTEGER NOT NULL,
  account_code TEXT NOT NULL REFERENCES ledger_accounts (code),
  debit_kurus INTEGER NOT NULL DEFAULT 0 CHECK (debit_kurus >= 0),
  credit_kurus INTEGER NOT NULL DEFAULT 0 CHECK (credit_kurus >= 0),
  CHECK ((debit_kurus = 0) <> (credit_kurus = 0)),
  PRIMARY KEY (entry_id, line)
);
CREATE INDEX journal_lines_account ON journal_lines (account_code);

-- Journal rows are never changed or removed: corrections are reversing entries.
CREATE TRIGGER journal_entries_immutable BEFORE UPDATE ON journal_entries
BEGIN SELECT RAISE(ABORT, 'journal entries are immutable'); END;
CREATE TRIGGER journal_entries_undeletable BEFORE DELETE ON journal_entries
BEGIN SELECT RAISE(ABORT, 'journal entries are immutable'); END;
CREATE TRIGGER journal_lines_immutable BEFORE UPDATE ON journal_lines
BEGIN SELECT RAISE(ABORT, 'journal lines are immutable'); END;
CREATE TRIGGER journal_lines_undeletable BEFORE DELETE ON journal_lines
BEGIN SELECT RAISE(ABORT, 'journal lines are immutable'); END;

-- What a partner pays per vehicle, from valid_from on. rules: JSON (src/pricing.ts).
CREATE TABLE price_lists (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners (id),
  valid_from INTEGER NOT NULL,
  rules TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX price_lists_partner ON price_lists (partner_id, valid_from);

-- What an agent earns for a delivered vehicle, from valid_from on. rule: JSON (src/pricing.ts).
CREATE TABLE payout_rules (
  id TEXT PRIMARY KEY,
  valid_from INTEGER NOT NULL,
  rule TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners (id),
  number TEXT UNIQUE,          -- the e-invoice number, once the integrator issues it
  issued_at INTEGER NOT NULL,
  net_kurus INTEGER NOT NULL,
  kdv_kurus INTEGER NOT NULL,
  total_kurus INTEGER NOT NULL,
  paid_kurus INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'paid', 'cancelled')),
  e_invoice_uuid TEXT,
  created_by TEXT NOT NULL
);

CREATE TABLE invoice_lines (
  invoice_id TEXT NOT NULL REFERENCES invoices (id),
  case_id TEXT NOT NULL UNIQUE REFERENCES cases (id), -- a case is invoiced once
  net_kurus INTEGER NOT NULL,
  kdv_bp INTEGER NOT NULL,
  kdv_kurus INTEGER NOT NULL,
  PRIMARY KEY (invoice_id, case_id)
);

CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners (id),
  invoice_id TEXT REFERENCES invoices (id),
  amount_kurus INTEGER NOT NULL CHECK (amount_kurus > 0),
  value_date TEXT NOT NULL,
  bank_ref TEXT NOT NULL UNIQUE, -- a bank movement is recorded once
  source TEXT NOT NULL CHECK (source IN ('manual', 'statement', 'bank_api')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE payouts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (user_id),
  vehicle_id TEXT NOT NULL REFERENCES vehicles (id),
  -- The case whose fee set the payout; the payout waits for that case's invoice to be paid.
  case_id TEXT NOT NULL UNIQUE REFERENCES cases (id),
  gross_kurus INTEGER NOT NULL,
  withholding_kurus INTEGER NOT NULL,
  net_kurus INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_receipt' CHECK (status IN (
    'awaiting_receipt', 'ready', 'approved', 'sent', 'cancelled'
  )),
  ordered_by TEXT,
  approved_by TEXT,
  bank_ref TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX payouts_status ON payouts (status, created_at);

-- ---------------------------------------------------------------------------------------------
-- Events for partners (webhooks, polling): written in the same batch as the change they report.
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX outbox_partner ON outbox (partner_id, created_at);

-- Who did what. Append-only.
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL, -- 'partner:<id>/<user>', 'agent:<id>', 'staff:<id>', 'system'
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_events_subject ON audit_events (subject, at);
CREATE TRIGGER audit_events_immutable BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
CREATE TRIGGER audit_events_undeletable BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
