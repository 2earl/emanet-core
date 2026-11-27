-- Privacy, agent identity and operations (docs/DESIGN.md §6, §8, §12).

-- Files removed from R2 (agents' photos in emanet-evidence, companies' documents in
-- emanet-documents): on a data subject's request, on account deletion, or when their retention
-- ends. The database row a file belonged to stays (a photo's hash still stops its reuse; a
-- document row is evidence that one was given); this says the file itself is gone, and why.
CREATE TABLE erased_files (
  file_ref TEXT PRIMARY KEY,
  bucket TEXT NOT NULL CHECK (bucket IN ('evidence', 'documents')),
  record_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL,       -- 'staff:<id>' or 'system'
  requested_at INTEGER NOT NULL,
  erased_at INTEGER                 -- NULL: due, Emanet Merkez's cron removes it from R2
);
CREATE INDEX erased_files_due ON erased_files (requested_at) WHERE erased_at IS NULL;
CREATE INDEX erased_files_record ON erased_files (record_id);

-- The register of data subjects' requests (KVKK art. 11 and 13: answered within 30 days).
CREATE TABLE privacy_requests (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'erasure', 'correction', 'objection')),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('agent', 'vehicle', 'contact', 'other')),
  subject_ref TEXT NOT NULL,        -- what staff searched by: a plate, a VIN, an account ID, an address
  channel TEXT NOT NULL,            -- how it arrived: email, KEP, post, partner
  note TEXT,
  received_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'refused')),
  outcome TEXT,
  created_by TEXT NOT NULL,
  closed_by TEXT,
  closed_at INTEGER
);
CREATE INDEX privacy_requests_open ON privacy_requests (status, due_at);

-- Agents: one account per person. The T.C. kimlik no is kept only as a keyed hash (tckn_hash,
-- already UNIQUE); the email is the one the agent proved with a code; a phone number belongs to
-- one agent. Test accounts made before this may share a phone: the later ones lose theirs and
-- must enter one again (none is active without the new checks anyway).
ALTER TABLE agents ADD COLUMN email TEXT;
ALTER TABLE agents ADD COLUMN email_verified_at INTEGER;
ALTER TABLE agents ADD COLUMN birth_year INTEGER;
ALTER TABLE agents ADD COLUMN phone_verified_at INTEGER; -- SMS code, when the SMS provider is in
UPDATE agents SET phone = NULL WHERE phone IS NOT NULL AND rowid NOT IN (
  SELECT min(rowid) FROM agents WHERE phone IS NOT NULL GROUP BY phone);
CREATE UNIQUE INDEX agents_email ON agents (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX agents_phone ON agents (phone) WHERE phone IS NOT NULL;

-- A code mailed to an address an agent wants to prove: one at a time, 15 minutes, five tries.
CREATE TABLE agent_email_codes (
  agent_id TEXT PRIMARY KEY REFERENCES agents (user_id),
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- KYC checks, with the kinds the web onboarding has: the proved email, the population registry's
-- answer for the ID number, the video call. (SQLite can't widen a CHECK: the table is rebuilt.)
CREATE TABLE kyc_checks_new (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (user_id),
  kind TEXT NOT NULL CHECK (kind IN (
    'email', 'id_registry', 'id_nfc', 'liveness', 'video_call', 'iban', 'criminal_record', 'phone'
  )),
  provider TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('passed', 'failed', 'review')),
  evidence_ref TEXT,
  reviewed_by TEXT,
  created_at INTEGER NOT NULL
);
INSERT INTO kyc_checks_new SELECT id, agent_id, kind, provider, result, evidence_ref, reviewed_by, created_at FROM kyc_checks;
DROP TABLE kyc_checks;
ALTER TABLE kyc_checks_new RENAME TO kyc_checks;
CREATE INDEX kyc_checks_agent ON kyc_checks (agent_id, kind, created_at);

-- What went wrong, and when the jobs last ran: Emanet Merkez's System page, and the alert email.
-- Never personal data: a source, an event name, an error's name.
CREATE TABLE ops_events (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('core', 'kurumsal', 'merkez', 'saha', 'web')),
  level TEXT NOT NULL CHECK (level IN ('error', 'warn', 'info')),
  event TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  alerted_at INTEGER
);
CREATE INDEX ops_events_at ON ops_events (at);
CREATE INDEX ops_events_unalerted ON ops_events (level, at) WHERE alerted_at IS NULL;

CREATE TABLE ops_heartbeats (
  name TEXT PRIMARY KEY,
  ok_at INTEGER,
  failed_at INTEGER,
  error TEXT
);
