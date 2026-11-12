import { reminderPositionCtes } from '../bookings/booking-reminders';

// Explicitly linked payments settle their own instalment, even when older debt
// exists. Only unreserved payments settle the remaining debt in due-date order.
// Cancelled bookings and their payments are excluded. A manual charge reversal
// releases reserved payments; reversed payments restore the instalment. Legacy charges keep their effective
// date, and the final cap prevents scheduled arrears exceeding account debt.
export const positionCtes = `${reminderPositionCtes}, reserved_payments AS (
  SELECT i.id AS instalment_id,p.ledger_entry_id
  FROM booking_instalments i
  JOIN bookings b ON b.organization_id=i.organization_id AND b.customer_id=i.customer_id AND b.id=i.booking_id
  JOIN booking_payments p ON p.organization_id=i.organization_id AND p.customer_id=i.customer_id AND p.booking_id=i.booking_id AND p.id=i.payment_id
  JOIN ledger_entries e ON e.organization_id=p.organization_id AND e.customer_id=p.customer_id AND e.id=p.ledger_entry_id
  WHERE i.organization_id=$1 AND b.deleted_at IS NULL AND b.schedule_basis<>'reminders' AND p.status='approved'
    AND p.amount_minor=i.amount_minor AND e.kind='payment' AND e.amount_minor=-p.amount_minor
    AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reversal_of=b.charge_entry_id)
    AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reversal_of=e.id)
), balances AS (
  SELECT c.id, COALESCE(SUM(e.amount_minor),0) AS balance,
    COALESCE(SUM(e.amount_minor),0)-COALESCE((SELECT SUM(t.total_minor-t.received) FROM reminder_payment_totals t WHERE t.customer_id=c.id),0) AS legacy_balance,
    COALESCE(-SUM(e.amount_minor) FILTER (WHERE (e.kind='payment' OR (e.kind='opening' AND e.amount_minor<0))
      AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reversal_of=e.id)
      AND NOT EXISTS (SELECT 1 FROM reserved_payments p WHERE p.ledger_entry_id=e.id)
      AND NOT EXISTS (SELECT 1 FROM booking_payments p JOIN reminder_payment_totals t ON t.booking_id=p.booking_id
        WHERE p.ledger_entry_id=e.id AND p.status='approved' AND p.deleted_at IS NULL)),0) AS paid
  FROM customers c LEFT JOIN account_ledger_entries e ON e.organization_id=c.organization_id AND e.customer_id=c.id
  WHERE c.organization_id=$1 GROUP BY c.id
), receivables AS (
  SELECT i.id::text,i.customer_id,i.booking_id,i.due_date,i.amount_minor,i.created_at,1 AS priority,
    b.reference AS booking_reference,c.name AS customer_name,c.customer_code,
    CASE WHEN p.instalment_id IS NULL THEN i.amount_minor ELSE 0 END AS remaining_minor
  FROM booking_instalments i JOIN bookings b ON b.organization_id=i.organization_id AND b.customer_id=i.customer_id AND b.id=i.booking_id
  JOIN customers c ON c.organization_id=i.organization_id AND c.id=i.customer_id
  LEFT JOIN reserved_payments p ON p.instalment_id=i.id
  WHERE i.organization_id=$1 AND b.deleted_at IS NULL AND b.schedule_basis<>'reminders' AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reversal_of=b.charge_entry_id)
  UNION ALL
  SELECT e.id::text,e.customer_id,NULL::uuid,e.effective_date,e.amount_minor,e.created_at,0,NULL::text,c.name,c.customer_code,e.amount_minor
  FROM account_ledger_entries e JOIN customers c ON c.organization_id=e.organization_id AND c.id=e.customer_id
  WHERE e.organization_id=$1 AND e.kind IN ('charge','opening') AND e.amount_minor>0
    AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reversal_of=e.id)
    AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.charge_entry_id=e.id)
), allocated AS (
  SELECT i.*,legacy_balance AS balance,GREATEST(0,i.remaining_minor-GREATEST(0,paid-COALESCE(SUM(i.remaining_minor) OVER
    (PARTITION BY i.customer_id ORDER BY i.due_date,i.priority,i.created_at,i.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0))) AS raw_unpaid
  FROM receivables i JOIN balances p ON p.id=i.customer_id
), capped AS (
  SELECT *, LEAST(raw_unpaid,GREATEST(0,balance-COALESCE(SUM(raw_unpaid) OVER
    (PARTITION BY customer_id ORDER BY due_date,priority,created_at,id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0))) AS unpaid
  FROM allocated
), positioned AS (
  SELECT * FROM capped WHERE booking_id IS NOT NULL
  UNION ALL
  SELECT id,customer_id,booking_id,due_date,amount_minor,created_at,priority,booking_reference,customer_name,customer_code,
    amount_minor AS remaining_minor,balance,raw_unpaid,unpaid FROM reminder_positions
)`;
