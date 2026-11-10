-- Save both the financial snapshot and its rendered bytes: downloading an old
-- invoice must never re-render it with today's customer details or template.
CREATE TABLE booking_invoices (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  invoice_number text NOT NULL UNIQUE CHECK (char_length(invoice_number) BETWEEN 1 AND 100),
  version integer NOT NULL CHECK (version > 0),
  reason text NOT NULL CHECK (reason IN ('booking_created','payment_approved','payment_reversed','booking_updated','booking_cancelled','charge_reversed','legacy_snapshot')),
  event_key text NOT NULL CHECK (char_length(event_key) BETWEEN 1 AND 200),
  issued_at timestamptz NOT NULL,
  total_minor bigint NOT NULL CHECK (total_minor BETWEEN 0 AND 100000000000000),
  paid_minor numeric(30,0) NOT NULL CHECK (paid_minor >= 0),
  balance_minor numeric(31,0) NOT NULL,
  currency char(3) NOT NULL CHECK (currency='GBP'),
  status text NOT NULL CHECK (status IN ('unpaid','partially_paid','paid','overpaid','cancelled')),
  filename text NOT NULL CHECK (filename ~ '^inv-[a-f0-9]{32}-v[0-9]+\.pdf$'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  pdf bytea NOT NULL CHECK (octet_length(pdf) BETWEEN 12 AND 2097152 AND substring(pdf FROM 1 FOR 5)=decode('255044462d','hex')),
  FOREIGN KEY (organization_id,customer_id,booking_id)
    REFERENCES bookings(organization_id,customer_id,id) ON DELETE CASCADE,
  UNIQUE (organization_id,customer_id,booking_id,version),
  UNIQUE (organization_id,customer_id,booking_id,event_key),
  CHECK (balance_minor=total_minor-paid_minor),
  CHECK ((status='cancelled' AND total_minor=0)
    OR (status='unpaid' AND total_minor>0 AND paid_minor=0)
    OR (status='partially_paid' AND paid_minor>0 AND balance_minor>0)
    OR (status='paid' AND total_minor>0 AND balance_minor=0)
    OR (status='overpaid' AND total_minor>0 AND balance_minor<0))
);
CREATE TRIGGER booking_invoices_preserve BEFORE UPDATE OR DELETE ON booking_invoices
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
REVOKE ALL ON TABLE booking_invoices FROM PUBLIC;

-- The outbox references the exact revision produced by the booking transaction.
-- Its attachment bytes are loaded only by the delivery worker after claiming.
ALTER TABLE payment_email_outbox ADD COLUMN invoice_id uuid REFERENCES booking_invoices(id) ON DELETE CASCADE;
CREATE INDEX payment_email_outbox_invoice ON payment_email_outbox(invoice_id) WHERE invoice_id IS NOT NULL;

-- Permit deletion only inside the already-authorized workspace/customer purge
-- context. Administrator deletion needs no invoice edits or attribution rewrite.
CREATE OR REPLACE FUNCTION account_purge_allows(table_name text, operation text, old_row jsonb, new_row jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE scope record;
BEGIN
    SELECT * INTO scope FROM account_purge_context
      WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current()
        AND organization_id=(old_row->>'organization_id')::uuid;
    IF NOT FOUND THEN RETURN false; END IF;
    IF operation='DELETE' THEN
        IF table_name='booking_invoices' THEN
          RETURN scope.workspace_delete OR scope.customer_id=(old_row->>'customer_id')::uuid;
        END IF;
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
DO $$
DECLARE application_schema text:=current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION %I.account_purge_allows(text,text,jsonb,jsonb) SET search_path TO pg_catalog, %I, pg_temp',application_schema,application_schema);
END;
$$;
