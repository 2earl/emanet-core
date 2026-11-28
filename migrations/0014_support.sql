-- Support desk: agents and companies write to 2earl, staff answer. One ticket is one question.
CREATE TABLE support_tickets (
  id TEXT PRIMARY KEY,
  requester_kind TEXT NOT NULL CHECK (requester_kind IN ('agent', 'partner')),
  -- An agent's account ID, or a partner's ID.
  requester_ref TEXT NOT NULL,
  opened_by TEXT NOT NULL,
  subject TEXT NOT NULL,
  category TEXT NOT NULL,
  -- open: waits for staff. answered: waits for the requester. closed.
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
  assigned_to TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  first_response_at INTEGER,
  closed_at INTEGER
);
CREATE INDEX support_tickets_requester ON support_tickets (requester_kind, requester_ref, updated_at);
CREATE INDEX support_tickets_queue ON support_tickets (status, updated_at);

CREATE TABLE support_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES support_tickets (id),
  -- note: staff only, never shown to the requester.
  author_kind TEXT NOT NULL CHECK (author_kind IN ('requester', 'staff', 'note')),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX support_messages_ticket ON support_messages (ticket_id, created_at);
