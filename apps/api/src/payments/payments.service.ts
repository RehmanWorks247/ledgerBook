import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import sharp from 'sharp';
import { z } from 'zod';
import { AccessService, type Membership } from '../access/access.service';
import { config } from '../config';
import { DatabaseService } from '../database/database.service';
import { businessDate } from '../dashboard/time';
import { formatMoney, parseMoney, UUID_PATTERN, validDate } from '../ledger/money';
import { cancelUnsentPaymentReviewEmails, queueCustomerPaymentEmail } from './payment-emails';
import { ensureBookingInvoice, issueBookingInvoice } from '../invoices/invoices.service';

export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
export const MAX_RECEIPTS = 5;
export const MAX_RECEIPT_PIXELS = 20_000_000;
export const MAX_PENDING_PAYMENTS = 10;
export const MAX_BOOKING_PAYMENTS = 100;
export const MAX_BOOKING_RECEIPT_BYTES = 100 * 1024 * 1024;
export type PaymentUpload = { originalname:string; mimetype:string; buffer:Buffer; size:number };
type Receipt = {name:string;content:Buffer;originalSha256:string;originalName:string;originalMime:string};
type PaymentRow = QueryResultRow & {id:string;organization_id:string;customer_id:string;booking_id:string;
  amount_minor:string;currency:string;payment_date:string;note:string;status:'pending'|'approved'|'rejected';
  submitted_at:Date|string;reviewed_at:Date|string|null;reviewed_by:string|null;rejection_reason:string|null;
  ledger_entry_id:string|null;request_hash:string;booking_reference:string;customer_name:string;customer_code:string;submitted_by:string};
const paymentColumns = `p.id,p.organization_id,p.customer_id,p.booking_id,p.amount_minor::text AS amount_minor,p.currency,
  p.payment_date::text AS payment_date,p.note,p.status,p.submitted_at,p.reviewed_at,p.reviewed_by,p.rejection_reason,
  p.ledger_entry_id::text AS ledger_entry_id,p.request_hash,p.submitted_by,b.reference AS booking_reference,c.name AS customer_name,c.customer_code`;
const paymentJoins = `FROM booking_payments p JOIN bookings b ON b.id=p.booking_id AND b.organization_id=p.organization_id
  JOIN customers c ON c.id=p.customer_id AND c.organization_id=p.organization_id`;
const submitSchema = z.object({amount:z.string().max(24),payment_date:z.string().refine(validDate,'Enter a valid payment date.'),
  note:z.string().trim().max(1000).default(''),idempotency_key:z.uuid()}).strict();
