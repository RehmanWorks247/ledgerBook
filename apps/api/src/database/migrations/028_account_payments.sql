-- Account submissions have no booking allocation. Existing payment identities,
-- receipts, allocations, ledger entries and invoice snapshots are unchanged.
ALTER TABLE booking_payments ALTER COLUMN booking_id DROP NOT NULL;
ALTER TABLE booking_payment_receipts ALTER COLUMN booking_id DROP NOT NULL;
ALTER TABLE booking_payments ADD CONSTRAINT booking_payment_account_scope
  FOREIGN KEY (organization_id,customer_id) REFERENCES customers(organization_id,id),
  ADD CONSTRAINT booking_payment_account_identity UNIQUE (organization_id,customer_id,id),
  ADD CONSTRAINT booking_payment_recorded_booking CHECK (source<>'booking_instalment' OR booking_id IS NOT NULL);
-- The older four-column FK still protects booking payments. This additional
-- non-null parent key protects receipts even when booking_id is NULL.
ALTER TABLE booking_payment_receipts ADD CONSTRAINT booking_payment_receipt_account_parent
  FOREIGN KEY (organization_id,customer_id,payment_id) REFERENCES booking_payments(organization_id,customer_id,id);
CREATE INDEX booking_payments_account ON booking_payments(organization_id,customer_id,submitted_at,id);
CREATE INDEX booking_payment_receipts_account_duplicate ON booking_payment_receipts(organization_id,customer_id,original_sha256);

CREATE OR REPLACE FUNCTION require_active_payment_booking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' OR (NEW.status='approved' AND OLD.status IS DISTINCT FROM 'approved') THEN
    IF NEW.booking_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id=NEW.booking_id AND b.organization_id=NEW.organization_id
        AND b.customer_id=NEW.customer_id AND b.deleted_at IS NULL) THEN
        RAISE EXCEPTION 'Cancelled bookings cannot receive new or approved payments' USING ERRCODE='23514';
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM customers c JOIN organizations o ON o.id=c.organization_id
      WHERE c.organization_id=NEW.organization_id AND c.id=NEW.customer_id AND c.status='active'
        AND o.deleted_at IS NULL AND o.currency='GBP' AND o.currency_exponent=2) THEN
      RAISE EXCEPTION 'Account payments require an active customer and GBP workspace' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_booking_payment_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent record;
BEGIN
  -- Lock before testing scope/status so approval cannot race receipt insertion.
  SELECT * INTO parent FROM booking_payments WHERE id=NEW.payment_id FOR UPDATE;
  IF NOT FOUND OR parent.organization_id IS DISTINCT FROM NEW.organization_id
    OR parent.customer_id IS DISTINCT FROM NEW.customer_id OR parent.booking_id IS DISTINCT FROM NEW.booking_id THEN
    RAISE EXCEPTION 'Receipt must match its payment account and booking scope' USING ERRCODE='23514';
  END IF;
  IF parent.status IS DISTINCT FROM 'pending' OR parent.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Receipts can only be added to an active pending payment' USING ERRCODE='23514';
  END IF;
  IF (SELECT count(*) FROM booking_payment_receipts WHERE payment_id=NEW.payment_id)>=5 THEN
    RAISE EXCEPTION 'A payment accepts at most five receipts' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Reuse the same narrowly authorized history routine and compensating ledger
