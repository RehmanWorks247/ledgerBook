import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Membership } from '../access/access.service';
import { businessDate } from '../dashboard/time';
import { parseMoney, validDate } from '../ledger/money';
import { validateInstalmentTotal } from './instalment-total';

export const paymentEntryIdSchema=z.string().regex(/^[1-9]\d{0,18}$/).refine(value=>/^[1-9]\d{0,18}$/.test(value)&&BigInt(value)<=9_223_372_036_854_775_807n,
  'Select a valid payment entry.');
export const remainingScheduleInput={schedule_basis:z.enum(['remaining_balance','reminders']).optional(),
  existing_payment_entry_ids:z.array(paymentEntryIdSchema).max(100).refine(ids=>new Set(ids).size===ids.length,'Select each existing payment only once.').optional()};

export const instalmentInputSchema=z.object({due_date:z.string().refine(validDate,'Use a valid date in YYYY-MM-DD format.'),amount:z.string(),
  paid:z.boolean().optional(),paid_date:z.string().refine(validDate,'Use a valid date received in YYYY-MM-DD format.').optional(),
  payment_entry_id:paymentEntryIdSchema.optional()}).strict();

export type InstalmentInput = { id?:string; due_date:string; amount:string; paid?:boolean; paid_date?:string;payment_entry_id?:string };
export type NormalizedInstalment = Omit<InstalmentInput,'amount'> & { amount_minor:string };
type SavedInstalment = { id:string;due_date:string;amount_minor:string;payment_id:string|null;
  paid:boolean;paid_date:string|null;payment_entry_id:string|null;payment_source:'booking_instalment'|'customer_receipt'|null };
type Context = { member:Membership;customerId:string;bookingId:string;reference:string;reason:string;fingerprint:string };

export function normalizeInstalments(items:readonly InstalmentInput[]):NormalizedInstalment[] {
  const today=businessDate();
  return items.map(item=>{
    if(item.paid && !item.paid_date && !item.payment_entry_id) throw new BadRequestException('Enter the date received for every paid instalment.');
    if(item.paid_date && !item.paid) throw new BadRequestException('Only paid instalments can have a date received.');
    if(item.payment_entry_id && !item.paid) throw new BadRequestException('Only paid instalments can link to an existing payment.');
    if(item.paid_date && item.paid_date>today) throw new BadRequestException('A paid instalment cannot have a future date received.');
    return {due_date:item.due_date,amount_minor:parseMoney(item.amount,2).toString(),
      ...(item.id===undefined?{}:{id:item.id}),...(item.paid===undefined?{}:{paid:item.paid}),
      ...(item.paid_date===undefined?{}:{paid_date:item.paid_date}),
      ...(item.payment_entry_id===undefined?{}:{payment_entry_id:item.payment_entry_id})};
  });
}

async function savedInstalments(client:PoolClient,bookingId:string):Promise<SavedInstalment[]> {
  const result=await client.query<SavedInstalment>(`SELECT i.id,i.due_date::text AS due_date,i.amount_minor::text AS amount_minor,i.payment_id,
    (p.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reversal_of=p.ledger_entry_id)) AS paid,
    CASE WHEN NOT EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reversal_of=p.ledger_entry_id) THEN p.payment_date::text END AS paid_date,
    p.ledger_entry_id::text AS payment_entry_id,p.source AS payment_source
    FROM booking_instalments i LEFT JOIN booking_payments p ON p.id=i.payment_id
    WHERE i.booking_id=$1 ORDER BY i.due_date,i.created_at,i.id`,[bookingId]);
  return result.rows;
}

export async function readBookingInstalments(client:PoolClient,bookingId:string) {
  return (await savedInstalments(client,bookingId)).map(({payment_id:_payment,...row})=>({...row,
    payment_entry_id:row.paid?row.payment_entry_id:null,paid_date:row.paid?row.paid_date:null,
    payment_source:row.paid?row.payment_source:null}));
}

export async function availableBookingPayments(client:PoolClient,organizationId:string,customerId:string,bookingId?:string) {
  return (await client.query<{id:string;amount_minor:string;payment_date:string;description:string;reference:string;already_recorded_for_booking:boolean}>(
    `SELECT e.id::text,(-e.amount_minor)::text AS amount_minor,e.effective_date::text AS payment_date,e.description,e.reference,
      (p.id IS NOT NULL AND p.booking_id=$3::uuid AND p.status='approved') AS already_recorded_for_booking
    FROM ledger_entries e LEFT JOIN booking_payments p ON p.ledger_entry_id=e.id
    WHERE e.organization_id=$1 AND e.customer_id=$2 AND e.kind='payment' AND e.effective_date<=$4::date
      AND NOT EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reversal_of=e.id)
      AND (p.id IS NULL OR (p.booking_id=$3::uuid AND p.status='approved'))
      AND NOT EXISTS(SELECT 1 FROM booking_instalments i WHERE i.payment_id=p.id)
    ORDER BY e.effective_date DESC,e.id DESC`,[organizationId,customerId,bookingId??null,businessDate()])).rows;
}

