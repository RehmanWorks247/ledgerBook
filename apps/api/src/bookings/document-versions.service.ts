import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import { AccessService, type Membership } from '../access/access.service';
import { DatabaseService } from '../database/database.service';
import { DocumentStorage, type StoredDocument } from './document-storage';
import { documentExtension, documentMimeType } from './document-files';
import { MAX_DOCUMENT_BYTES } from './bookings.service';

export const MAX_EDIT_TEXT_BYTES = 256 * 1024;
const replacementSchema = z.object({name:z.string().trim().min(1).max(240).refine(value => !/[/\\]/.test(value) && !Array.from(value).some(char=>char.charCodeAt(0)<32 || char.charCodeAt(0)===127) && !['.','..'].includes(value)),
  size:z.number().int().min(1).max(MAX_DOCUMENT_BYTES),sha256:z.string().regex(/^[0-9a-f]{64}$/),
  idempotency_key:z.uuid(),expected_version:z.number().int().positive()}).strict();
const restoreSchema = z.object({expected_version:z.number().int().positive()}).strict();
type Replacement = z.infer<typeof replacementSchema>;
type Node = QueryResultRow & {id:string;organization_id:string;customer_id:string;booking_id:string;parent_id:string;name:string;mime_type:string;
  size:number;content:Buffer|null;storage_object_id:string|null;content_version:number;updated_at:Date;service_key:string;default_folder:boolean;issued_at:Date|null};
const nodeColumns='id,organization_id,customer_id,booking_id,parent_id,name,mime_type,size,storage_object_id,content_version,updated_at,service_key,default_folder,issued_at';
type Upload = QueryResultRow & {id:string;document_id:string;created_by:string;filename:string;size:number;checksum:string;expected_version:number;
  completed_version:number|null;storage_object_id:string|null;expires_at:Date};
function parse<T>(schema:z.ZodType<T>,raw:unknown):T {
  const result=schema.safeParse(raw);
  if(!result.success) throw new BadRequestException(result.error.issues.map(issue=>`${issue.path.join('.')}: ${issue.message}`));
  return result.data;
}
function versionNumber(value:number) { if(!Number.isSafeInteger(value) || value<1) throw new BadRequestException('Select a valid document version.'); }
function serialize(node:Node) {
  const url=`/api/organizations/${node.organization_id}/customers/${node.customer_id}/bookings/${node.booking_id}/documents/${node.id}`;
  return {id:node.id,parentId:node.parent_id,name:node.name,kind:'file' as const,size:node.size,modifiedAt:new Date(node.updated_at).getTime(),
    serviceKey:node.service_key,defaultFolder:node.default_folder,issuedAt:node.issued_at,mimeType:node.mime_type,url,openUrl:url,downloadUrl:`${url}?download=1`,version:node.content_version};
}
function safeText(name:string,bytes:Buffer) {
  if(!/\.(txt|csv|json|md|markdown)$/i.test(name)) throw new BadRequestException('Use Replace file for this format. Text editing supports TXT, CSV, JSON and Markdown.');
  if(bytes.length>MAX_EDIT_TEXT_BYTES) throw new BadRequestException('Text editing supports files up to 256 KB. Download and replace larger files.');
  let text:string;
  try { text=new TextDecoder('utf-8',{fatal:true}).decode(bytes); }
  catch { throw new BadRequestException('This file is not UTF-8 text. Download and replace it instead.'); }
  if(Array.from(text).some(char=>{const code=char.charCodeAt(0);return code===127 || code<32 && ![9,10,13].includes(code);})) throw new BadRequestException('This file contains binary control characters. Download and replace it instead.');
  return text;
}

@Injectable()
export class DocumentVersionsService {
  constructor(@Inject(DatabaseService) private readonly db:DatabaseService,@Inject(AccessService) private readonly access:AccessService,
    @Optional() @Inject(DocumentStorage) private readonly storage:DocumentStorage=new DocumentStorage()) {}

