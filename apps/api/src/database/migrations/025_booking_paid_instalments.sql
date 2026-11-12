-- Staff-recorded advance payments share the immutable booking payment history.
-- Receipt submissions retain their existing customer and evidence requirements.
ALTER TABLE booking_payments ADD COLUMN source text NOT NULL DEFAULT 'customer_receipt'
  CHECK (source IN ('customer_receipt','booking_instalment'));
ALTER TABLE booking_payments ALTER COLUMN submitted_by DROP NOT NULL;
ALTER TABLE booking_payments ADD CONSTRAINT booking_payment_source_actor CHECK (
  (source='customer_receipt' AND submitted_by IS NOT NULL) OR
  (source='booking_instalment' AND submitted_by IS NULL AND status='approved')
);
ALTER TABLE booking_instalments ADD COLUMN payment_id uuid UNIQUE;
ALTER TABLE booking_instalments ADD CONSTRAINT booking_instalment_payment_scope
  FOREIGN KEY (organization_id,customer_id,booking_id,payment_id)
  REFERENCES booking_payments(organization_id,customer_id,booking_id,id)
  ON DELETE SET NULL (payment_id);

CREATE OR REPLACE FUNCTION validate_booking_payment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP='UPDATE' AND account_purge_allows(TG_TABLE_NAME,TG_OP,to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' AND NEW.source='booking_instalment' THEN
    IF NEW.status<>'approved' OR NEW.submitted_by IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM memberships m WHERE m.organization_id=NEW.organization_id AND m.user_id=NEW.reviewed_by
        AND m.role='admin' AND m.is_active AND m.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Recorded instalment payments require an active administrator' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM ledger_entries e WHERE e.id=NEW.ledger_entry_id AND e.organization_id=NEW.organization_id
        AND e.customer_id=NEW.customer_id AND e.kind='payment' AND e.amount_minor=-NEW.amount_minor
        AND e.currency=NEW.currency AND e.effective_date=NEW.payment_date
        AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reversal_of=e.id)
    ) THEN
      RAISE EXCEPTION 'Recorded instalment payment must match its posted customer payment' USING ERRCODE='23514';
    END IF;
  ELSIF TG_OP='INSERT' THEN
    IF NEW.source<>'customer_receipt' OR NEW.status<>'pending' OR NOT EXISTS (
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
CREATE OR REPLACE FUNCTION require_booking_payment_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source='customer_receipt' AND NOT EXISTS (SELECT 1 FROM booking_payment_receipts r WHERE r.payment_id=NEW.id) THEN
    RAISE EXCEPTION 'A payment submission must commit with receipt evidence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_instalment_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM booking_payments p WHERE p.id=NEW.payment_id AND p.organization_id=NEW.organization_id
      AND p.customer_id=NEW.customer_id AND p.booking_id=NEW.booking_id
      AND p.status='approved' AND p.amount_minor=NEW.amount_minor
      AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reversal_of=p.ledger_entry_id)
  ) THEN
    RAISE EXCEPTION 'Paid instalment must match its active recorded booking payment' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER booking_instalments_validate_payment BEFORE INSERT OR UPDATE OF payment_id,amount_minor,booking_id,customer_id,organization_id
  ON booking_instalments FOR EACH ROW EXECUTE FUNCTION validate_instalment_payment();

-- Removing an administrator may anonymize an approved historical payment on a
-- cancelled booking. Only new payments and new approvals need an active trip.
CREATE OR REPLACE FUNCTION require_active_payment_booking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' OR (NEW.status='approved' AND OLD.status IS DISTINCT FROM 'approved') THEN
    IF NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id=NEW.booking_id AND b.organization_id=NEW.organization_id
      AND b.customer_id=NEW.customer_id AND b.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'Cancelled bookings cannot receive new or approved payments' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DO $$ DECLARE application_schema text:=current_schema(); BEGIN
  EXECUTE format('ALTER FUNCTION %I.validate_booking_payment() SET search_path TO pg_catalog, %I, pg_temp',application_schema,application_schema);
END; $$;