export async function bookingPaymentTotals(client:PoolClient,bookingId:string,totalMinor:string) {
  const result=await client.query<{id:string;amount_minor:string;ledger_entry_id:string}>(`SELECT p.id,p.amount_minor::text,p.ledger_entry_id::text
    FROM booking_payments p WHERE p.booking_id=$1 AND p.status='approved' AND p.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reversal_of=p.ledger_entry_id) ORDER BY p.id`,[bookingId]);
  const paid=result.rows.reduce((sum,row)=>sum+BigInt(row.amount_minor),0n),remaining=BigInt(totalMinor)-paid;
  return {paid_minor:paid.toString(),remaining_minor:(remaining>0n?remaining:0n).toString(),
    overpaid_minor:(remaining<0n?-remaining:0n).toString(),payment_snapshot:createHash('sha256').update(JSON.stringify(result.rows)).digest('hex')};
}

async function audit(client:PoolClient,context:Context,action:string,id:string,metadata:Record<string,unknown>) {
  await client.query(`INSERT INTO audit_events(organization_id,actor_id,action,object_id,metadata) VALUES($1,$2,$3,$4,$5::jsonb)`,
    [context.member.organization_id,context.member.user_id,action,id,
      JSON.stringify({customer_id:context.customerId,booking_id:context.bookingId,reason:context.reason,...metadata})]);
}

async function recordPayment(client:PoolClient,context:Context,item:NormalizedInstalment,existingEntryId?:string) {
  const {member,customerId,bookingId,reference}=context,id=randomUUID();
  const fingerprint=createHash('sha256').update(`${context.fingerprint}:instalment-payment:${id}`).digest('hex');
  const entry=existingEntryId?{rows:[{id:existingEntryId}]}:await client.query<{id:string}>(`INSERT INTO ledger_entries(organization_id,customer_id,kind,amount_minor,currency,effective_date,
    description,reference,created_by,idempotency_key,request_hash)
    VALUES($1,$2,'payment',$3,'GBP',$4,$5,$6,$7,$8,$9) RETURNING id::text AS id`,
    [member.organization_id,customerId,(-BigInt(item.amount_minor)).toString(),item.paid_date,
      `Advance instalment payment for booking ${reference}`,reference,member.user_id,randomUUID(),fingerprint]);
  await client.query(`INSERT INTO booking_payments(id,organization_id,customer_id,booking_id,amount_minor,payment_date,note,status,
    submitted_by,idempotency_key,request_hash,reviewed_by,reviewed_at,ledger_entry_id,source)
    VALUES($1,$2,$3,$4,$5,$6,$7,'approved',NULL,$8,$9,$10,now(),$11,'booking_instalment')`,
    [id,member.organization_id,customerId,bookingId,item.amount_minor,item.paid_date,
      existingEntryId?'Existing ledger payment allocated to this booking.':'Advance payment recorded with the booking instalment schedule.',randomUUID(),fingerprint,member.user_id,entry.rows[0].id]);
  await audit(client,context,existingEntryId?'payment.linked':'payment.recorded',id,{entry_id:entry.rows[0].id,amount_minor:item.amount_minor,payment_date:item.paid_date,source:'booking_instalment'});
  if(!existingEntryId) await audit(client,context,'ledger.posted',entry.rows[0].id,{kind:'payment',payment_id:id,source:'booking_instalment'});
  return id;
}

