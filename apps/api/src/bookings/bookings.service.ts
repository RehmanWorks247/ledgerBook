import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import { AccessService, type Membership } from '../access/access.service';
import { DatabaseService } from '../database/database.service';
import { parseMoney, UUID_PATTERN, validDate } from '../ledger/money';
import { config } from '../config';
import { DocumentStorage, type StoredDocument } from './document-storage';
import { documentExtension, documentMimeType } from './document-files';
import { issueBookingInvoice } from '../invoices/invoices.service';
import { queueBookingCreatedEmail } from '../payments/payment-emails';
import { validateInstalmentTotal } from './instalment-total';

export const SERVICE_KEYS = ['flight','makkah','madinah','transfers','visas','extras'] as const;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const nameSchema = z.string().trim().min(1).max(240).refine(value => value !== '.' && value !== '..' && !/[/\\]/.test(value)
  && !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127), 'Enter a name without a slash or control character.');
const dateSchema = z.string().refine(validDate, 'Use a valid date in YYYY-MM-DD format.');
const bookingSchema = z.object({
  reference:z.string().trim().min(1).max(160),
  departure_at:z.iso.datetime({ offset:true }),
  required_services:z.array(z.enum(SERVICE_KEYS)).max(6).default([]),
  amount:z.string(), effective_date:dateSchema,
  instalments:z.array(z.object({due_date:dateSchema,amount:z.string()}).strict()).max(100).default([]),
  idempotency_key:z.uuid(),
}).strict();
const folderSchema = z.object({parent_id:z.uuid().nullable(),name:nameSchema,idempotency_key:z.uuid()}).strict();
const moveSchema = z.object({parent_id:z.uuid().nullable()}).strict();
const renameSchema = z.object({name:nameSchema}).strict();
const uploadSchema = z.object({name:nameSchema,size:z.number().int().min(1).max(MAX_DOCUMENT_BYTES),
  sha256:z.string().regex(/^[0-9a-f]{64}$/),idempotency_key:z.uuid()}).strict();
