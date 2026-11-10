-- Keep terminal failures/cancellations out of the worker's hot queue index.
DROP INDEX payment_email_outbox_due;
CREATE INDEX payment_email_outbox_due ON payment_email_outbox(next_attempt_at,created_at,id)
  WHERE state IN ('pending','processing');
