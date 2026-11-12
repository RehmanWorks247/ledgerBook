-- Reporting excludes all money associated with cancelled bookings, while the
-- append-only ledger and invoices continue to preserve the original history.
-- Audit attribution covers replaced charges/payments and permanently removed
-- payment records; current foreign keys also cover imported/legacy records.
CREATE INDEX audit_booking_ledger_entry ON audit_events
  (organization_id, (CASE WHEN action='ledger.posted' THEN object_id ELSE metadata->>'entry_id' END))
  WHERE metadata->>'booking_id' IS NOT NULL
    AND action IN ('ledger.posted','payment.linked','payment.recorded');

CREATE VIEW account_ledger_entries WITH (security_invoker=true) AS
SELECT e.* FROM ledger_entries e
WHERE NOT EXISTS (
  SELECT 1 FROM bookings b
  WHERE b.organization_id=e.organization_id AND b.customer_id=e.customer_id
    AND b.deleted_at IS NOT NULL AND b.charge_entry_id=COALESCE(e.reversal_of,e.id)
)
AND NOT EXISTS (
  SELECT 1 FROM booking_payments p JOIN bookings b
    ON b.organization_id=p.organization_id AND b.customer_id=p.customer_id AND b.id=p.booking_id
  WHERE p.organization_id=e.organization_id AND p.customer_id=e.customer_id
    AND b.deleted_at IS NOT NULL AND p.ledger_entry_id=COALESCE(e.reversal_of,e.id)
)
AND NOT EXISTS (
  SELECT 1 FROM audit_events a JOIN bookings b
    ON b.organization_id=a.organization_id AND b.id::text=a.metadata->>'booking_id'
  WHERE a.organization_id=e.organization_id AND b.customer_id=e.customer_id AND b.deleted_at IS NOT NULL
    AND a.metadata->>'booking_id' IS NOT NULL
    AND a.action IN ('ledger.posted','payment.linked','payment.recorded')
    AND (CASE WHEN a.action='ledger.posted' THEN a.object_id ELSE a.metadata->>'entry_id' END)=COALESCE(e.reversal_of,e.id)::text
);