const issueSchema = z.object({issued:z.boolean()}).strict();
function parse<T>(schema:z.ZodType<T>, value:unknown):T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`));
  return parsed.data;
}
function hash(value:unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function uuid(value:string, label:string) {
  if (!UUID_PATTERN.test(value ?? '')) throw new BadRequestException(`Select a valid ${label}.`);
}
type Node = QueryResultRow & {
  id:string; organization_id:string; customer_id:string; booking_id:string; parent_id:string|null;
  name:string; kind:'file'|'folder'; size:number; updated_at:Date|string; service_key:string|null;
  default_folder:boolean; issued_at:Date|null; request_hash:string; content?:Buffer; mime_type:string; content_version:number;
};
const nodeColumns = 'id,organization_id,customer_id,booking_id,parent_id,name,kind,size,updated_at,service_key,default_folder,issued_at,request_hash,mime_type,content_version';
const bookingColumns = 'b.*,b.total_minor::text AS total_minor,(SELECT e.effective_date::text FROM ledger_entries e WHERE e.id=b.charge_entry_id) AS effective_date,(SELECT c.customer_code FROM customers c WHERE c.id=b.customer_id AND c.organization_id=b.organization_id) AS customer_code';

@Injectable()
export class BookingsService {
  constructor(@Inject(DatabaseService) private readonly db:DatabaseService,
    @Inject(AccessService) private readonly access:AccessService,
    @Optional() @Inject(DocumentStorage) private readonly storage:DocumentStorage = new DocumentStorage()) {}

  private serialize(node:Node) {
    const base = `/api/organizations/${node.organization_id}/customers/${node.customer_id}/bookings/${node.booking_id}/documents/${node.id}`;
    return {id:node.id,parentId:node.parent_id,name:node.name,kind:node.kind,size:node.size,
      modifiedAt:new Date(node.updated_at).getTime(),serviceKey:node.service_key,
      defaultFolder:node.default_folder,issuedAt:node.issued_at,
      ...(node.kind === 'file' ? {version:node.content_version,mimeType:node.mime_type,url:base,openUrl:base,downloadUrl:`${base}?download=1`} : {})};
  }
  private async context(client:PoolClient, member:Membership, customerId:string, bookingId:string, write=false) {
    uuid(bookingId,'booking');
    const active = await this.access.membership(member.user_id,member.organization_id,write,client);
    const customer = await this.access.customer(active,customerId,client,write);
    const result = await client.query(`SELECT ${bookingColumns} FROM bookings b
      WHERE b.organization_id=$1 AND b.customer_id=$2 AND b.id=$3 AND b.deleted_at IS NULL ${write ? 'FOR UPDATE' : ''}`,
      [active.organization_id,customerId,bookingId]);
    if (!result.rows[0]) throw new NotFoundException('Booking was not found for this customer.');
    if (write && customer.status !== 'active') throw new ConflictException('Restore this customer before managing booking documents.');
    return {active,booking:result.rows[0]};
  }
  private async node(client:PoolClient, orgId:string, customerId:string, bookingId:string, id:string) {
    uuid(id,'document or folder');
    const result = await client.query<Node>(`SELECT ${nodeColumns} FROM booking_nodes
      WHERE organization_id=$1 AND customer_id=$2 AND booking_id=$3 AND id=$4`,[orgId,customerId,bookingId,id]);
    if (!result.rows[0]) throw new NotFoundException('Document or folder was not found in this booking.');
    return result.rows[0];
  }
  private async destination(client:PoolClient, orgId:string, customerId:string, bookingId:string, id:string|null) {
    if (id === null) return null;
    const node = await this.node(client,orgId,customerId,bookingId,id);
    if (node.kind !== 'folder') throw new BadRequestException('Choose a folder in this booking.');
    return node;
  }
  private async audit(client:PoolClient, member:Membership, action:string, objectId:string, metadata:unknown) {
    await client.query(`INSERT INTO audit_events(organization_id,actor_id,action,object_id,metadata)
      VALUES($1,$2,$3,$4,$5::jsonb)`,[member.organization_id,member.user_id,action,objectId,JSON.stringify(metadata)]);
  }

  async list(member:Membership, customerId:string, includeCancelled=false) {
    return this.db.transaction(async client => {
      const active = await this.access.membership(member.user_id,member.organization_id,false,client);
      await this.access.customer(active,customerId,client);
      const result = await client.query(`SELECT ${bookingColumns} FROM bookings b
        WHERE b.organization_id=$1 AND b.customer_id=$2 AND ($3::boolean OR b.deleted_at IS NULL) ORDER BY b.departure_at DESC,b.id`,[active.organization_id,customerId,includeCancelled]);
      return {time_zone:config.businessTimeZone,items:result.rows.map(({request_hash:_hash,idempotency_key:_key,...booking}) => ({...booking,currency_exponent:2}))};
    });
  }
  async get(member:Membership, customerId:string, bookingId:string) {
    return this.db.transaction(async client => {
      const {booking} = await this.context(client,member,customerId,bookingId);
      const instalments = await client.query(`SELECT id,due_date::text AS due_date,amount_minor::text AS amount_minor
        FROM booking_instalments WHERE organization_id=$1 AND customer_id=$2 AND booking_id=$3 ORDER BY due_date,id`,[member.organization_id,customerId,bookingId]);
      const {request_hash:_hash,idempotency_key:_key,...visible} = booking;
      return {...visible,currency_exponent:2,time_zone:config.businessTimeZone,instalments:instalments.rows};
    });
  }
  async create(member:Membership, customerId:string, raw:unknown) {
    const data = parse(bookingSchema,raw);
    const amount = parseMoney(data.amount,2);
    const instalments = (data.instalments.length ? data.instalments : [{due_date:data.effective_date,amount:data.amount}])
      .map(item => ({due_date:item.due_date,amount_minor:parseMoney(item.amount,2).toString()}));
    validateInstalmentTotal(amount,instalments);
    const required = [...new Set(data.required_services)].sort();
    const fingerprint = hash({...data,required_services:required,amount:amount.toString(),instalments,customerId,userId:member.user_id});
    const bookingId = await this.db.transaction(async client => {
      const active = await this.access.membership(member.user_id,member.organization_id,true,client);
      const customer = await this.access.customer(active,customerId,client,true);
      if (active.currency !== 'GBP' || active.currency_exponent !== 2) {
        throw new ConflictException('Booking charges require a GBP accounting workspace. Existing transactions cannot be relabelled as GBP.');
      }
      const previous = await client.query('SELECT id,request_hash,deleted_at FROM bookings WHERE organization_id=$1 AND idempotency_key=$2',[active.organization_id,data.idempotency_key]);
      if (previous.rows[0]) {
        if (previous.rows[0].deleted_at) throw new ConflictException('This booking was cancelled. Use a new submission key to create another booking.');
        if (previous.rows[0].request_hash !== fingerprint) throw new ConflictException('This submission key was used for a different booking.');
        await client.query('SELECT ensure_booking_folders($1)',[previous.rows[0].id]);
        return previous.rows[0].id as string;
      }
      if (customer.status !== 'active') throw new ConflictException('Restore this customer before adding a booking.');
      const id = randomUUID();
      const charge = await client.query(`INSERT INTO ledger_entries(organization_id,customer_id,kind,amount_minor,currency,effective_date,description,reference,created_by,idempotency_key,request_hash)
        VALUES($1,$2,'charge',$3,'GBP',$4,$5,$6,$7,$8,$9) RETURNING id::text AS id`,
        [active.organization_id,customerId,amount.toString(),data.effective_date,`Booking ${data.reference}`,data.reference,active.user_id,randomUUID(),fingerprint]);
      await client.query(`INSERT INTO bookings(id,organization_id,customer_id,reference,departure_at,required_services,total_minor,charge_entry_id,created_by,idempotency_key,request_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,active.organization_id,customerId,data.reference,data.departure_at,required,amount.toString(),charge.rows[0].id,active.user_id,data.idempotency_key,fingerprint]);
      for (const item of instalments) await client.query(`INSERT INTO booking_instalments(id,organization_id,customer_id,booking_id,due_date,amount_minor)
        VALUES($1,$2,$3,$4,$5,$6)`,[randomUUID(),active.organization_id,customerId,id,item.due_date,item.amount_minor]);
      await client.query('SELECT ensure_booking_folders($1)',[id]);
      await this.audit(client,active,'booking.created',id,{customer_id:customerId,booking_id:id,reference:data.reference,entry_id:charge.rows[0].id});
      await this.audit(client,active,'ledger.posted',charge.rows[0].id,{customer_id:customerId,kind:'charge',booking_id:id});
      const invoice=await issueBookingInvoice(client,{organizationId:active.organization_id,customerId,bookingId:id,
        actorId:active.user_id,reason:'booking_created',eventKey:`booking-created:${id}`});
      await queueBookingCreatedEmail(client,{organizationId:active.organization_id,organizationName:active.organization_name!,
        customerId,customerName:customer.name,recipient:customer.email,bookingId:id,bookingReference:data.reference,invoiceId:invoice.id});
      return id;
    });
    return this.get(member,customerId,bookingId);
  }

  async files(member:Membership, customerId:string, bookingId:string) {
    return this.db.transaction(async client => {
      const {active} = await this.context(client,member,customerId,bookingId);
      let result = await client.query<Node>(`SELECT ${nodeColumns} FROM booking_nodes
        WHERE organization_id=$1 AND customer_id=$2 AND booking_id=$3 ORDER BY created_at,id`,[active.organization_id,customerId,bookingId]);
      // Ordinary listings are read-only; repair legacy/incomplete bookings only when needed.
      if(result.rows.filter(node=>node.default_folder).length!==SERVICE_KEYS.length) {
        // Repair writes nodes and their report revision. Match all document
        // writers' customer-before-booking order, including legacy read repair.
        await this.access.customer(active,customerId,client,true);
        await client.query('SELECT id FROM bookings WHERE id=$1 FOR UPDATE',[bookingId]);
        await client.query('SELECT ensure_booking_folders($1)',[bookingId]);
        result=await client.query<Node>(`SELECT ${nodeColumns} FROM booking_nodes
          WHERE organization_id=$1 AND customer_id=$2 AND booking_id=$3 ORDER BY created_at,id`,[active.organization_id,customerId,bookingId]);
      }
      return {items:result.rows.map(node => this.serialize(node))};
    });
  }

  async createFolder(member:Membership, customerId:string, bookingId:string, raw:unknown) {
    const data = parse(folderSchema,raw);
    return this.db.transaction(async client => {
      const {active} = await this.context(client,member,customerId,bookingId,true);
      const parent = await this.destination(client,active.organization_id,customerId,bookingId,data.parent_id);
      const fingerprint = hash({bookingId,customerId,...data});
      const prior = await client.query<Node>(`SELECT ${nodeColumns} FROM booking_nodes WHERE organization_id=$1 AND idempotency_key=$2`,[active.organization_id,data.idempotency_key]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== fingerprint) throw new ConflictException('This submission key was used for another folder.');
        if (prior.rows[0].parent_id !== data.parent_id) throw new ConflictException('This folder has moved. Refresh the booking before creating another folder.');
        return this.serialize(prior.rows[0]);
      }
      const result = await client.query<Node>(`INSERT INTO booking_nodes(id,organization_id,customer_id,booking_id,parent_id,kind,name,service_key,created_by,idempotency_key,request_hash)
        VALUES($1,$2,$3,$4,$5,'folder',$6,$7,$8,$9,$10) RETURNING ${nodeColumns}`,
        [randomUUID(),active.organization_id,customerId,bookingId,data.parent_id,data.name,parent?.service_key ?? null,active.user_id,data.idempotency_key,fingerprint]);
      return this.serialize(result.rows[0]);
    });
  }

  async authorizeUpload(member:Membership, customerId:string, bookingId:string, folderId:string) {
    return this.db.transaction(async client=>{
      const {active}=await this.context(client,member,customerId,bookingId,true);
      const folder=await this.destination(client,active.organization_id,customerId,bookingId,folderId);
      if(!folder?.service_key) throw new BadRequestException('Select the destination service folder for this booking before uploading.');
    });
  }

  async upload(member:Membership, customerId:string, bookingId:string, folderId:string, name:unknown, key:unknown, content:unknown) {
    return this.persistUpload(member,customerId,bookingId,folderId,name,key,content);
  }

  async beginUpload(member:Membership, customerId:string, bookingId:string, folderId:string, raw:unknown) {
    const data=parse(uploadSchema,raw);
    const fingerprint=hash({customerId,bookingId,folderId,filename:data.name,checksum:data.sha256});
    const prepared=await this.db.transaction(async client=>{
      const {active}=await this.context(client,member,customerId,bookingId,true);
      const folder=await this.destination(client,active.organization_id,customerId,bookingId,folderId);
      if(!folder?.service_key) throw new BadRequestException('Select the destination service folder for this booking before uploading.');
      const prior=await client.query<Node>(`SELECT ${nodeColumns} FROM booking_nodes WHERE organization_id=$1 AND idempotency_key=$2`,[active.organization_id,data.idempotency_key]);
      if(prior.rows[0]) {
        if(prior.rows[0].request_hash!==fingerprint || prior.rows[0].size!==data.size) throw new ConflictException('This submission key was used for a different upload.');
        if(prior.rows[0].parent_id!==folderId) throw new ConflictException('This document has moved. Refresh the booking before uploading another copy.');
        return {document:this.serialize(prior.rows[0])};
      }
      if(!this.storage.direct) return {};
      const existing=await client.query<StoredDocument & {request_hash:string;expires_at:Date;created_by:string;state:string}>(`SELECT o.id,o.bucket,o.object_key,o.checksum,o.size,o.state,u.request_hash,u.expires_at,u.created_by
        FROM document_uploads u JOIN document_objects o ON o.id=u.id WHERE u.organization_id=$1 AND u.idempotency_key=$2`,[active.organization_id,data.idempotency_key]);
      const attempt=existing.rows[0];
      if(attempt) {
        if(attempt.request_hash!==fingerprint || attempt.size!==data.size || attempt.created_by!==active.user_id) throw new ConflictException('This submission key was used for a different upload.');
        if(attempt.state==='pending' && new Date(attempt.expires_at).getTime()>Date.now()+5000) return {object:attempt,expiresAt:new Date(attempt.expires_at)};
        await client.query('DELETE FROM document_uploads WHERE id=$1',[attempt.id]);
      }
      const id=randomUUID(),expiresAt=new Date(Date.now()+10*60*1000);
      const object:StoredDocument={id,bucket:this.storage.options.bucket!,object_key:`documents/${active.organization_id}/${customerId}/${bookingId}/${id}`,checksum:data.sha256,size:data.size};
      await client.query(`INSERT INTO document_objects(id,organization_id,customer_id,booking_id,bucket,object_key,checksum,size)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,active.organization_id,customerId,bookingId,object.bucket,object.object_key,object.checksum,object.size]);
      await client.query(`INSERT INTO document_uploads(id,organization_id,customer_id,booking_id,folder_id,created_by,filename,idempotency_key,request_hash,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,active.organization_id,customerId,bookingId,folderId,active.user_id,data.name,data.idempotency_key,fingerprint,expiresAt]);
      return {object,expiresAt};
    });
    if(prepared.document) return {transport:'complete' as const,document:prepared.document};
    if(!prepared.object || !prepared.expiresAt) return {transport:'proxy' as const};
    const signed=await this.storage.signUpload(prepared.object,documentMimeType(data.name),Math.max(1,Math.floor((prepared.expiresAt.getTime()-Date.now())/1000)));
    return {transport:'direct' as const,uploadId:prepared.object.id,...signed,expiresAt:prepared.expiresAt.toISOString()};
  }

  async completeUpload(member:Membership, customerId:string, bookingId:string, folderId:string, uploadId:string) {
    uuid(uploadId,'upload');
    const prepared=await this.db.transaction(async client=>{
      const {active}=await this.context(client,member,customerId,bookingId,true);
      const rows=await client.query<StoredDocument & {filename:string;idempotency_key:string;request_hash:string;expires_at:Date;state:string}>(`SELECT o.id,o.bucket,o.object_key,o.checksum,o.size,o.state,u.filename,u.idempotency_key,u.request_hash,u.expires_at
        FROM document_uploads u JOIN document_objects o ON o.id=u.id WHERE u.id=$1 AND u.organization_id=$2 AND u.customer_id=$3 AND u.booking_id=$4 AND u.folder_id=$5 AND u.created_by=$6`,
      [uploadId,active.organization_id,customerId,bookingId,folderId,active.user_id]);
      const upload=rows.rows[0];
      if(!upload) throw new NotFoundException('This upload was not found. Select the file and retry.');
      const prior=await client.query<Node>(`SELECT ${nodeColumns} FROM booking_nodes WHERE organization_id=$1 AND idempotency_key=$2`,[active.organization_id,upload.idempotency_key]);
      if(prior.rows[0]) {
        if(prior.rows[0].request_hash!==upload.request_hash || prior.rows[0].parent_id!==folderId) throw new ConflictException('This document changed. Refresh the booking before retrying.');
        return {document:this.serialize(prior.rows[0])};
      }
      if(upload.state!=='pending' || new Date(upload.expires_at).getTime()<=Date.now()) throw new ConflictException('This upload expired. Select the file and retry.');
      const folder=await this.destination(client,active.organization_id,customerId,bookingId,folderId);
      if(!folder?.service_key) throw new BadRequestException('Select the destination service folder for this booking before uploading.');
      return {upload};
    });
    if(prepared.document) return prepared.document;
    const upload=prepared.upload!;
    try {
      const bytes=await this.storage.get(upload,true);
      // persistUpload rechecks live membership and the destination after the
      // provider call. The signed create-only PUT prevents validation/overwrite races.
      return await this.persistUpload(member,customerId,bookingId,folderId,upload.filename,upload.idempotency_key,bytes,upload);
    } catch(error) {
      if(error instanceof BadRequestException) await this.db.query('DELETE FROM document_uploads WHERE id=$1',[upload.id]);
      throw error;
    }
  }

  private async persistUpload(member:Membership, customerId:string, bookingId:string, folderId:string, name:unknown, key:unknown, content:unknown,verifiedObject?:StoredDocument) {
    const filename = parse(nameSchema,name);
    const idempotencyKey = parse(z.uuid(),key);
    if (!Buffer.isBuffer(content) || content.length === 0 || content.length > MAX_DOCUMENT_BYTES) {
      throw new BadRequestException('Choose a non-empty file of at most 10 MB.');
    }
    const mimeType = documentMimeType(filename);
    if (mimeType === 'application/pdf' && (content.length < 12 ||
      !content.subarray(0,8).toString('ascii').startsWith('%PDF-') || !content.subarray(-1024).includes(Buffer.from('%%EOF')))) {
      throw new BadRequestException('Choose a valid PDF of at most 10 MB.');
    }
    const checksum = createHash('sha256').update(content).digest('hex');
    const fingerprint = hash({customerId,bookingId,folderId,filename,checksum});
    const prepare=async (client:PoolClient)=>{
      const {active} = await this.context(client,member,customerId,bookingId,true);
      const folder = await this.destination(client,active.organization_id,customerId,bookingId,folderId);
      if (!folder?.service_key) throw new BadRequestException('Select the destination service folder for this booking before uploading.');
      const prior = await client.query<Node>(`SELECT ${nodeColumns} FROM booking_nodes WHERE organization_id=$1 AND idempotency_key=$2`,[active.organization_id,idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== fingerprint) throw new ConflictException('This submission key was used for a different upload.');
        if (prior.rows[0].parent_id !== folderId) throw new ConflictException('This document has moved. Refresh the booking before uploading another copy.');
        return {active,folder,prior:prior.rows[0]};
      }
      return {active,folder,prior:undefined};
    };
    const persist=async (client:PoolClient,object?:StoredDocument)=>{
      const {active,folder,prior}=await prepare(client);
      if(prior) return this.serialize(prior);
      if(object) {
        const ready=await client.query("UPDATE document_objects SET state='ready' WHERE id=$1 AND state='pending' RETURNING id",[object.id]);
        if(!ready.rows[0]) throw new ConflictException('This upload expired. Retry the file.');
      }
      const siblings = await client.query<{name:string}>('SELECT name FROM booking_nodes WHERE booking_id=$1 AND parent_id=$2',[bookingId,folderId]);
      const taken = new Set(siblings.rows.map(row => row.name.toLowerCase()));
      const candidateExtension = documentExtension(filename);
      const extension = candidateExtension.length <= 32 ? candidateExtension : '';
      const stem = filename.slice(0,filename.length-extension.length);
      let uniqueName = filename;
      for (let copy=2;taken.has(uniqueName.toLowerCase());copy++) {
        const suffix = ` (${copy})`;
        uniqueName = `${stem.slice(0,240-extension.length-suffix.length)}${suffix}${extension}`;
      }
      const result = await client.query<Node>(`INSERT INTO booking_nodes(id,organization_id,customer_id,booking_id,parent_id,kind,name,service_key,content,size,created_by,idempotency_key,request_hash,storage_object_id,mime_type)
        VALUES($1,$2,$3,$4,$5,'file',$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${nodeColumns}`,
        [randomUUID(),active.organization_id,customerId,bookingId,folderId,uniqueName,folder.service_key,object ? null : content,content.length,active.user_id,idempotencyKey,fingerprint,object?.id ?? null,mimeType]);
      await this.audit(client,active,'document.uploaded',result.rows[0].id,{customer_id:customerId,booking_id:bookingId,service_key:folder.service_key,name:uniqueName});
      return this.serialize(result.rows[0]);
    };
    if(verifiedObject) return this.db.transaction(client=>persist(client,verifiedObject));
    if(!this.storage.cloud) return this.db.transaction(client=>persist(client));
    const prepared=await this.db.transaction(async client=>{
      const {active,prior}=await prepare(client);
      if(prior) return {node:this.serialize(prior),object:undefined};
      const id=randomUUID();
      const object:StoredDocument={id,bucket:this.storage.options.bucket!,
        object_key:`documents/${active.organization_id}/${customerId}/${bookingId}/${id}`,checksum,size:content.length};
      await client.query(`INSERT INTO document_objects(id,organization_id,customer_id,booking_id,bucket,object_key,checksum,size)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,active.organization_id,customerId,bookingId,object.bucket,object.object_key,checksum,content.length]);
      return {node:undefined,object};
    });
    if(prepared.node) return prepared.node;
    // Never hold a database connection/booking lock during a provider call. The
    // journal remains recoverable if upload, final commit, or process fails.
    await this.storage.put(prepared.object,content,mimeType);
    return this.db.transaction(client=>persist(client,prepared.object));
  }

  async move(member:Membership, customerId:string, bookingId:string, nodeId:string, raw:unknown) {
    if(typeof raw==='object' && raw!==null && 'name' in raw) return this.rename(member,customerId,bookingId,nodeId,raw);
    const data = parse(moveSchema,raw);
    return this.db.transaction(async client => {
      const {active} = await this.context(client,member,customerId,bookingId,true);
      const node = await this.node(client,active.organization_id,customerId,bookingId,nodeId);
      if (node.parent_id === data.parent_id) return this.serialize(node);
      if (node.default_folder) throw new BadRequestException('Default service folders must remain at the booking root.');
      const destination = await this.destination(client,active.organization_id,customerId,bookingId,data.parent_id);
      const descendants = await client.query<{id:string;kind:string}>(`WITH RECURSIVE tree AS (
        SELECT id,kind FROM booking_nodes WHERE id=$1 AND booking_id=$2
        UNION ALL SELECT n.id,n.kind FROM booking_nodes n JOIN tree t ON n.parent_id=t.id WHERE n.booking_id=$2
      ) SELECT id,kind FROM tree`,[nodeId,bookingId]);
      if (descendants.rows.some(item => item.id === data.parent_id)) throw new BadRequestException('A folder cannot be moved into itself or its subfolders.');
      if (!destination?.service_key && descendants.rows.some(item => item.kind === 'file')) throw new BadRequestException('Documents must remain inside a service folder.');
      await client.query('UPDATE booking_nodes SET service_key=$1,updated_at=now() WHERE id=ANY($2::uuid[])',[destination?.service_key ?? null,descendants.rows.map(item => item.id)]);
      const result = await client.query<Node>(`UPDATE booking_nodes SET parent_id=$1,updated_at=now() WHERE id=$2 RETURNING ${nodeColumns}`,[data.parent_id,nodeId]);
      return this.serialize(result.rows[0]);
    });
  }

  private async rename(member:Membership, customerId:string, bookingId:string, nodeId:string, raw:unknown) {
    const {name}=parse(renameSchema,raw);
    return this.db.transaction(async client=>{
      const {active}=await this.context(client,member,customerId,bookingId,true);
      const node=await this.node(client,active.organization_id,customerId,bookingId,nodeId);
      if(node.default_folder) throw new BadRequestException('Default service folders cannot be renamed.');
      if(node.kind==='file' && documentExtension(node.name).toLowerCase()!==documentExtension(name).toLowerCase()) {
        throw new BadRequestException('Keep the original file extension when renaming this document.');
      }
      if(node.name===name) return this.serialize(node);
      const duplicate=await client.query('SELECT id FROM booking_nodes WHERE booking_id=$1 AND parent_id IS NOT DISTINCT FROM $2::uuid AND lower(name)=lower($3) AND id<>$4',[bookingId,node.parent_id,name,node.id]);
      if(duplicate.rows[0]) throw new ConflictException('A file or folder with that name already exists here.');
      const result=await client.query<Node>(`UPDATE booking_nodes SET name=$1,updated_at=now() WHERE id=$2 RETURNING ${nodeColumns}`,[name,node.id]);
      await this.audit(client,active,'document.renamed',node.id,{customer_id:customerId,booking_id:bookingId,previous_name:node.name,name});
      return this.serialize(result.rows[0]);
    });
  }

  async remove(member:Membership, customerId:string, bookingId:string, nodeId:string) {
    return this.db.transaction(async client=>{
      const {active}=await this.context(client,member,customerId,bookingId,true);
      const node=await this.node(client,active.organization_id,customerId,bookingId,nodeId);
      if(node.default_folder) throw new BadRequestException('Default service folders cannot be deleted.');
      const children=await client.query('SELECT id FROM booking_nodes WHERE booking_id=$1 AND parent_id=$2 LIMIT 1',[bookingId,nodeId]);
      if(children.rows[0]) throw new ConflictException('This folder is not empty. Move or delete its contents first.');
      const objects=await client.query<StoredDocument>(`SELECT o.id,o.bucket,o.object_key,o.checksum,o.size FROM document_objects o JOIN booking_nodes n ON n.storage_object_id=o.id WHERE n.id=$1`,[node.id]);
      // Retain only private object coordinates until cloud deletion succeeds.
      for(const object of objects.rows) await client.query(`INSERT INTO document_purge_outbox(id,bucket,object_key,checksum,size) VALUES($1,$2,$3,$4,$5)`,[object.id,object.bucket,object.object_key,object.checksum,object.size]);
      await client.query('DELETE FROM booking_nodes WHERE id=$1',[node.id]);
      for(const object of objects.rows) await client.query('DELETE FROM document_objects WHERE id=$1',[object.id]);
      await this.audit(client,active,'document.deleted',node.id,{customer_id:customerId,booking_id:bookingId,name:node.name,kind:node.kind});
      return {deleted:true};
    });
  }

  async issuance(member:Membership, customerId:string, bookingId:string, service:string, raw:unknown) {
    const serviceKey = parse(z.enum(SERVICE_KEYS),service);
    const data = parse(issueSchema,raw);
    return this.db.transaction(async client => {
      const {active} = await this.context(client,member,customerId,bookingId,true);
      await client.query('SELECT ensure_booking_folders($1)',[bookingId]);
      const result = await client.query<Node>(`UPDATE booking_nodes SET issued_at=CASE WHEN $1 THEN coalesce(issued_at,now()) ELSE NULL END,updated_at=now()
        WHERE booking_id=$2 AND default_folder AND service_key=$3 RETURNING ${nodeColumns}`,[data.issued,bookingId,serviceKey]);
      await this.audit(client,active,'service.issuance_updated',bookingId,{customer_id:customerId,booking_id:bookingId,service_key:serviceKey,issued:data.issued});
      return this.serialize(result.rows[0]);
    });
  }

  async document(member:Membership, customerId:string, bookingId:string, documentId:string) {
    const result=await this.db.transaction(async client => {
      const {active} = await this.context(client,member,customerId,bookingId);
      const node = await this.node(client,active.organization_id,customerId,bookingId,documentId);
      if (node.kind !== 'file') throw new NotFoundException('File was not found in this booking.');
      const bytes = await client.query<{content:Buffer|null;storage_object_id:string|null}>('SELECT content,storage_object_id FROM booking_nodes WHERE id=$1',[documentId]);
      if(bytes.rows[0].content!==null) return {name:node.name,mimeType:node.mime_type,content:Buffer.from(bytes.rows[0].content),object:undefined};
      const stored=await client.query<StoredDocument>("SELECT id,bucket,object_key,checksum,size FROM document_objects WHERE id=$1 AND state='ready'",[bytes.rows[0].storage_object_id]);
      if(!stored.rows[0]) throw new NotFoundException('Document storage was not found.');
      return {name:node.name,mimeType:node.mime_type,content:undefined,object:stored.rows[0]};
    });
    return {name:result.name,mimeType:result.mimeType,content:result.content ?? await this.storage.get(result.object!)};
  }
}
