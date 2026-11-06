-- Written in the same transaction as payment submission/review. Provider I/O is
-- performed after commit by a leased worker, so an outage cannot lose an event.
CREATE TABLE payment_email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  recipient text NOT NULL CHECK (char_length(recipient) BETWEEN 3 AND 320 AND recipient !~ '[\r\n]'),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 500),
  body text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','sent')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CHECK ((state='processing') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((state='sent') = (sent_at IS NOT NULL))
);
CREATE INDEX payment_email_outbox_due ON payment_email_outbox(next_attempt_at,created_at) WHERE state <> 'sent';
CREATE INDEX payment_email_outbox_organization ON payment_email_outbox(organization_id,state,created_at);
