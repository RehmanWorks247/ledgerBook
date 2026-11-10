import { BadRequestException, Inject, Injectable, Optional, ServiceUnavailableException, type OnApplicationShutdown } from '@nestjs/common';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { DatabaseService } from '../database/database.service';

export type StoredDocument = {id:string;bucket:string;object_key:string;checksum:string;size:number};
export type DocumentStorageOptions = {mode:'database'|'s3'|'r2';bucket?:string;region?:string;endpoint?:string;forcePathStyle?:boolean;credentials?:{accessKeyId:string;secretAccessKey:string}};

export function documentStorageOptions(env:NodeJS.ProcessEnv=process.env):DocumentStorageOptions {
  const mode=env.DOCUMENT_STORAGE ?? (env.NODE_ENV==='production'?'s3':'database');
  if(mode!=='database' && mode!=='s3' && mode!=='r2') throw new Error('DOCUMENT_STORAGE must be database, s3 or r2.');
  if(mode==='r2') {
    const environment=env.STORAGE_ENVIRONMENT;
    if(environment!=='development' && environment!=='production') throw new Error('R2 storage requires STORAGE_ENVIRONMENT=development or production.');
    if((env.NODE_ENV==='production') !== (environment==='production')) throw new Error('STORAGE_ENVIRONMENT must match the application environment.');
    if(!/^[a-f0-9]{32}$/.test(env.R2_ACCOUNT_ID ?? '')) throw new Error('R2_ACCOUNT_ID must be a valid Cloudflare account ID.');
    if(!env.R2_ACCESS_KEY_ID?.trim() || !env.R2_SECRET_ACCESS_KEY?.trim()) throw new Error('R2 storage requires R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.');
    if(!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.R2_DOCUMENT_BUCKET ?? '') || !env.R2_DOCUMENT_BUCKET!.endsWith(`-${environment}`)) {
      throw new Error('R2_DOCUMENT_BUCKET must be a valid bucket name ending with the STORAGE_ENVIRONMENT suffix.');
    }
    return {mode,bucket:env.R2_DOCUMENT_BUCKET,region:'auto',endpoint:`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,forcePathStyle:true,
      credentials:{accessKeyId:env.R2_ACCESS_KEY_ID,secretAccessKey:env.R2_SECRET_ACCESS_KEY}};
  }
  if(mode==='s3' && (!env.S3_DOCUMENT_BUCKET || !env.AWS_REGION)) throw new Error('S3 document storage requires S3_DOCUMENT_BUCKET and AWS_REGION.');
  if(env.S3_DOCUMENT_BUCKET && !/^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.S3_DOCUMENT_BUCKET)) throw new Error('S3_DOCUMENT_BUCKET must be a valid bucket name.');
  return {mode,bucket:env.S3_DOCUMENT_BUCKET,region:env.AWS_REGION};
}

/** Private objects only. R2 credentials are explicit server-side credentials. */
@Injectable()
export class DocumentStorage implements OnApplicationShutdown {
  readonly options:DocumentStorageOptions;
  private readonly client?:S3Client;
  constructor(@Optional() @Inject('DOCUMENT_STORAGE_OPTIONS') options?:DocumentStorageOptions) {
    this.options=options ?? documentStorageOptions();
    if(this.cloud) {
      if(!this.options.bucket || !this.options.region) throw new Error('S3 document storage requires a bucket and region.');
      this.client=new S3Client({region:this.options.region,endpoint:this.options.endpoint,forcePathStyle:this.options.forcePathStyle,credentials:this.options.credentials,
        maxAttempts:3,requestHandler:{connectionTimeout:5000,requestTimeout:15000,throwOnRequestTimeout:true},
        requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
    }
  }
  get cloud() { return this.options.mode!=='database'; }
  get direct() { return this.options.mode==='r2'; }
  get uploadOrigin() { return this.direct && this.options.endpoint ? new URL(this.options.endpoint).origin : undefined; }
  async signUpload(object:StoredDocument,mimeType:string,expiresIn:number) {
    if(!this.client || !this.direct) throw new ServiceUnavailableException('Direct document uploads are not configured.');
    try {
      // The condition is signed and enforced atomically by R2. A leaked or
      // replayed URL cannot replace bytes after they have been verified.
      const url=await getSignedUrl(this.client,new PutObjectCommand({Bucket:object.bucket,Key:object.object_key,
        ContentLength:object.size,ContentType:mimeType,IfNoneMatch:'*'}),
      {expiresIn,signableHeaders:new Set(['content-type','content-length','if-none-match'])});
      return {url,headers:{'Content-Type':mimeType,'If-None-Match':'*'}};
    } catch { throw new ServiceUnavailableException('Document storage is temporarily unavailable. Retry this upload.'); }
  }
  async put(object:StoredDocument,bytes:Buffer,mimeType='application/pdf') {
    try {
      if(!this.client) throw new Error('Storage not configured');
      await this.client.send(new PutObjectCommand({Bucket:object.bucket,Key:object.object_key,Body:bytes,
        ContentType:mimeType,ContentLength:bytes.length,CacheControl:'private, no-store',
        ...(this.options.mode==='r2' ? {ContentMD5:createHash('md5').update(bytes).digest('base64')} :
          {ServerSideEncryption:'AES256' as const,ChecksumSHA256:Buffer.from(object.checksum,'hex').toString('base64')})}),
      {abortSignal:AbortSignal.timeout(45000)});
    } catch { throw new ServiceUnavailableException('Document storage is temporarily unavailable. Retry this upload.'); }
  }
  /** Disaster recovery only: never replaces an object that already exists. */
  async restoreIfAbsent(object:StoredDocument,bytes:Buffer):Promise<'created'|'existing'> {
    if(!this.client || object.bucket!==this.options.bucket || bytes.length!==object.size ||
      createHash('sha256').update(bytes).digest('hex')!==object.checksum) throw new Error('Document restore metadata or bytes are invalid for this bucket.');
    let result:'created'|'existing'='created';
    try {
      await this.client.send(new PutObjectCommand({Bucket:object.bucket,Key:object.object_key,Body:bytes,IfNoneMatch:'*',
        ContentType:'application/octet-stream',ContentLength:bytes.length,CacheControl:'private, no-store',
        ...(this.options.mode==='r2'?{ContentMD5:createHash('md5').update(bytes).digest('base64')}:
          {ServerSideEncryption:'AES256' as const,ChecksumSHA256:Buffer.from(object.checksum,'hex').toString('base64')})}),
      {abortSignal:AbortSignal.timeout(45000)});
    } catch(error) {
      if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode!==412) throw new Error('Document restore was not confirmed. Retry with the same verified backup.',{cause:error});
      result='existing';
    }
    // The same bounded size/checksum verification covers new and pre-existing
    // objects. A conflicting destination is never overwritten or deleted.
    try {await this.get(object);} catch {throw new Error('The destination object is unavailable or does not match this backup. No existing object was overwritten.');}
    return result;
  }
  async get(object:StoredDocument,upload=false):Promise<Buffer> {
    try {
      if(!this.client) throw new Error('Storage not configured');
      const response=await this.client.send(new GetObjectCommand({Bucket:object.bucket,Key:object.object_key}),{abortSignal:AbortSignal.timeout(45000)});
      const body=response.Body;
      if(!(body instanceof Readable)) throw new Error('Invalid object stream');
      // SDK send() resolves at the headers. Bound the body separately, and copy
      // each chunk into one fixed-size allocation instead of buffering twice.
      const timer=setTimeout(()=>body.destroy(new Error('Document transfer timed out')),45000);
      timer.unref();
      try {
        const invalid=()=>upload ? new BadRequestException('The uploaded file does not match its declared size or checksum. Select the file and retry.') : new Error('Invalid object content');
        if(response.ContentLength!==object.size || object.size>10485760 || object.size<1) throw invalid();
        const bytes=Buffer.allocUnsafe(object.size),checksum=createHash('sha256');
        let offset=0;
        for await(const value of body) {
          const chunk=Buffer.isBuffer(value) ? value : Buffer.from(value);
          if(offset+chunk.length>bytes.length) throw invalid();
          checksum.update(chunk);chunk.copy(bytes,offset);offset+=chunk.length;
        }
        if(offset!==bytes.length || checksum.digest('hex')!==object.checksum) throw invalid();
        return bytes;
      } finally { clearTimeout(timer);body.destroy(); }
    } catch(error) {
      if(upload && error instanceof BadRequestException) throw error;
      if(upload && (error as {name?:string}).name==='NoSuchKey') throw new BadRequestException('The file has not finished uploading. Retry the upload.');
      throw new ServiceUnavailableException('This document is temporarily unavailable. Please try again.');
    }
  }
  async remove(object:StoredDocument,signal?:AbortSignal) {
    if(!this.client) throw new Error('Configure S3 before cleaning up document storage.');
    const timeout=AbortSignal.timeout(45000);
    await this.client.send(new DeleteObjectCommand({Bucket:object.bucket,Key:object.object_key}),{abortSignal:signal ? AbortSignal.any([signal,timeout]) : timeout});
  }
  onApplicationShutdown() { this.client?.destroy(); }
}

/** Delayed reconciliation survives process death and ambiguous commits. Never deletes a referenced object. */
export async function cleanupDocumentObjects(db:DatabaseService,storage:DocumentStorage,limit=100,signal?:AbortSignal) {
  if(!storage.cloud || signal?.aborted) return {removed:0,failed:0};
  const objects=await db.transaction(async client=>{
    const rows=await client.query<StoredDocument>(`SELECT o.id,o.bucket,o.object_key,o.checksum,o.size FROM document_objects o
      WHERE o.state IN ('pending','deleting') AND o.created_at < now()-interval '24 hours'
      AND NOT EXISTS(SELECT 1 FROM booking_nodes n WHERE n.storage_object_id=o.id)
      AND NOT EXISTS(SELECT 1 FROM document_versions v WHERE v.storage_object_id=o.id)
      ORDER BY o.created_at,o.id LIMIT $1 FOR UPDATE OF o SKIP LOCKED`,[limit]);
    await client.query("UPDATE document_objects SET state='deleting' WHERE id=ANY($1::uuid[])",[rows.rows.map(row=>row.id)]);
    return rows.rows;
  });
  let removed=0,failed=0;
  for(const object of objects) {
    if(signal?.aborted) break;
    try {
      await storage.remove(object,signal);
      await db.query("DELETE FROM document_objects WHERE id=$1 AND state='deleting'",[object.id]);
      removed++;
    } catch { failed++; }
  }
  // Account purges remove their relational data immediately and retain only
  // the private object coordinates until cloud deletion succeeds. The same
  // 24-hour grace period prevents racing an upload already in flight at purge.
  if(signal?.aborted) return {removed,failed};
  const purged=await db.query<StoredDocument>(`SELECT id,bucket,object_key,checksum,size FROM document_purge_outbox
    WHERE created_at < now()-interval '24 hours' ORDER BY created_at,id LIMIT $1`,[Math.max(0,limit-objects.length)]);
  for(const object of purged.rows) {
    if(signal?.aborted) break;
    try {
      await storage.remove(object,signal);
      await db.query('DELETE FROM document_purge_outbox WHERE id=$1',[object.id]);
      removed++;
    } catch { failed++; }
  }
  return {removed,failed};
}