const queryInteger = (maximum:number) => z.union([z.number(),z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().min(1).max(maximum));
const reviewQuerySchema = z.object({
  status:z.enum(['pending','approved','rejected','all']).default('pending'),
  q:z.string().trim().max(200).default(''),
  from:z.string().refine(validDate,'Enter a valid start date.').optional(),
  to:z.string().refine(validDate,'Enter a valid end date.').optional(),
  page:queryInteger(1_000_000).default(1),
  page_size:queryInteger(100).default(25),
  sort:z.enum(['oldest','newest','amount_desc','amount_asc']).default('oldest'),
}).strict().refine(value=>!value.from || !value.to || value.from<=value.to,
  {message:'The start date must be on or before the end date.',path:['from']});
const filenameSchema = z.string().trim().min(1).max(240).refine(value => value!=='.' && value!=='..' && !/[/\\]/.test(value)
  && !Array.from(value).some(char=>char.charCodeAt(0)<32 || char.charCodeAt(0)===127),'Use a filename without slashes or control characters.');
function parse<T>(schema:z.ZodType<T>,value:unknown):T {
  const result=schema.safeParse(value);
  if(!result.success) throw new BadRequestException(result.error.issues.map(issue=>`${issue.path.join('.')}: ${issue.message}`));
  return result.data;
}
function uuid(value:string,label:string) {
  if(!UUID_PATTERN.test(value??'')) throw new BadRequestException(`Choose a valid ${label}.`);
}
function digest(value:string|Buffer) {return createHash('sha256').update(value).digest('hex');}
function reviewSearchTerms(value:string) {
  const months=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  // Keep a displayed date as one search value; separate "02"/"2026" terms can match unrelated dates.
  return value.replace(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\s+(\d{4})\b/gi,
    (original,day:string,month:string,year:string)=>{
      const date=`${year}-${String(months.indexOf(month.slice(0,3).toLowerCase())+1).padStart(2,'0')}-${day.padStart(2,'0')}`;
      return validDate(date)?date:original;
    }).replace(/£/g,'GBP ').split(/\s+/).filter(Boolean);
}

@Injectable()
export class PaymentsService {
  constructor(@Inject(DatabaseService) private readonly db:DatabaseService,
    @Inject(AccessService) private readonly access:AccessService) {}

  private async context(client:PoolClient,member:Membership,customerId:string,bookingId:string,mode:'read'|'submit'|'review'='read') {
    uuid(bookingId,'booking');
    if(mode==='submit') {
      uuid(customerId,'customer');
      // Account disable/deletion locks organization -> customer -> membership.
      // Match that order before taking the customer's lock: membership() also
      // shares the organization row, which would otherwise invert the order.
      await client.query('SELECT id FROM organizations WHERE id=$1 FOR SHARE',[member.organization_id]);
      // Lock only an already-authorized account, then revalidate membership.
      // Taking the membership first would deadlock with access revocation.
      const locked=await client.query(`SELECT c.id FROM customers c JOIN memberships m
        ON m.organization_id=c.organization_id AND (m.customer_id=c.id OR m.role='admin')
        WHERE c.organization_id=$1 AND c.id=$2 AND m.user_id=$3 AND m.is_active FOR UPDATE OF c`,
        [member.organization_id,customerId,member.user_id]);
      if(!locked.rows.length) throw new NotFoundException('Customer account was not found.');
    }
    const active=await this.access.membership(member.user_id,member.organization_id,mode==='review',client);
    const customer=await this.access.customer(active,customerId,client,mode!=='read');
    if(mode==='submit' && active.role!=='customer') throw new ForbiddenException('Only the customer can submit payment evidence.');
    const result=await client.query(`SELECT b.*,b.total_minor::text AS total_minor FROM bookings b
      WHERE b.organization_id=$1 AND b.customer_id=$2 AND b.id=$3 ${mode!=='read'?'FOR UPDATE':''}`,[active.organization_id,customerId,bookingId]);
    const booking=result.rows[0];
    if(!booking) throw new NotFoundException('Booking was not found for this customer.');
    if(mode!=='read' && booking.deleted_at) throw new ConflictException('This booking has been cancelled.');
    if(mode!=='read' && customer.status!=='active') throw new ConflictException('Restore this customer before submitting or reviewing payments.');
    if(mode!=='read' && (active.currency!=='GBP' || active.currency_exponent!==2 || booking.currency!=='GBP')) {
      throw new ConflictException('Booking payments require a GBP accounting workspace.');
    }
    return {active,customer,booking};
  }

  private async assertChargeActive(client:PoolClient,chargeId:string) {
    const reversed=await client.query('SELECT 1 FROM ledger_entries WHERE reversal_of=$1',[chargeId]);
    if(reversed.rows.length) throw new ConflictException('This booking charge was reversed. Contact the administrator before submitting or approving a payment.');
  }

  /** Called before multipart buffering; submit repeats authorization inside its write transaction. */
  async authorizeUpload(member:Membership,customerId:string,bookingId:string) {
    await this.db.transaction(async client=>{const {booking}=await this.context(client,member,customerId,bookingId,'submit');
      await this.assertChargeActive(client,booking.charge_entry_id);});
  }

  private async normalizeFiles(files:PaymentUpload[]):Promise<Receipt[]> {
    if(!Array.isArray(files) || files.length<1 || files.length>MAX_RECEIPTS) throw new BadRequestException('Attach between one and five receipt images.');
    const receipts:Receipt[]=[];
    const hashes=new Set<string>();
    // Decode sequentially so one request never expands five large images at once.
    for(const file of files) {
      const originalName=parse(filenameSchema,file.originalname);
      if(!Buffer.isBuffer(file.buffer) || file.buffer.length===0 || file.buffer.length>MAX_RECEIPT_BYTES || file.size!==file.buffer.length)
        throw new BadRequestException('Each receipt must be an image of at most 5 MB.');
      if(!['image/jpeg','image/png','image/webp'].includes(file.mimetype)) throw new BadRequestException('Receipts must be JPEG, PNG, or WebP images.');
      const originalSha256=digest(file.buffer);
      if(hashes.has(originalSha256)) throw new BadRequestException('The same receipt image was attached more than once.');
      hashes.add(originalSha256);
      let content:Buffer;
      try {
        const image=sharp(file.buffer,{limitInputPixels:MAX_RECEIPT_PIXELS,failOn:'warning',animated:false});
        const metadata=await image.metadata();
        const mime={jpeg:'image/jpeg',png:'image/png',webp:'image/webp'}[metadata.format as 'jpeg'|'png'|'webp'];
        if(mime!==file.mimetype || !metadata.width || !metadata.height || metadata.width>10000 || metadata.height>10000 || (metadata.pages??1)>1) {
          throw new Error('Unsupported image');
        }
        // Re-encoding removes metadata, scripts, appended data and untrusted original bytes.
        content=await image.rotate().webp({lossless:true,effort:4}).toBuffer();
        if(content.length>MAX_RECEIPT_BYTES) throw new Error('Normalized image too large');
      } catch {throw new BadRequestException('A receipt is invalid, animated, or too large to process. Use a still JPEG, PNG, or WebP up to 20 megapixels and 5 MB.');}
      const stem=originalName.replace(/\.[^.]*$/,'').slice(0,235)||'receipt';
      receipts.push({name:`${stem}.webp`,content,originalSha256,originalName,originalMime:file.mimetype});
    }
    return receipts;
  }

  private async audit(client:PoolClient,member:Membership,action:string,id:string,metadata:unknown) {
    await client.query(`INSERT INTO audit_events(organization_id,actor_id,action,object_id,metadata)
      VALUES($1,$2,$3,$4,$5::jsonb)`,[member.organization_id,member.user_id,action,id,JSON.stringify(metadata)]);
  }

  private async serialize(client:PoolClient,rows:PaymentRow[]) {
    if(!rows.length) return [];
    const receipts=await client.query<{id:string;payment_id:string;name:string;mime_type:string;size:number}>(
      `SELECT id,payment_id,name,mime_type,size FROM booking_payment_receipts WHERE organization_id=$1 AND payment_id=ANY($2::uuid[]) ORDER BY created_at,id`,
      [rows[0].organization_id,rows.map(row=>row.id)]);
    return rows.map(({request_hash:_hash,organization_id:_organization,submitted_by:_submitter,...row})=>({...row,
      receipts:receipts.rows.filter(receipt=>receipt.payment_id===row.id).map(({payment_id:_payment,...receipt})=>({...receipt,
        url:`/api/organizations/${_organization}/customers/${row.customer_id}/bookings/${row.booking_id}/payments/${row.id}/receipts/${receipt.id}`}))}));
  }

  private async find(client:PoolClient,orgId:string,customerId:string,bookingId:string,paymentId:string,lock=false) {
    uuid(paymentId,'payment');
    const result=await client.query<PaymentRow>(`SELECT ${paymentColumns} ${paymentJoins}
      WHERE p.organization_id=$1 AND p.customer_id=$2 AND p.booking_id=$3 AND p.id=$4 ${lock?'FOR UPDATE OF p':''}`,
      [orgId,customerId,bookingId,paymentId]);
    if(!result.rows[0]) throw new NotFoundException('Payment submission was not found in this booking.');
    return result.rows[0];
  }

  async list(member:Membership,customerId:string,bookingId:string) {
    return this.db.transaction(async client=>{
      const {active}=await this.context(client,member,customerId,bookingId);
      const result=await client.query<PaymentRow>(`SELECT ${paymentColumns} ${paymentJoins}
        WHERE p.organization_id=$1 AND p.customer_id=$2 AND p.booking_id=$3 ORDER BY p.submitted_at DESC,p.id`,[active.organization_id,customerId,bookingId]);
      return {items:await this.serialize(client,result.rows),time_zone:config.businessTimeZone};
    });
  }

  async reviewQueue(member:Membership,rawQuery:unknown={}) {
    // Keep the original direct-service status argument compatible with existing callers.
    const query=parse(reviewQuerySchema,typeof rawQuery==='string'?{status:rawQuery}:rawQuery);
    return this.db.transaction(async client=>{
      const active=await this.access.membership(member.user_id,member.organization_id,true,client);
      const values:unknown[]=[active.organization_id];
      const conditions=['p.organization_id=$1'];
      const parameter=(value:unknown)=>{values.push(value);return `$${values.length}`;};
      if(query.from) conditions.push(`p.payment_date>=${parameter(query.from)}::date`);
      if(query.to) conditions.push(`p.payment_date<=${parameter(query.to)}::date`);
      if(query.q) {
        const zone=parameter(config.businessTimeZone);
        const searchable=`concat_ws(' ',p.id::text,p.customer_id::text,p.booking_id::text,
          c.name,c.customer_code,c.email,b.reference,p.note,p.rejection_reason,p.status,p.currency,
          p.ledger_entry_id::text,p.payment_date::text,to_char(p.payment_date,'FMDD Mon YYYY'),
          to_char(p.payment_date,'DD/MM/YYYY'),to_char(p.amount_minor::numeric/100,'FM9999999999990.00'),
          to_char(p.amount_minor::numeric/100,'FM9,999,999,999,990.00'),
          to_char(p.submitted_at AT TIME ZONE ${zone},'YYYY-MM-DD FMDD Mon YYYY DD/MM/YYYY HH24:MI'),
          to_char(p.reviewed_at AT TIME ZONE ${zone},'YYYY-MM-DD FMDD Mon YYYY DD/MM/YYYY HH24:MI'),
          (SELECT string_agg(concat_ws(' ',r.id::text,r.name),' ') FROM booking_payment_receipts r
            WHERE r.organization_id=p.organization_id AND r.payment_id=p.id))`;
        // Match each word literally, including '%' and '_', without SQL wildcard surprises.
        for(const term of reviewSearchTerms(query.q)) {
          const pattern=`%${term.replace(/[\\%_]/g,'\\$&')}%`;
          conditions.push(`${searchable} ILIKE ${parameter(pattern)}`);
        }
      }
      const scope=conditions.join(' AND ');
      const count=await client.query<{pending:number;approved:number;rejected:number;all:number}>(`SELECT
        count(*) FILTER (WHERE p.status='pending')::integer AS pending,
        count(*) FILTER (WHERE p.status='approved')::integer AS approved,
        count(*) FILTER (WHERE p.status='rejected')::integer AS rejected,count(*)::integer AS all
        ${paymentJoins} WHERE ${scope}`,values);
      const counts=count.rows[0];
      const total=counts[query.status];
      const totalPages=Math.max(1,Math.ceil(total/query.page_size));
      const page=Math.min(query.page,totalPages);
      if(query.status!=='all') conditions.push(`p.status=${parameter(query.status)}`);
      const limit=parameter(query.page_size);
      const offset=parameter((page-1)*query.page_size);
      const order={oldest:'p.submitted_at,p.id',newest:'p.submitted_at DESC,p.id',
        amount_desc:'p.amount_minor DESC,p.submitted_at,p.id',amount_asc:'p.amount_minor,p.submitted_at,p.id'}[query.sort];
      const result=await client.query<PaymentRow>(`SELECT ${paymentColumns} ${paymentJoins}
        WHERE ${conditions.join(' AND ')} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,values);
      return {items:await this.serialize(client,result.rows),time_zone:config.businessTimeZone,total,
        page,page_size:query.page_size,total_pages:totalPages,counts};
    });
  }

  async submit(member:Membership,customerId:string,bookingId:string,raw:unknown,files:PaymentUpload[]) {
    const data=parse(submitSchema,raw);
    const amount=parseMoney(data.amount,2);
    if(data.payment_date>businessDate()) throw new BadRequestException('Payment date cannot be in the future.');
    // Direct service callers receive the same authorization-before-decoding guarantee as HTTP callers.
    await this.authorizeUpload(member,customerId,bookingId);
    const receipts=await this.normalizeFiles(files);
    const fingerprint=digest(JSON.stringify({organization:member.organization_id,customer:customerId,booking:bookingId,
      user:member.user_id,amount:amount.toString(),date:data.payment_date,note:data.note,
      receipts:receipts.map(receipt=>({sha:receipt.originalSha256,name:receipt.originalName,mime:receipt.originalMime}))}));
    return this.db.transaction(async client=>{
      const {active,customer,booking}=await this.context(client,member,customerId,bookingId,'submit');
      const prior=await client.query<{id:string;request_hash:string}>(`SELECT id,request_hash FROM booking_payments WHERE organization_id=$1 AND idempotency_key=$2`,[active.organization_id,data.idempotency_key]);
      if(prior.rows[0]) {
        if(prior.rows[0].request_hash!==fingerprint) throw new ConflictException('This submission key was already used for a different payment.');
        return (await this.serialize(client,[await this.find(client,active.organization_id,customerId,bookingId,prior.rows[0].id)]))[0];
      }
      await this.assertChargeActive(client,booking.charge_entry_id);
      const limits=await client.query<{total:number;pending:number}>(`SELECT count(*)::integer AS total,count(*) FILTER (WHERE status='pending')::integer AS pending
        FROM booking_payments WHERE booking_id=$1`,[bookingId]);
      if(limits.rows[0].pending>=MAX_PENDING_PAYMENTS) throw new ConflictException('This booking already has ten payments awaiting review. Wait for the administrator to review them.');
      if(limits.rows[0].total>=MAX_BOOKING_PAYMENTS) throw new ConflictException('This booking has reached its payment submission limit. Contact the administrator.');
      const used=await client.query<{bytes:string}>(`SELECT coalesce(sum(size),0)::text AS bytes FROM booking_payment_receipts WHERE booking_id=$1`,[bookingId]);
      if(BigInt(used.rows[0].bytes)+BigInt(receipts.reduce((sum,receipt)=>sum+receipt.content.length,0))>BigInt(MAX_BOOKING_RECEIPT_BYTES)) {
        throw new ConflictException('This booking has reached its receipt storage limit. Contact the administrator.');
      }
      const duplicate=await client.query(`SELECT 1 FROM booking_payment_receipts r JOIN booking_payments p ON p.id=r.payment_id
        WHERE r.booking_id=$1 AND r.original_sha256=ANY($2::text[]) AND p.status IN ('pending','approved') LIMIT 1`,[bookingId,receipts.map(receipt=>receipt.originalSha256)]);
      if(duplicate.rows.length) throw new ConflictException('A receipt is already attached to a pending or approved payment in this booking. Check its existing status.');
      const id=randomUUID();
      const inserted=await client.query<{submitted_at:Date}>(`INSERT INTO booking_payments(id,organization_id,customer_id,booking_id,amount_minor,payment_date,note,submitted_by,idempotency_key,request_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING submitted_at`,[id,active.organization_id,customerId,bookingId,amount.toString(),data.payment_date,data.note,active.user_id,data.idempotency_key,fingerprint]);
      for(const receipt of receipts) await client.query(`INSERT INTO booking_payment_receipts(id,organization_id,customer_id,booking_id,payment_id,name,size,content,original_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[randomUUID(),active.organization_id,customerId,bookingId,id,receipt.name,receipt.content.length,receipt.content,receipt.originalSha256]);
      await this.audit(client,active,'payment.submitted',id,{customer_id:customerId,booking_id:bookingId,amount_minor:amount.toString(),receipt_count:receipts.length});
      const submittedAt=new Date(inserted.rows[0].submitted_at).toISOString();
      const link=`${config.appUrl}/o/${active.organization_id}/users/${customerId}/bookings/${bookingId}`;
      // Insert all administrator intents in one query, regardless of team size.
      await client.query(`INSERT INTO payment_email_outbox(organization_id,recipient,subject,body,dedupe_key)
        SELECT m.organization_id,u.email,$2,$3,$4||u.email FROM memberships m JOIN users u ON u.id=m.user_id
        WHERE m.organization_id=$1 AND m.role='admin' AND m.is_active AND m.deleted_at IS NULL
        ON CONFLICT (dedupe_key) DO NOTHING`,[active.organization_id,'Payment receipt submitted',
        `${customer.name} uploaded ${receipts.length} payment receipt image(s).\n\nBooking: ${booking.reference}\nAmount: GBP ${formatMoney(amount,2)}\nPayment date: ${data.payment_date}\nUploaded at: ${submittedAt}\n\nOpen the booking to check the current review status. If still pending, verify the payment before approving:\n${link}`,`payment-submitted:${id}:`]);
      await queueCustomerPaymentEmail(client,{kind:'received',organizationId:active.organization_id,organizationName:active.organization_name!,
        customerId,customerName:customer.name,recipient:customer.email,bookingId,bookingReference:booking.reference,
        paymentId:id,submittedBy:active.user_id,amountMinor:amount.toString(),currency:booking.currency,paymentDate:data.payment_date,receiptCount:receipts.length});
      return (await this.serialize(client,[await this.find(client,active.organization_id,customerId,bookingId,id)]))[0];
    });
  }

  async approve(member:Membership,customerId:string,bookingId:string,paymentId:string,raw:unknown={}) {
    parse(z.object({}).strict(),raw??{});
    return this.db.transaction(async client=>{
      const {active,customer,booking}=await this.context(client,member,customerId,bookingId,'review');
      const payment=await this.find(client,active.organization_id,customerId,bookingId,paymentId,true);
      if(payment.status==='approved') return (await this.serialize(client,[payment]))[0];
      if(payment.status!=='pending') throw new ConflictException('A rejected payment cannot be approved. Ask the customer to submit new evidence.');
      await this.assertChargeActive(client,booking.charge_entry_id);
      await ensureBookingInvoice(client,{organizationId:active.organization_id,customerId,bookingId,actorId:active.user_id});
      const entry=await client.query<{id:string}>(`INSERT INTO ledger_entries(organization_id,customer_id,kind,amount_minor,currency,effective_date,description,reference,created_by,idempotency_key,request_hash)
        VALUES($1,$2,'payment',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id::text AS id`,
        [active.organization_id,customerId,(-BigInt(payment.amount_minor)).toString(),payment.currency,payment.payment_date,
          `Approved payment for booking ${booking.reference}`,booking.reference,active.user_id,randomUUID(),digest(`booking-payment:${payment.id}`)]);
      await client.query(`UPDATE booking_payments SET status='approved',reviewed_by=$1,reviewed_at=now(),ledger_entry_id=$2 WHERE id=$3`,[active.user_id,entry.rows[0].id,payment.id]);
      await this.audit(client,active,'payment.approved',payment.id,{customer_id:customerId,booking_id:bookingId,entry_id:entry.rows[0].id});
      await this.audit(client,active,'ledger.posted',entry.rows[0].id,{customer_id:customerId,kind:'payment',booking_id:bookingId,payment_id:payment.id});
      await cancelUnsentPaymentReviewEmails(client,active.organization_id,[payment.id]);
      const invoice=await issueBookingInvoice(client,{organizationId:active.organization_id,customerId,bookingId,actorId:active.user_id,
        reason:'payment_approved',eventKey:`payment-approved:${payment.id}`});
      await queueCustomerPaymentEmail(client,{kind:'approved',organizationId:active.organization_id,organizationName:active.organization_name!,
        customerId,customerName:customer.name,recipient:customer.email,bookingId,bookingReference:booking.reference,
        paymentId:payment.id,submittedBy:payment.submitted_by,amountMinor:payment.amount_minor,currency:payment.currency,paymentDate:payment.payment_date,invoiceId:invoice.id});
      return (await this.serialize(client,[await this.find(client,active.organization_id,customerId,bookingId,payment.id)]))[0];
    });
  }

  async reject(member:Membership,customerId:string,bookingId:string,paymentId:string,raw:unknown) {
    const {reason}=parse(z.object({reason:z.string().trim().min(1).max(1000)}).strict(),raw);
    return this.db.transaction(async client=>{
      const {active,customer,booking}=await this.context(client,member,customerId,bookingId,'review');
      const payment=await this.find(client,active.organization_id,customerId,bookingId,paymentId,true);
      if(payment.status==='rejected' && payment.rejection_reason===reason) return (await this.serialize(client,[payment]))[0];
      if(payment.status!=='pending') throw new ConflictException('This payment has already been reviewed. Refresh the booking.');
      await client.query(`UPDATE booking_payments SET status='rejected',reviewed_by=$1,reviewed_at=now(),rejection_reason=$2 WHERE id=$3`,[active.user_id,reason,payment.id]);
      await this.audit(client,active,'payment.rejected',payment.id,{customer_id:customerId,booking_id:bookingId,reason});
      await cancelUnsentPaymentReviewEmails(client,active.organization_id,[payment.id]);
      await queueCustomerPaymentEmail(client,{kind:'rejected',organizationId:active.organization_id,organizationName:active.organization_name!,
        customerId,customerName:customer.name,recipient:customer.email,bookingId,bookingReference:booking.reference,
        paymentId:payment.id,submittedBy:payment.submitted_by,amountMinor:payment.amount_minor,currency:payment.currency,paymentDate:payment.payment_date,reason});
      return (await this.serialize(client,[await this.find(client,active.organization_id,customerId,bookingId,payment.id)]))[0];
    });
  }

  async receipt(member:Membership,customerId:string,bookingId:string,paymentId:string,receiptId:string) {
    uuid(receiptId,'receipt');
    return this.db.transaction(async client=>{
      const {active}=await this.context(client,member,customerId,bookingId);
      await this.find(client,active.organization_id,customerId,bookingId,paymentId);
      const result=await client.query<{name:string;mime_type:string;size:number;content:Buffer|Uint8Array}>(`SELECT name,mime_type,size,content FROM booking_payment_receipts
        WHERE organization_id=$1 AND customer_id=$2 AND booking_id=$3 AND payment_id=$4 AND id=$5`,[active.organization_id,customerId,bookingId,paymentId,receiptId]);
      if(!result.rows[0]) throw new NotFoundException('Receipt was not found in this payment submission.');
      return {...result.rows[0],content:Buffer.from(result.rows[0].content)};
    });
  }
}
