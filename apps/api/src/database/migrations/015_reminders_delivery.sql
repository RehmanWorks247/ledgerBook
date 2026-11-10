-- Automatic reminders are deliberately opt-in for each organization.
CREATE TABLE reminder_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  due_soon_days integer NOT NULL DEFAULT 3 CHECK (due_soon_days BETWEEN 0 AND 14),
  repeat_days integer NOT NULL DEFAULT 7 CHECK (repeat_days BETWEEN 1 AND 30),
  send_hour integer NOT NULL DEFAULT 9 CHECK (send_hour BETWEEN 0 AND 23),
  time_zone text NOT NULL DEFAULT 'UTC',
  last_scheduled_date date,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE customer_reminder_preferences (
  customer_id uuid PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,customer_id) REFERENCES customers(organization_id,id) ON DELETE CASCADE
);
CREATE TABLE reminder_email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  instalment_id uuid REFERENCES booking_instalments(id) ON DELETE SET NULL,
  scheduled_date date NOT NULL,
  recipient text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','sent','cancelled','failed')),
  attempts integer NOT NULL DEFAULT 0,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  provider_message_id text,
  delivery_status text NOT NULL DEFAULT 'queued' CHECK (delivery_status IN ('queued','accepted','delivered','delayed','bounced','complained','failed','suppressed','cancelled')),
  delivery_updated_at timestamptz,
  UNIQUE(instalment_id,scheduled_date),
  CHECK ((state='processing') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((state='sent') = (sent_at IS NOT NULL)),
  FOREIGN KEY (organization_id,customer_id,booking_id) REFERENCES bookings(organization_id,customer_id,id) ON DELETE CASCADE
);
CREATE INDEX reminder_email_due ON reminder_email_outbox(next_attempt_at,created_at) WHERE state IN ('pending','processing');
CREATE INDEX reminder_email_history ON reminder_email_outbox(organization_id,created_at DESC,id);
CREATE INDEX reminder_email_instalment ON reminder_email_outbox(instalment_id,created_at DESC);
CREATE INDEX reminder_email_provider ON reminder_email_outbox(provider_message_id) WHERE provider_message_id IS NOT NULL;

ALTER TABLE payment_email_outbox DROP CONSTRAINT payment_email_outbox_state_check;
ALTER TABLE payment_email_outbox ADD CONSTRAINT payment_email_outbox_state_check CHECK (state IN ('pending','processing','sent','failed','cancelled'));
ALTER TABLE payment_email_outbox ADD COLUMN first_attempt_at timestamptz;
ALTER TABLE payment_email_outbox ADD COLUMN provider_message_id text;
ALTER TABLE payment_email_outbox ADD COLUMN delivery_status text NOT NULL DEFAULT 'queued'
  CHECK (delivery_status IN ('queued','accepted','delivered','delayed','bounced','complained','failed','suppressed','cancelled'));
ALTER TABLE payment_email_outbox ADD COLUMN delivery_updated_at timestamptz;
UPDATE payment_email_outbox SET delivery_status='accepted',delivery_updated_at=sent_at WHERE state='sent';
-- Old retries cannot safely exceed the provider's 24-hour idempotency window.
UPDATE payment_email_outbox SET first_attempt_at=created_at WHERE attempts>0;
CREATE INDEX payment_email_provider ON payment_email_outbox(provider_message_id) WHERE provider_message_id IS NOT NULL;

-- Store only correlation data, never webhook payloads or message bodies.
CREATE TABLE email_delivery_events (
  event_id text PRIMARY KEY,
  provider_message_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted','delivered','delayed','bounced','complained','failed','suppressed')),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_delivery_message ON email_delivery_events(provider_message_id,occurred_at DESC);
CREATE TABLE email_suppressions (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recipient_hash text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('bounced','complained','suppressed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,recipient_hash)
);
