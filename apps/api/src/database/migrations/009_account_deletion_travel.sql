-- Integrate the saved account-deletion workflow with travel and payment data.
-- Prior migration files retain their names and checksums on either upgrade path.
ALTER TABLE account_purge_context
  ADD COLUMN payment_delete_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN receipt_delete_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN booking_anonymize_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN node_anonymize_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN payment_anonymize_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE bookings ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE booking_nodes ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE exchange_rate_overrides ALTER COLUMN updated_by DROP NOT NULL;

-- An approved/rejected review survives removal of its administrator. The
-- validation trigger still requires an active reviewer for every new review.
ALTER TABLE booking_payments DROP CONSTRAINT booking_payments_check;
ALTER TABLE booking_payments ADD CONSTRAINT booking_payments_review_state CHECK (
  (status='pending' AND reviewed_by IS NULL AND reviewed_at IS NULL AND rejection_reason IS NULL AND ledger_entry_id IS NULL)
  OR (status='approved' AND reviewed_at IS NOT NULL AND rejection_reason IS NULL AND ledger_entry_id IS NOT NULL)
  OR (status='rejected' AND reviewed_at IS NOT NULL AND rejection_reason IS NOT NULL AND ledger_entry_id IS NULL)
);

CREATE TABLE document_purge_outbox (
  id uuid PRIMARY KEY,
  bucket text NOT NULL,
  object_key text NOT NULL UNIQUE,
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  size integer NOT NULL CHECK (size BETWEEN 12 AND 10485760),
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE document_purge_outbox FROM PUBLIC;

CREATE OR REPLACE FUNCTION account_purge_allows(table_name text, operation text, old_row jsonb, new_row jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE scope record;
BEGIN
    SELECT * INTO scope FROM account_purge_context
      WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current()
        AND organization_id=(old_row->>'organization_id')::uuid;
    IF NOT FOUND THEN RETURN false; END IF;
    IF operation='DELETE' THEN
        IF table_name='ledger_entries' THEN RETURN (old_row->>'id')::bigint=ANY(scope.ledger_delete_ids); END IF;
        IF table_name='audit_events' THEN RETURN (old_row->>'id')::bigint=ANY(scope.audit_delete_ids); END IF;
        IF table_name='booking_payments' THEN RETURN (old_row->>'id')::uuid=ANY(scope.payment_delete_ids); END IF;
        IF table_name='booking_payment_receipts' THEN RETURN (old_row->>'id')::uuid=ANY(scope.receipt_delete_ids); END IF;
    ELSIF operation='UPDATE' AND scope.user_id IS NOT NULL THEN
        IF table_name='booking_payments' THEN
            RETURN (old_row->>'id')::uuid=ANY(scope.payment_anonymize_ids)
              AND (old_row->>'reviewed_by')::uuid=scope.user_id AND new_row->>'reviewed_by' IS NULL
              AND old_row-'reviewed_by'=new_row-'reviewed_by';
        END IF;
        IF table_name='audit_events' THEN
            RETURN (old_row->>'id')::bigint=ANY(scope.audit_anonymize_ids)
              AND (old_row->>'actor_id')::uuid=scope.user_id AND new_row->>'actor_id' IS NULL
              AND old_row-'actor_id'=new_row-'actor_id';
        END IF;
        IF new_row->>'created_by' IS NOT NULL OR (old_row->>'created_by')::uuid IS DISTINCT FROM scope.user_id
          OR old_row-'created_by' IS DISTINCT FROM new_row-'created_by' THEN RETURN false; END IF;
        IF table_name='ledger_entries' THEN RETURN (old_row->>'id')::bigint=ANY(scope.ledger_anonymize_ids); END IF;
        IF table_name='customers' THEN RETURN (old_row->>'id')::uuid=ANY(scope.customer_anonymize_ids); END IF;
        IF table_name='invitations' THEN RETURN (old_row->>'id')::uuid=ANY(scope.invitation_anonymize_ids); END IF;
        IF table_name='bookings' THEN RETURN (old_row->>'id')::uuid=ANY(scope.booking_anonymize_ids); END IF;
        IF table_name='booking_nodes' THEN RETURN (old_row->>'id')::uuid=ANY(scope.node_anonymize_ids); END IF;
    END IF;
    RETURN false;
END;
$$;
CREATE OR REPLACE FUNCTION validate_booking_payment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP='UPDATE' AND account_purge_allows(TG_TABLE_NAME,TG_OP,to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW; END IF;
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
CREATE OR REPLACE FUNCTION permanently_delete_customer(actor_user uuid, organization uuid, customer uuid, confirmation_email text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    account record;
    member_ids uuid[];
    member_users uuid[];
    invitation_ids uuid[];
    entry_ids bigint[];
    event_ids bigint[];
    payment_ids uuid[];
    receipt_ids uuid[];
    booking_ids uuid[];
    node_ids uuid[];
BEGIN
    PERFORM 1 FROM organizations WHERE id=organization FOR UPDATE;
    PERFORM 1 FROM memberships WHERE organization_id=organization AND user_id=actor_user AND role='admin' AND is_active AND deleted_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active organization administrator access is required' USING ERRCODE='42501'; END IF;
    SELECT * INTO account FROM customers WHERE id=customer AND organization_id=organization FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Customer account was not found' USING ERRCODE='P0002'; END IF;
    IF lower(btrim(confirmation_email)) IS DISTINCT FROM account.email THEN
        RAISE EXCEPTION 'The confirmation email does not match this customer account' USING ERRCODE='22023';
    END IF;
    SELECT COALESCE(array_agg(id),'{}'),COALESCE(array_agg(user_id),'{}') INTO member_ids,member_users FROM memberships WHERE customer_id=customer AND organization_id=organization;
    SELECT COALESCE(array_agg(id),'{}') INTO invitation_ids FROM invitations WHERE customer_id=customer AND organization_id=organization;
    SELECT COALESCE(array_agg(id),'{}') INTO entry_ids FROM ledger_entries WHERE customer_id=customer AND organization_id=organization;
    SELECT COALESCE(array_agg(id),'{}') INTO booking_ids FROM bookings WHERE customer_id=customer AND organization_id=organization;
    SELECT COALESCE(array_agg(id),'{}') INTO node_ids FROM booking_nodes WHERE customer_id=customer AND organization_id=organization;
    SELECT COALESCE(array_agg(id),'{}') INTO payment_ids FROM booking_payments WHERE customer_id=customer AND organization_id=organization;
    SELECT COALESCE(array_agg(id),'{}') INTO receipt_ids FROM booking_payment_receipts WHERE customer_id=customer AND organization_id=organization;
    SELECT COALESCE(array_agg(a.id),'{}') INTO event_ids FROM audit_events a WHERE a.organization_id=organization AND (
        a.object_id=customer::text OR a.object_id=ANY(member_ids::text[]) OR a.object_id=ANY(invitation_ids::text[]) OR a.object_id=ANY(entry_ids::text[])
        OR a.object_id=ANY(member_users::text[]) OR a.actor_id=ANY(member_users)
        OR a.metadata->>'customerId'=customer::text OR a.metadata->>'customer_id'=customer::text
        OR a.metadata->>'membershipId'=ANY(member_ids::text[]) OR a.metadata->>'userId'=ANY(member_users::text[])
        OR a.metadata->>'invitationId'=ANY(invitation_ids::text[])
        OR a.object_id=ANY(booking_ids::text[]) OR a.object_id=ANY(node_ids::text[])
        OR a.object_id=ANY(payment_ids::text[]) OR a.object_id=ANY(receipt_ids::text[])
        OR a.metadata->>'booking_id'=ANY(booking_ids::text[]) OR a.metadata->>'bookingId'=ANY(booking_ids::text[])
        OR a.metadata->>'payment_id'=ANY(payment_ids::text[]) OR a.metadata->>'paymentId'=ANY(payment_ids::text[])
    );
    INSERT INTO account_purge_context(backend_pid,transaction_id,organization_id,customer_id,ledger_delete_ids,audit_delete_ids,payment_delete_ids,receipt_delete_ids)
      VALUES(pg_backend_pid(),txid_current(),organization,customer,entry_ids,event_ids,payment_ids,receipt_ids);
    DELETE FROM audit_events WHERE id=ANY(event_ids) AND organization_id=organization;
    -- The durable removal journal survives the customer's deletion and retries
    -- failed cloud cleanup without retaining account or booking relationships.
    INSERT INTO document_purge_outbox(id,bucket,object_key,checksum,size)
      SELECT id,bucket,object_key,checksum,size FROM document_objects WHERE organization_id=organization AND customer_id=customer;
    DELETE FROM payment_email_outbox WHERE organization_id=organization AND
      (recipient=account.email OR split_part(dedupe_key,':',2)=ANY(payment_ids::text[]));
    DELETE FROM booking_payment_receipts WHERE id=ANY(receipt_ids) AND organization_id=organization;
    DELETE FROM booking_payments WHERE id=ANY(payment_ids) AND organization_id=organization;
    DELETE FROM booking_nodes WHERE id=ANY(node_ids) AND organization_id=organization;
    DELETE FROM document_objects WHERE customer_id=customer AND organization_id=organization;
    DELETE FROM booking_instalments WHERE customer_id=customer AND organization_id=organization;
    DELETE FROM bookings WHERE id=ANY(booking_ids) AND organization_id=organization;
    -- Reversals reference originals with RESTRICT, so remove them first.
    DELETE FROM ledger_entries WHERE id=ANY(entry_ids) AND organization_id=organization AND kind='reversal';
    DELETE FROM ledger_entries WHERE id=ANY(entry_ids) AND organization_id=organization;
    DELETE FROM invitations WHERE id=ANY(invitation_ids) AND organization_id=organization;
    DELETE FROM memberships WHERE id=ANY(member_ids) AND organization_id=organization;
    DELETE FROM customers WHERE id=customer AND organization_id=organization;
    DELETE FROM account_purge_context WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current();
    RETURN jsonb_build_object('customer_id',customer,'user_ids',member_users,'ledger_entries',cardinality(entry_ids),'audit_events',cardinality(event_ids));
END;
$$;
CREATE OR REPLACE FUNCTION permanently_delete_administrator(actor_user uuid, organization uuid, target_membership uuid, confirmation_email text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    member record;
    identity record;
    event_ids bigint[];
BEGIN
    PERFORM 1 FROM organizations WHERE id=organization FOR UPDATE;
    PERFORM 1 FROM memberships WHERE organization_id=organization AND user_id=actor_user AND role='admin' AND is_active AND deleted_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active organization administrator access is required' USING ERRCODE='42501'; END IF;
    SELECT * INTO member FROM memberships WHERE id=target_membership AND organization_id=organization AND role='admin' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Administrator was not found' USING ERRCODE='P0002'; END IF;
    IF member.user_id=actor_user THEN RAISE EXCEPTION 'You cannot delete your own administrator account' USING ERRCODE='22023'; END IF;
    IF member.is_active AND (SELECT count(*) FROM memberships WHERE organization_id=organization AND role='admin' AND is_active AND deleted_at IS NULL)<=1 THEN
        RAISE EXCEPTION 'The organization must retain an active administrator' USING ERRCODE='22023';
    END IF;
    SELECT * INTO identity FROM users WHERE id=member.user_id FOR UPDATE;
    IF lower(btrim(confirmation_email)) IS DISTINCT FROM identity.email THEN
        RAISE EXCEPTION 'The confirmation email does not match this administrator' USING ERRCODE='22023';
    END IF;
    SELECT COALESCE(array_agg(a.id),'{}') INTO event_ids FROM audit_events a WHERE a.organization_id=organization AND (
        a.object_id=member.id::text OR a.object_id=identity.id::text OR a.metadata->>'membershipId'=member.id::text OR a.metadata->>'userId'=identity.id::text
    );
    INSERT INTO account_purge_context(backend_pid,transaction_id,organization_id,user_id,audit_delete_ids,ledger_anonymize_ids,audit_anonymize_ids,customer_anonymize_ids,invitation_anonymize_ids,booking_anonymize_ids,node_anonymize_ids,payment_anonymize_ids)
    VALUES(pg_backend_pid(),txid_current(),organization,identity.id,event_ids,
      ARRAY(SELECT id FROM ledger_entries WHERE organization_id=organization AND created_by=identity.id),
      ARRAY(SELECT id FROM audit_events WHERE organization_id=organization AND actor_id=identity.id AND NOT(id=ANY(event_ids))),
      ARRAY(SELECT id FROM customers WHERE organization_id=organization AND created_by=identity.id),
      ARRAY(SELECT id FROM invitations WHERE organization_id=organization AND created_by=identity.id),
      ARRAY(SELECT id FROM bookings WHERE organization_id=organization AND created_by=identity.id),
      ARRAY(SELECT id FROM booking_nodes WHERE organization_id=organization AND created_by=identity.id),
      ARRAY(SELECT id FROM booking_payments WHERE organization_id=organization AND reviewed_by=identity.id));
    DELETE FROM audit_events WHERE id=ANY(event_ids) AND organization_id=organization;
    UPDATE audit_events SET actor_id=NULL WHERE organization_id=organization AND actor_id=identity.id;
    UPDATE ledger_entries SET created_by=NULL WHERE organization_id=organization AND created_by=identity.id;
    UPDATE invitations SET created_by=NULL WHERE organization_id=organization AND created_by=identity.id;
    UPDATE customers SET created_by=NULL WHERE organization_id=organization AND created_by=identity.id;
    UPDATE exchange_rate_overrides SET updated_by=NULL WHERE organization_id=organization AND updated_by=identity.id;
    UPDATE bookings SET created_by=NULL WHERE organization_id=organization AND created_by=identity.id;
    UPDATE booking_nodes SET created_by=NULL WHERE organization_id=organization AND created_by=identity.id;
    UPDATE booking_payments SET reviewed_by=NULL WHERE organization_id=organization AND reviewed_by=identity.id;
    DELETE FROM payment_email_outbox WHERE organization_id=organization AND recipient=identity.email;
    DELETE FROM memberships WHERE id=member.id AND organization_id=organization;
    DELETE FROM account_purge_context WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current();
    RETURN jsonb_build_object('user_ids',ARRAY[identity.id]);
END;
$$;
-- Ordinary document edits cannot erase or rewrite their author's identity.
CREATE FUNCTION protect_booking_creator() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.created_by IS DISTINCT FROM OLD.created_by
    AND NOT account_purge_allows(TG_TABLE_NAME,TG_OP,to_jsonb(OLD),to_jsonb(NEW)) THEN
    RAISE EXCEPTION 'Booking creator attribution is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bookings_preserve_creator BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION protect_booking_creator();
CREATE TRIGGER booking_nodes_preserve_creator BEFORE UPDATE ON booking_nodes FOR EACH ROW EXECUTE FUNCTION protect_booking_creator();

DO $$
DECLARE application_schema text:=current_schema(); routine text;
BEGIN
  FOREACH routine IN ARRAY ARRAY[
    'account_purge_allows(text,text,jsonb,jsonb)', 'validate_booking_payment()', 'protect_booking_creator()',
    'permanently_delete_customer(uuid,uuid,uuid,text)', 'permanently_delete_administrator(uuid,uuid,uuid,text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path TO pg_catalog, %I, pg_temp',application_schema,routine,application_schema);
  END LOOP;
END;
$$;
