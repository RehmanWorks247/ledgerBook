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
type Receipt = {name:string;content:Buffer;mimeType:'image/webp'|'application/pdf';originalSha256:string;originalName:string;originalMime:string};
type PaymentRow = QueryResultRow & {id:string;organization_id:string;customer_id:string;booking_id:string|null;
  invoice_id:string|null;invoice_number:string|null;
  amount_minor:string;currency:string;payment_date:string;note:string;status:'pending'|'approved'|'rejected';
  submitted_at:Date|string;reviewed_at:Date|string|null;reviewed_by:string|null;rejection_reason:string|null;
  ledger_entry_id:string|null;request_hash:string;booking_reference:string|null;customer_name:string;customer_code:string;submitted_by:string;
  source:'booking_instalment'|'customer_receipt';version:number;deleted_at:Date|string|null;deletion_reason:string|null;restore_credit:boolean|null;reversed:boolean};
const paymentColumns = `p.id,p.organization_id,p.customer_id,p.booking_id,p.invoice_id,
  (SELECT i.invoice_number FROM booking_invoices i WHERE i.id=p.invoice_id) AS invoice_number,p.amount_minor::text AS amount_minor,p.currency,
  p.payment_date::text AS payment_date,p.note,p.status,p.submitted_at,p.reviewed_at,p.reviewed_by,p.rejection_reason,
  p.ledger_entry_id::text AS ledger_entry_id,p.request_hash,p.submitted_by,p.source,p.version,p.deleted_at,p.deletion_reason,p.restore_credit,
  EXISTS(SELECT 1 FROM ledger_entries reversed WHERE reversed.reversal_of=p.ledger_entry_id) AS reversed,
  b.reference AS booking_reference,c.name AS customer_name,c.customer_code`;
const paymentJoins = `FROM booking_payments p LEFT JOIN bookings b ON b.id=p.booking_id AND b.organization_id=p.organization_id
  JOIN customers c ON c.id=p.customer_id AND c.organization_id=p.organization_id`;
const submitSchema = z.object({amount:z.string().max(24),payment_date:z.string().refine(validDate,'Enter a valid payment date.'),
  note:z.string().trim().max(1000).default(''),idempotency_key:z.uuid(),invoice_id:z.uuid().optional()}).strict();
const linkSchema=z.object({payment_entry_id:z.string().regex(/^[1-9]\d{0,18}$/)
  .refine(value=>/^[1-9]\d{0,18}$/.test(value)&&BigInt(value)<=9_223_372_036_854_775_807n,'Choose a valid existing payment.'),idempotency_key:z.uuid()}).strict();
type RecordedPaymentInput={operation:'record';amount:string;payment_date:string;note:string;idempotency_key:string}
  | {operation:'link';payment_entry_id:string;idempotency_key:string};
