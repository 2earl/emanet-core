-- Files on a support message: a photo or a PDF, stored in the evidence bucket under support/.
CREATE TABLE support_attachments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES support_tickets (id),
  message_id TEXT NOT NULL REFERENCES support_messages (id),
  file_ref TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX support_attachments_ticket ON support_attachments (ticket_id, created_at);
