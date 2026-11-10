-- Reminder lookup must stay bounded as the immutable audit history grows.
-- The dashboard selects at most 100 attention rows before consulting these indexes.
CREATE INDEX audit_reminder_instalment ON audit_events
  (organization_id, (metadata->>'instalment_id'), created_at DESC, id DESC)
  WHERE action LIKE 'reminder.%' AND metadata->>'instalment_id' IS NOT NULL;

CREATE INDEX audit_reminder_customer ON audit_events
  (organization_id, (COALESCE(metadata->>'customer_id',metadata->>'customerId')), created_at DESC, id DESC)
  WHERE action LIKE 'reminder.%' AND metadata->>'instalment_id' IS NULL;
