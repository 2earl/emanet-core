-- A legal hold stops automatic deletion for one agent, case or company onboarding while a dispute
-- or an investigation is open. Releasing it keeps the row: who set it, why, who lifted it.
CREATE TABLE legal_holds (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('agent', 'case', 'onboarding')),
  subject_ref TEXT NOT NULL,
  reason TEXT NOT NULL,
  set_by TEXT NOT NULL,
  set_at INTEGER NOT NULL,
  released_by TEXT,
  released_at INTEGER,
  release_reason TEXT
);
CREATE UNIQUE INDEX legal_holds_open ON legal_holds (subject_kind, subject_ref) WHERE released_at IS NULL;
CREATE INDEX legal_holds_by_time ON legal_holds (set_at);
