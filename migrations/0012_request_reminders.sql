-- One reminder per request, sent a few days before its time limit; null until sent.
ALTER TABLE agent_requests ADD COLUMN reminded_at INTEGER;
