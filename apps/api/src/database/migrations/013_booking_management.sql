-- Booking cancellation retains the immutable ledger, receipts and document audit.
ALTER TABLE bookings ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE bookings ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE bookings ADD COLUMN deleted_at timestamptz;
ALTER TABLE bookings ADD COLUMN deleted_by uuid;
ALTER TABLE bookings ADD COLUMN deletion_reason text;
ALTER TABLE bookings ADD CONSTRAINT booking_cancellation_actor
  FOREIGN KEY (organization_id,deleted_by) REFERENCES memberships(organization_id,user_id) ON DELETE SET NULL (deleted_by);
ALTER TABLE bookings ADD CONSTRAINT booking_cancellation_complete CHECK (
  (deleted_at IS NULL AND deleted_by IS NULL AND deletion_reason IS NULL) OR
  (deleted_at IS NOT NULL AND char_length(btrim(deletion_reason)) BETWEEN 1 AND 1000)
);
CREATE INDEX bookings_active_customer ON bookings(organization_id,customer_id,departure_at DESC,id) WHERE deleted_at IS NULL;

-- An interrupted response can replay the committed result even after a later edit.
CREATE TABLE booking_operations (
  organization_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  action text NOT NULL CHECK (action IN ('updated','cancelled')),
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,idempotency_key),
  FOREIGN KEY(organization_id,customer_id,booking_id)
    REFERENCES bookings(organization_id,customer_id,id) ON DELETE CASCADE
);

CREATE FUNCTION require_active_payment_booking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP='INSERT' OR NEW.status='approved') AND NOT EXISTS (
    SELECT 1 FROM bookings b WHERE b.id=NEW.booking_id AND b.organization_id=NEW.organization_id
      AND b.customer_id=NEW.customer_id AND b.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Cancelled bookings cannot receive new or approved payments' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER booking_payments_require_active_booking BEFORE INSERT OR UPDATE ON booking_payments
  FOR EACH ROW EXECUTE FUNCTION require_active_payment_booking();
