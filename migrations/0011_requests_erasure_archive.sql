-- Asking an applicant for more, deletion on request, and the sealed archive of what was deleted
-- (docs/DESIGN.md §6, §8).

-- More kinds of document than the two every applicant gives: staff can ask for these. A document
-- that isn't from e-Devlet has no barcode; one given for a request says which.
CREATE TABLE agent_documents_new (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (user_id),
  kind TEXT NOT NULL CHECK (kind IN (
    'criminal_record', 'population_record', 'residence_record', 'driving_licence',
    'tax_certificate', 'bank_proof', 'other')),
  file_ref TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  barcode TEXT NOT NULL DEFAULT '',
  uploaded_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'verified', 'rejected')),
  outcome TEXT CHECK (outcome IN ('clear', 'has_record', 'mismatch', 'invalid')),
  decided_by TEXT,
  decided_at INTEGER,
  note TEXT,
  request_id TEXT
);
INSERT INTO agent_documents_new (id, agent_id, kind, file_ref, sha256, barcode, uploaded_at, status, outcome, decided_by, decided_at, note)
  SELECT id, agent_id, kind, file_ref, sha256, barcode, uploaded_at, status, outcome, decided_by, decided_at, note
  FROM agent_documents;
DROP TABLE agent_documents;
ALTER TABLE agent_documents_new RENAME TO agent_documents;
CREATE INDEX agent_documents_agent ON agent_documents (agent_id, kind, uploaded_at);

-- What staff asked an applicant (or an agent) for: a detail to correct, or a document to give.
-- The agent answers each; staff accept the answer, ask again, or withdraw the request.
CREATE TABLE agent_requests (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (user_id),
  kind TEXT NOT NULL CHECK (kind IN ('info', 'document')),
  subject TEXT NOT NULL,           -- info: which detail; document: which kind of document
  note TEXT NOT NULL,              -- what staff wrote to the agent
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'accepted', 'cancelled')),
  answer TEXT,                     -- the agent's words, if they wrote any
  document_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  answered_at INTEGER,
  closed_by TEXT,
  closed_at INTEGER
);
CREATE INDEX agent_requests_agent ON agent_requests (agent_id, status);
CREATE INDEX agent_requests_answered ON agent_requests (answered_at) WHERE status = 'answered';

-- A data subject can withdraw a request before it is decided.
CREATE TABLE privacy_requests_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'erasure', 'correction', 'objection')),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('agent', 'vehicle', 'contact', 'other')),
  subject_ref TEXT NOT NULL,
  channel TEXT NOT NULL,
  note TEXT,
  received_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'refused', 'withdrawn')),
  outcome TEXT,
  created_by TEXT NOT NULL,
  closed_by TEXT,
  closed_at INTEGER
);
INSERT INTO privacy_requests_new SELECT id, kind, subject_kind, subject_ref, channel, note, received_at, due_at, status, outcome, created_by, closed_by, closed_at FROM privacy_requests;
DROP TABLE privacy_requests;
ALTER TABLE privacy_requests_new RENAME TO privacy_requests;
CREATE INDEX privacy_requests_open ON privacy_requests (status, due_at);
CREATE INDEX privacy_requests_subject ON privacy_requests (subject_kind, subject_ref);

-- When an agent's personal data was erased.
ALTER TABLE agents ADD COLUMN erased_at INTEGER;

-- What was erased, sealed (src/pii.ts) and kept apart for a fixed time: to answer a court, an
-- authority or a claim. Nothing in the product reads it; an admin opens one record at a time,
-- with a reason, and every opening is written down. When its time is up the content is destroyed
-- and only this line stays.
CREATE TABLE erasure_archive (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('agent')),
  subject_ref TEXT NOT NULL,       -- the account ID, which names nobody by itself
  lookup_hash TEXT,                -- keyed hash of the email address, to find a record when asked
  request_id TEXT,
  reason TEXT NOT NULL,
  payload_enc TEXT,                -- sealed JSON; NULL once destroyed
  files TEXT NOT NULL DEFAULT '[]',-- sealed objects in storage: [{ref, name, kind, type, size}]
  archived_by TEXT NOT NULL,
  archived_at INTEGER NOT NULL,
  purge_at INTEGER NOT NULL,
  purged_at INTEGER
);
CREATE INDEX erasure_archive_subject ON erasure_archive (subject_ref);
CREATE INDEX erasure_archive_lookup ON erasure_archive (lookup_hash);
CREATE INDEX erasure_archive_purge ON erasure_archive (purge_at) WHERE purged_at IS NULL;

CREATE TABLE erasure_archive_views (
  id TEXT PRIMARY KEY,
  archive_id TEXT NOT NULL REFERENCES erasure_archive (id),
  staff_id TEXT NOT NULL,
  what TEXT NOT NULL,              -- 'record' or 'file'
  reason TEXT NOT NULL,
  viewed_at INTEGER NOT NULL
);
CREATE INDEX erasure_archive_views_archive ON erasure_archive_views (archive_id, viewed_at);

-- A file queued for removal that belongs to an archive is sealed and moved, not destroyed.
ALTER TABLE erased_files ADD COLUMN archive_id TEXT;
ALTER TABLE erased_files ADD COLUMN name TEXT;
