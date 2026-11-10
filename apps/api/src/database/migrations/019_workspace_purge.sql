-- A workspace purge is scoped to a single locked tenant, without collecting
-- every financial entry into arrays. Only this checked definer routine can
-- establish the private transaction context used by immutable-history triggers.
ALTER TABLE account_purge_context ADD COLUMN workspace_delete boolean NOT NULL DEFAULT false;

CREATE TABLE workspace_delete_receipts (
  organization_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  files_pending integer NOT NULL CHECK (files_pending >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION account_purge_allows(table_name text, operation text, old_row jsonb, new_row jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE scope record;
BEGIN
    SELECT * INTO scope FROM account_purge_context
      WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current()
        AND organization_id=(old_row->>'organization_id')::uuid;
    IF NOT FOUND THEN RETURN false; END IF;
    IF operation='DELETE' THEN
        IF scope.workspace_delete AND table_name IN ('ledger_entries','audit_events','booking_payments','booking_payment_receipts') THEN RETURN true; END IF;
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
REVOKE ALL ON FUNCTION account_purge_allows(text,text,jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION permanently_delete_workspace(actor_user uuid, organization uuid, confirmation_name text, expected_version integer, request_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE workspace record; receipt record; pending_files integer;
BEGIN
    IF request_hash IS NULL OR request_hash !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'A valid deletion request digest is required' USING ERRCODE='22023';
    END IF;
    SELECT * INTO workspace FROM organizations WHERE id=organization FOR UPDATE;
    IF NOT FOUND THEN
      SELECT r.files_pending INTO receipt FROM workspace_delete_receipts r
        WHERE r.organization_id=organization AND r.actor_id=actor_user AND r.request_hash=$5;
      IF FOUND THEN RETURN jsonb_build_object('id',organization,'deleted',true,'files_pending',receipt.files_pending); END IF;
      RAISE EXCEPTION 'Workspace was not found' USING ERRCODE='P0002';
    END IF;
    PERFORM 1 FROM memberships WHERE organization_id=organization AND user_id=actor_user
      AND role='admin' AND is_active AND deleted_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active workspace administrator access is required' USING ERRCODE='42501'; END IF;
    IF confirmation_name IS DISTINCT FROM workspace.name THEN
      RAISE EXCEPTION 'The confirmation name does not match this workspace' USING ERRCODE='22023';
    END IF;
    IF expected_version IS DISTINCT FROM workspace.version THEN
      RAISE EXCEPTION 'This workspace changed in another session. Refresh before deleting it.' USING ERRCODE='40001';
    END IF;

    -- Sign-in identities are global; deleting their workspace never deletes or
    -- disables their other memberships. Its administrator can create a new one.
    UPDATE users SET workspace_creator=true WHERE id=actor_user;
    INSERT INTO account_purge_context(backend_pid,transaction_id,organization_id,workspace_delete)
      VALUES(pg_backend_pid(),txid_current(),organization,true);

    SELECT count(*)::integer INTO pending_files FROM document_objects WHERE organization_id=organization;
    INSERT INTO document_purge_outbox(id,bucket,object_key,checksum,size)
      SELECT id,bucket,object_key,checksum,size FROM document_objects WHERE organization_id=organization
      ON CONFLICT(id) DO NOTHING;

    DELETE FROM email_delivery_events WHERE provider_message_id IN (
      SELECT provider_message_id FROM payment_email_outbox WHERE organization_id=organization AND provider_message_id IS NOT NULL
      UNION SELECT provider_message_id FROM reminder_email_outbox WHERE organization_id=organization AND provider_message_id IS NOT NULL
    );
    DELETE FROM reminder_email_outbox WHERE organization_id=organization;
    DELETE FROM payment_email_outbox WHERE organization_id=organization;
    DELETE FROM audit_events WHERE organization_id=organization;
    DELETE FROM booking_payment_receipts WHERE organization_id=organization;
    DELETE FROM booking_payments WHERE organization_id=organization;
    -- All object coordinates were journaled above. Remove snapshots together
    -- before nodes so a historical object shared by snapshots cannot block purge.
    DELETE FROM document_versions WHERE document_id IN (SELECT id FROM booking_nodes WHERE organization_id=organization);
    DELETE FROM booking_nodes WHERE organization_id=organization;
    DELETE FROM document_objects WHERE organization_id=organization;
    DELETE FROM booking_instalments WHERE organization_id=organization;
    DELETE FROM bookings WHERE organization_id=organization;
    DELETE FROM ledger_entries WHERE organization_id=organization AND kind='reversal';
    DELETE FROM ledger_entries WHERE organization_id=organization;
    DELETE FROM invitations WHERE organization_id=organization;
    DELETE FROM exchange_rate_overrides WHERE organization_id=organization;
    DELETE FROM memberships WHERE organization_id=organization;
    DELETE FROM customers WHERE organization_id=organization;
    DELETE FROM reminder_settings WHERE organization_id=organization;
    DELETE FROM email_suppressions WHERE organization_id=organization;
    -- Keep only the actor's submission key/digest, preventing stale create
    -- retries from recreating a deleted workspace or returning its profile.
    UPDATE workspace_create_requests SET response=NULL WHERE organization_id=organization;
    DELETE FROM organizations WHERE id=organization;
    DELETE FROM account_purge_context WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current();
    INSERT INTO workspace_delete_receipts(organization_id,actor_id,request_hash,files_pending)
      VALUES(organization,actor_user,$5,pending_files);
    RETURN jsonb_build_object('id',organization,'deleted',true,'files_pending',pending_files);
END;
$$;
REVOKE ALL ON FUNCTION permanently_delete_workspace(uuid,uuid,text,integer,text) FROM PUBLIC;

DO $$
DECLARE application_schema text:=current_schema(); routine text;
BEGIN
    FOREACH routine IN ARRAY ARRAY[
      'account_purge_allows(text,text,jsonb,jsonb)',
      'permanently_delete_workspace(uuid,uuid,text,integer,text)'
    ] LOOP
      EXECUTE format('ALTER FUNCTION %I.%s SET search_path TO pg_catalog, %I, pg_temp',application_schema,routine,application_schema);
    END LOOP;
END;
$$;
