-- 2earl's own company details, as the agreement and invoices name it (docs/DESIGN.md §5,
-- Onboarding). One row, set by staff in Emanet Merkez; every change is audited. A signed
-- agreement keeps the text it was signed with, so a later change never touches it.
CREATE TABLE provider_details (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  details TEXT NOT NULL,                      -- JSON Provider
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
