import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AccessService } from '../apps/api/src/access/access.service';
import { createApp } from '../apps/api/src/app';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { cleanupDocumentObjects, DocumentStorage, documentStorageOptions } from '../apps/api/src/bookings/document-storage';
import { config } from '../apps/api/src/config';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

const credentials={accessKeyId:'r2-test-access',secretAccessKey:'r2-test-secret'};
const sha256=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const hmac=(key:Buffer|string,value:string)=>createHmac('sha256',key).update(value).digest();
const encode=(value:string)=>encodeURIComponent(value).replace(/[!'()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** Verifies real presigner signatures and atomic create-only writes over HTTP. */
class R2StandIn {
  server?:Server;
  objects=new Map<string,Buffer>();
  requests:Array<{method:string;path:string}>=[];
  failGets=false;
  failDeletes=false;
  verify(request:IncomingMessage,url:URL) {
    const query=url.searchParams;
    const scope=query.get('X-Amz-Credential')?.split('/') ?? [];
    const headers=query.get('X-Amz-SignedHeaders') ?? '';
    if(scope[0]!==credentials.accessKeyId || headers!=='content-length;content-type;host;if-none-match') return false;
    const canonicalQuery=[...query.entries()].filter(([key])=>key!=='X-Amz-Signature').map(([key,value])=>[encode(key),encode(value)])
      .sort(([a,av],[b,bv])=>a<b?-1:a>b?1:av<bv?-1:av>bv?1:0).map(([key,value])=>`${key}=${value}`).join('&');
    const canonicalHeaders=headers.split(';').map(name=>`${name}:${String(request.headers[name] ?? '').trim().replace(/\s+/g,' ')}\n`).join('');
    const canonical=['PUT',url.pathname,canonicalQuery,canonicalHeaders,headers,'UNSIGNED-PAYLOAD'].join('\n');
    const key=hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`,scope[1]),scope[2]),scope[3]),scope[4]);
    const expected=createHmac('sha256',key).update(['AWS4-HMAC-SHA256',query.get('X-Amz-Date'),scope.slice(1).join('/'),sha256(canonical)].join('\n')).digest('hex');
    return expected===query.get('X-Amz-Signature');
  }
  async start() {
    this.server=createServer((request,response)=>{void(async()=>{
      const url=new URL(request.url!,`http://${request.headers.host}`),path=decodeURIComponent(url.pathname);
      this.requests.push({method:request.method!,path});
      const failure=(status:number,code:string)=>response.writeHead(status,{'Content-Type':'application/xml'}).end(`<Error><Code>${code}</Code></Error>`);
      if(url.searchParams.has('X-Amz-Signature')) {
        if(request.method!=='PUT' || !this.verify(request,url)) { failure(403,'SignatureDoesNotMatch');return; }
      } else if(!request.headers.authorization?.startsWith('AWS4-HMAC-SHA256 ')) { failure(403,'AccessDenied');return; }
      if(request.method==='PUT') {
        const chunks:Buffer[]=[];
        for await(const chunk of request) chunks.push(Buffer.from(chunk));
        const bytes=Buffer.concat(chunks);
        if(request.headers['x-amz-server-side-encryption']) { failure(400,'UnsupportedHeader');return; }
        if(request.headers['if-none-match']==='*' && this.objects.has(path)) { failure(412,'PreconditionFailed');return; }
        if(!url.searchParams.has('X-Amz-Signature') && request.headers['content-md5']!==createHash('md5').update(bytes).digest('base64')) { failure(400,'BadDigest');return; }
        this.objects.set(path,bytes);
        response.writeHead(200,{ETag:'"r2-test"'}).end();
      } else if(request.method==='GET') {
        if(this.failGets) { failure(503,'ServiceUnavailable');return; }
        const bytes=this.objects.get(path);
        if(!bytes) { failure(404,'NoSuchKey');return; }
        response.writeHead(200,{'Content-Length':bytes.length}).end(bytes);
      } else if(request.method==='DELETE') {
        if(this.failDeletes) { failure(503,'ServiceUnavailable');return; }
        this.objects.delete(path);response.writeHead(204).end();
      } else failure(501,'NotImplemented');
    })().catch(()=>response.destroy());});
    await new Promise<void>(resolve=>this.server!.listen(0,'127.0.0.1',resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async close() { this.server?.closeAllConnections();await new Promise<void>(resolve=>this.server?.close(()=>resolve())); }
}

type Direct={transport:'direct';uploadId:string;url:string;headers:Record<string,string>;expiresAt:string};

describe('R2 environment isolation',()=>{
  const env={NODE_ENV:'development',DOCUMENT_STORAGE:'r2',STORAGE_ENVIRONMENT:'development',R2_ACCOUNT_ID:'a'.repeat(32),R2_ACCESS_KEY_ID:'test',R2_SECRET_ACCESS_KEY:'secret',R2_DOCUMENT_BUCKET:'ledgerbook-documents-development'};
  it('uses explicit R2 credentials, auto region and a pinned HTTPS account endpoint',()=>{
    const options=documentStorageOptions(env);
    assert.equal(options.endpoint,`https://${'a'.repeat(32)}.r2.cloudflarestorage.com`);
    assert.deepEqual(options.credentials,{accessKeyId:'test',secretAccessKey:'secret'});
    assert.equal(options.region,'auto');assert.equal(options.forcePathStyle,true);
  });
  it('fails closed on mixed environments, invalid accounts, missing keys and wrong bucket labels',()=>{
    for(const patch of [{NODE_ENV:'production'},{STORAGE_ENVIRONMENT:'production'},{STORAGE_ENVIRONMENT:''},{R2_ACCOUNT_ID:'untrusted.example'},{R2_ACCESS_KEY_ID:''},{R2_SECRET_ACCESS_KEY:''},{R2_DOCUMENT_BUCKET:'ledgerbook-documents-production'}]) {
      assert.throws(()=>documentStorageOptions({...env,...patch}));
    }
    assert.equal(documentStorageOptions({...env,NODE_ENV:'production',STORAGE_ENVIRONMENT:'production',R2_DOCUMENT_BUCKET:'ledgerbook-documents-production'}).mode,'r2');
  });
});

describe('private R2 direct upload HTTP workflow',()=>{
  const provider=new R2StandIn();
  let database:TestDatabase,seed:TestSeed,storage:DocumentStorage,app:NestExpressApplication;
  let bookingId:string,folderId:string,base:string,adminHeaders:Record<string,string>,customerHeaders:Record<string,string>;
  const bytes=Buffer.concat([Buffer.from('%PDF-1.7\n%'),Buffer.from([0,128,255]),Buffer.from('\n%%EOF\n')]);
  const prepare=(name='ticket.pdf',content=bytes,key=randomUUID())=>fetch(`${base}/folders/${folderId}/uploads`,{method:'POST',headers:adminHeaders,body:JSON.stringify({name,size:content.length,sha256:sha256(content),idempotency_key:key})});
  const complete=(upload:Direct,headers=adminHeaders)=>fetch(`${base}/folders/${folderId}/uploads/${upload.uploadId}/complete`,{method:'POST',headers,body:'{}'});
  const put=(upload:Direct,content=bytes)=>fetch(upload.url,{method:'PUT',headers:upload.headers,body:new Uint8Array(content)});
  async function ready(name='ticket.pdf',content=bytes) {
    const response=await prepare(name,content);assert.equal(response.status,201);
    const upload=await response.json() as Direct;
    assert.equal((await put(upload,content)).status,200);
    const result=await complete(upload);assert.equal(result.status,201,await result.clone().text());
    return {upload,document:await result.json() as {id:string;name:string}};
  }
  before(async()=>{
    const endpoint=await provider.start();
    storage=new DocumentStorage({mode:'r2',bucket:'ledgerbook-documents-development',region:'auto',endpoint,forcePathStyle:true,credentials});
    database=await setupTestDatabase();seed=await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1",[seed.orgId]);
    seed.admin=await new AccessService(database.db).membership(seed.adminId,seed.orgId);
    app=await createApp({database:database.db,documentStorage:storage,logger:false,paymentEmails:false});
    await app.listen(0,'127.0.0.1');
    const bookings=app.get(BookingsService);
    bookingId=String((await bookings.create(seed.admin,seed.customerId,{reference:'R2-UPLOAD',departure_at:'2026-11-12T10:30:00Z',amount:'100.00',effective_date:'2026-11-09',idempotency_key:randomUUID()})).id);
    folderId=(await bookings.files(seed.admin,seed.customerId,bookingId)).items.find(item=>item.serviceKey==='extras')!.id;
    base=`${await app.getUrl()}/api/organizations/${seed.orgId}/customers/${seed.customerId}/bookings/${bookingId}`;
    adminHeaders={Cookie:`${config.sessionCookie}=${await app.get(AuthService).createSession(seed.adminId)}`,Origin:config.appUrl,'X-CSRF-Protection':'1','Content-Type':'application/json'};
    customerHeaders={...adminHeaders,Cookie:`${config.sessionCookie}=${await app.get(AuthService).createSession(seed.customerUserId)}`};
  });
  after(async()=>{await app?.close();await provider.close();await database?.close();});

  it('authenticates and signs only exact create-only file uploads; authorizes bytes after verification',async()=>{
    const key=randomUUID(),response=await prepare('direct.pdf',bytes,key);
    assert.equal(response.status,201);
    assert.ok(response.headers.get('content-security-policy')?.includes(storage.uploadOrigin!));
    const upload=await response.json() as Direct;
    assert.equal(upload.transport,'direct');
    assert.equal(new URL(upload.url).searchParams.get('X-Amz-SignedHeaders'),'content-length;content-type;host;if-none-match');
    assert.equal(upload.headers['If-None-Match'],'*');
    assert.equal(upload.headers['Content-Length'],undefined,'Browser sets its own signed content length.');
    assert.ok(Date.parse(upload.expiresAt)>Date.now());
    assert.equal((await database.db.query('SELECT id FROM booking_nodes WHERE idempotency_key=$1',[key])).rowCount,0);
    assert.equal((await fetch(upload.url,{method:'PUT',headers:{'Content-Type':'application/pdf'},body:new Uint8Array(bytes)})).status,403);
    assert.equal((await put(upload,Buffer.concat([bytes,Buffer.from('x')]))).status,403);
    assert.equal((await put(upload)).status,200);
    assert.equal((await database.db.query('SELECT id FROM booking_nodes WHERE idempotency_key=$1',[key])).rowCount,0);
    const finalized=await complete(upload);assert.equal(finalized.status,201,await finalized.clone().text());
    const document=await finalized.json() as {id:string};
    const replay=await complete(upload);assert.equal((await replay.json() as {id:string}).id,document.id);
    assert.equal((await put(upload)).status,412);
    const retry=await prepare('direct.pdf',bytes,key);
    const retryBody=await retry.json() as {transport:string;document:{id:string}};
    assert.equal(retryBody.transport,'complete');assert.equal(retryBody.document.id,document.id);
    const read=await fetch(`${base}/documents/${document.id}`,{headers:customerHeaders});assert.equal(read.status,200);
    assert.deepEqual(Buffer.from(await read.arrayBuffer()),bytes);
    assert.equal((await database.db.query("SELECT count(*)::int AS n FROM audit_events WHERE action='document.uploaded' AND object_id=$1",[document.id])).rows[0].n,1);
  });

  it('denies customer preparation, finalization and all document writes with no provider side effect',async()=>{
    const pending=await (await prepare()).json() as Direct;
    const before=provider.requests.length;
    const init=await fetch(`${base}/folders/${folderId}/uploads`,{method:'POST',headers:customerHeaders,body:JSON.stringify({name:'a.pdf',size:bytes.length,sha256:sha256(bytes),idempotency_key:randomUUID()})});
    assert.equal(init.status,403);assert.equal((await complete(pending,customerHeaders)).status,403);
    assert.equal((await fetch(`${base}/files/${folderId}`,{method:'PATCH',headers:customerHeaders,body:JSON.stringify({name:'rename'})})).status,403);
    assert.equal((await fetch(`${base}/files/${folderId}`,{method:'DELETE',headers:customerHeaders})).status,403);
    assert.equal(provider.requests.length,before);
    assert.equal((await fetch(`${base}/folders/${folderId}/uploads`,{method:'POST',headers:{...adminHeaders,Origin:'https://elsewhere.invalid'},body:'{}'})).status,403);
  });

  it('invalidates tampered and malformed files so retries get a fresh immutable object',async()=>{
    const key=randomUUID(),upload=await (await prepare('tampered.pdf',bytes,key)).json() as Direct;
    const bad=Buffer.from(bytes);bad[8]^=1;
    assert.equal((await put(upload,bad)).status,200);
    const rejected=await complete(upload);assert.equal(rejected.status,400);assert.match(await rejected.text(),/checksum/);
    const retry=await (await prepare('tampered.pdf',bytes,key)).json() as Direct;assert.notEqual(retry.uploadId,upload.uploadId);
    assert.equal((await put(retry)).status,200);assert.equal((await complete(retry)).status,201);
    const invalid=Buffer.from('not actually a PDF document');
    const malformed=await (await prepare('invalid.pdf',invalid)).json() as Direct;
    assert.equal((await put(malformed,invalid)).status,200);
    const malformedResult=await complete(malformed);assert.equal(malformedResult.status,400);assert.match(await malformedResult.text(),/valid PDF/);
    assert.equal((await database.db.query("SELECT id FROM booking_nodes WHERE name='invalid.pdf'")).rowCount,0);
  });

  it('preserves pending uploads on provider failure and rejects expired or conflicting sessions',async()=>{
    const key=randomUUID(),upload=await (await prepare('retry.pdf',bytes,key)).json() as Direct;
    assert.equal((await put(upload)).status,200);
    provider.failGets=true;
    try { const response=await complete(upload);assert.equal(response.status,503);assert.match(await response.text(),/temporarily unavailable/); }
    finally { provider.failGets=false; }
    assert.equal((await complete(upload)).status,201);
    const next=await (await prepare('expiry.pdf')).json() as Direct;
    await database.db.query("UPDATE document_uploads SET expires_at=now()-interval '1 second' WHERE id=$1",[next.uploadId]);
    assert.equal((await complete(next)).status,409);
    assert.equal((await prepare('different.pdf',bytes,key)).status,409);
  });

  it('renames only safe files, protects service folders, and journals deleted objects until cleanup succeeds',async()=>{
    const {document,upload}=await ready('management.pdf');
    assert.equal((await fetch(`${base}/files/${document.id}`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({name:'renamed.pdf'})})).status,200);
    assert.equal((await fetch(`${base}/files/${document.id}`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({name:'renamed.html'})})).status,400);
    assert.equal((await fetch(`${base}/files/${folderId}`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({name:'Changed'})})).status,400);
    assert.equal((await fetch(`${base}/files/${folderId}`,{method:'DELETE',headers:adminHeaders})).status,400);
    const removed=await fetch(`${base}/files/${document.id}`,{method:'DELETE',headers:adminHeaders});assert.equal(removed.status,200);
    assert.deepEqual(await removed.json(),{deleted:true});
    assert.equal((await fetch(`${base}/documents/${document.id}`,{headers:customerHeaders})).status,404);
    assert.equal((await complete(upload)).status,404,'Deleted documents cannot be resurrected by a completion replay.');
    assert.equal((await database.db.query('SELECT id FROM document_purge_outbox WHERE id=$1',[upload.uploadId])).rowCount,1);
    const path=new URL(upload.url).pathname;assert.ok(provider.objects.has(path));
    await database.db.query("UPDATE document_purge_outbox SET created_at=now()-interval '25 hours' WHERE id=$1",[upload.uploadId]);
    provider.failDeletes=true;
    try { assert.deepEqual(await cleanupDocumentObjects(database.db,storage),{removed:0,failed:1}); }
    finally { provider.failDeletes=false; }
    assert.ok(provider.objects.has(path));
    assert.deepEqual(await cleanupDocumentObjects(database.db,storage),{removed:1,failed:0});
    assert.equal(provider.objects.has(path),false);
  });

  it('allows custom-folder management while refusing nonempty deletion and duplicate names',async()=>{
    const folder=async(parent_id:string,name:string)=>{
      const response=await fetch(`${base}/folders`,{method:'POST',headers:adminHeaders,body:JSON.stringify({parent_id,name,idempotency_key:randomUUID()})});
      assert.equal(response.status,201);return await response.json() as {id:string};
    };
    const parent=await folder(folderId,'Custom folder'),child=await folder(parent.id,'Nested folder');
    assert.equal((await fetch(`${base}/files/${parent.id}`,{method:'DELETE',headers:adminHeaders})).status,409);
    assert.equal((await fetch(`${base}/files/${parent.id}`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({name:'Renamed folder'})})).status,200);
    const sibling=await folder(folderId,'Sibling folder');
    assert.equal((await fetch(`${base}/files/${sibling.id}`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({name:'renamed FOLDER'})})).status,409);
    assert.equal((await fetch(`${base}/files/${child.id}`,{method:'DELETE',headers:adminHeaders})).status,200);
    assert.equal((await fetch(`${base}/files/${parent.id}`,{method:'DELETE',headers:adminHeaders})).status,200);
  });
});
