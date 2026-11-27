-- Every acceptance of the agreement, kept for good (docs/DESIGN.md §5, Onboarding). Staff can
-- send a signed onboarding back for changes, which clears it from `onboardings`; the text the
-- company accepted, its hash and who accepted it stay here. Append-only, like the audit log.
CREATE TABLE onboarding_acceptances (
  id TEXT PRIMARY KEY,
  onboarding_id TEXT NOT NULL REFERENCES onboardings(id),
  contract_version TEXT NOT NULL,
  contract_sha256 TEXT NOT NULL,
  contract_text TEXT NOT NULL,
  signed_by TEXT NOT NULL,
  signer_name TEXT NOT NULL,
  signer_title TEXT NOT NULL,
  signer_ip TEXT,
  signed_at INTEGER NOT NULL
);
CREATE INDEX onboarding_acceptances_by ON onboarding_acceptances (onboarding_id, signed_at);
CREATE TRIGGER onboarding_acceptances_immutable BEFORE UPDATE ON onboarding_acceptances
BEGIN SELECT RAISE(ABORT, 'acceptances are immutable'); END;
CREATE TRIGGER onboarding_acceptances_undeletable BEFORE DELETE ON onboarding_acceptances
BEGIN SELECT RAISE(ABORT, 'acceptances are immutable'); END;

-- A document a company gave is evidence too: never changed or removed once recorded.
CREATE TRIGGER onboarding_documents_immutable BEFORE UPDATE ON onboarding_documents
BEGIN SELECT RAISE(ABORT, 'onboarding documents are immutable'); END;
CREATE TRIGGER onboarding_documents_undeletable BEFORE DELETE ON onboarding_documents
BEGIN SELECT RAISE(ABORT, 'onboarding documents are immutable'); END;
