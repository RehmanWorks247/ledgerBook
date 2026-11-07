import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { createApp } from '../apps/api/src/app';
import { config } from '../apps/api/src/config';
import { LedgerService } from '../apps/api/src/ledger/ledger.service';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

const pdf = (label:string) => Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Title (${label}) >>\nendobj\n%%EOF\n`);
const input = (reference:string) => ({reference,departure_at:'2026-11-12T10:30:00+00:00',required_services:['makkah'],amount:'100.00',effective_date:'2026-11-01',
  instalments:[{due_date:'2026-11-02',amount:'40.00'},{due_date:'2026-11-09',amount:'60.00'}],idempotency_key:randomUUID()});

describe('booking folders, transactional PDF storage and document access', () => {
  let database:TestDatabase;
  let seed:TestSeed;
  let bookings:BookingsService;
  let app:NestExpressApplication;
  let base:string;
  let adminCookie:string;
  let customerCookie:string;
  let first:string;
  let second:string;
  let otherCustomerBooking:string;
  let firstFolder:string;
  let secondFolder:string;
  let firstDocument:string;

  before(async () => {
    database = await setupTestDatabase();
    seed = await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1",[seed.orgId]);
    const access = new AccessService(database.db);
    seed.admin = await access.membership(seed.adminId,seed.orgId);
    seed.customerMember = await access.membership(seed.customerUserId,seed.orgId);
    bookings = new BookingsService(database.db,access);
    first = (await bookings.create(seed.admin,seed.customerId,input('TRIP-ONE'))).id as string;
    second = (await bookings.create(seed.admin,seed.customerId,input('TRIP-TWO'))).id as string;
    otherCustomerBooking = (await bookings.create(seed.admin,seed.secondCustomerId,input('TRIP-OTHER'))).id as string;
    firstFolder = (await bookings.files(seed.admin,seed.customerId,first)).items.find(item => item.serviceKey === 'makkah')!.id;
    secondFolder = (await bookings.files(seed.admin,seed.customerId,second)).items.find(item => item.serviceKey === 'makkah')!.id;
    app = await createApp({database:database.db,logger:false});
    await app.listen(0,'127.0.0.1');
    base = await app.getUrl();
    adminCookie = `${config.sessionCookie}=${await app.get(AuthService).createSession(seed.adminId)}`;
    customerCookie = `${config.sessionCookie}=${await app.get(AuthService).createSession(seed.customerUserId)}`;
  });
  after(async () => {
    if (app) await app.close();
    if (database) await database.close();
  });
  const path = (customerId:string,bookingId:string) => `/api/organizations/${seed.orgId}/customers/${customerId}/bookings/${bookingId}`;

  it('creates GBP charges and complete schedules atomically, safely retries bookings, and counts two independent trips',async () => {
    const request = input('TRIP-RETRY');
    const [one,two] = await Promise.all([bookings.create(seed.admin,seed.customerId,request),bookings.create(seed.admin,seed.customerId,request)]);
    assert.equal(one.id,two.id);
    assert.equal(one.total_minor,'10000');
    assert.equal(one.currency,'GBP');
    assert.equal(one.instalments.length,2);
    assert.equal((await bookings.files(seed.admin,seed.customerId,one.id as string)).items.length,6);
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM ledger_entries WHERE reference=$1',[request.reference])).rows[0].n,1);
    await assert.rejects(bookings.create(seed.admin,seed.customerId,{...request,amount:'101'}),/Instalments/);
    await assert.rejects(bookings.create(seed.admin,seed.customerId,{...request,reference:'CHANGED'}),/submission key/);
    const beforeCount = (await database.db.query('SELECT count(*)::int AS n FROM ledger_entries')).rows[0].n;
    await assert.rejects(bookings.create(seed.admin,seed.customerId,input('TRIP-ONE')));
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM ledger_entries')).rows[0].n,beforeCount,'Duplicate booking reference rolls back its charge.');
    await assert.rejects(bookings.create(seed.otherAdmin,seed.otherCustomerId,input('NON-GBP')),/GBP accounting workspace/);
    await assert.rejects(bookings.create(seed.customerMember,seed.customerId,input('CUSTOMER-WRITE')),/administrator/);
    assert.equal((await bookings.list(seed.customerMember,seed.customerId)).items.length,3);
  });

  it('keeps the same customer’s two hotel vouchers separate and default-folder repair preserves files',async () => {
    const key = randomUUID();
    const [one,retry] = await Promise.all([
      bookings.upload(seed.admin,seed.customerId,first,firstFolder,'Makkah voucher.pdf',key,pdf('first trip')),
      bookings.upload(seed.admin,seed.customerId,first,firstFolder,'Makkah voucher.pdf',key,pdf('first trip')),
    ]);
    firstDocument = one.id;
    const two = await bookings.upload(seed.admin,seed.customerId,second,secondFolder,'Makkah voucher.pdf',randomUUID(),pdf('second trip'));
    assert.equal(one.id,retry.id);
    assert.notEqual(one.id,two.id);
    assert.deepEqual((await bookings.document(seed.customerMember,seed.customerId,first,one.id)).content,pdf('first trip'));
    assert.deepEqual((await bookings.document(seed.customerMember,seed.customerId,second,two.id)).content,pdf('second trip'));
    await assert.rejects(bookings.document(seed.customerMember,seed.customerId,second,one.id),/not found/);
    const empty = (await bookings.files(seed.admin,seed.customerId,first)).items.find(item => item.serviceKey === 'extras')!;
    await database.db.query('DELETE FROM booking_nodes WHERE id=$1',[empty.id]);
    await database.db.query('UPDATE booking_nodes SET default_folder=false WHERE id=$1',[firstFolder]);
    await bookings.files(seed.customerMember,seed.customerId,first);
    const repaired = await bookings.files(seed.customerMember,seed.customerId,first);
    assert.equal(repaired.items.filter(item => item.defaultFolder).length,6);
    assert.equal(repaired.items.filter(item => item.kind === 'file').length,1);
    assert.equal(repaired.items.find(item => item.serviceKey === 'makkah' && item.kind === 'folder')!.id,firstFolder);
    assert.equal(repaired.items.find(item => item.id === firstFolder)!.issuedAt,null,'Uploading is distinct from service issuance.');
    await bookings.issuance(seed.admin,seed.customerId,first,'makkah',{issued:true});
    assert.ok((await bookings.files(seed.admin,seed.customerId,first)).items.find(item => item.id === firstFolder)!.issuedAt);
  });

  it('rejects missing, cross-customer, cross-booking and unauthorized upload destinations',async () => {
    const upload = (customerId:string,bookingId:string,folderId:string) => bookings.upload(seed.admin,customerId,bookingId,folderId,'voucher.pdf',randomUUID(),pdf('invalid context'));
    const count = (await database.db.query('SELECT count(*)::int AS n FROM booking_nodes WHERE kind=\'file\'')).rows[0].n;
    await assert.rejects(upload(seed.customerId,first,''),/valid document or folder/);
    await assert.rejects(upload(seed.secondCustomerId,first,firstFolder),/Booking was not found/);
    await assert.rejects(upload(seed.customerId,first,secondFolder),/not found in this booking/);
    await assert.rejects(upload(seed.customerId,'',firstFolder),/valid booking/);
    await assert.rejects(bookings.upload(seed.customerMember,seed.customerId,first,firstFolder,'voucher.pdf',randomUUID(),pdf('customer write')),/administrator/);
    await assert.rejects(bookings.upload(seed.otherAdmin,seed.customerId,first,firstFolder,'voucher.pdf',randomUUID(),pdf('other tenant')),/not found/);
    await assert.rejects(bookings.upload(seed.admin,seed.customerId,first,firstFolder,'voucher.pdf',randomUUID(),Buffer.from('not a PDF')),/valid PDF/);
    await assert.rejects(bookings.upload(seed.admin,seed.customerId,first,firstFolder,'empty.txt',randomUUID(),Buffer.alloc(0)),/non-empty file/);
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM booking_nodes WHERE kind=\'file\'')).rows[0].n,count);
  });

  it('rolls bytes, metadata and audit back together on failure and permits a clean retry',async () => {
    const key = randomUUID();
    await database.db.query(`CREATE FUNCTION test_reject_upload() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='document.uploaded' THEN RAISE EXCEPTION 'simulated persistence failure'; END IF; RETURN NEW; END; $$;`);
    await database.db.query('CREATE TRIGGER test_reject_upload BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_reject_upload()');
    await assert.rejects(bookings.upload(seed.admin,seed.customerId,first,firstFolder,'retry.pdf',key,pdf('retry')),/simulated persistence failure/);
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM booking_nodes WHERE idempotency_key=$1',[key])).rows[0].n,0);
    await database.db.query('DROP TRIGGER test_reject_upload ON audit_events');
    await database.db.query('DROP FUNCTION test_reject_upload()');
    const saved = await bookings.upload(seed.admin,seed.customerId,first,firstFolder,'retry.pdf',key,pdf('retry'));
    assert.deepEqual((await bookings.document(seed.admin,seed.customerId,first,saved.id)).content,pdf('retry'));
    await assert.rejects(bookings.upload(seed.admin,seed.customerId,first,firstFolder,'retry.pdf',key,pdf('changed')),/different upload/);
  });

  it('preserves folder controls, prevents cycles and moves documents only within the selected booking’s service folders',async () => {
    const request = {name:'Hotel details',parent_id:firstFolder,idempotency_key:randomUUID()};
    const folder = await bookings.createFolder(seed.admin,seed.customerId,first,request);
    assert.equal((await bookings.createFolder(seed.admin,seed.customerId,first,request)).id,folder.id);
    const child = await bookings.createFolder(seed.admin,seed.customerId,first,{name:'Travel party',parent_id:folder.id,idempotency_key:randomUUID()});
    const file = await bookings.upload(seed.admin,seed.customerId,first,child.id,'party.pdf',randomUUID(),pdf('party'));
    await assert.rejects(bookings.move(seed.admin,seed.customerId,first,folder.id,{parent_id:child.id}),/subfolders/);
    await assert.rejects(bookings.move(seed.admin,seed.customerId,first,folder.id,{parent_id:null}),/service folder/);
    await assert.rejects(bookings.move(seed.admin,seed.customerId,first,firstFolder,{parent_id:folder.id}),/booking root/);
    await assert.rejects(bookings.move(seed.admin,seed.customerId,first,file.id,{parent_id:secondFolder}),/not found/);
    const extras = (await bookings.files(seed.admin,seed.customerId,first)).items.find(item => item.serviceKey === 'extras')!;
    await bookings.move(seed.admin,seed.customerId,first,folder.id,{parent_id:extras.id});
    const nodes = (await bookings.files(seed.admin,seed.customerId,first)).items;
    assert.equal(nodes.find(item => item.id === file.id)!.serviceKey,'extras');
    assert.equal(nodes.find(item => item.id === child.id)!.parentId,folder.id);
    assert.deepEqual((await bookings.document(seed.customerMember,seed.customerId,first,file.id)).content,pdf('party'));
  });

  it('enforces sessions, CSRF and ownership on HTTP lists, uploads, inline PDF previews and downloads',async () => {
    const url = `${base}${path(seed.customerId,first)}`;
    assert.equal((await fetch(`${url}/files`)).status,401);
    const listing = await fetch(`${url}/files`,{headers:{Cookie:customerCookie}});
    assert.equal(listing.status,200);
    assert.match(listing.headers.get('content-security-policy')!,/object-src 'none'/);
    assert.equal((await fetch(`${base}${path(seed.secondCustomerId,otherCustomerBooking)}/files`,{headers:{Cookie:customerCookie}})).status,404);
    assert.equal((await fetch(`${base}${path(seed.secondCustomerId,first)}/documents/${firstDocument}`,{headers:{Cookie:customerCookie}})).status,404);
    const inline = await fetch(`${url}/documents/${firstDocument}`,{headers:{Cookie:customerCookie}});
    assert.equal(inline.status,200);
    assert.match(inline.headers.get('content-type')!,/application\/pdf/);
    assert.match(inline.headers.get('content-disposition')!,/^inline/);
    assert.match(inline.headers.get('content-security-policy')!,/object-src 'self'/);
    assert.match(inline.headers.get('content-security-policy')!,/frame-ancestors 'none'/);
    assert.match(inline.headers.get('content-security-policy')!,/script-src 'self'/);
    assert.equal(inline.headers.get('x-content-type-options'),'nosniff');
    assert.equal(inline.headers.get('cache-control'),'private, no-store');
    assert.deepEqual(Buffer.from(await inline.arrayBuffer()),pdf('first trip'));
    const downloaded = await fetch(`${url}/documents/${firstDocument}?download=1`,{headers:{Cookie:customerCookie}});
    assert.match(downloaded.headers.get('content-disposition')!,/^attachment/);
    assert.match(downloaded.headers.get('content-security-policy')!,/object-src 'none'/);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),pdf('first trip'));
    const uploadUrl = `${url}/folders/${firstFolder}/documents`;
    const headers = {Cookie:adminCookie,Origin:config.appUrl,'X-CSRF-Protection':'1','Content-Type':'application/pdf','X-File-Name':encodeURIComponent('HTTP voucher.pdf'),'Idempotency-Key':randomUUID()};
    const uploaded = await fetch(uploadUrl,{method:'POST',headers,body:pdf('http')});
    assert.equal(uploaded.status,201,await uploaded.clone().text());
    const saved = await uploaded.json();
    assert.equal(saved.kind,'file');
    const repeated = await fetch(uploadUrl,{method:'POST',headers,body:pdf('http')});
    assert.equal((await repeated.json()).id,saved.id);
    assert.equal((await fetch(uploadUrl,{method:'POST',headers:{...headers,Cookie:customerCookie},body:pdf('http')})).status,403);
    assert.equal((await fetch(uploadUrl,{method:'POST',headers:{...headers,Origin:'https://other.example'},body:pdf('http')})).status,403);
    const wrong = `${base}${path(seed.customerId,second)}/folders/${firstFolder}/documents`;
    assert.equal((await fetch(wrong,{method:'POST',headers,body:pdf('http')})).status,404);
    await database.db.query('UPDATE memberships SET is_active=false WHERE user_id=$1 AND organization_id=$2',[seed.customerUserId,seed.orgId]);
    assert.equal((await fetch(`${url}/documents/${firstDocument}?download=1`,{headers:{Cookie:customerCookie}})).status,404);
    await database.db.query('UPDATE memberships SET is_active=true WHERE user_id=$1 AND organization_id=$2',[seed.customerUserId,seed.orgId]);
  });

  it('enforces charge customer, amount and creator associations for direct database writes too',async () => {
    const ledger = new LedgerService(database.db,new AccessService(database.db));
    const charge = await ledger.post(seed.admin,seed.secondCustomerId,{kind:'charge',amount:'50.00',effective_date:'2026-11-06',description:'Integrity test charge',idempotency_key:randomUUID()});
    const insert = (customerId:string,amount:string,creator:string) => database.db.query(`
      INSERT INTO bookings(id,organization_id,customer_id,reference,departure_at,total_minor,charge_entry_id,created_by,idempotency_key,request_hash)
      VALUES($1,$2,$3,$4,'2026-11-12T10:30:00Z',$5,$6,$7,$8,$9)`,
      [randomUUID(),seed.orgId,customerId,`INTEGRITY-${randomUUID()}`,amount,charge.id,creator,randomUUID(),'0'.repeat(64)]);
    await assert.rejects(insert(seed.customerId,'5000',seed.adminId),/must match its customer GBP ledger charge/);
    await assert.rejects(insert(seed.secondCustomerId,'5100',seed.adminId),/must match its customer GBP ledger charge/);
    await assert.rejects(insert(seed.secondCustomerId,'5000',seed.otherAdminId),/booking_creator_membership/);
    const payment = await ledger.post(seed.admin,seed.secondCustomerId,{kind:'payment',amount:'5.00',effective_date:'2026-11-06',description:'Integrity test payment',idempotency_key:randomUUID()});
    await assert.rejects(database.db.query('UPDATE bookings SET charge_entry_id=$1 WHERE id=$2',[payment.id,otherCustomerBooking]),/must match its customer GBP ledger charge/);
    await assert.rejects(database.db.query('UPDATE booking_nodes SET created_by=$1 WHERE id=$2',[seed.otherAdminId,firstFolder]),/Booking creator attribution is immutable/);
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM bookings WHERE charge_entry_id=$1',[charge.id])).rows[0].n,0);
  });

  it('rejects unauthorized and oversized uploads before waiting for any file bytes',async()=>{
    const url=`${base}${path(seed.customerId,first)}/folders/${firstFolder}/documents`;
    const headers={Origin:config.appUrl,'X-CSRF-Protection':'1','Content-Type':'application/pdf',
      'X-File-Name':'voucher.pdf','Idempotency-Key':randomUUID(),'Content-Length':'1048576'};
    const withoutBody=(extra:Record<string,string>)=>new Promise<number>((resolve,reject)=>{
      const request=httpRequest(url,{method:'POST',headers:{...headers,...extra}},response=>{
        response.resume();
        response.on('end',()=>{resolve(response.statusCode!);request.destroy();});
      });
      request.on('error',reject);
      request.setTimeout(2500,()=>{request.destroy();reject(new Error('Upload tried to read bytes before rejecting headers/access.'));});
      request.flushHeaders();
    });
    assert.equal(await withoutBody({}),401);
    assert.equal(await withoutBody({Cookie:customerCookie}),403);
    assert.equal(await withoutBody({Cookie:adminCookie,'Content-Length':'10485761'}),413);
    assert.equal(await withoutBody({Cookie:adminCookie,'Content-Encoding':'gzip'}),415);
    assert.equal(await withoutBody({Cookie:adminCookie,'Idempotency-Key':'invalid'}),400);
  });
});
