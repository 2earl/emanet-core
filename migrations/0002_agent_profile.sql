-- What an agent fills in before staff check their identity (docs/DESIGN.md §6, Joining).
ALTER TABLE agents ADD COLUMN phone TEXT;
ALTER TABLE agents ADD COLUMN terms_version TEXT;
ALTER TABLE agents ADD COLUMN terms_accepted_at INTEGER;
ALTER TABLE agents ADD COLUMN submitted_at INTEGER;
