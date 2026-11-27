-- Why a claim ended, for the agent to read: staff's reason when a delivery isn't accepted
-- (docs/DESIGN.md §7, Review queue).
ALTER TABLE claims ADD COLUMN close_note TEXT;
-- The audit event that records that decision: what else the decision changes (photos, a strike)
-- is tied to it, so two people deciding in the same second can't both apply it.
ALTER TABLE claims ADD COLUMN close_ref TEXT;

-- A money event is booked once. Two staff pressing the same button at the same moment would
-- otherwise both pass the status check and both write the entry; now the second batch fails as a
-- whole. A correction is its own kind of entry (a reversal), so it isn't caught by this.
CREATE UNIQUE INDEX journal_entries_once ON journal_entries (kind, ref_id)
  WHERE ref_id IS NOT NULL AND kind IN ('agent_fee', 'invoice', 'receipt', 'payout');

-- Retention (docs/DESIGN.md §8): the cron removes a closed case's places after 30 days.
CREATE INDEX cases_closed ON cases (status, updated_at) WHERE status IN ('delivered', 'withdrawn', 'expired');

-- The audit log, newest first, for Emanet Merkez's Audit page.
CREATE INDEX audit_events_at ON audit_events (at);
CREATE INDEX audit_events_actor ON audit_events (actor, at);
