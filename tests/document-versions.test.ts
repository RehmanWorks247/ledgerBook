import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AccessService } from '../apps/api/src/access/access.service';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { createApp } from '../apps/api/src/app';
import { config } from '../apps/api/src/config';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { DocumentVersionsService } from '../apps/api/src/bookings/document-versions.service';
import { cleanupDocumentObjects, DocumentStorage } from '../apps/api/src/bookings/document-storage';
import { AccountDeletionService } from '../apps/api/src/users/account-deletion.service';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const bookingInput=()=>({reference:`VERSIONS-${randomUUID()}`,departure_at:'2026-11-12T10:30:00Z',amount:'100.00',effective_date:'2026-11-09',required_services:['makkah'],idempotency_key:randomUUID()});

describe('document replacement, text editing and version history',()=>{
  let database:TestDatabase,seed:TestSeed,bookings:BookingsService,versions:DocumentVersionsService,booking:string,folder:string;
  let app:NestExpressApplication,base:string,adminCookie:string,customerCookie:string;
  before(async()=>{
    database=await setupTestDatabase();seed=await database.seed();await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1",[seed.orgId]);
    const access=new AccessService(database.db);seed.admin=await access.membership(seed.adminId,seed.orgId);
    bookings=new BookingsService(database.db,access);versions=new DocumentVersionsService(database.db,access);
    booking=(await bookings.create(seed.admin,seed.customerId,bookingInput())).id as string;
    folder=(await bookings.files(seed.admin,seed.customerId,booking)).items.find(node=>node.serviceKey==='makkah')!.id;
    app=await createApp({database:database.db,logger:false});await app.listen(0,'127.0.0.1');base=await app.getUrl();
    adminCookie=`${config.sessionCookie}=${await app.get(AuthService).createSession(seed.adminId)}`;
    customerCookie=`${config.sessionCookie}=${await app.get(AuthService).createSession(seed.customerUserId)}`;
  });
  after(async()=>{await app?.close();await database?.close();});
  const upload=(name='notes.txt',bytes=Buffer.from('original'))=>bookings.upload(seed.admin,seed.customerId,booking,folder,name,randomUUID(),bytes);
  const replace=(id:string,bytes:Buffer,expected=1,key=randomUUID(),name='notes.txt')=>versions.proxy(seed.admin,seed.customerId,booking,id,folder,name,key,expected,bytes);
  const path=(id:string)=>`${base}/api/organizations/${seed.orgId}/customers/${seed.customerId}/bookings/${booking}/documents/${id}`;

  it('keeps one public document, immutable prior bytes, audited revisions and retry-safe saves',async()=>{
    const file=await upload();const key=randomUUID();const bytes=Buffer.from('updated\nUTF-8 café');
    const saved=await replace(file.id,bytes,1,key);
    assert.equal(saved.id,file.id);assert.equal(saved.version,2);
    assert.equal((await replace(file.id,bytes,1,key)).version,2);
    assert.deepEqual((await versions.download(seed.customerMember,seed.customerId,booking,file.id,1)).content,Buffer.from('original'));
    assert.deepEqual((await bookings.document(seed.customerMember,seed.customerId,booking,file.id)).content,bytes);
    assert.equal((await versions.history(seed.customerMember,seed.customerId,booking,file.id)).items.length,2);
    assert.equal((await database.db.query("SELECT count(*)::int AS n FROM audit_events WHERE object_id=$1 AND action='document.replaced'",[file.id])).rows[0].n,1);
    await assert.rejects(replace(file.id,Buffer.from('different'),1,key),/different replacement/);
    const restored=await versions.restore(seed.admin,seed.customerId,booking,file.id,1,{expected_version:2});
    assert.equal(restored.version,3);assert.equal((await versions.text(seed.admin,seed.customerId,booking,file.id)).text,'original');
    assert.deepEqual((await versions.download(seed.admin,seed.customerId,booking,file.id,2)).content,bytes);
    await assert.rejects(versions.restore(seed.admin,seed.customerId,booking,file.id,1,{expected_version:2}),/newer version/);
  });
  it('rejects competing stale edits without altering the saved bytes or version count',async()=>{
    const file=await upload();const responses=await Promise.allSettled([replace(file.id,Buffer.from('writer one')),replace(file.id,Buffer.from('writer two'))]);
    assert.equal(responses.filter(result=>result.status==='fulfilled').length,1);
    const rejected=responses.find(result=>result.status==='rejected') as PromiseRejectedResult;
    assert.match(String(rejected.reason),/newer version/);
    assert.equal((await versions.history(seed.admin,seed.customerId,booking,file.id)).items.length,2);
  });
  it('rolls snapshot, replacement and audit back together and retries the original submission',async()=>{
    const file=await upload();const key=randomUUID();
    await database.db.query(`CREATE FUNCTION version_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='document.replaced' THEN RAISE EXCEPTION 'simulated version audit failure'; END IF; RETURN NEW; END; $$`);
    await database.db.query('CREATE TRIGGER version_reject_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION version_reject_audit()');
    try {await assert.rejects(replace(file.id,Buffer.from('changed'),1,key),/simulated version audit failure/);} finally {await database.db.query('DROP TRIGGER version_reject_audit ON audit_events');await database.db.query('DROP FUNCTION version_reject_audit()');}
    assert.equal((await versions.history(seed.admin,seed.customerId,booking,file.id)).items.length,1);
    assert.equal((await versions.text(seed.admin,seed.customerId,booking,file.id)).text,'original');
    assert.equal((await replace(file.id,Buffer.from('changed'),1,key)).version,2);
  });
  it('enforces authorization, booking ownership, safe UTF-8 editor bounds and archive restrictions',async()=>{
    const file=await upload();
    await assert.rejects(versions.proxy(seed.customerMember,seed.customerId,booking,file.id,folder,'notes.txt',randomUUID(),1,Buffer.from('bad')),/administrator/);
    await assert.rejects(versions.history(seed.otherAdmin,seed.customerId,booking,file.id),/not found/);
    await assert.rejects(versions.history(seed.customerMember,seed.secondCustomerId,booking,file.id),/not found/);
    await assert.rejects(versions.restore(seed.customerMember,seed.customerId,booking,file.id,1,{expected_version:1}),/administrator/);
    await assert.rejects(replace(file.id,Buffer.from('bad'),1,randomUUID(),'notes.pdf'),/same file extension/);
    for(const [name,bytes,reason] of [['invalid.txt',Buffer.from([0xff,0xfe]),/UTF-8/],['binary.txt',Buffer.from([97,0]),/control characters/],['large.md',Buffer.alloc(256*1024+1,97),/256 KB/],['word.docx',Buffer.from('content'),/Replace file/]] as const) {
      const item=await upload(name,bytes);await assert.rejects(versions.text(seed.admin,seed.customerId,booking,item.id),reason);
    }
    await database.db.query("UPDATE customers SET status='archived' WHERE id=$1",[seed.customerId]);
    try {await assert.rejects(replace(file.id,Buffer.from('archived')),/Restore this customer/);}finally{await database.db.query("UPDATE customers SET status='active' WHERE id=$1",[seed.customerId]);}
  });
  it('HTTP replacement and history enforce sessions, CSRF, role boundaries and download headers',async()=>{
    const file=await upload();const url=path(file.id);const bytes=Buffer.from('from HTTP');
    assert.equal((await fetch(`${url}/versions`)).status,401);
    const target=`${base}/api/organizations/${seed.orgId}/customers/${seed.customerId}/bookings/${booking}/folders/${folder}/documents/${file.id}/content`;
    const headers={Cookie:adminCookie,Origin:config.appUrl,'X-CSRF-Protection':'1','Content-Type':'application/octet-stream','X-File-Name':'notes.txt','Idempotency-Key':randomUUID(),'X-Document-Version':'1'};
    const response=await fetch(target,{method:'POST',headers,body:bytes});assert.equal(response.status,201,await response.clone().text());assert.equal((await response.json()).version,2);
    assert.equal((await fetch(target,{method:'POST',headers:{...headers,Cookie:customerCookie},body:bytes})).status,403);
    assert.equal((await fetch(`${url}/versions/1/restore`,{method:'POST',headers:{Cookie:adminCookie,'Content-Type':'application/json'},body:'{"expected_version":2}'})).status,403);
    assert.equal((await fetch(`${url}/text`,{headers:{Cookie:customerCookie}})).status,403);
    assert.equal((await fetch(`${url}/versions`,{headers:{Cookie:customerCookie}})).status,200);
    const old=await fetch(`${url}/versions/1`,{headers:{Cookie:customerCookie}});assert.equal(old.status,200);assert.equal(await old.text(),'original');
    assert.equal(old.headers.get('cache-control'),'private, no-store');assert.match(old.headers.get('content-disposition')!,/^attachment/);assert.equal(old.headers.get('x-content-type-options'),'nosniff');
    assert.equal((await fetch(`${url}/versions/999`,{headers:{Cookie:customerCookie}})).status,404);
  });
  it('deleting a document and permanently deleting its customer cascade all database versions and attempts',async()=>{
    const file=await upload();await replace(file.id,Buffer.from('revised'));await bookings.remove(seed.admin,seed.customerId,booking,file.id);
    assert.equal((await database.db.query('SELECT * FROM document_versions WHERE document_id=$1',[file.id])).rowCount,0);
    assert.equal((await database.db.query('SELECT * FROM document_version_uploads WHERE document_id=$1',[file.id])).rowCount,0);
    await new AccountDeletionService(database.db,new AccessService(database.db)).removeCustomer(seed.admin,seed.customerId,'customer@example.test');
    assert.equal((await database.db.query('SELECT * FROM document_versions')).rowCount,0);assert.equal((await database.db.query('SELECT * FROM document_version_uploads')).rowCount,0);
  });
});

