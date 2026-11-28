-- What an applicant accepted, word for word (docs/DESIGN.md §6): the version and digest of the
-- agent agreement, the privacy notice and the explicit consent, with when and in which language.
CREATE TABLE agent_acceptances (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (user_id),
  version TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  locale TEXT NOT NULL,
  -- Each is accepted on its own: the agreement, having read the notice, the explicit consent.
  agreement INTEGER NOT NULL,
  notice INTEGER NOT NULL,
  consent INTEGER NOT NULL,
  accepted_at INTEGER NOT NULL,
  withdrawn_at INTEGER
);
CREATE INDEX agent_acceptances_agent ON agent_acceptances (agent_id, accepted_at);

-- The e-Devlet documents an applicant uploads: the criminal record and the population register
-- extract. The file leaves storage as soon as staff have checked it; the result stays.
CREATE TABLE agent_documents (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (user_id),
  kind TEXT NOT NULL CHECK (kind IN ('criminal_record', 'population_record')),
  file_ref TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  barcode TEXT NOT NULL,           -- the document's barcode number, typed by the applicant
  uploaded_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'verified', 'rejected')),
  -- What staff saw when they verified it at e-Devlet: clean, or needs a decision, never the detail.
  outcome TEXT CHECK (outcome IN ('clear', 'has_record', 'mismatch', 'invalid')),
  decided_by TEXT,
  decided_at INTEGER,
  note TEXT
);
CREATE INDEX agent_documents_agent ON agent_documents (agent_id, kind, uploaded_at);

-- Tax documents for a payout name the person paid: the ID number is kept sealed for that alone,
-- and the address tax law wants on the document.
ALTER TABLE agents ADD COLUMN tckn_enc TEXT;
ALTER TABLE agents ADD COLUMN address TEXT;

-- Sign-offs before the first customer (docs/DESIGN.md §13): who confirmed what, for which version.
CREATE TABLE signoffs (
  key TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  signer TEXT NOT NULL,            -- the lawyer's or accountant's name, as staff typed it
  note TEXT,
  signed_by TEXT NOT NULL,         -- the staff account that recorded it
  signed_at INTEGER NOT NULL
);

-- A month handed to the accountant. Nothing can be booked into a past month anyway (entries are
-- written at the time they happen); this records that the pack was taken and by whom.
CREATE TABLE closed_months (
  month TEXT PRIMARY KEY,          -- YYYY-MM, Turkey time
  closed_by TEXT NOT NULL,
  closed_at INTEGER NOT NULL
);
