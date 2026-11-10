// Customer payments settle receivables in due-date order. Legacy charges use
// their effective date, so a settled old debt cannot pay a new booking twice.
// Reversed payments restore the schedule; reversed charges remove their debt.
// The final cap prevents scheduled arrears exceeding the actual account debt.
export const positionCtes = `balances AS (
  SELECT c.id, COALESCE(SUM(e.amount_minor),0) AS balance,
    COALESCE(-SUM(e.amount_minor) FILTER (WHERE (e.kind='payment' OR (e.kind='opening' AND e.amount_minor<0))
      AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reversal_of=e.id)),0) AS paid
  FROM customers c LEFT JOIN ledger_entries e ON e.organization_id=c.organization_id AND e.customer_id=c.id
  WHERE c.organization_id=$1 GROUP BY c.id
), receivables AS (
  SELECT i.id::text,i.customer_id,i.booking_id,i.due_date,i.amount_minor,i.created_at,1 AS priority,
    b.reference AS booking_reference,c.name AS customer_name,c.customer_code
  FROM booking_instalments i JOIN bookings b ON b.organization_id=i.organization_id AND b.customer_id=i.customer_id AND b.id=i.booking_id
  JOIN customers c ON c.organization_id=i.organization_id AND c.id=i.customer_id
  WHERE i.organization_id=$1 AND b.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reversal_of=b.charge_entry_id)
  UNION ALL
  SELECT e.id::text,e.customer_id,NULL::uuid,e.effective_date,e.amount_minor,e.created_at,0,NULL::text,c.name,c.customer_code
  FROM ledger_entries e JOIN customers c ON c.organization_id=e.organization_id AND c.id=e.customer_id
  WHERE e.organization_id=$1 AND e.kind IN ('charge','opening') AND e.amount_minor>0
    AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reversal_of=e.id)
    AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.charge_entry_id=e.id)
), allocated AS (
  SELECT i.*,balance,GREATEST(0,i.amount_minor-GREATEST(0,paid-COALESCE(SUM(i.amount_minor) OVER
    (PARTITION BY i.customer_id ORDER BY i.due_date,i.priority,i.created_at,i.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0))) AS raw_unpaid
  FROM receivables i JOIN balances p ON p.id=i.customer_id
), capped AS (
  SELECT *, LEAST(raw_unpaid,GREATEST(0,balance-COALESCE(SUM(raw_unpaid) OVER
    (PARTITION BY customer_id ORDER BY due_date,priority,created_at,id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0))) AS unpaid
  FROM allocated
), positioned AS (
  SELECT * FROM capped WHERE booking_id IS NOT NULL
)`;