async function resolveExistingPayment(client:PoolClient,context:Context,item:NormalizedInstalment,instalmentId?:string) {
  const result=await client.query<{id:string;amount_minor:string;payment_date:string;payment_id:string|null;booking_id:string|null;status:string|null;instalment_id:string|null}>(
    `SELECT e.id::text,(-e.amount_minor)::text AS amount_minor,e.effective_date::text AS payment_date,p.id AS payment_id,p.booking_id,p.status,i.id AS instalment_id
    FROM ledger_entries e LEFT JOIN booking_payments p ON p.ledger_entry_id=e.id
    LEFT JOIN booking_instalments i ON i.payment_id=p.id
    WHERE e.id=$1 AND e.organization_id=$2 AND e.customer_id=$3 AND e.kind='payment'
      AND NOT EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reversal_of=e.id)`,
    [item.payment_entry_id,context.member.organization_id,context.customerId]);
  const payment=result.rows[0];
  if(!payment) throw new BadRequestException('Choose an unreversed payment from this customer account.');
  if(payment.booking_id && (payment.booking_id!==context.bookingId || payment.status!=='approved'))
    throw new ConflictException('That payment is already assigned to another booking.');
  if(payment.instalment_id && payment.instalment_id!==instalmentId)
    throw new ConflictException('That payment is already assigned to an instalment.');
  if(payment.amount_minor!==item.amount_minor) throw new BadRequestException('The existing payment must match the whole instalment amount exactly.');
  if(payment.payment_date>businessDate()) throw new BadRequestException('A paid instalment cannot have a future date received.');
  if(item.paid_date && item.paid_date!==payment.payment_date) throw new BadRequestException('The date received must match the existing payment date.');
  return payment;
}

async function reversePayment(client:PoolClient,context:Context,item:SavedInstalment) {
  // Only the schedule's own staff-recorded payment is corrected here. Receipt
  // approvals are managed through the administrator payment history flow.
  const original=await client.query<{id:string;amount_minor:string;effective_date:string}>(`SELECT e.id::text,e.amount_minor::text,e.effective_date::text
    FROM booking_payments p JOIN ledger_entries e ON e.id=p.ledger_entry_id
    WHERE p.id=$1 AND p.organization_id=$2 AND p.customer_id=$3 AND p.booking_id=$4 AND p.source='booking_instalment'
      AND NOT EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reversal_of=e.id)`,
    [item.payment_id,context.member.organization_id,context.customerId,context.bookingId]);
  if(!original.rows[0]) throw new ConflictException('The recorded instalment payment changed. Refresh the booking before saving.');
  const payment=original.rows[0],today=businessDate();
  const effectiveDate=today>payment.effective_date?today:payment.effective_date;
  const reversal=await client.query<{id:string}>(`INSERT INTO ledger_entries(organization_id,customer_id,kind,amount_minor,currency,effective_date,
    description,reference,created_by,reversal_of,idempotency_key,request_hash)
    VALUES($1,$2,'reversal',$3,'GBP',$4,$5,$6,$7,$8,$9,$10) RETURNING id::text AS id`,
    [context.member.organization_id,context.customerId,(-BigInt(payment.amount_minor)).toString(),effectiveDate,
      `Instalment payment correction: ${context.reason}`.slice(0,1000),context.reference,context.member.user_id,payment.id,randomUUID(),context.fingerprint]);
  await audit(client,context,'ledger.reversed',reversal.rows[0].id,{kind:'reversal',reversal_of:payment.id,payment_id:item.payment_id,source:'booking_instalment'});
}

