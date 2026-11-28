-- People without an organization ask 2earl to invite their company to Emanet (docs/DESIGN.md §5,
-- Invitation requests). Staff invite or decline them in Merkez → Onboarding.
CREATE TABLE invitation_requests (
  id TEXT PRIMARY KEY,
  -- The 2earl account that asked.
  user_id TEXT NOT NULL,
  company TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bank', 'vys', 'law_firm', 'leasing', 'other')),
  contact_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  phone TEXT,
  job_title TEXT,
  -- Roughly how many vehicles a year: 'small' (under 50), 'medium' (50 to 500), 'large' (over 500).
  volume TEXT CHECK (volume IN ('small', 'medium', 'large')),
  message TEXT,
  locale TEXT NOT NULL CHECK (locale IN ('tr', 'en')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'invited', 'declined')),
  handled_by TEXT,
  handled_at INTEGER,
  -- For staff only; never sent to the person.
  staff_note TEXT,
  onboarding_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX invitation_requests_status ON invitation_requests (status, created_at);
CREATE INDEX invitation_requests_user ON invitation_requests (user_id, created_at);

-- Where Emanet sends its emails to 2earl's own teams, set in Merkez → Settings. A key without a
-- row uses the default in src/mail-routes.ts.
CREATE TABLE mail_routes (
  key TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