  private async context(client:PoolClient,member:Membership,customerId:string,bookingId:string,documentId:string,write=false,folderId?:string) {
    const active=await this.access.membership(member.user_id,member.organization_id,write,client);
    const customer=await this.access.customer(active,customerId,client,write);
    const booking=await client.query('SELECT id FROM bookings WHERE organization_id=$1 AND customer_id=$2 AND id=$3 AND deleted_at IS NULL'+(write?' FOR UPDATE':''),[active.organization_id,customerId,bookingId]);
    if(!booking.rows[0]) throw new NotFoundException('Booking was not found for this customer.');
    if(write && customer.status!=='active') throw new ConflictException('Restore this customer before managing booking documents.');
    const result=await client.query<Node>(`SELECT ${nodeColumns} FROM booking_nodes WHERE organization_id=$1 AND customer_id=$2 AND booking_id=$3 AND id=$4 AND kind='file'`,[active.organization_id,customerId,bookingId,documentId]);
    const node=result.rows[0];
    if(!node || (folderId && node.parent_id!==folderId)) throw new NotFoundException('Document was not found in this booking and folder.');
    return {active,node};
  }
  private expected(node:Node,expected:number) {
    if(node.content_version!==expected) throw new ConflictException('This file has a newer version. Close this dialog and reopen it before editing again. Your changes were not saved.');
    if(node.content_version>=101) throw new ConflictException('This file has reached its 100 saved revisions. Download a copy and add it as a new document.');
  }
  private async object(client:PoolClient,id:string) {
    const result=await client.query<StoredDocument>('SELECT id,bucket,object_key,checksum,size FROM document_objects WHERE id=$1',[id]);
    if(!result.rows[0]) throw new NotFoundException('Document storage was not found.');
    return result.rows[0];
  }
  private async snapshot(client:PoolClient,node:Node) {
    await client.query(`INSERT INTO document_versions(document_id,version,name,mime_type,size,content,storage_object_id,created_at)
      SELECT id,content_version,name,mime_type,size,content,storage_object_id,updated_at FROM booking_nodes WHERE id=$1`,[node.id]);
  }
  private async audit(client:PoolClient,member:Membership,node:Node,action:string,extra:Record<string,unknown>={}) {
    await client.query(`INSERT INTO audit_events(organization_id,actor_id,action,object_id,metadata) VALUES($1,$2,$3,$4,$5::jsonb)`,
      [member.organization_id,member.user_id,action,node.id,JSON.stringify({customer_id:node.customer_id,booking_id:node.booking_id,version:node.content_version+1,...extra})]);
  }
  async history(member:Membership,customerId:string,bookingId:string,documentId:string) {
    return this.db.transaction(async client=>{
      const {node}=await this.context(client,member,customerId,bookingId,documentId);
      const history=await client.query<{version:number;name:string;mimeType:string;size:number;createdAt:Date;current:boolean}>(`
        SELECT content_version AS version,name,mime_type AS "mimeType",size,updated_at AS "createdAt",true AS current FROM booking_nodes WHERE id=$1
        UNION ALL SELECT version,name,mime_type AS "mimeType",size,created_at AS "createdAt",false AS current FROM document_versions WHERE document_id=$1
        ORDER BY version DESC LIMIT 101`,[node.id]);
      const current=history.rows.find(row=>row.current);
      if(!current)throw new NotFoundException('Document was not found.');
      return {version:current.version,items:history.rows};
    });
  }
  async download(member:Membership,customerId:string,bookingId:string,documentId:string,version:number) {
    versionNumber(version);
    const result=await this.db.transaction(async client=>{
      const {node}=await this.context(client,member,customerId,bookingId,documentId);
      // One statement snapshot chooses the requested version even if a writer
      // archived the former head after authorization completed.
      const row=(await client.query<Node>(`SELECT name,mime_type,size,content,storage_object_id FROM booking_nodes WHERE id=$1 AND content_version=$2
        UNION ALL SELECT name,mime_type,size,content,storage_object_id FROM document_versions WHERE document_id=$1 AND version=$2`,[node.id,version])).rows[0];
      if(!row) throw new NotFoundException('Document version was not found.');
      return {name:row.name,mimeType:row.mime_type,content:row.content,object:row.storage_object_id?await this.object(client,row.storage_object_id):undefined};
    });
    return {name:result.name,mimeType:result.mimeType,content:result.object?await this.storage.get(result.object):Buffer.from(result.content!)};
  }
  async text(member:Membership,customerId:string,bookingId:string,documentId:string) {
    // Both lookups enforce live authorization. If edited concurrently, the captured
    // immutable version is read and its guard prevents overwriting the new version.
    const head=await this.db.transaction(async client=>(await this.context(client,member,customerId,bookingId,documentId,true)).node);
    if(head.size>MAX_EDIT_TEXT_BYTES) throw new BadRequestException('Text editing supports files up to 256 KB. Download and replace larger files.');
    const content=await this.download(member,customerId,bookingId,documentId,head.content_version);
    return {name:content.name,version:head.content_version,text:safeText(content.name,content.content)};
  }
  async restore(member:Membership,customerId:string,bookingId:string,documentId:string,version:number,raw:unknown) {
    versionNumber(version);const data=parse(restoreSchema,raw);
    return this.db.transaction(async client=>{
      const {active,node}=await this.context(client,member,customerId,bookingId,documentId,true);
      this.expected(node,data.expected_version);
      const prior=(await client.query<Node>('SELECT * FROM document_versions WHERE document_id=$1 AND version=$2',[node.id,version])).rows[0];
      if(!prior) throw new NotFoundException('An earlier document version was not found.');
      // Keep the current display name: restoring content must not rename a file or
      // change its extension after administrators deliberately renamed it.
      if(documentExtension(prior.name).toLowerCase()!==documentExtension(node.name).toLowerCase()) throw new ConflictException('This version has a different file type. Download it instead.');
      await this.snapshot(client,node);
      const saved=await client.query<Node>(`UPDATE booking_nodes SET content=$1,storage_object_id=$2,size=$3,mime_type=$4,content_version=content_version+1,updated_at=now() WHERE id=$5 RETURNING ${nodeColumns}`,[prior.content,prior.storage_object_id,prior.size,prior.mime_type,node.id]);
      await this.audit(client,active,node,'document.restored',{restored_version:version});
      return serialize(saved.rows[0]);
    });
  }
  async begin(member:Membership,customerId:string,bookingId:string,documentId:string,folderId:string,raw:unknown) {
    const data=parse(replacementSchema,raw);
    const prepared=await this.db.transaction(async client=>{
      const {active,node}=await this.context(client,member,customerId,bookingId,documentId,true,folderId);
      let upload:Upload|undefined=(await client.query<Upload>('SELECT * FROM document_version_uploads WHERE organization_id=$1 AND idempotency_key=$2',[active.organization_id,data.idempotency_key])).rows[0];
      if(upload) {
        if(upload.document_id!==node.id || upload.created_by!==active.user_id || upload.filename!==data.name || upload.size!==data.size || upload.checksum!==data.sha256 || upload.expected_version!==data.expected_version) throw new ConflictException('This submission key was used for a different replacement.');
        if(upload.completed_version) return {document:serialize(node)};
        if(new Date(upload.expires_at).getTime()<=Date.now()+5000) { await client.query('DELETE FROM document_version_uploads WHERE id=$1',[upload.id]);upload=undefined; }
      }
      this.expected(node,data.expected_version);
      if(documentExtension(data.name).toLowerCase()!==documentExtension(node.name).toLowerCase()) throw new BadRequestException('Choose a replacement with the same file extension. The document keeps its current name.');
      if(!upload) {
        const id=randomUUID(),expiresAt=new Date(Date.now()+10*60*1000);
        let objectId:string|null=null;
        if(this.storage.cloud) {
          objectId=randomUUID();
          await client.query(`INSERT INTO document_objects(id,organization_id,customer_id,booking_id,bucket,object_key,checksum,size) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [objectId,active.organization_id,customerId,bookingId,this.storage.options.bucket!,`documents/${active.organization_id}/${customerId}/${bookingId}/${objectId}`,data.sha256,data.size]);
        }
        upload=(await client.query<Upload>(`INSERT INTO document_version_uploads(id,document_id,organization_id,created_by,idempotency_key,filename,size,checksum,expected_version,storage_object_id,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[id,node.id,active.organization_id,active.user_id,data.idempotency_key,data.name,data.size,data.sha256,data.expected_version,objectId,expiresAt])).rows[0];
      }
      return {upload,object:upload.storage_object_id?await this.object(client,upload.storage_object_id):undefined};
    });
    if(prepared.document) return {transport:'complete' as const,document:prepared.document};
    if(!this.storage.direct) return {transport:'proxy' as const,uploadId:prepared.upload!.id};
    return {transport:'direct' as const,uploadId:prepared.upload!.id,...await this.storage.signUpload(prepared.object!,documentMimeType(data.name),Math.max(1,Math.floor((new Date(prepared.upload!.expires_at).getTime()-Date.now())/1000)))};
  }
  async complete(member:Membership,customerId:string,bookingId:string,documentId:string,folderId:string,uploadId:string) {
    const prepared=await this.db.transaction(async client=>{
      const {node}=await this.context(client,member,customerId,bookingId,documentId,true,folderId);
      const upload=await this.uploadRecord(client,node,member,uploadId);
      if(upload.completed_version) return {document:serialize(node)};
      this.expected(node,upload.expected_version);
      if(!upload.storage_object_id || !this.storage.direct) throw new BadRequestException('Upload this replacement through the application.');
      return {object:await this.object(client,upload.storage_object_id)};
    });
    if(prepared.document) return prepared.document;
    return this.commit(member,customerId,bookingId,documentId,folderId,uploadId,await this.storage.get(prepared.object!,true));
  }
  private async uploadRecord(client:PoolClient,node:Node,member:Membership,id:string) {
    const upload=(await client.query<Upload>('SELECT * FROM document_version_uploads WHERE id=$1 AND document_id=$2 AND organization_id=$3 AND created_by=$4',[id,node.id,member.organization_id,member.user_id])).rows[0];
    if(!upload) throw new NotFoundException('This replacement upload was not found.');
    if(!upload.completed_version && new Date(upload.expires_at).getTime()<=Date.now()) throw new ConflictException('This replacement upload expired. Select the file and retry.');
    return upload;
  }
  async proxy(member:Membership,customerId:string,bookingId:string,documentId:string,folderId:string,name:string,key:string,expected:number,content:unknown) {
    if(!Buffer.isBuffer(content) || !content.length || content.length>MAX_DOCUMENT_BYTES) throw new BadRequestException('Choose a non-empty file up to 10 MB.');
    const data:Replacement={name,size:content.length,sha256:createHash('sha256').update(content).digest('hex'),idempotency_key:key,expected_version:expected};
    const ticket=await this.begin(member,customerId,bookingId,documentId,folderId,data);
    if(ticket.transport==='complete') return ticket.document;
    if(this.storage.direct) throw new BadRequestException('Use the prepared direct upload for this replacement.');
    if(this.storage.cloud) {
      const record=(await this.db.query<Upload>('SELECT * FROM document_version_uploads WHERE id=$1',[ticket.uploadId])).rows[0];
      if(!record)throw new NotFoundException('This replacement upload was not found.');
      const object=await this.db.transaction(client=>this.object(client,record.storage_object_id!));
      await this.storage.put(object,content,documentMimeType(name));
    }
    return this.commit(member,customerId,bookingId,documentId,folderId,ticket.uploadId,content);
  }
  private async commit(member:Membership,customerId:string,bookingId:string,documentId:string,folderId:string,uploadId:string,content:Buffer) {
    return this.db.transaction(async client=>{
      const {active,node}=await this.context(client,member,customerId,bookingId,documentId,true,folderId);
      const upload=await this.uploadRecord(client,node,member,uploadId);
      if(upload.completed_version) return serialize(node);
      this.expected(node,upload.expected_version);
      if(content.length!==upload.size || createHash('sha256').update(content).digest('hex')!==upload.checksum) throw new BadRequestException('The uploaded replacement does not match its declared size or checksum.');
      if(documentMimeType(upload.filename)==='application/pdf' && (content.length<12 || !content.subarray(0,8).toString('ascii').startsWith('%PDF-') || !content.subarray(-1024).includes(Buffer.from('%%EOF')))) throw new BadRequestException('Choose a valid PDF of at most 10 MB.');
      if(upload.storage_object_id) {
        const ready=await client.query("UPDATE document_objects SET state='ready' WHERE id=$1 AND state='pending' RETURNING id",[upload.storage_object_id]);
        if(!ready.rows[0]) throw new ConflictException('This replacement expired. Select the file and retry.');
      }
      await this.snapshot(client,node);
      const saved=await client.query<Node>(`UPDATE booking_nodes SET content=$1,storage_object_id=$2,size=$3,mime_type=$4,content_version=content_version+1,updated_at=now() WHERE id=$5 RETURNING ${nodeColumns}`,
        [upload.storage_object_id?null:content,upload.storage_object_id,content.length,documentMimeType(upload.filename),node.id]);
      await client.query('UPDATE document_version_uploads SET completed_version=$1 WHERE id=$2',[node.content_version+1,upload.id]);
      await this.audit(client,active,node,'document.replaced',{name:node.name});
      return serialize(saved.rows[0]);
    });
  }
}
