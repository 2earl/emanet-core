-- Email notices to partners that don't use webhooks (docs/DESIGN.md §5): vehicles that reached
-- custody, and cases about to expire. One row per partner: what was last mailed, so each event is
-- mailed once and expiry warnings at most once a day.
CREATE TABLE partner_notices (
  partner_id TEXT PRIMARY KEY REFERENCES partners(id),
  delivered_through INTEGER NOT NULL DEFAULT 0, -- outbox created_at of the last delivery mailed
  delivered_mailed_at INTEGER,
  expiring_mailed_at INTEGER
);

-- Partners can turn the notices off (Emanet Merkez); on by default.
ALTER TABLE partners ADD COLUMN mail_notices INTEGER NOT NULL DEFAULT 1 CHECK (mail_notices IN (0, 1));
