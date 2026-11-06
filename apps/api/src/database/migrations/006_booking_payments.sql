-- Customer evidence stays separate from posted money until an administrator reviews it.
CREATE TABLE booking_payments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 100000000000000),
  currency char(3) NOT NULL DEFAULT 'GBP' CHECK (currency='GBP'),
  payment_date date NOT NULL CHECK (payment_date BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'),
  note text NOT NULL DEFAULT '' CHECK (char_length(note)<=1000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  submitted_by uuid NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  reviewed_by uuid,
  reviewed_at timestamptz,
  rejection_reason text CHECK (char_length(btrim(rejection_reason)) BETWEEN 1 AND 1000),
  ledger_entry_id bigint UNIQUE,
  FOREIGN KEY (organization_id,customer_id,booking_id) REFERENCES bookings(organization_id,customer_id,id),
  FOREIGN KEY (organization_id,submitted_by) REFERENCES memberships(organization_id,user_id),
  FOREIGN KEY (organization_id,reviewed_by) REFERENCES memberships(organization_id,user_id),
  FOREIGN KEY (organization_id,customer_id,ledger_entry_id) REFERENCES ledger_entries(organization_id,customer_id,id),
  UNIQUE (organization_id,idempotency_key),
  UNIQUE (organization_id,customer_id,booking_id,id),
  CHECK ((status='pending' AND reviewed_by IS NULL AND reviewed_at IS NULL AND rejection_reason IS NULL AND ledger_entry_id IS NULL)
    OR (status='approved' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND rejection_reason IS NULL AND ledger_entry_id IS NOT NULL)
    OR (status='rejected' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND rejection_reason IS NOT NULL AND ledger_entry_id IS NULL))
);
CREATE INDEX booking_payments_review ON booking_payments(organization_id,status,submitted_at,id);
CREATE INDEX booking_payments_booking ON booking_payments(organization_id,customer_id,booking_id,submitted_at,id);

CREATE TABLE booking_payment_receipts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 240 AND name !~ '[/\\\\]'),
  mime_type text NOT NULL DEFAULT 'image/webp' CHECK (mime_type='image/webp'),
  size integer NOT NULL CHECK (size BETWEEN 1 AND 5242880),
  content bytea NOT NULL,
  original_sha256 text NOT NULL CHECK (original_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,customer_id,booking_id,payment_id) REFERENCES booking_payments(organization_id,customer_id,booking_id,id),
  CHECK (octet_length(content)=size),
  UNIQUE (payment_id,original_sha256)
);
CREATE INDEX booking_payment_receipts_parent ON booking_payment_receipts(payment_id,id);
CREATE INDEX booking_payment_receipts_duplicate ON booking_payment_receipts(booking_id,original_sha256);

CREATE FUNCTION validate_booking_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'pending' OR NOT EXISTS (
      SELECT 1 FROM memberships m WHERE m.organization_id=NEW.organization_id AND m.user_id=NEW.submitted_by
        AND m.customer_id=NEW.customer_id AND m.role='customer' AND m.is_active
    ) THEN
      RAISE EXCEPTION 'Payment evidence requires the active customer membership' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['status','reviewed_by','reviewed_at','rejection_reason','ledger_entry_id'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','reviewed_by','reviewed_at','rejection_reason','ledger_entry_id'])
      OR OLD.status<>'pending' OR NEW.status NOT IN ('approved','rejected') THEN
      RAISE EXCEPTION 'Payment evidence and completed reviews are immutable' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM memberships m WHERE m.organization_id=NEW.organization_id AND m.user_id=NEW.reviewed_by
        AND m.role='admin' AND m.is_active
    ) THEN
      RAISE EXCEPTION 'Payment review requires an active administrator' USING ERRCODE='23514';
    END IF;
    IF NEW.status='approved' AND NOT EXISTS (
      SELECT 1 FROM ledger_entries e WHERE e.id=NEW.ledger_entry_id AND e.organization_id=NEW.organization_id
        AND e.customer_id=NEW.customer_id AND e.kind='payment' AND e.amount_minor=-NEW.amount_minor
        AND e.currency=NEW.currency AND e.effective_date=NEW.payment_date AND e.created_by=NEW.reviewed_by
    ) THEN
      RAISE EXCEPTION 'Approved evidence must match its posted customer payment' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM booking_payment_receipts r WHERE r.payment_id=NEW.id) THEN
      RAISE EXCEPTION 'A payment review requires receipt evidence' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER booking_payments_validate BEFORE INSERT OR UPDATE ON booking_payments
  FOR EACH ROW EXECUTE FUNCTION validate_booking_payment();
CREATE TRIGGER booking_payments_preserve BEFORE DELETE ON booking_payments
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER booking_payment_receipts_preserve BEFORE UPDATE OR DELETE ON booking_payment_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION validate_booking_payment_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
BEGIN
  -- Serialize receipt inserts with review, including callers outside the service.
  SELECT status INTO parent_status FROM booking_payments WHERE id=NEW.payment_id FOR UPDATE;
  IF parent_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'Receipts can only be added to a pending payment' USING ERRCODE='23514';
  END IF;
  IF (SELECT count(*) FROM booking_payment_receipts WHERE payment_id=NEW.payment_id)>=5 THEN
    RAISE EXCEPTION 'A payment accepts at most five receipts' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER booking_payment_receipts_validate BEFORE INSERT ON booking_payment_receipts
  FOR EACH ROW EXECUTE FUNCTION validate_booking_payment_receipt();

CREATE FUNCTION require_booking_payment_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM booking_payment_receipts WHERE payment_id=NEW.id) THEN
    RAISE EXCEPTION 'A payment submission must commit with receipt evidence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER booking_payments_require_evidence AFTER INSERT ON booking_payments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_booking_payment_evidence();