-- checks for account payments. NULL must match NULL, never a booking payment.
CREATE OR REPLACE FUNCTION manage_booking_payment(actor uuid, organization uuid, customer uuid, booking uuid, payment uuid,
  expected_version integer, operation text, amount bigint, received date, memo text, entry bigint, reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE original record; revised record; trip record; receipt_ids uuid[]; financial_change boolean; customer_state text;
BEGIN
  PERFORM 1 FROM organizations WHERE id=organization AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Organization access is unavailable' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM memberships WHERE organization_id=organization AND user_id=actor AND role='admin' AND is_active AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active organization administrator access is required' USING ERRCODE='42501'; END IF;
  SELECT status INTO customer_state FROM customers WHERE organization_id=organization AND id=customer FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer was not found' USING ERRCODE='P0002'; END IF;
  IF booking IS NOT NULL THEN
    SELECT * INTO trip FROM bookings WHERE organization_id=organization AND customer_id=customer AND id=booking FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Booking was not found' USING ERRCODE='P0002'; END IF;
  END IF;
  SELECT * INTO original FROM booking_payments WHERE organization_id=organization AND customer_id=customer
    AND booking_id IS NOT DISTINCT FROM booking AND id=payment FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment was not found' USING ERRCODE='P0002'; END IF;
  IF original.version IS DISTINCT FROM expected_version THEN RAISE EXCEPTION 'Payment changed; refresh before saving' USING ERRCODE='40001'; END IF;
  IF reason IS NULL OR char_length(btrim(reason)) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'A correction reason is required' USING ERRCODE='22023'; END IF;
  revised:=original;
  revised.version:=original.version+1;
  financial_change:=false;
  IF operation='edit' THEN
    IF original.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Restore the payment before editing it' USING ERRCODE='23514'; END IF;
    revised.amount_minor:=amount; revised.payment_date:=received; revised.note:=memo;
    financial_change:=original.status='approved' AND (amount IS DISTINCT FROM original.amount_minor OR received IS DISTINCT FROM original.payment_date);
    IF financial_change THEN revised.ledger_entry_id:=entry; END IF;
  ELSIF operation='delete' THEN
    IF original.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Payment is already in trash' USING ERRCODE='23514'; END IF;
    revised.deleted_at:=clock_timestamp(); revised.deletion_reason:=btrim(reason);
    revised.restore_credit:=original.status='approved' AND EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reversal_of=original.ledger_entry_id
      AND r.created_by=actor AND r.xmin::text::bigint=mod(txid_current(),4294967296));
  ELSIF operation='restore' THEN
    IF original.deleted_at IS NULL THEN RAISE EXCEPTION 'Only a deleted payment can be restored' USING ERRCODE='23514'; END IF;
    revised.deleted_at:=NULL; revised.deletion_reason:=NULL; revised.restore_credit:=NULL;
    financial_change:=original.status='approved' AND original.restore_credit;
    IF financial_change THEN revised.ledger_entry_id:=entry; END IF;
  ELSIF operation='permanent-delete' THEN
    IF original.deleted_at IS NULL THEN RAISE EXCEPTION 'Move the payment to trash before permanently deleting it' USING ERRCODE='23514'; END IF;
  ELSE RAISE EXCEPTION 'Unsupported payment operation' USING ERRCODE='22023'; END IF;
  IF financial_change THEN
    IF customer_state<>'active' THEN
      RAISE EXCEPTION 'An active customer is required to restore or replace a payment' USING ERRCODE='23514';
    END IF;
    IF booking IS NOT NULL THEN
      IF trip.deleted_at IS NOT NULL OR EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reversal_of=trip.charge_entry_id) THEN
        RAISE EXCEPTION 'An active booking charge is required to restore or replace a booking payment' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  IF original.status='approved' AND (operation IN ('delete','restore','permanent-delete') OR financial_change) THEN
    IF NOT EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reversal_of=original.ledger_entry_id) THEN
      RAISE EXCEPTION 'Reverse the original posted payment before changing its financial effect' USING ERRCODE='23514';
    END IF;
  END IF;
  IF financial_change THEN
    IF operation='edit' AND NOT EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reversal_of=original.ledger_entry_id
      AND r.created_by=actor AND r.xmin::text::bigint=mod(txid_current(),4294967296)) THEN
      RAISE EXCEPTION 'A payment correction requires its own transactional reversal' USING ERRCODE='23514';
    END IF;
    IF revised.ledger_entry_id IS NOT DISTINCT FROM original.ledger_entry_id OR NOT EXISTS(
      SELECT 1 FROM ledger_entries e WHERE e.id=revised.ledger_entry_id AND e.organization_id=organization AND e.customer_id=customer
        AND e.kind='payment' AND e.amount_minor=-revised.amount_minor AND e.effective_date=revised.payment_date AND e.currency=original.currency
        AND e.created_by=actor AND e.xmin::text::bigint=mod(txid_current(),4294967296)
        AND NOT EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reversal_of=e.id)) THEN
      RAISE EXCEPTION 'The replacement must match a newly posted payment in this transaction' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT coalesce(array_agg(id),'{}') INTO receipt_ids FROM booking_payment_receipts WHERE payment_id=payment;
  INSERT INTO payment_history_context(backend_pid,transaction_id,organization_id,payment_id,old_row,new_row,receipt_delete_ids)
    VALUES(pg_backend_pid(),txid_current(),organization,payment,to_jsonb(original),CASE WHEN operation='permanent-delete' THEN NULL ELSE to_jsonb(revised) END,receipt_ids);
  IF operation='permanent-delete' THEN
    DELETE FROM booking_payment_receipts WHERE payment_id=payment AND organization_id=organization;
    DELETE FROM booking_payments WHERE id=payment AND organization_id=organization;
  ELSE
    -- A changed payment remains credit for this booking. Its old scheduled
    -- amount is preserved and becomes due until an administrator reallocates it.
    IF revised.amount_minor<>original.amount_minor THEN UPDATE booking_instalments SET payment_id=NULL WHERE payment_id=payment; END IF;
    UPDATE booking_payments SET amount_minor=revised.amount_minor,payment_date=revised.payment_date,note=revised.note,
      ledger_entry_id=revised.ledger_entry_id,version=revised.version,deleted_at=revised.deleted_at,deletion_reason=revised.deletion_reason,restore_credit=revised.restore_credit WHERE id=payment;
  END IF;
  DELETE FROM payment_history_context WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current();
  INSERT INTO audit_events(organization_id,actor_id,action,object_id,metadata) VALUES(organization,actor,
    CASE operation WHEN 'edit' THEN 'payment.edited' WHEN 'delete' THEN 'payment.deleted' WHEN 'restore' THEN 'payment.restored' ELSE 'payment.permanently_deleted' END,
    payment::text,jsonb_build_object('customer_id',customer,'booking_id',booking,'reason',btrim(reason),'version',expected_version,
      'before',to_jsonb(original),'after',CASE WHEN operation='permanent-delete' THEN NULL ELSE to_jsonb(revised) END));
  UPDATE bookings SET version=version+1,updated_at=now() WHERE id=booking;
  UPDATE reminder_email_outbox SET state='cancelled',delivery_status='cancelled',lease_token=NULL,lease_until=NULL,
    last_error='Payment history changed before notification delivery.' WHERE booking_id=booking AND state IN ('pending','processing');
  RETURN jsonb_build_object('id',payment,'deleted',operation='permanent-delete');
END;
$$;
DO $$ DECLARE application_schema text:=current_schema(); BEGIN
  EXECUTE format('ALTER FUNCTION %I.manage_booking_payment(uuid,uuid,uuid,uuid,uuid,integer,text,bigint,date,text,bigint,text) SET search_path TO pg_catalog, %I, pg_temp',application_schema,application_schema);
END; $$;
