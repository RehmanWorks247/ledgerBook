-- Retain the exact invoice the customer selected, even after a later revision.
ALTER TABLE booking_invoices ADD CONSTRAINT booking_invoices_payment_scope
  UNIQUE(organization_id,customer_id,booking_id,id);
ALTER TABLE booking_payments ADD COLUMN invoice_id uuid;
ALTER TABLE booking_payments ADD CONSTRAINT payment_invoice_scope
  FOREIGN KEY(organization_id,customer_id,booking_id,invoice_id)
  REFERENCES booking_invoices(organization_id,customer_id,booking_id,id);
ALTER TABLE booking_payments ADD CONSTRAINT payment_invoice_requires_booking CHECK(invoice_id IS NULL OR booking_id IS NOT NULL);

-- Administrator notices still belong to the accepted customer's lifecycle.
ALTER TABLE payment_email_outbox ADD COLUMN source_customer_id uuid;
ALTER TABLE payment_email_outbox ADD CONSTRAINT email_source_customer_scope
  FOREIGN KEY(organization_id,source_customer_id) REFERENCES customers(organization_id,id) ON DELETE CASCADE;
CREATE INDEX payment_email_source_customer ON payment_email_outbox(source_customer_id) WHERE source_customer_id IS NOT NULL;

ALTER TABLE reminder_email_outbox ADD COLUMN kind text NOT NULL DEFAULT 'payment_due'
  CHECK(kind IN ('payment_due','departure_3_days','departure_6_hours'));
ALTER TABLE reminder_email_outbox ADD COLUMN departure_at timestamptz;
ALTER TABLE reminder_email_outbox ADD CONSTRAINT reminder_departure_scope
  CHECK((kind='payment_due' AND departure_at IS NULL) OR (kind<>'payment_due' AND departure_at IS NOT NULL AND instalment_id IS NULL));
CREATE UNIQUE INDEX reminder_departure_once ON reminder_email_outbox(booking_id,kind,departure_at) WHERE kind<>'payment_due';
CREATE INDEX bookings_upcoming_departure ON bookings(departure_at,id) WHERE deleted_at IS NULL;

-- Preserve the reviewed payment-history routine while restricting its reminder
-- invalidation to money reminders. Travel reminders survive payment edits.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('manage_booking_payment(uuid,uuid,uuid,uuid,uuid,integer,text,bigint,date,text,bigint,text)'::regprocedure) INTO definition;
  definition:=replace(definition,
    'WHERE booking_id=booking AND state IN (''pending'',''processing'')',
    'WHERE booking_id=booking AND kind=''payment_due'' AND state IN (''pending'',''processing'')');
  EXECUTE definition;
END;
$$;
