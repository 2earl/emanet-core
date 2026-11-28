-- The IBAN a payout is sent to, fixed when it is first ordered, and who confirmed the delivery
-- that created it (the same person may not also order it).
ALTER TABLE payouts ADD COLUMN iban TEXT;
ALTER TABLE payouts ADD COLUMN confirmed_by TEXT;
-- Payouts already ordered get the agent's verified IBAN of today; unverified ones stay empty and
-- can't be sent until ordered again.
UPDATE payouts SET iban = (
  SELECT a.iban FROM agents a WHERE a.user_id = payouts.agent_id AND a.iban_verified_at IS NOT NULL
) WHERE iban IS NULL AND ordered_by IS NOT NULL AND status IN ('ready', 'approved');

-- Email codes: a day's window per agent, so codes can't be asked for and guessed without end.
ALTER TABLE agent_email_codes ADD COLUMN window_start INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_email_codes ADD COLUMN window_requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_email_codes ADD COLUMN window_failures INTEGER NOT NULL DEFAULT 0;

-- Accounts deleted in login: an old session can't start anything new in their name. Only a
-- SHA-256 of the account ID, never the ID itself.
CREATE TABLE deleted_accounts (
  user_hash TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
) STRICT;
