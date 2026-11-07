-- Only the checked purge routines may authorize precisely scoped destructive
-- operations. A separate application role cannot enable a generic bypass.
-- The migration owner already has unrestricted DDL privileges; production roles
-- should receive EXECUTE only on the two checked permanent-delete routines.
CREATE TABLE account_purge_context (
    backend_pid integer NOT NULL,
    transaction_id bigint NOT NULL,
    organization_id uuid NOT NULL,
    customer_id uuid,
    user_id uuid,
    ledger_delete_ids bigint[] NOT NULL DEFAULT '{}',
    audit_delete_ids bigint[] NOT NULL DEFAULT '{}',
    ledger_anonymize_ids bigint[] NOT NULL DEFAULT '{}',
    audit_anonymize_ids bigint[] NOT NULL DEFAULT '{}',
    customer_anonymize_ids uuid[] NOT NULL DEFAULT '{}',
    invitation_anonymize_ids uuid[] NOT NULL DEFAULT '{}',
    PRIMARY KEY (backend_pid,transaction_id)
);
REVOKE ALL ON TABLE account_purge_context FROM PUBLIC;

-- Surviving books can retain their facts when an administrator is deleted,
-- without falsely attributing that administrator's work to another person.
ALTER TABLE customers ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE invitations ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE ledger_entries ALTER COLUMN created_by DROP NOT NULL;

CREATE FUNCTION account_purge_allows(table_name text, operation text, old_row jsonb, new_row jsonb)
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
    ELSIF operation='UPDATE' AND scope.user_id IS NOT NULL THEN
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
    END IF;
    RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION account_purge_allows(text,text,jsonb,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION reject_history_mutation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    IF account_purge_allows(TG_TABLE_NAME,TG_OP,to_jsonb(OLD),CASE WHEN TG_OP='UPDATE' THEN to_jsonb(NEW) ELSE NULL END) THEN
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Posted financial and audit history cannot be edited or deleted' USING ERRCODE='23514';
END;
$$;

CREATE OR REPLACE FUNCTION protect_customer_identity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    IF account_purge_allows(TG_TABLE_NAME,TG_OP,to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW; END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.email IS DISTINCT FROM OLD.email OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
        OR NEW.request_hash IS DISTINCT FROM OLD.request_hash THEN
        RAISE EXCEPTION 'Customer identity and creation history are immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_invitation_identity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    IF TG_OP='UPDATE' AND account_purge_allows(TG_TABLE_NAME,TG_OP,to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW; END IF;
    IF NOT EXISTS (SELECT 1 FROM customers c WHERE c.id=NEW.customer_id AND c.organization_id=NEW.organization_id AND c.email=NEW.email) THEN
        RAISE EXCEPTION 'Invitation must match its customer email and organization' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND (
        NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.email IS DISTINCT FROM OLD.email
        OR NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
        OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR (OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS DISTINCT FROM OLD.accepted_at)
        OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
    ) THEN
        RAISE EXCEPTION 'Invitation identity and consumed status are immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION permanently_delete_customer(actor_user uuid, organization uuid, customer uuid, confirmation_email text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    account record;
    member_ids uuid[];
    member_users uuid[];
    invitation_ids uuid[];
    entry_ids bigint[];
    event_ids bigint[];
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
    SELECT COALESCE(array_agg(a.id),'{}') INTO event_ids FROM audit_events a WHERE a.organization_id=organization AND (
        a.object_id=customer::text OR a.object_id=ANY(member_ids::text[]) OR a.object_id=ANY(invitation_ids::text[]) OR a.object_id=ANY(entry_ids::text[])
        OR a.object_id=ANY(member_users::text[]) OR a.actor_id=ANY(member_users)
        OR a.metadata->>'customerId'=customer::text OR a.metadata->>'customer_id'=customer::text
        OR a.metadata->>'membershipId'=ANY(member_ids::text[]) OR a.metadata->>'userId'=ANY(member_users::text[])
        OR a.metadata->>'invitationId'=ANY(invitation_ids::text[])
    );
    INSERT INTO account_purge_context(backend_pid,transaction_id,organization_id,customer_id,ledger_delete_ids,audit_delete_ids)
      VALUES(pg_backend_pid(),txid_current(),organization,customer,entry_ids,event_ids);
    DELETE FROM audit_events WHERE id=ANY(event_ids) AND organization_id=organization;
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
REVOKE ALL ON FUNCTION permanently_delete_customer(uuid,uuid,uuid,text) FROM PUBLIC;

CREATE FUNCTION permanently_delete_administrator(actor_user uuid, organization uuid, target_membership uuid, confirmation_email text)
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
    INSERT INTO account_purge_context(backend_pid,transaction_id,organization_id,user_id,audit_delete_ids,ledger_anonymize_ids,audit_anonymize_ids,customer_anonymize_ids,invitation_anonymize_ids)
    VALUES(pg_backend_pid(),txid_current(),organization,identity.id,event_ids,
      ARRAY(SELECT id FROM ledger_entries WHERE organization_id=organization AND created_by=identity.id),
      ARRAY(SELECT id FROM audit_events WHERE organization_id=organization AND actor_id=identity.id AND NOT(id=ANY(event_ids))),
      ARRAY(SELECT id FROM customers WHERE organization_id=organization AND created_by=identity.id),
      ARRAY(SELECT id FROM invitations WHERE organization_id=organization AND created_by=identity.id));
    DELETE FROM audit_events WHERE id=ANY(event_ids) AND organization_id=organization;
    UPDATE audit_events SET actor_id=NULL WHERE organization_id=organization AND actor_id=identity.id;
    UPDATE ledger_entries SET created_by=NULL WHERE organization_id=organization AND created_by=identity.id;
    UPDATE invitations SET created_by=NULL WHERE organization_id=organization AND created_by=identity.id;
    UPDATE customers SET created_by=NULL WHERE organization_id=organization AND created_by=identity.id;
    DELETE FROM memberships WHERE id=member.id AND organization_id=organization;
    DELETE FROM account_purge_context WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current();
    RETURN jsonb_build_object('user_ids',ARRAY[identity.id]);
END;
$$;
REVOKE ALL ON FUNCTION permanently_delete_administrator(uuid,uuid,uuid,text) FROM PUBLIC;

-- Resolve the migration's actual application schema, including isolated test
-- schemas, then pin every privileged routine to it with pg_temp explicitly last.
DO $$
DECLARE application_schema text:=current_schema(); routine text;
BEGIN
    FOREACH routine IN ARRAY ARRAY[
      'account_purge_allows(text,text,jsonb,jsonb)', 'reject_history_mutation()',
      'protect_customer_identity()', 'validate_invitation_identity()',
      'permanently_delete_customer(uuid,uuid,uuid,text)',
      'permanently_delete_administrator(uuid,uuid,uuid,text)'
    ] LOOP
      EXECUTE format('ALTER FUNCTION %I.%s SET search_path TO pg_catalog, %I, pg_temp',application_schema,routine,application_schema);
    END LOOP;
END;
$$;
