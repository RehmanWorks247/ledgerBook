import { Inject, Injectable, Optional, ServiceUnavailableException, type OnApplicationShutdown } from '@nestjs/common';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { DatabaseService } from '../database/database.service';

export type StoredDocument = {id:string;bucket:string;object_key:string;checksum:string;size:number};
export type DocumentStorageOptions = {mode:'database'|'s3';bucket?:string;region?:string;endpoint?:string;forcePathStyle?:boolean};

export function documentStorageOptions(env:NodeJS.ProcessEnv=process.env):DocumentStorageOptions {
  const mode=env.DOCUMENT_STORAGE ?? (env.NODE_ENV==='production'?'s3':'database');
  if(mode!=='database' && mode!=='s3') throw new Error('DOCUMENT_STORAGE must be database or s3.');
  if(mode==='s3' && (!env.S3_DOCUMENT_BUCKET || !env.AWS_REGION)) throw new Error('S3 document storage requires S3_DOCUMENT_BUCKET and AWS_REGION.');
  if(env.S3_DOCUMENT_BUCKET && !/^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.S3_DOCUMENT_BUCKET)) throw new Error('S3_DOCUMENT_BUCKET must be a valid bucket name.');
  return {mode,bucket:env.S3_DOCUMENT_BUCKET,region:env.AWS_REGION};
}

/** Private objects only. Credentials come from the AWS SDK's server-side identity chain. */
@Injectable()
export class DocumentStorage implements OnApplicationShutdown {
  readonly options:DocumentStorageOptions;
  private readonly client?:S3Client;
  constructor(@Optional() @Inject('DOCUMENT_STORAGE_OPTIONS') options?:DocumentStorageOptions) {
    this.options=options ?? documentStorageOptions();
    if(this.options.mode==='s3') {
      if(!this.options.bucket || !this.options.region) throw new Error('S3 document storage requires a bucket and region.');
      this.client=new S3Client({region:this.options.region,endpoint:this.options.endpoint,forcePathStyle:this.options.forcePathStyle,
        maxAttempts:3,requestHandler:{connectionTimeout:5000,requestTimeout:15000,throwOnRequestTimeout:true},
        requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
    }
  }
  get cloud() { return this.options.mode==='s3'; }
  async put(object:StoredDocument,bytes:Buffer) {
    try {
      if(!this.client) throw new Error('Storage not configured');
      await this.client.send(new PutObjectCommand({Bucket:object.bucket,Key:object.object_key,Body:bytes,
        ContentType:'application/pdf',ContentLength:bytes.length,CacheControl:'private, no-store',
        ServerSideEncryption:'AES256',ChecksumSHA256:Buffer.from(object.checksum,'hex').toString('base64')}),
      {abortSignal:AbortSignal.timeout(45000)});
    } catch { throw new ServiceUnavailableException('Document storage is temporarily unavailable. Retry this upload.'); }
  }
  async get(object:StoredDocument):Promise<Buffer> {
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
        if(response.ContentLength!==object.size || object.size>10485760 || object.size<12) throw new Error('Invalid object size');
        const bytes=Buffer.allocUnsafe(object.size),checksum=createHash('sha256');
        let offset=0;
        for await(const value of body) {
          const chunk=Buffer.isBuffer(value) ? value : Buffer.from(value);
          if(offset+chunk.length>bytes.length) throw new Error('Invalid object size');
          checksum.update(chunk);chunk.copy(bytes,offset);offset+=chunk.length;
        }
        if(offset!==bytes.length || checksum.digest('hex')!==object.checksum) throw new Error('Invalid object checksum');
        return bytes;
      } finally { clearTimeout(timer);body.destroy(); }
    } catch { throw new ServiceUnavailableException('This document is temporarily unavailable. Please try again.'); }
  }
  async remove(object:StoredDocument) {
    if(!this.client) throw new Error('Configure S3 before cleaning up document storage.');
    await this.client.send(new DeleteObjectCommand({Bucket:object.bucket,Key:object.object_key}),{abortSignal:AbortSignal.timeout(45000)});
  }
  onApplicationShutdown() { this.client?.destroy(); }
}

/** Delayed reconciliation survives process death and ambiguous commits. Never deletes a referenced object. */
export async function cleanupDocumentObjects(db:DatabaseService,storage:DocumentStorage,limit=100) {
  if(!storage.cloud) return {removed:0,failed:0};
  const objects=await db.transaction(async client=>{
    const rows=await client.query<StoredDocument>(`SELECT o.id,o.bucket,o.object_key,o.checksum,o.size FROM document_objects o
      WHERE o.state IN ('pending','deleting') AND o.created_at < now()-interval '24 hours'
      AND NOT EXISTS(SELECT 1 FROM booking_nodes n WHERE n.storage_object_id=o.id)
      ORDER BY o.created_at,o.id LIMIT $1 FOR UPDATE OF o SKIP LOCKED`,[limit]);
    await client.query("UPDATE document_objects SET state='deleting' WHERE id=ANY($1::uuid[])",[rows.rows.map(row=>row.id)]);
    return rows.rows;
  });
  let removed=0,failed=0;
  for(const object of objects) {
    try {
      await storage.remove(object);
      await db.query("DELETE FROM document_objects WHERE id=$1 AND state='deleting'",[object.id]);
      removed++;
    } catch { failed++; }
  }
  return {removed,failed};
}