const queryInteger = (maximum:number) => z.union([z.number(),z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().min(1).max(maximum));
const listQuerySchema=z.object({deleted:z.enum(['active','deleted']).default('active')}).strict();
const historyOperationSchema=z.object({version:z.number().int().min(1),reason:z.string().trim().min(1).max(1000)});
const historyEditSchema=historyOperationSchema.extend({amount:z.string().max(24),payment_date:z.string().refine(validDate,'Enter a valid payment date.'),note:z.string().trim().max(1000)}).strict();
const reviewQuerySchema = z.object({
  deleted:z.enum(['active','deleted']).default('active'),
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

  private async context(client:PoolClient,member:Membership,customerId:string,bookingId:string|null,mode:'read'|'submit'|'review'|'history'|'record'='read') {
    if(bookingId!==null) uuid(bookingId,'booking');
    if(mode!=='read') {
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
    const active=await this.access.membership(member.user_id,member.organization_id,mode==='review'||mode==='history'||mode==='record',client);
    const customer=await this.access.customer(active,customerId,client,mode!=='read');
    if(mode==='submit' && active.role!=='customer') throw new ForbiddenException('Only the customer can submit payment evidence.');
    if(mode!=='read' && mode!=='history' && customer.status!=='active') throw new ConflictException('Restore this customer before submitting or reviewing payments.');
    if(mode!=='read' && (active.currency!=='GBP' || active.currency_exponent!==2)) {
      throw new ConflictException('Payments require a GBP accounting workspace.');
    }
    if(bookingId===null) return {active,customer,booking:null};
    const result=await client.query(`SELECT b.*,b.total_minor::text AS total_minor FROM bookings b
      WHERE b.organization_id=$1 AND b.customer_id=$2 AND b.id=$3 ${mode!=='read'?'FOR UPDATE':''}`,[active.organization_id,customerId,bookingId]);
    const booking=result.rows[0];
    if(!booking) throw new NotFoundException('Booking was not found for this customer.');
    if(mode!=='read' && mode!=='history' && booking.deleted_at) throw new ConflictException('This booking has been cancelled.');
    if(mode!=='read' && booking.currency!=='GBP') {
      throw new ConflictException('Booking payments require a GBP accounting workspace.');
    }
    return {active,customer,booking};
  }

  private async assertChargeActive(client:PoolClient,chargeId:string) {
    const reversed=await client.query('SELECT 1 FROM ledger_entries WHERE reversal_of=$1',[chargeId]);
    if(reversed.rows.length) throw new ConflictException('This booking charge was reversed. Contact the administrator before submitting or approving a payment.');
  }

  /** Called before multipart buffering; submit repeats authorization inside its write transaction. */
  async authorizeUpload(member:Membership,customerId:string,bookingId:string|null) {
    await this.db.transaction(async client=>{const {booking}=await this.context(client,member,customerId,bookingId,'submit');
      if(booking) await this.assertChargeActive(client,booking.charge_entry_id);});
  }

  private async normalizeFiles(files:PaymentUpload[]):Promise<Receipt[]> {
    if(!Array.isArray(files) || files.length>MAX_RECEIPTS) throw new BadRequestException('Attach at most five receipt files.');
    const receipts:Receipt[]=[];
    const hashes=new Set<string>();
    // Decode sequentially so one request never expands five large images at once.
    for(const file of files) {
      const originalName=parse(filenameSchema,file.originalname);
      if(!Buffer.isBuffer(file.buffer) || file.buffer.length===0 || file.buffer.length>MAX_RECEIPT_BYTES || file.size!==file.buffer.length)
        throw new BadRequestException('Each receipt must be a nonempty file of at most 5 MB.');
      if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(file.mimetype)) throw new BadRequestException('Receipts must be PDF, JPEG, PNG, or WebP files.');
      const originalSha256=digest(file.buffer);
      if(hashes.has(originalSha256)) throw new BadRequestException('The same receipt file was attached more than once.');
      hashes.add(originalSha256);
      if(file.mimetype==='application/pdf') {
        // Match booking-document PDF validation, while preserving the original
        // receipt bytes for review and download rather than rasterizing pages.
        if(!/\.pdf$/i.test(originalName) || file.buffer.length<12 || !file.buffer.subarray(0,8).toString('ascii').startsWith('%PDF-')
          || !file.buffer.subarray(-1024).includes(Buffer.from('%%EOF'))) throw new BadRequestException('Choose a valid PDF receipt of at most 5 MB.');
        receipts.push({name:originalName,content:file.buffer,mimeType:'application/pdf',originalSha256,originalName,originalMime:file.mimetype});
        continue;
      }
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
      receipts.push({name:`${stem}.webp`,content,mimeType:'image/webp',originalSha256,originalName,originalMime:file.mimetype});
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
        url:`/api/organizations/${_organization}/customers/${row.customer_id}${row.booking_id?`/bookings/${row.booking_id}`:''}/payments/${row.id}/receipts/${receipt.id}`}))}));
  }

  private async find(client:PoolClient,orgId:string,customerId:string,bookingId:string|null,paymentId:string,lock=false) {
    uuid(paymentId,'payment');
    const result=await client.query<PaymentRow>(`SELECT ${paymentColumns} ${paymentJoins}
      WHERE p.organization_id=$1 AND p.customer_id=$2 AND p.booking_id IS NOT DISTINCT FROM $3::uuid AND p.id=$4 ${lock?'FOR UPDATE OF p':''}`,
      [orgId,customerId,bookingId,paymentId]);
    if(!result.rows[0]) throw new NotFoundException('Payment submission was not found in this account or booking.');
    return result.rows[0];
  }

  async list(member:Membership,customerId:string,bookingId:string|null,rawQuery:unknown={}) {
    const query=parse(listQuerySchema,rawQuery);
    return this.db.transaction(async client=>{
      const {active}=await this.context(client,member,customerId,bookingId);
      if(query.deleted==='deleted' && active.role!=='admin') throw new ForbiddenException('Only administrators can view deleted payment history.');
      const result=await client.query<PaymentRow>(`SELECT ${paymentColumns} ${paymentJoins}
        WHERE p.organization_id=$1 AND p.customer_id=$2 AND ($3::uuid IS NULL OR p.booking_id=$3)
        AND ($3::uuid IS NOT NULL OR b.deleted_at IS NULL)
        AND p.deleted_at IS ${query.deleted==='deleted'?'NOT ':''}NULL ORDER BY p.submitted_at DESC,p.id`,[active.organization_id,customerId,bookingId]);
      return {items:await this.serialize(client,result.rows),time_zone:config.businessTimeZone};
    });
  }

  async reviewQueue(member:Membership,rawQuery:unknown={}) {
    // Keep the original direct-service status argument compatible with existing callers.
    const query=parse(reviewQuerySchema,typeof rawQuery==='string'?{status:rawQuery}:rawQuery);
    return this.db.transaction(async client=>{
      const active=await this.access.membership(member.user_id,member.organization_id,true,client);
      const values:unknown[]=[active.organization_id];
      const conditions=['p.organization_id=$1',`p.deleted_at IS ${query.deleted==='deleted'?'NOT ':''}NULL`];
      if(query.deleted==='active') conditions.push('b.deleted_at IS NULL');
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

  /** Confirm received money separately from the reminder schedule. */
  async record(member:Membership,customerId:string,bookingId:string,raw:unknown) {
    const data=parse(submitSchema.omit({invoice_id:true}),raw),amount=parseMoney(data.amount,2).toString();
    if(data.payment_date>businessDate()) throw new BadRequestException('Payment date cannot be in the future.');
    return this.saveRecordedPayment(member,customerId,bookingId,{...data,amount,operation:'record'});
  }

  /** Allocate one whole, unassigned customer payment without posting it again. */
  async link(member:Membership,customerId:string,bookingId:string,raw:unknown) {
    return this.saveRecordedPayment(member,customerId,bookingId,{...parse(linkSchema,raw),operation:'link'});
  }

  private async saveRecordedPayment(member:Membership,customerId:string,bookingId:string,data:RecordedPaymentInput) {
    const fingerprint=digest(JSON.stringify({organization:member.organization_id,customer:customerId,booking:bookingId,
      user:member.user_id,...data,idempotency_key:undefined}));
    return this.db.transaction(async client=>{
      const {active,booking}=await this.context(client,member,customerId,bookingId,'record');
      // Customer locks serialize payment allocation, and the key lock also
      // protects accidental reuse for a different customer in this workspace.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`record-payment:${active.organization_id}:${data.idempotency_key}`]);
      const prior=await client.query<{id:string;request_hash:string}>(`SELECT id,request_hash FROM booking_payments
        WHERE organization_id=$1 AND idempotency_key=$2`,[active.organization_id,data.idempotency_key]);
      if(prior.rows[0]) {
        if(prior.rows[0].request_hash!==fingerprint) throw new ConflictException('This request was already used for a different payment.');
        const payment=await this.find(client,active.organization_id,customerId,bookingId,prior.rows[0].id);
        if(payment.deleted_at) throw new ConflictException('This payment was deleted. Restore it from payment history instead of recording it again.');
        return (await this.serialize(client,[payment]))[0];
      }
      const purged=await client.query(`SELECT 1 FROM audit_events WHERE organization_id=$1 AND action='payment.permanently_deleted'
        AND metadata->'before'->>'idempotency_key'=$2`,[active.organization_id,data.idempotency_key]);
      if(purged.rows.length) throw new ConflictException('This payment was permanently deleted. Start a new record for a new payment.');
      await this.assertChargeActive(client,booking.charge_entry_id);
      let amount:string,paymentDate:string,note:string,entryId:string|undefined;
      if(data.operation==='link') {
        const result=await client.query<{id:string;amount_minor:string;payment_date:string;description:string;payment_id:string|null;booking_id:string|null}>(
          `SELECT e.id::text,(-e.amount_minor)::text AS amount_minor,e.effective_date::text AS payment_date,e.description,
            p.id AS payment_id,p.booking_id FROM ledger_entries e LEFT JOIN booking_payments p ON p.ledger_entry_id=e.id
          WHERE e.id=$1 AND e.organization_id=$2 AND e.customer_id=$3 AND e.kind='payment' AND e.currency='GBP'
            AND e.amount_minor<0 AND NOT EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reversal_of=e.id)`,
          [data.payment_entry_id,active.organization_id,customerId]);
        const entry=result.rows[0];
        if(!entry) throw new BadRequestException('Choose an available payment from this customer account.');
        if(entry.payment_id) throw new ConflictException(entry.booking_id===bookingId?
          'This payment is already recorded for this booking.':'This payment is already assigned to another booking.');
        if(entry.payment_date>businessDate()) throw new BadRequestException('Payment date cannot be in the future.');
        amount=entry.amount_minor;paymentDate=entry.payment_date;note=entry.description;entryId=entry.id;
      } else {amount=data.amount;paymentDate=data.payment_date;note=data.note;}
      await ensureBookingInvoice(client,{organizationId:active.organization_id,customerId,bookingId,actorId:active.user_id});
      const id=randomUUID();
      if(!entryId) {
        const entry=await client.query<{id:string}>(`INSERT INTO ledger_entries(organization_id,customer_id,kind,amount_minor,currency,effective_date,
          description,reference,created_by,idempotency_key,request_hash)
          VALUES($1,$2,'payment',$3,'GBP',$4,$5,$6,$7,$8,$9) RETURNING id::text AS id`,
          [active.organization_id,customerId,(-BigInt(amount)).toString(),paymentDate,`Payment for booking ${booking.reference}`,
            booking.reference,active.user_id,randomUUID(),fingerprint]);
        entryId=entry.rows[0].id;
        await this.audit(client,active,'ledger.posted',entryId,{customer_id:customerId,booking_id:bookingId,payment_id:id,kind:'payment'});
      }
      await client.query(`INSERT INTO booking_payments(id,organization_id,customer_id,booking_id,amount_minor,payment_date,note,status,
        submitted_by,idempotency_key,request_hash,reviewed_by,reviewed_at,ledger_entry_id,source)
        VALUES($1,$2,$3,$4,$5,$6,$7,'approved',NULL,$8,$9,$10,now(),$11,'booking_instalment')`,
        [id,active.organization_id,customerId,bookingId,amount,paymentDate,note,data.idempotency_key,fingerprint,active.user_id,entryId]);
      await client.query('UPDATE bookings SET version=version+1,updated_at=now() WHERE id=$1',[bookingId]);
      await this.audit(client,active,data.operation==='link'?'payment.linked':'payment.recorded',id,
        {customer_id:customerId,booking_id:bookingId,entry_id:entryId,amount_minor:amount,payment_date:paymentDate,source:'booking_instalment'});
      await issueBookingInvoice(client,{organizationId:active.organization_id,customerId,bookingId,actorId:active.user_id,
        reason:'payment_approved',eventKey:`payment-${data.operation}:${id}`});
      return (await this.serialize(client,[await this.find(client,active.organization_id,customerId,bookingId,id)]))[0];
    });
  }

  async submit(member:Membership,customerId:string,bookingId:string|null,raw:unknown,files:PaymentUpload[]) {
    const data=parse(submitSchema,raw);
    if(data.invoice_id && !bookingId) throw new BadRequestException('Choose the booking for this invoice.');
    const amount=parseMoney(data.amount,2);
    if(data.payment_date>businessDate()) throw new BadRequestException('Payment date cannot be in the future.');
    // Direct service callers receive the same authorization-before-decoding guarantee as HTTP callers.
    await this.authorizeUpload(member,customerId,bookingId);
    const receipts=await this.normalizeFiles(files??[]);
    const fingerprint=digest(JSON.stringify({organization:member.organization_id,customer:customerId,booking:bookingId,
      user:member.user_id,amount:amount.toString(),date:data.payment_date,note:data.note,...(data.invoice_id?{invoice:data.invoice_id}:{}),
      receipts:receipts.map(receipt=>({sha:receipt.originalSha256,name:receipt.originalName,mime:receipt.originalMime}))}));
    return this.db.transaction(async client=>{
      const {active,customer,booking}=await this.context(client,member,customerId,bookingId,'submit');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`record-payment:${active.organization_id}:${data.idempotency_key}`]);
      const prior=await client.query<{id:string;request_hash:string}>(`SELECT id,request_hash FROM booking_payments WHERE organization_id=$1 AND idempotency_key=$2`,[active.organization_id,data.idempotency_key]);
      if(prior.rows[0]) {
        if(prior.rows[0].request_hash!==fingerprint) throw new ConflictException('This submission key was already used for a different payment.');
        const previous=await this.find(client,active.organization_id,customerId,bookingId,prior.rows[0].id);
        if(previous.deleted_at) throw new ConflictException('This payment submission was deleted by an administrator.');
        return (await this.serialize(client,[previous]))[0];
      }
      const purged=await client.query(`SELECT 1 FROM audit_events WHERE organization_id=$1 AND action='payment.permanently_deleted'
        AND metadata->'before'->>'idempotency_key'=$2`,[active.organization_id,data.idempotency_key]);
      if(purged.rows.length) throw new ConflictException('This payment submission was permanently deleted. Use a new submission for a new payment.');
      if(booking) await this.assertChargeActive(client,booking.charge_entry_id);
      const invoice=bookingId?await ensureBookingInvoice(client,{organizationId:active.organization_id,customerId,bookingId,actorId:active.user_id}):null;
      if(data.invoice_id && invoice?.id!==data.invoice_id) {
        throw new ConflictException('This invoice is no longer the latest invoice for this booking. Refresh the invoices and select the latest version.');
      }
      if(invoice && (BigInt(invoice.balance_minor)<=0n || !['unpaid','partially_paid'].includes(invoice.status))) {
        throw new ConflictException('This invoice has no outstanding balance. Refresh the invoices before submitting a payment.');
      }
      if(invoice) {
        const balance=await client.query<{balance:string}>(`SELECT COALESCE(SUM(amount_minor),0)::text AS balance
          FROM account_ledger_entries WHERE organization_id=$1 AND customer_id=$2`,[active.organization_id,customerId]);
        if(BigInt(balance.rows[0].balance)<=0n) throw new ConflictException('Your account has no outstanding balance. Refresh your account before submitting a payment.');
      }
      const limits=await client.query<{total:number;pending:number}>(`SELECT count(*)::integer AS total,count(*) FILTER (WHERE status='pending')::integer AS pending
        FROM booking_payments WHERE organization_id=$1 AND customer_id=$2 AND booking_id IS NOT DISTINCT FROM $3::uuid
          AND source='customer_receipt' AND deleted_at IS NULL`,[active.organization_id,customerId,bookingId]);
      const scope=booking?'booking':'account';
      if(limits.rows[0].pending>=MAX_PENDING_PAYMENTS) throw new ConflictException(`This ${scope} already has ten payments awaiting review. Wait for the administrator to review them.`);
      if(limits.rows[0].total>=MAX_BOOKING_PAYMENTS) throw new ConflictException(`This ${scope} has reached its payment submission limit. Contact the administrator.`);
      const used=await client.query<{bytes:string}>(`SELECT coalesce(sum(size),0)::text AS bytes FROM booking_payment_receipts
        WHERE organization_id=$1 AND customer_id=$2 AND booking_id IS NOT DISTINCT FROM $3::uuid`,[active.organization_id,customerId,bookingId]);
      if(BigInt(used.rows[0].bytes)+BigInt(receipts.reduce((sum,receipt)=>sum+receipt.content.length,0))>BigInt(MAX_BOOKING_RECEIPT_BYTES)) {
        throw new ConflictException(`This ${scope} has reached its receipt storage limit. Contact the administrator.`);
      }
      const duplicate=await client.query(`SELECT 1 FROM booking_payment_receipts r JOIN booking_payments p ON p.id=r.payment_id
        WHERE r.organization_id=$1 AND r.customer_id=$2 AND ($3::uuid IS NULL OR r.booking_id=$3 OR r.booking_id IS NULL)
          AND r.original_sha256=ANY($4::text[]) AND p.status IN ('pending','approved') AND p.deleted_at IS NULL LIMIT 1`,
        [active.organization_id,customerId,bookingId,receipts.map(receipt=>receipt.originalSha256)]);
      if(duplicate.rows.length) throw new ConflictException(`A receipt is already attached to a pending or approved payment in this ${scope}. Check its existing status.`);
      const id=randomUUID();
      const inserted=await client.query<{submitted_at:Date}>(`INSERT INTO booking_payments(id,organization_id,customer_id,booking_id,amount_minor,payment_date,note,submitted_by,idempotency_key,request_hash,invoice_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING submitted_at`,[id,active.organization_id,customerId,bookingId,amount.toString(),data.payment_date,data.note,active.user_id,data.idempotency_key,fingerprint,invoice?.id??null]);
      for(const receipt of receipts) await client.query(`INSERT INTO booking_payment_receipts(id,organization_id,customer_id,booking_id,payment_id,name,size,content,original_sha256,mime_type)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[randomUUID(),active.organization_id,customerId,bookingId,id,receipt.name,receipt.content.length,receipt.content,receipt.originalSha256,receipt.mimeType]);
      await this.audit(client,active,'payment.submitted',id,{customer_id:customerId,booking_id:bookingId,invoice_id:invoice?.id??null,amount_minor:amount.toString(),receipt_count:receipts.length});
      const submittedAt=new Date(inserted.rows[0].submitted_at).toISOString();
      const link=booking?`${config.appUrl}/o/${active.organization_id}/users/${customerId}/bookings/${bookingId}`:
        `${config.appUrl}/o/${active.organization_id}/payment-reviews?q=${id}`;
      // Insert all administrator intents in one query, regardless of team size.
      await client.query(`INSERT INTO payment_email_outbox(organization_id,recipient,subject,body,dedupe_key)
        SELECT m.organization_id,u.email,$2,$3,$4||u.email FROM memberships m JOIN users u ON u.id=m.user_id
        WHERE m.organization_id=$1 AND m.role='admin' AND m.is_active AND m.deleted_at IS NULL
        ON CONFLICT (dedupe_key) DO NOTHING`,[active.organization_id,receipts.length?'Payment receipt submitted':'Payment submitted for review',
        `${customer.name} ${receipts.length?`uploaded ${receipts.length} payment receipt file(s)`:'submitted payment details without an attachment'}.\n\n${booking?`Booking: ${booking.reference}`:`Account: ${customer.name}`}\nAmount: GBP ${formatMoney(amount,2)}\nPayment date: ${data.payment_date}\nUploaded at: ${submittedAt}\n\nOpen ${booking?'the booking':'payment review'} to check the current review status. If still pending, verify the payment before approving:\n${link}`,`payment-submitted:${id}:`]);
      await queueCustomerPaymentEmail(client,{kind:'received',organizationId:active.organization_id,organizationName:active.organization_name!,
        customerId,customerName:customer.name,recipient:customer.email,bookingId,bookingReference:booking?.reference??null,
        paymentId:id,submittedBy:active.user_id,amountMinor:amount.toString(),currency:active.currency!,paymentDate:data.payment_date,receiptCount:receipts.length});
      return (await this.serialize(client,[await this.find(client,active.organization_id,customerId,bookingId,id)]))[0];
    });
  }

  async approve(member:Membership,customerId:string,bookingId:string|null,paymentId:string,raw:unknown={}) {
    parse(z.object({}).strict(),raw??{});
    return this.db.transaction(async client=>{
      const {active,customer,booking}=await this.context(client,member,customerId,bookingId,'review');
      const payment=await this.find(client,active.organization_id,customerId,bookingId,paymentId,true);
      if(payment.deleted_at) throw new ConflictException('Restore this payment before reviewing it.');
      if(payment.status==='approved') return (await this.serialize(client,[payment]))[0];
      if(payment.status!=='pending') throw new ConflictException('A rejected payment cannot be approved. Ask the customer to submit new evidence.');
      if(booking && bookingId) {
        await this.assertChargeActive(client,booking.charge_entry_id);
        await ensureBookingInvoice(client,{organizationId:active.organization_id,customerId,bookingId,actorId:active.user_id});
      }
      const entry=await client.query<{id:string}>(`INSERT INTO ledger_entries(organization_id,customer_id,kind,amount_minor,currency,effective_date,description,reference,created_by,idempotency_key,request_hash)
        VALUES($1,$2,'payment',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id::text AS id`,
        [active.organization_id,customerId,(-BigInt(payment.amount_minor)).toString(),payment.currency,payment.payment_date,
          booking?`Approved payment for booking ${booking.reference}`:'Approved account payment',booking?.reference??'',active.user_id,randomUUID(),digest(`booking-payment:${payment.id}`)]);
      await client.query(`UPDATE booking_payments SET version=version+1,status='approved',reviewed_by=$1,reviewed_at=now(),ledger_entry_id=$2 WHERE id=$3`,[active.user_id,entry.rows[0].id,payment.id]);
      await this.audit(client,active,'payment.approved',payment.id,{customer_id:customerId,booking_id:bookingId,entry_id:entry.rows[0].id});
      await this.audit(client,active,'ledger.posted',entry.rows[0].id,{customer_id:customerId,kind:'payment',booking_id:bookingId,payment_id:payment.id});
      await cancelUnsentPaymentReviewEmails(client,active.organization_id,[payment.id]);
      const invoice=bookingId?await issueBookingInvoice(client,{organizationId:active.organization_id,customerId,bookingId,actorId:active.user_id,
        reason:'payment_approved',eventKey:`payment-approved:${payment.id}`}):null;
      await queueCustomerPaymentEmail(client,{kind:'approved',organizationId:active.organization_id,organizationName:active.organization_name!,
        customerId,customerName:customer.name,recipient:customer.email,bookingId,bookingReference:booking?.reference??null,
        paymentId:payment.id,submittedBy:payment.submitted_by,amountMinor:payment.amount_minor,currency:payment.currency,paymentDate:payment.payment_date,invoiceId:invoice?.id});
      return (await this.serialize(client,[await this.find(client,active.organization_id,customerId,bookingId,payment.id)]))[0];
    });
  }

  async reject(member:Membership,customerId:string,bookingId:string|null,paymentId:string,raw:unknown) {
    const {reason}=parse(z.object({reason:z.string().trim().min(1).max(1000)}).strict(),raw);
    return this.db.transaction(async client=>{
      const {active,customer,booking}=await this.context(client,member,customerId,bookingId,'review');
      const payment=await this.find(client,active.organization_id,customerId,bookingId,paymentId,true);
      if(payment.deleted_at) throw new ConflictException('Restore this payment before reviewing it.');
      if(payment.status==='rejected' && payment.rejection_reason===reason) return (await this.serialize(client,[payment]))[0];
      if(payment.status!=='pending') throw new ConflictException('This payment has already been reviewed. Refresh the payment history.');
      await client.query(`UPDATE booking_payments SET version=version+1,status='rejected',reviewed_by=$1,reviewed_at=now(),rejection_reason=$2 WHERE id=$3`,[active.user_id,reason,payment.id]);
      await this.audit(client,active,'payment.rejected',payment.id,{customer_id:customerId,booking_id:bookingId,reason});
      await cancelUnsentPaymentReviewEmails(client,active.organization_id,[payment.id]);
      await queueCustomerPaymentEmail(client,{kind:'rejected',organizationId:active.organization_id,organizationName:active.organization_name!,
        customerId,customerName:customer.name,recipient:customer.email,bookingId,bookingReference:booking?.reference??null,
        paymentId:payment.id,submittedBy:payment.submitted_by,amountMinor:payment.amount_minor,currency:payment.currency,paymentDate:payment.payment_date,reason});
      return (await this.serialize(client,[await this.find(client,active.organization_id,customerId,bookingId,payment.id)]))[0];
    });
  }

  /** History management never edits posted money: every correction is a reversal and optional new payment. */
  async manage(member:Membership,customerId:string,bookingId:string|null,paymentId:string,operation:'edit'|'delete'|'restore'|'permanent-delete',raw:unknown) {
    const data=parse(operation==='edit'?historyEditSchema:operation==='permanent-delete'?
      historyOperationSchema.extend({confirmation:z.literal('DELETE')}).strict():historyOperationSchema.strict(),raw);
    const edit=operation==='edit'?parse(historyEditSchema,raw):null;
    const amount=edit?parseMoney(edit.amount,2).toString():null;
    if(edit && edit.payment_date>businessDate()) throw new BadRequestException('Payment date cannot be in the future.');
    return this.db.transaction(async client=>{
      const {active,customer,booking}=await this.context(client,member,customerId,bookingId,'history');
      uuid(paymentId,'payment');
      if(operation==='permanent-delete') {
        const prior=await client.query(`SELECT 1 FROM audit_events WHERE organization_id=$1 AND action='payment.permanently_deleted'
          AND object_id=$2 AND metadata->>'customer_id'=$3 AND metadata->>'booking_id' IS NOT DISTINCT FROM $4::text AND (metadata->>'version')::integer=$5`,
        [active.organization_id,paymentId,customerId,bookingId,data.version]);
        if(prior.rows.length) return {id:paymentId,deleted:true};
      }
      const payment=await this.find(client,active.organization_id,customerId,bookingId,paymentId,true);
      if(payment.version!==data.version) throw new ConflictException('This payment changed in another session. Refresh it before saving.');
      if((operation==='edit'||operation==='delete') && payment.deleted_at) throw new ConflictException('Restore this payment before editing or deleting it again.');
      if((operation==='restore'||operation==='permanent-delete') && !payment.deleted_at) throw new ConflictException('Move this payment to trash first.');
      const financialEdit=Boolean(edit && payment.status==='approved' && (amount!==payment.amount_minor || edit.payment_date!==payment.payment_date));
      if(financialEdit && payment.reversed) throw new ConflictException('This payment was already reversed. Record a new payment instead of changing its amount or date.');
      if(financialEdit || (operation==='restore' && payment.status==='approved' && payment.restore_credit)) {
        if(booking?.deleted_at || customer.status!=='active') throw new ConflictException('Restore the customer and any linked booking before restoring or replacing a payment.');
        if(booking) await this.assertChargeActive(client,booking.charge_entry_id);
      }
      const financesChanged=payment.status==='approved' && (financialEdit||(operation==='restore'&&payment.restore_credit)||(operation==='delete'&&!payment.reversed));
      if(financesChanged && bookingId) await ensureBookingInvoice(client,{organizationId:active.organization_id,customerId,bookingId,actorId:active.user_id});
      if(payment.status==='approved' && !payment.reversed && (financialEdit||operation==='delete')) {
        const reversal=await client.query<{id:string}>(`INSERT INTO ledger_entries(organization_id,customer_id,kind,amount_minor,currency,effective_date,
          description,reference,created_by,reversal_of,idempotency_key,request_hash)
          VALUES($1,$2,'reversal',$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id::text AS id`,
        [active.organization_id,customerId,payment.amount_minor,payment.currency,payment.payment_date>businessDate()?payment.payment_date:businessDate(),
          `Payment ${operation}: ${data.reason}`.slice(0,1000),booking?.reference??'',active.user_id,payment.ledger_entry_id,randomUUID(),digest(`history:${payment.id}:${payment.version}:${operation}:reverse`)]);
        await this.audit(client,active,'ledger.reversed',reversal.rows[0].id,{customer_id:customerId,booking_id:bookingId,payment_id:payment.id,
          reversal_of:payment.ledger_entry_id,reason:data.reason});
      }
      let entryId=payment.ledger_entry_id;
      if(payment.status==='approved' && (financialEdit||(operation==='restore'&&payment.restore_credit))) {
        const entry=await client.query<{id:string}>(`INSERT INTO ledger_entries(organization_id,customer_id,kind,amount_minor,currency,effective_date,
          description,reference,created_by,idempotency_key,request_hash)
          VALUES($1,$2,'payment',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id::text AS id`,
        [active.organization_id,customerId,(-BigInt(amount??payment.amount_minor)).toString(),payment.currency,edit?.payment_date??payment.payment_date,
          `Payment ${operation}: ${data.reason}`.slice(0,1000),booking?.reference??'',active.user_id,randomUUID(),digest(`history:${payment.id}:${payment.version}:${operation}:post`)]);
        entryId=entry.rows[0].id;
        await this.audit(client,active,'ledger.posted',entryId,{customer_id:customerId,booking_id:bookingId,payment_id:payment.id,kind:'payment',reason:data.reason});
      }
      await client.query('SELECT manage_booking_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [active.user_id,active.organization_id,customerId,bookingId,paymentId,data.version,operation,amount??payment.amount_minor,
          edit?.payment_date??payment.payment_date,edit?.note??payment.note,entryId,data.reason]);
      // Cancel uncompleted notices without changing sent messages or queuing new mail.
      await client.query(`UPDATE payment_email_outbox SET state='cancelled',delivery_status='cancelled',delivery_updated_at=now(),
        lease_token=NULL,lease_until=NULL,last_error='Payment history changed before notification delivery.'
        WHERE organization_id=$1 AND split_part(dedupe_key,':',2)=$2 AND state IN ('pending','processing')`,[active.organization_id,paymentId]);
      if(financesChanged && bookingId) await issueBookingInvoice(client,{organizationId:active.organization_id,customerId,bookingId,actorId:active.user_id,
        reason:operation==='delete'?'payment_reversed':'payment_approved',eventKey:`payment-${operation}:${payment.id}:v${payment.version+1}`});
      if(operation==='permanent-delete') return {id:paymentId,deleted:true};
      return (await this.serialize(client,[await this.find(client,active.organization_id,customerId,bookingId,payment.id)]))[0];
    });
  }

  async receipt(member:Membership,customerId:string,bookingId:string|null,paymentId:string,receiptId:string) {
    uuid(receiptId,'receipt');
    return this.db.transaction(async client=>{
      const {active}=await this.context(client,member,customerId,bookingId);
      const payment=await this.find(client,active.organization_id,customerId,bookingId,paymentId);
      if(payment.deleted_at && active.role!=='admin') throw new NotFoundException('Receipt was not found in this payment submission.');
      const result=await client.query<{name:string;mime_type:string;size:number;content:Buffer|Uint8Array}>(`SELECT name,mime_type,size,content FROM booking_payment_receipts
        WHERE organization_id=$1 AND customer_id=$2 AND booking_id IS NOT DISTINCT FROM $3::uuid AND payment_id=$4 AND id=$5`,[active.organization_id,customerId,bookingId,paymentId,receiptId]);
      if(!result.rows[0]) throw new NotFoundException('Receipt was not found in this payment submission.');
      return {...result.rows[0],content:Buffer.from(result.rows[0].content)};
    });
  }
}
