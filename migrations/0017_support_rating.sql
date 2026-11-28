-- Whether the requester found 2earl's answer helpful (docs/DESIGN.md §20). One mark per ticket,
-- changeable; null until given. Staff see it per ticket and in the answer times.
ALTER TABLE support_tickets ADD COLUMN rating TEXT CHECK (rating IN ('helped', 'not_helped'));
ALTER TABLE support_tickets ADD COLUMN rated_at INTEGER;