/** Call only after taking the customer and booking locks, inside their write transaction. */
export async function saveBookingInstalments(client:PoolClient,context:Context,items:readonly NormalizedInstalment[]) {
  const existing=await savedInstalments(client,context.bookingId),used=new Set<string>();
  const resolved=items.map(item=>{
    const previous=item.id?existing.find(row=>row.id===item.id):existing.find(row=>!used.has(row.id)&&row.due_date===item.due_date&&row.amount_minor===item.amount_minor);
    if(item.id && !previous) throw new NotFoundException('An instalment was not found in this booking. Refresh before saving.');
    if(previous && used.has(previous.id)) throw new BadRequestException('An instalment cannot appear more than once.');
    if(previous) used.add(previous.id);
    if(previous?.paid && !item.id && ((item.paid!==undefined && !item.paid) || (item.paid_date!==undefined && item.paid_date!==previous.paid_date)
      ||(item.payment_entry_id!==undefined&&item.payment_entry_id!==previous.payment_entry_id)))
      throw new ConflictException('Reload the booking to change its recorded paid instalment.');
    const paid=item.paid??previous?.paid??false;
    return {item:{...item,paid,...(paid?{paid_date:item.paid_date??previous?.paid_date??undefined}:{})},previous};
  });
  if(existing.some(row=>row.paid&&!used.has(row.id)))
    throw new ConflictException('Mark the paid instalment as due and save before removing it. Reload the booking to edit its recorded payment.');
  const selectedEntries=new Map<NormalizedInstalment,Awaited<ReturnType<typeof resolveExistingPayment>>>();
  const selectedIds=new Set<string>();
  for(const {item,previous} of resolved) {
    if(item.paid && item.payment_entry_id && (!previous?.paid || item.payment_entry_id!==previous.payment_entry_id)) {
      if(selectedIds.has(item.payment_entry_id)) throw new BadRequestException('An existing payment can only be assigned to one instalment.');
      selectedIds.add(item.payment_entry_id);
      const selected=await resolveExistingPayment(client,context,item,previous?.id);
      item.paid_date=selected.payment_date;
      selectedEntries.set(item,selected);
    }
    if(item.paid && !item.paid_date) throw new BadRequestException('Enter the date received for every paid instalment.');
    if(previous?.paid && !item.id && (item.amount_minor!==previous.amount_minor || item.paid_date!==previous.paid_date))
      throw new ConflictException('Reload the booking to change its recorded paid instalment.');
    if(previous?.paid && previous.payment_source==='customer_receipt' && (!item.paid||item.amount_minor!==previous.amount_minor
      ||item.paid_date!==previous.paid_date||(item.payment_entry_id!==undefined&&item.payment_entry_id!==previous.payment_entry_id)))
      throw new ConflictException('This instalment uses an approved customer receipt. Correct its payment in payment history before changing the paid amount or status.');
  }
  const changed=resolved.some(({item,previous})=>!previous||item.due_date!==previous.due_date||item.amount_minor!==previous.amount_minor
    ||item.paid!==previous.paid||(item.paid && (item.paid_date!==previous.paid_date||selectedEntries.has(item)))) || used.size!==existing.length;
  if(!changed) return;
  if(resolved.some(({item,previous})=>item.paid&&(!previous?.paid||item.amount_minor!==previous.amount_minor
    ||item.paid_date!==previous.paid_date||selectedEntries.has(item)))) {
    const activeCharge=await client.query(`SELECT 1 FROM bookings b WHERE b.id=$1 AND b.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reversal_of=b.charge_entry_id)`,[context.bookingId]);
    if(!activeCharge.rows.length) throw new ConflictException('This booking charge was reversed. Resolve its ledger correction before recording an instalment payment.');
  }
  await client.query(`UPDATE reminder_email_outbox SET state='cancelled',delivery_status='cancelled',lease_token=NULL,lease_until=NULL,
    last_error='Booking schedule changed before notification delivery.' WHERE booking_id=$1 AND state IN ('pending','processing')`,[context.bookingId]);
  // Unchanged legacy rows keep their identities; omitted paid rows were rejected
  // above, so deleting an unpaid row cannot accidentally discard received money.
  const removed=existing.filter(row=>!used.has(row.id)).map(row=>row.id);
  if(removed.length) await client.query('DELETE FROM booking_instalments WHERE booking_id=$1 AND id=ANY($2::uuid[])',[context.bookingId,removed]);
  for(const {item,previous} of resolved) {
    let paymentId=previous?.paid?previous.payment_id:null;
    const paymentChanged=previous?.paid && (!item.paid||item.amount_minor!==previous.amount_minor||item.paid_date!==previous.paid_date||selectedEntries.has(item));
    if(paymentChanged) {await reversePayment(client,context,previous);paymentId=null;}
    if(item.paid&&!paymentId) {
      const selected=selectedEntries.get(item);
      paymentId=selected?.payment_id??await recordPayment(client,context,item,selected?.id);
      if(selected?.payment_id) await audit(client,context,'payment.linked',selected.payment_id,{entry_id:selected.id,instalment_id:previous?.id??null});
    }
    if(previous) {
      await client.query('UPDATE booking_instalments SET due_date=$1,amount_minor=$2,payment_id=$3 WHERE id=$4 AND booking_id=$5',
        [item.due_date,item.amount_minor,paymentId,previous.id,context.bookingId]);
    } else {
      await client.query(`INSERT INTO booking_instalments(id,organization_id,customer_id,booking_id,due_date,amount_minor,payment_id)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[randomUUID(),context.member.organization_id,context.customerId,context.bookingId,item.due_date,item.amount_minor,paymentId]);
    }
  }
}

/**
 * Remaining-balance plans retain completed rows as allocation history, so the
 * same money cannot also flow through the account's unreserved FIFO pool.
 * Customer/booking locks and the surrounding transaction are required.
 */
export async function saveRemainingBalanceInstalments(client:PoolClient,context:Context,items:readonly NormalizedInstalment[],
  selectedEntryIds:readonly string[],bookingTotal:bigint,defaultDueDate:string) {
  const previous=await savedInstalments(client,context.bookingId),represented=new Set<string>();
  const planned=[...items];
  for(const item of planned) {
    const row=item.id?previous.find(saved=>saved.id===item.id):previous.find(saved=>!represented.has(saved.id)
      &&saved.due_date===item.due_date&&saved.amount_minor===item.amount_minor);
    if(row) represented.add(row.id);
  }
  // A future-payment-only client must not erase a completed installment merely
  // because it is displayed in payment history rather than in the plan editor.
  for(const row of previous) if(row.paid&&!represented.has(row.id)) planned.push({id:row.id,due_date:row.due_date,amount_minor:row.amount_minor,
    paid:true,paid_date:row.paid_date!,payment_entry_id:row.payment_entry_id!});
  await saveBookingInstalments(client,context,planned);
  let saved=await savedInstalments(client,context.bookingId);
  const representedEntries=new Set(saved.filter(row=>row.paid).map(row=>row.payment_entry_id));
  const anchors:NormalizedInstalment[]=[];
  const addAnchor=(entry:{id:string;amount_minor:string;payment_date:string})=>{
    if(representedEntries.has(entry.id)) return;
    representedEntries.add(entry.id);
    anchors.push({due_date:entry.payment_date,amount_minor:entry.amount_minor,paid:true,paid_date:entry.payment_date,payment_entry_id:entry.id});
  };
  // Selected existing payments are linked whole, scoped to this customer, and
  // never posted again. Taking the customer lock also serializes ledger writers.
  if(selectedEntryIds.length) {
    const selected=await client.query<{id:string;amount_minor:string;payment_date:string;booking_id:string|null;status:string|null;deleted_at:string|null}>(
      `SELECT e.id::text,(-e.amount_minor)::text AS amount_minor,e.effective_date::text AS payment_date,p.booking_id,p.status,p.deleted_at
      FROM ledger_entries e LEFT JOIN booking_payments p ON p.ledger_entry_id=e.id
      WHERE e.organization_id=$1 AND e.customer_id=$2 AND e.id=ANY($3::bigint[]) AND e.kind='payment'
        AND NOT EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reversal_of=e.id)`,
      [context.member.organization_id,context.customerId,selectedEntryIds]);
    for(const entryId of selectedEntryIds) {
      const entry=selected.rows.find(row=>row.id===entryId);
      if(!entry) throw new BadRequestException('Choose an unreversed existing payment from this customer account.');
      if(entry.booking_id && (entry.booking_id!==context.bookingId||entry.status!=='approved'||entry.deleted_at))
        throw new ConflictException('That existing payment is already assigned to another booking or is no longer active.');
      if(entry.payment_date>businessDate()) throw new BadRequestException('An existing payment cannot have a future date received.');
      addAnchor(entry);
    }
  }
  // Existing approved receipts may have settled older scheduled amounts without
  // an explicit paid row. Convert their allocation only when saving a new plan.
  const recorded=await client.query<{id:string;amount_minor:string;payment_date:string}>(`SELECT p.ledger_entry_id::text AS id,
    p.amount_minor::text AS amount_minor,p.payment_date::text AS payment_date FROM booking_payments p
    WHERE p.organization_id=$1 AND p.customer_id=$2 AND p.booking_id=$3 AND p.status='approved' AND p.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reversal_of=p.ledger_entry_id) ORDER BY p.payment_date,p.id`,
    [context.member.organization_id,context.customerId,context.bookingId]);
  for(const payment of recorded.rows) addAnchor(payment);
  const savedInput=()=>saved.map(row=>({id:row.id,due_date:row.due_date,amount_minor:row.amount_minor,paid:row.paid,
    ...(row.paid?{paid_date:row.paid_date!,payment_entry_id:row.payment_entry_id!}:{})}));
  if(anchors.length) {
    await saveBookingInstalments(client,context,[...savedInput(),...anchors]);
    saved=await savedInstalments(client,context.bookingId);
  }
  const totals=await bookingPaymentTotals(client,context.bookingId,bookingTotal.toString());
  const remaining=BigInt(totals.remaining_minor);
  if(items.length===0 && remaining>0n) {
    await saveBookingInstalments(client,context,[...savedInput(),{due_date:defaultDueDate,amount_minor:remaining.toString(),paid:false}]);
    saved=await savedInstalments(client,context.bookingId);
  }
  validateInstalmentTotal(remaining,saved.filter(row=>!row.paid),'remaining booking balance');
}