describe('replacement uploads through the real R2 SDK and raw HTTP storage simulation',()=>{
  let database:TestDatabase,seed:TestSeed,bookings:BookingsService,versions:DocumentVersionsService,storage:DocumentStorage,server:Server,booking:string,folder:string;
  const objects=new Map<string,Buffer>();let failDelete=false;const calls:string[]=[];
  before(async()=>{
    server=createServer((req,res)=>{void(async()=>{
      const url=new URL(req.url!,'http://127.0.0.1');const path=decodeURIComponent(url.pathname);calls.push(req.method!);
      if(!req.headers.authorization?.startsWith('AWS4-HMAC-SHA256 ') && !url.searchParams.has('X-Amz-Signature')) {res.writeHead(403).end();return;}
      if(req.method==='PUT') {
        const parts:Buffer[]=[];for await(const chunk of req)parts.push(Buffer.from(chunk));const bytes=Buffer.concat(parts);
        if(req.headers['if-none-match']==='*' && objects.has(path)){res.writeHead(412).end();return;}
        objects.set(path,bytes);res.writeHead(200,{ETag:'"fixture"'}).end();
      }else if(req.method==='GET') {
        const bytes=objects.get(path);if(!bytes)res.writeHead(404,{'Content-Type':'application/xml'}).end('<Error><Code>NoSuchKey</Code></Error>');else res.writeHead(200,{'Content-Length':bytes.length}).end(bytes);
      }else if(req.method==='DELETE') {if(failDelete)res.writeHead(503,{'Content-Type':'application/xml'}).end('<Error><Code>ServiceUnavailable</Code></Error>');else{objects.delete(path);res.writeHead(204).end();}}
      else res.writeHead(501).end();
    })().catch(()=>res.writeHead(500).end());});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    storage=new DocumentStorage({mode:'r2',bucket:'versions-development',region:'auto',endpoint:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,forcePathStyle:true,credentials:{accessKeyId:'synthetic',secretAccessKey:'synthetic'}});
    database=await setupTestDatabase();seed=await database.seed();await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1",[seed.orgId]);
    const access=new AccessService(database.db);seed.admin=await access.membership(seed.adminId,seed.orgId);bookings=new BookingsService(database.db,access,storage);versions=new DocumentVersionsService(database.db,access,storage);
    booking=(await bookings.create(seed.admin,seed.customerId,bookingInput())).id as string;folder=(await bookings.files(seed.admin,seed.customerId,booking)).items.find(node=>node.serviceKey==='makkah')!.id;
  });
  after(async()=>{storage?.onApplicationShutdown();server?.closeAllConnections();await new Promise<void>(resolve=>server?.close(()=>resolve()));await database?.close();});
  const upload=()=>bookings.upload(seed.admin,seed.customerId,booking,folder,'binary.docx',randomUUID(),Buffer.from([0x50,0x4b,0xff,0]));
  async function ticket(id:string,bytes:Buffer,expected=1) {
    const result=await versions.begin(seed.admin,seed.customerId,booking,id,folder,{name:'binary.docx',size:bytes.length,sha256:hash(bytes),idempotency_key:randomUUID(),expected_version:expected});
    assert.equal(result.transport,'direct');if(result.transport!=='direct')throw Error('Expected direct upload');return result;
  }
  it('never overwrites prior objects, validates binary checksums, restores history and handles retry',async()=>{
    const file=await upload();const bytes=Buffer.from([0x50,0x4b,0x80,0xff,12,0]);const prepared=await ticket(file.id,bytes);
    assert.match(new URL(prepared.url).searchParams.get('X-Amz-SignedHeaders')!,/if-none-match/);
    assert.equal((await fetch(prepared.url,{method:'PUT',headers:prepared.headers,body:bytes})).status,200);
    assert.equal((await fetch(prepared.url,{method:'PUT',headers:prepared.headers,body:Buffer.alloc(bytes.length)})).status,412);
    const saved=await versions.complete(seed.admin,seed.customerId,booking,file.id,folder,prepared.uploadId);assert.equal(saved.version,2);
    assert.equal((await versions.complete(seed.admin,seed.customerId,booking,file.id,folder,prepared.uploadId)).version,2);
    assert.deepEqual((await versions.download(seed.customerMember,seed.customerId,booking,file.id,2)).content,bytes);
    const old=(await versions.download(seed.customerMember,seed.customerId,booking,file.id,1)).content;assert.deepEqual(old,Buffer.from([0x50,0x4b,0xff,0]));assert.equal(objects.size,2);
    await versions.restore(seed.admin,seed.customerId,booking,file.id,1,{expected_version:2});assert.deepEqual((await bookings.document(seed.customerMember,seed.customerId,booking,file.id)).content,old);
    await database.db.query("UPDATE document_objects SET created_at=now()-interval '25 hours'");
    assert.deepEqual(await cleanupDocumentObjects(database.db,storage),{removed:0,failed:0},'Both current and historical ready objects remain protected.');
    await bookings.remove(seed.admin,seed.customerId,booking,file.id);
    assert.equal((await database.db.query('SELECT * FROM document_objects')).rowCount,0);
    assert.equal((await database.db.query('SELECT * FROM document_versions')).rowCount,0);
    await database.db.query("UPDATE document_purge_outbox SET created_at=now()-interval '25 hours'");failDelete=true;
    try{assert.deepEqual(await cleanupDocumentObjects(database.db,storage),{removed:0,failed:2});}finally{failDelete=false;}
    assert.equal(objects.size,2);assert.deepEqual(await cleanupDocumentObjects(database.db,storage),{removed:2,failed:0});assert.equal(objects.size,0);
  });
  it('rejects corrupt, stale and revoked attempts before publication and cleans orphan objects',async()=>{
    const file=await upload();const bytes=Buffer.from('replacement');const prepared=await ticket(file.id,bytes);
    await fetch(prepared.url,{method:'PUT',headers:prepared.headers,body:Buffer.from('corrupt----')});
    await assert.rejects(versions.complete(seed.admin,seed.customerId,booking,file.id,folder,prepared.uploadId),/size or checksum/);
    assert.equal((await versions.history(seed.admin,seed.customerId,booking,file.id)).items.length,1);
    const one=await ticket(file.id,bytes),two=await ticket(file.id,Buffer.from('second'));
    await fetch(one.url,{method:'PUT',headers:one.headers,body:bytes});await fetch(two.url,{method:'PUT',headers:two.headers,body:Buffer.from('second')});
    await versions.complete(seed.admin,seed.customerId,booking,file.id,folder,one.uploadId);
    await assert.rejects(versions.complete(seed.admin,seed.customerId,booking,file.id,folder,two.uploadId),/newer version/);
    const pending=await ticket(file.id,Buffer.from('pending'),2);await fetch(pending.url,{method:'PUT',headers:pending.headers,body:Buffer.from('pending')});
    await database.db.query('UPDATE memberships SET is_active=false WHERE user_id=$1 AND organization_id=$2',[seed.adminId,seed.orgId]);
    try{await assert.rejects(versions.complete(seed.admin,seed.customerId,booking,file.id,folder,pending.uploadId),/not available|access|membership/i);}finally{await database.db.query('UPDATE memberships SET is_active=true WHERE user_id=$1 AND organization_id=$2',[seed.adminId,seed.orgId]);}
    await database.db.query("UPDATE document_objects SET created_at=now()-interval '25 hours'");
    assert.deepEqual(await cleanupDocumentObjects(database.db,storage),{removed:3,failed:0});assert.equal(objects.size,2);
    await new AccountDeletionService(database.db,new AccessService(database.db)).removeCustomer(seed.admin,seed.customerId,'customer@example.test');
    assert.equal((await database.db.query('SELECT * FROM document_objects')).rowCount,0);assert.equal((await database.db.query('SELECT * FROM document_versions')).rowCount,0);
    await database.db.query("UPDATE document_purge_outbox SET created_at=now()-interval '25 hours'");assert.deepEqual(await cleanupDocumentObjects(database.db,storage),{removed:2,failed:0});assert.equal(objects.size,0);
    assert.ok(calls.includes('PUT')&&calls.includes('GET')&&calls.includes('DELETE'));
  });
});
