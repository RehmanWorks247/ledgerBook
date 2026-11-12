import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { AccessService, type Membership } from '../access/access.service';
import { DatabaseService } from '../database/database.service';
import { parseMoney, UUID_PATTERN, validDate } from '../ledger/money';
import { config } from '../config';
import { SERVICE_KEYS } from './bookings.service';
import { cancelUnsentPaymentReviewEmails, queueCustomerPaymentEmail } from '../payments/payment-emails';
import { ensureBookingInvoice, issueBookingInvoice } from '../invoices/invoices.service';
import { validateInstalmentTotal } from './instalment-total';
import { bookingPaymentTotals, instalmentInputSchema, normalizeInstalments, readBookingInstalments, remainingScheduleInput, saveBookingInstalments, saveRemainingBalanceInstalments } from './booking-instalment-payments';
import { readBookingReminders, saveBookingReminders, validateReminderInput } from './booking-reminders';

const date = z.string().refine(validDate, 'Use a valid date in YYYY-MM-DD format.');
const operation = {expected_version:z.number().int().min(1),reason:z.string().trim().min(1).max(1000),effective_date:date,idempotency_key:z.uuid()};
const editSchema = z.object({...operation,...remainingScheduleInput,reference:z.string().trim().min(1).max(160),departure_at:z.iso.datetime({offset:true}),
  required_services:z.array(z.enum(SERVICE_KEYS)).max(6),amount:z.string(),instalment_total:z.string().optional(),
  expected_paid_minor:z.string().regex(/^\d{1,20}$/).optional(),expected_payment_snapshot:z.string().regex(/^[0-9a-f]{64}$/).optional(),
  instalments:z.array(instalmentInputSchema.extend({id:z.uuid().optional()})).max(1000)}).strict().refine(data=>data.schedule_basis!==undefined||data.instalments.length>0,
  {message:'Add at least one installment.',path:['instalments']}).refine(data=>data.schedule_basis==='remaining_balance'?data.instalments.filter(row=>!row.paid).length<=100:data.instalments.length<=100,
  {message:'A plan supports at most 100 unpaid installments (100 total for legacy schedules).',path:['instalments']});
