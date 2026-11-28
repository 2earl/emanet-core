-- Agents are told of decisions in their own language, and can be sent back to correct an
-- application instead of only approved or refused (docs/DESIGN.md §6, Joining).
ALTER TABLE agents ADD COLUMN locale TEXT NOT NULL DEFAULT 'tr';
ALTER TABLE agents ADD COLUMN review_note TEXT;

-- What staff ticked when confirming a delivery (docs/DESIGN.md §7, Reviews).
ALTER TABLE claims ADD COLUMN checks TEXT;
