import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { businessDate } from '../dashboard/time';
import { bookingPaymentTotals, type InstalmentInput, type NormalizedInstalment } from './booking-instalment-payments';

/** Shared by booking detail, dashboard and the send-time reminder check. */
export const reminderPositionCtes = `reminder_payment_totals AS (
  SELECT b.id AS booking_id,b.customer_id,b.total_minor,b.reminder_payment_baseline,
    COALESCE(SUM(p.amount_minor),0) AS received,
    COALESCE(SUM(GREATEST(0,p.amount_minor-COALESCE((b.reminder_payment_baseline->>p.id::text)::bigint,0))),0) AS new_received
  FROM bookings b LEFT JOIN booking_payments p ON p.booking_id=b.id AND p.status='approved' AND p.deleted_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reversal_of=p.ledger_entry_id)
  WHERE b.organization_id=$1 AND b.schedule_basis='reminders' AND b.deleted_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reversal_of=b.charge_entry_id)
  GROUP BY b.id
), reminder_allocated AS (
  SELECT i.id::text,i.customer_id,i.booking_id,i.due_date,i.amount_minor,i.created_at,1 AS priority,
    b.reference AS booking_reference,c.name AS customer_name,c.customer_code,
    GREATEST(0,t.total_minor-t.received) AS balance,
    GREATEST(0,i.amount_minor-GREATEST(0,t.new_received-COALESCE(SUM(i.amount_minor) OVER
      (PARTITION BY i.booking_id ORDER BY i.due_date,i.created_at,i.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0))) AS raw_unpaid
  FROM booking_instalments i JOIN reminder_payment_totals t ON t.booking_id=i.booking_id
  JOIN bookings b ON b.id=i.booking_id JOIN customers c ON c.id=i.customer_id
  WHERE i.is_reminder
), reminder_positions AS (
  SELECT *,LEAST(raw_unpaid,GREATEST(0,balance-COALESCE(SUM(raw_unpaid) OVER
    (PARTITION BY booking_id ORDER BY due_date,created_at,id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0))) AS unpaid
  FROM reminder_allocated
)`;

export function validateReminderInput(data:{instalments:readonly InstalmentInput[];instalment_total?:string;existing_payment_entry_ids?:readonly string[]}) {
  if(data.instalment_total!==undefined || data.existing_payment_entry_ids!==undefined
    ||data.instalments.some(row=>row.paid!==undefined||row.paid_date!==undefined||row.payment_entry_id!==undefined)) {
    throw new BadRequestException('Reminders accept only a date and amount. Record or correct payments in payment history.');
  }
}

export async function readBookingReminders(client:PoolClient,organizationId:string,bookingId:string) {
  const rows=await client.query<{id:string;due_date:string;amount_minor:string;remaining_minor:string}>(`WITH ${reminderPositionCtes}
    SELECT id,due_date::text,amount_minor::text,unpaid::text AS remaining_minor FROM reminder_positions
    WHERE booking_id=$2 ORDER BY due_date,created_at,id`,[organizationId,bookingId]);
  const today=businessDate();
  return rows.rows.map(row=>({...row,paid:false,paid_date:null,payment_entry_id:null,payment_source:null,
    payment_status:row.remaining_minor==='0'?'Completed':row.due_date<today?'Overdue':'Due'}));
}

/** Caller holds customer and booking locks. Saving reminders never writes money. */
export async function saveBookingReminders(client:PoolClient,context:{organizationId:string;bookingId:string;customerId:string},
  items:readonly NormalizedInstalment[],totalMinor:string,expected?:{paidMinor:string;paymentSnapshot:string}) {
  const totals=await bookingPaymentTotals(client,context.bookingId,totalMinor);
  if(expected&&(expected.paidMinor!==totals.paid_minor||expected.paymentSnapshot!==totals.payment_snapshot)) {
    throw new ConflictException('Payments changed while this reminder plan was open. Refresh the booking before saving.');
  }
  const scheduled=items.reduce((sum,row)=>sum+BigInt(row.amount_minor),0n);
  if(scheduled>BigInt(totals.remaining_minor)) throw new BadRequestException({code:'REMINDERS_EXCEED_BALANCE',
    message:'Reminder amounts cannot exceed the remaining booking balance.',remaining_minor:totals.remaining_minor,scheduled_minor:scheduled.toString()});
  const existing=(await client.query<{id:string;payment_id:string|null;active_payment:boolean}>(`SELECT i.id,i.payment_id,
    (p.id IS NOT NULL AND p.status='approved' AND p.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reversal_of=p.ledger_entry_id)) AS active_payment
    FROM booking_instalments i LEFT JOIN booking_payments p ON p.id=i.payment_id WHERE i.booking_id=$1`,[context.bookingId])).rows;
  const used=new Set<string>(),historicalRows=new Set<string>();
  for(const item of items) if(item.id) {
    const saved=existing.find(row=>row.id===item.id);
    if(!saved) throw new NotFoundException('A reminder was not found in this booking. Refresh before saving.');
    if(saved.active_payment) throw new BadRequestException('Payment history cannot be edited as a reminder.');
    if(used.has(item.id)) throw new BadRequestException('Each reminder can appear only once.');
    used.add(item.id);
    if(saved.payment_id) historicalRows.add(item.id);
  }
  await client.query(`UPDATE reminder_email_outbox SET state='cancelled',delivery_status='cancelled',lease_token=NULL,lease_until=NULL,
    last_error='Booking reminders changed before notification delivery.' WHERE booking_id=$1 AND state IN ('pending','processing')`,[context.bookingId]);
  // Keep legacy completed rows as history. In particular, never reverse their payments.
  await client.query('DELETE FROM booking_instalments WHERE booking_id=$1 AND payment_id IS NULL AND NOT(id=ANY($2::uuid[]))',[context.bookingId,[...used]]);
  for(const item of items) {
    // A reversed/trashed legacy payment leaves an outstanding row. Keep its
    // history link intact and create a fresh reminder for that outstanding amount.
    if(item.id&&!historicalRows.has(item.id)) await client.query('UPDATE booking_instalments SET due_date=$1,amount_minor=$2,is_reminder=true WHERE id=$3 AND booking_id=$4',
      [item.due_date,item.amount_minor,item.id,context.bookingId]);
    else await client.query(`INSERT INTO booking_instalments(id,organization_id,customer_id,booking_id,due_date,amount_minor,is_reminder)
      VALUES($1,$2,$3,$4,$5,$6,true)`,[randomUUID(),context.organizationId,context.customerId,context.bookingId,item.due_date,item.amount_minor]);
  }
  await client.query(`UPDATE bookings SET schedule_basis='reminders',reminder_paid_baseline_minor=$2,
    reminder_payment_baseline=(SELECT COALESCE(jsonb_object_agg(p.id::text,p.amount_minor::text),'{}'::jsonb)
      FROM booking_payments p WHERE p.booking_id=$1 AND p.status='approved' AND p.deleted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reversal_of=p.ledger_entry_id)) WHERE id=$1`,[context.bookingId,totals.paid_minor]);
}