const deleteSchema = z.object({...operation,confirmation:z.string().min(1).max(160)}).strict();
function parse<T>(schema:z.ZodType<T>, raw:unknown):T {
  const parsed=schema.safeParse(raw);
  if(!parsed.success) throw new BadRequestException(parsed.error.issues.map(issue=>`${issue.path.join('.')}: ${issue.message}`));
  return parsed.data;
}
function digest(value:unknown) {return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
type BookingRow = {id:string;reference:string;departure_at:Date|string;required_services:string[];total_minor:string;
  charge_entry_id:string;version:number;deleted_at:Date|null;effective_date:string;[key:string]:unknown};

@Injectable()
export class BookingManagementService {
  constructor(@Inject(DatabaseService) private readonly db:DatabaseService,@Inject(AccessService) private readonly access:AccessService) {}

  private async context(client:PoolClient,member:Membership,customerId:string,bookingId:string) {
    if(!UUID_PATTERN.test(bookingId)) throw new BadRequestException('Select a valid booking.');
    const active=await this.access.membership(member.user_id,member.organization_id,true,client);
    const customer=await this.access.customer(active,customerId,client,true);
    const result=await client.query<BookingRow>(`SELECT b.*,b.total_minor::text AS total_minor,b.charge_entry_id::text AS charge_entry_id,e.effective_date::text AS effective_date
      FROM bookings b JOIN ledger_entries e ON e.id=b.charge_entry_id
      WHERE b.organization_id=$1 AND b.customer_id=$2 AND b.id=$3 FOR UPDATE OF b`,[active.organization_id,customerId,bookingId]);
    if(!result.rows[0]) throw new NotFoundException('Booking was not found for this customer.');
    if(customer.status!=='active') throw new ConflictException('Restore this customer before changing a booking.');
    return {active,customer,booking:result.rows[0]};
  }

  private async prior(client:PoolClient,orgId:string,key:string,fingerprint:string) {
    const prior=await client.query<{request_hash:string;result:Record<string,unknown>}>(
      'SELECT request_hash,result FROM booking_operations WHERE organization_id=$1 AND idempotency_key=$2',[orgId,key]);
    if(prior.rows[0] && prior.rows[0].request_hash!==fingerprint) throw new ConflictException('This submission key was used for a different booking change.');
    return prior.rows[0]?.result;
  }

  private checkVersion(booking:BookingRow,version:number) {
    if(booking.deleted_at) throw new ConflictException('This booking has been cancelled.');
    if(booking.version!==version) throw new ConflictException('This booking changed in another session. Refresh it before saving.');
  }

  private async audit(client:PoolClient,member:Membership,action:string,id:string,metadata:unknown) {
    await client.query('INSERT INTO audit_events(organization_id,actor_id,action,object_id,metadata) VALUES($1,$2,$3,$4,$5::jsonb)',
      [member.organization_id,member.user_id,action,id,JSON.stringify(metadata)]);
  }

  private async snapshot(client:PoolClient,bookingId:string) {
    const result=await client.query(`SELECT b.*,b.total_minor::text AS total_minor,b.reminder_paid_baseline_minor::text AS reminder_paid_baseline_minor,COALESCE(b.instalment_total_minor,b.total_minor)::text AS instalment_total_minor,b.charge_entry_id::text AS charge_entry_id,
      e.effective_date::text AS effective_date,c.customer_code FROM bookings b
      JOIN customers c ON c.id=b.customer_id JOIN ledger_entries e ON e.id=b.charge_entry_id WHERE b.id=$1`,[bookingId]);
    const {request_hash:_hash,idempotency_key:_key,reminder_payment_baseline:_baseline,...booking}=result.rows[0];
    const instalments=booking.schedule_basis==='reminders'?await readBookingReminders(client,booking.organization_id,bookingId):await readBookingInstalments(client,bookingId);
    const payments=await bookingPaymentTotals(client,bookingId,booking.total_minor);
    // Normalize timestamps once, so retries return the exact committed response.
    return JSON.parse(JSON.stringify({...booking,...payments,currency_exponent:2,time_zone:config.businessTimeZone,instalments})) as Record<string,unknown>;
  }

  private async record(client:PoolClient,member:Membership,customerId:string,bookingId:string,key:string,fingerprint:string,action:string,result:Record<string,unknown>) {
    await client.query(`INSERT INTO booking_operations(organization_id,customer_id,booking_id,idempotency_key,request_hash,action,result)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,[member.organization_id,customerId,bookingId,key,fingerprint,action,JSON.stringify(result)]);
    return result;
  }

  private async reverseCharge(client:PoolClient,member:Membership,customerId:string,booking:BookingRow,effectiveDate:string,reason:string,fingerprint:string,allowReversed=false) {
    const reversed=await client.query<{id:string}>('SELECT id::text AS id FROM ledger_entries WHERE reversal_of=$1',[booking.charge_entry_id]);
    if(reversed.rows[0]) {
      if(allowReversed) return reversed.rows[0].id;
      throw new ConflictException('This booking charge was already reversed. Resolve its ledger correction before changing the booking amount.');
    }
    if(effectiveDate<booking.effective_date) throw new BadRequestException('A correction cannot be dated before the current booking charge.');
    const reversal=await client.query<{id:string}>(`INSERT INTO ledger_entries(organization_id,customer_id,kind,amount_minor,currency,effective_date,description,reference,created_by,reversal_of,idempotency_key,request_hash)
      VALUES($1,$2,'reversal',$3,'GBP',$4,$5,$6,$7,$8,$9,$10) RETURNING id::text AS id`,
      [member.organization_id,customerId,(-BigInt(booking.total_minor)).toString(),effectiveDate,`Booking correction: ${reason}`.slice(0,1000),booking.reference,member.user_id,booking.charge_entry_id,randomUUID(),fingerprint]);
    await this.audit(client,member,'ledger.posted',reversal.rows[0].id,{customer_id:customerId,booking_id:booking.id,kind:'reversal',reversal_of:booking.charge_entry_id,reason});
    return reversal.rows[0].id;
  }

  async update(member:Membership,customerId:string,bookingId:string,raw:unknown) {
    const data=parse(editSchema,raw),amount=parseMoney(data.amount,2);
    const remainingBasis=data.schedule_basis==='remaining_balance',reminderBasis=data.schedule_basis==='reminders';
    if(reminderBasis) {
      validateReminderInput(data);
      if(data.expected_paid_minor===undefined||data.expected_payment_snapshot===undefined) throw new BadRequestException('Refresh the booking payment summary before editing reminders.');
    }
    const calculationTotal=parseMoney(data.instalment_total ?? data.amount,2);
    if(remainingBasis && calculationTotal!==amount) throw new BadRequestException('Remaining-balance schedules use the booking total.');
    if(!remainingBasis && data.existing_payment_entry_ids?.length) throw new BadRequestException('Select remaining_balance to allocate existing payments to a new plan.');
    const instalments=normalizeInstalments(data.instalments);
    if(!remainingBasis&&!reminderBasis) validateInstalmentTotal(calculationTotal,instalments);
    const required=[...new Set(data.required_services)].sort();
    const fingerprint=digest({...data,...(data.instalment_total === undefined ? {} : {instalment_total:calculationTotal.toString()}),amount:amount.toString(),instalments,required_services:required,customerId,bookingId,userId:member.user_id,action:'updated'});
    return this.db.transaction(async client=>{
      const {active,booking}=await this.context(client,member,customerId,bookingId);
      const prior=await this.prior(client,active.organization_id,data.idempotency_key,fingerprint);
      if(prior) return prior;
      this.checkVersion(booking,data.expected_version);
      if(booking.schedule_basis==='reminders'&&!reminderBasis) throw new BadRequestException('Use reminder mode to edit this booking. Record payments in payment history.');
      const before=await this.snapshot(client,bookingId);
      await ensureBookingInvoice(client,{organizationId:active.organization_id,customerId,bookingId,actorId:active.user_id});
      let chargeId=booking.charge_entry_id;
      if(amount!==BigInt(booking.total_minor)) {
        await this.reverseCharge(client,active,customerId,booking,data.effective_date,data.reason,fingerprint);
        const charge=await client.query<{id:string}>(`INSERT INTO ledger_entries(organization_id,customer_id,kind,amount_minor,currency,effective_date,description,reference,created_by,idempotency_key,request_hash)
          VALUES($1,$2,'charge',$3,'GBP',$4,$5,$6,$7,$8,$9) RETURNING id::text AS id`,
          [active.organization_id,customerId,amount.toString(),data.effective_date,`Booking ${data.reference}`,data.reference,active.user_id,randomUUID(),fingerprint]);
        chargeId=charge.rows[0].id;
        await this.audit(client,active,'ledger.posted',chargeId,{customer_id:customerId,booking_id:bookingId,kind:'charge',reason:data.reason});
      }
      await client.query(`UPDATE bookings SET reference=$1,departure_at=$2,required_services=$3,total_minor=$4,charge_entry_id=$5,instalment_total_minor=$7,version=version+1,updated_at=now() WHERE id=$6`,
        [data.reference,data.departure_at,required,amount.toString(),chargeId,bookingId,calculationTotal.toString()]);
      const scheduleContext={member:active,customerId,bookingId,reference:data.reference,reason:data.reason,fingerprint};
      if(reminderBasis) await saveBookingReminders(client,{organizationId:active.organization_id,customerId,bookingId},instalments,amount.toString(),
        {paidMinor:data.expected_paid_minor!,paymentSnapshot:data.expected_payment_snapshot!});
      else if(remainingBasis) {await saveRemainingBalanceInstalments(client,scheduleContext,instalments,data.existing_payment_entry_ids??[],amount,data.effective_date);
        await client.query("UPDATE bookings SET schedule_basis='remaining_balance' WHERE id=$1",[bookingId]);}
      else await saveBookingInstalments(client,scheduleContext,instalments);
      const after=await this.snapshot(client,bookingId);
      await this.audit(client,active,'booking.updated',bookingId,{customer_id:customerId,booking_id:bookingId,reason:data.reason,effective_date:data.effective_date,before,after});
      await issueBookingInvoice(client,{organizationId:active.organization_id,customerId,bookingId,actorId:active.user_id,
        reason:'booking_updated',eventKey:`booking-updated:${data.idempotency_key}`});
      return this.record(client,active,customerId,bookingId,data.idempotency_key,fingerprint,'updated',after);
    });
  }

  async cancel(member:Membership,customerId:string,bookingId:string,raw:unknown) {
    const data=parse(deleteSchema,raw);
    const fingerprint=digest({...data,customerId,bookingId,userId:member.user_id,action:'cancelled'});
    return this.db.transaction(async client=>{
      const {active,customer,booking}=await this.context(client,member,customerId,bookingId);
      const prior=await this.prior(client,active.organization_id,data.idempotency_key,fingerprint);
      if(prior) return prior;
      this.checkVersion(booking,data.expected_version);
      if(data.confirmation!==booking.reference) throw new BadRequestException('Type the exact booking reference to confirm cancellation.');
      await ensureBookingInvoice(client,{organizationId:active.organization_id,customerId,bookingId,actorId:active.user_id});
      const reversalId=await this.reverseCharge(client,active,customerId,booking,data.effective_date,data.reason,fingerprint,true);
      const rejectionReason=`Booking cancelled: ${data.reason}`.slice(0,1000);
      const pending=await client.query<{id:string;submitted_by:string;amount_minor:string;currency:string;payment_date:string}>(`UPDATE booking_payments SET version=version+1,status='rejected',reviewed_by=$1,reviewed_at=now(),rejection_reason=$2
        WHERE booking_id=$3 AND status='pending' AND deleted_at IS NULL RETURNING id,submitted_by,amount_minor::text,currency,payment_date::text`,[active.user_id,rejectionReason,bookingId]);
      for(const payment of pending.rows) await this.audit(client,active,'payment.rejected',payment.id,{customer_id:customerId,booking_id:bookingId,reason:data.reason,booking_cancelled:true});
      await cancelUnsentPaymentReviewEmails(client,active.organization_id,pending.rows.map(payment=>payment.id));
      for(const payment of pending.rows) await queueCustomerPaymentEmail(client,{kind:'rejected',organizationId:active.organization_id,organizationName:active.organization_name!,
        customerId,customerName:customer.name,recipient:customer.email,bookingId,bookingReference:booking.reference,
        paymentId:payment.id,submittedBy:payment.submitted_by,amountMinor:payment.amount_minor,currency:payment.currency,paymentDate:payment.payment_date,
        reason:rejectionReason,bookingCancelled:true});
      await client.query(`UPDATE reminder_email_outbox SET state='cancelled',delivery_status='cancelled',lease_token=NULL,lease_until=NULL,last_error='Booking was cancelled before notification delivery.'
        WHERE booking_id=$1 AND state IN ('pending','processing')`,[bookingId]);
      await client.query(`UPDATE bookings SET deleted_at=now(),deleted_by=$1,deletion_reason=$2,version=version+1,updated_at=now() WHERE id=$3`,[active.user_id,data.reason,bookingId]);
      await client.query('UPDATE booking_nodes SET issued_at=NULL WHERE booking_id=$1 AND issued_at IS NOT NULL',[bookingId]);
      await client.query('DELETE FROM document_uploads WHERE booking_id=$1',[bookingId]);
      await client.query(`DELETE FROM document_version_uploads u USING booking_nodes n
        WHERE n.id=u.document_id AND n.booking_id=$1 AND u.completed_version IS NULL`,[bookingId]);
      const credit=await client.query<{amount:string}>(`SELECT coalesce(sum(p.amount_minor),0)::text AS amount FROM booking_payments p
        WHERE p.booking_id=$1 AND p.status='approved' AND NOT EXISTS(SELECT 1 FROM ledger_entries e WHERE e.reversal_of=p.ledger_entry_id)`,[bookingId]);
      const result={id:bookingId,cancelled:true,version:booking.version+1,reversal_entry_id:reversalId,
        retained_payments_minor:'0',excluded_payments_minor:credit.rows[0].amount};
      await this.audit(client,active,'booking.cancelled',bookingId,{customer_id:customerId,booking_id:bookingId,reason:data.reason,effective_date:data.effective_date,reference:booking.reference,...result});
      await issueBookingInvoice(client,{organizationId:active.organization_id,customerId,bookingId,actorId:active.user_id,
        reason:'booking_cancelled',eventKey:`booking-cancelled:${data.idempotency_key}`});
      return this.record(client,active,customerId,bookingId,data.idempotency_key,fingerprint,'cancelled',result);
    });
  }
}
