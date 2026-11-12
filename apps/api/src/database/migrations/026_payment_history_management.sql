-- Add lifecycle metadata only. Existing payments, receipts, invoices and ledger
-- entries retain their values, identities and financial effects.
ALTER TABLE booking_payments ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version>0),
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN restore_credit boolean,
  ADD COLUMN deletion_reason text CHECK (char_length(btrim(deletion_reason)) BETWEEN 1 AND 1000),
  ADD CONSTRAINT booking_payment_deletion_state CHECK ((deleted_at IS NULL)=(deletion_reason IS NULL) AND (deleted_at IS NULL)=(restore_credit IS NULL));
CREATE INDEX booking_payments_deleted ON booking_payments(organization_id,booking_id,deleted_at) WHERE deleted_at IS NOT NULL;

-- The runtime cannot populate this exact-row authorization context. It exists
-- only while the checked definer routine below performs one scoped mutation.
CREATE TABLE payment_history_context (
  backend_pid integer NOT NULL,
  transaction_id bigint NOT NULL,
  organization_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  old_row jsonb NOT NULL,
  new_row jsonb,
  receipt_delete_ids uuid[] NOT NULL DEFAULT '{}',
  PRIMARY KEY(backend_pid,transaction_id)
);
REVOKE ALL ON TABLE payment_history_context FROM PUBLIC;
CREATE FUNCTION payment_history_allows(table_name text, operation text, old_value jsonb, new_value jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scope record;
BEGIN
  SELECT * INTO scope FROM payment_history_context WHERE backend_pid=pg_backend_pid()
    AND transaction_id=txid_current() AND organization_id=(old_value->>'organization_id')::uuid;
  IF NOT FOUND THEN RETURN false; END IF;
  IF table_name='booking_payments' AND old_value=scope.old_row THEN
    RETURN (operation='DELETE' AND scope.new_row IS NULL)
      OR (operation='UPDATE' AND new_value=scope.new_row);
  END IF;
  RETURN table_name='booking_payment_receipts' AND operation='DELETE' AND scope.new_row IS NULL
    AND (old_value->>'payment_id')::uuid=scope.payment_id AND (old_value->>'id')::uuid=ANY(scope.receipt_delete_ids);
END;
$$;
REVOKE ALL ON FUNCTION payment_history_allows(text,text,jsonb,jsonb) FROM PUBLIC;
CREATE FUNCTION protect_payment_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF account_purge_allows(TG_TABLE_NAME,TG_OP,to_jsonb(OLD),CASE WHEN TG_OP='UPDATE' THEN to_jsonb(NEW) ELSE NULL END)
    OR payment_history_allows(TG_TABLE_NAME,TG_OP,to_jsonb(OLD),CASE WHEN TG_OP='UPDATE' THEN to_jsonb(NEW) ELSE NULL END) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Payment history is immutable outside checked administrator corrections' USING ERRCODE='23514';
END;
$$;
DROP TRIGGER booking_payments_preserve ON booking_payments;
CREATE TRIGGER booking_payments_preserve BEFORE DELETE ON booking_payments FOR EACH ROW EXECUTE FUNCTION protect_payment_history();
DROP TRIGGER booking_payment_receipts_preserve ON booking_payment_receipts;
CREATE TRIGGER booking_payment_receipts_preserve BEFORE UPDATE OR DELETE ON booking_payment_receipts FOR EACH ROW EXECUTE FUNCTION protect_payment_history();

CREATE OR REPLACE FUNCTION validate_booking_payment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP='UPDATE' AND payment_history_allows(TG_TABLE_NAME,TG_OP,to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' AND (NEW.version<>1 OR NEW.deleted_at IS NOT NULL OR NEW.deletion_reason IS NOT NULL OR NEW.restore_credit IS NOT NULL) THEN
    RAISE EXCEPTION 'New payments must start active at version one' USING ERRCODE='23514';
  END IF;
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
    -- Support old application instances while deployment switches traffic.
    IF OLD.status='pending' AND NEW.status IN ('approved','rejected') AND NEW.version=OLD.version THEN NEW.version:=OLD.version+1; END IF;
    IF (to_jsonb(NEW)-ARRAY['status','reviewed_by','reviewed_at','rejection_reason','ledger_entry_id','version'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','reviewed_by','reviewed_at','rejection_reason','ledger_entry_id','version'])
      OR OLD.status<>'pending' OR OLD.deleted_at IS NOT NULL OR NEW.status NOT IN ('approved','rejected') OR NEW.version<>OLD.version+1 THEN
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
  END IF;
  RETURN NEW;
END;
$$;

-- Attachments are optional; supplied receipt bytes and their immutability stay unchanged.
DROP TRIGGER booking_payments_require_evidence ON booking_payments;

-- Supplied attachments remain immutable and cannot be appended while in trash.
CREATE OR REPLACE FUNCTION validate_booking_payment_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status text; parent_deleted timestamptz;
BEGIN
  SELECT status,deleted_at INTO parent_status,parent_deleted FROM booking_payments WHERE id=NEW.payment_id FOR UPDATE;
  IF parent_status IS DISTINCT FROM 'pending' OR parent_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'Receipts can only be added to an active pending payment' USING ERRCODE='23514';
  END IF;
  IF (SELECT count(*) FROM booking_payment_receipts WHERE payment_id=NEW.payment_id)>=5 THEN
    RAISE EXCEPTION 'A payment accepts at most five receipts' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

-- The caller posts append-only compensating ledger entries first in the same
-- transaction. The routine validates their exact scope and transaction before
-- permitting financial fields to change; it can never authorize ledger edits.
CREATE FUNCTION manage_booking_payment(actor uuid, organization uuid, customer uuid, booking uuid, payment uuid,
  expected_version integer, operation text, amount bigint, received date, memo text, entry bigint, reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE original record; revised record; trip record; receipt_ids uuid[]; financial_change boolean;
BEGIN
  PERFORM 1 FROM organizations WHERE id=organization AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Organization access is unavailable' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM memberships WHERE organization_id=organization AND user_id=actor AND role='admin' AND is_active AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active organization administrator access is required' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM customers WHERE organization_id=organization AND id=customer FOR UPDATE;
  SELECT b.*,c.status AS customer_status INTO trip FROM bookings b JOIN customers c ON c.id=b.customer_id AND c.organization_id=b.organization_id
    WHERE b.organization_id=organization AND b.customer_id=customer AND b.id=booking FOR UPDATE OF b;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking was not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO original FROM booking_payments WHERE organization_id=organization AND customer_id=customer AND booking_id=booking AND id=payment FOR UPDATE;
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
    IF trip.deleted_at IS NOT NULL OR trip.customer_status<>'active'
      OR EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reversal_of=trip.charge_entry_id) THEN
      RAISE EXCEPTION 'An active customer and booking charge are required to restore or replace a payment' USING ERRCODE='23514';
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
REVOKE ALL ON FUNCTION manage_booking_payment(uuid,uuid,uuid,uuid,uuid,integer,text,bigint,date,text,bigint,text) FROM PUBLIC;
DO $$ DECLARE application_schema text:=current_schema(); routine text; BEGIN
  FOREACH routine IN ARRAY ARRAY['payment_history_allows(text,text,jsonb,jsonb)','protect_payment_history()',
    'validate_booking_payment()','manage_booking_payment(uuid,uuid,uuid,uuid,uuid,integer,text,bigint,date,text,bigint,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path TO pg_catalog, %I, pg_temp',application_schema,routine,application_schema);
  END LOOP;
END; $$;
