import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import { createApp } from '../apps/api/src/app';
import { AccessService } from '../apps/api/src/access/access.service';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { config } from '../apps/api/src/config';
import { businessDate } from '../apps/api/src/dashboard/time';
import { LedgerService } from '../apps/api/src/ledger/ledger.service';
import { PaymentEmailOutbox } from '../apps/api/src/payments/email-outbox.service';
import { NotificationsService } from '../apps/api/src/notifications/notifications.service';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

describe('payment multipart upload, protected image delivery and approval HTTP contracts', () => {
  let database:TestDatabase;
  let seed:TestSeed;
  let app:NestExpressApplication;
  let base:string;
  let inProcess = false;
  let adminCookie:string;
  let customerCookie:string;
  let otherAdminCookie:string;
  let first:string;
  let second:string;
  let foreignCustomerBooking:string;
  let png:Buffer;
  let imageNumber = 0;
  let mail:NotificationsService;
  let originalSend:NotificationsService['send'];
  let requestSends=0;

  before(async () => {
    database = await setupTestDatabase();
    seed = await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1",[seed.orgId]);
    const access = new AccessService(database.db);
    const bookings = new BookingsService(database.db,access);
    seed.admin = await access.membership(seed.adminId,seed.orgId);
    const create = async (customer:string) => (await bookings.create(seed.admin,customer,{
      reference:`HTTP-PAY-${randomUUID()}`,departure_at:'2030-01-01T12:00:00Z',amount:'100.00',
      required_services:[],effective_date:businessDate(),idempotency_key:randomUUID(),
    })).id as string;
    first = await create(seed.customerId);
    second = await create(seed.customerId);
    foreignCustomerBooking = await create(seed.secondCustomerId);
    png = await sharp({create:{width:30,height:24,channels:3,background:'#123456'}}).png().toBuffer();
    app = await createApp({database:database.db,logger:false,paymentEmails:false});
    mail=app.get(NotificationsService);
    originalSend=mail.send.bind(mail);
    mail.send=async()=>{requestSends++;throw new Error('Payment requests must queue email instead of sending it inline.');};
    adminCookie = `${config.sessionCookie}=${await app.get(AuthService).createSession(seed.adminId)}`;
    customerCookie = `${config.sessionCookie}=${await app.get(AuthService).createSession(seed.customerUserId)}`;
    otherAdminCookie = `${config.sessionCookie}=${await app.get(AuthService).createSession(seed.otherAdminId)}`;
    try { await app.listen(0,'127.0.0.1'); base = await app.getUrl(); }
    catch (error) {
      const code = (error as {code?:string}).code;
      if (!['EACCES','EPERM'].includes(code ?? '') || process.env.CI || process.env.TEST_DATABASE_URL) throw error;
      inProcess = true;
      console.info('Payment HTTP tests exercise real Nest/Express through native HTTP injection because loopback is unavailable.');
    }
  });
  after(async () => { if (app) await app.close(); if (database) await database.close(); });

  const endpoint = (bookingId=first,customerId=seed.customerId) =>
    `/api/organizations/${seed.orgId}/customers/${customerId}/bookings/${bookingId}/payments`;
  const reviewEndpoint = () => `/api/organizations/${seed.orgId}/payment-submissions`;
  const authHeaders = (cookie=customerCookie) => ({Cookie:cookie,Origin:config.appUrl,'X-CSRF-Protection':'1'});

  function inject(path:string,method:string,headers:Headers,body?:Buffer):Promise<Response> {
    const chunks:Buffer[] = [];
    const socket = new Duplex({read() {},write(chunk:Buffer,_encoding,callback) {chunks.push(Buffer.from(chunk));callback();}});
    Object.defineProperty(socket,'remoteAddress',{value:'127.0.0.1'});
    const incoming = new IncomingMessage(socket as Socket);
    incoming.method = method;
    incoming.url = path;
    incoming.httpVersion = '1.1'; incoming.httpVersionMajor=1; incoming.httpVersionMinor=1; incoming.complete=true;
    incoming.headers = Object.fromEntries(headers.entries());
    incoming.headers.host = 'localhost'; incoming.headers.connection = 'close';
    if (body) incoming.headers['content-length'] = String(body.length);
    const outgoing = new ServerResponse(incoming);
    outgoing.assignSocket(socket as Socket);
    return new Promise((resolve,reject) => {
      const timeout = setTimeout(() => reject(new Error('Payment HTTP request timed out.')),10000);
      outgoing.once('error',error => {clearTimeout(timeout);reject(error);});
      outgoing.once('finish',() => {
        clearTimeout(timeout);
        try {
          const raw = Buffer.concat(chunks);
          const boundary = raw.indexOf('\r\n\r\n');
          assert.ok(boundary >= 0);
          assert.notEqual(outgoing.getHeader('transfer-encoding'),'chunked');
          const responseHeaders = new Headers();
          for (const [key,value] of Object.entries(outgoing.getHeaders())) {
            for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) responseHeaders.append(key,String(item));
          }
          resolve(new Response([204,304].includes(outgoing.statusCode) ? null : raw.subarray(boundary+4),{status:outgoing.statusCode,headers:responseHeaders}));
        } catch (error) {reject(error);} finally {socket.destroy();}
      });
      if (body) incoming.push(body);
      incoming.push(null);
      app.getHttpAdapter().getInstance()(incoming,outgoing);
    });
  }
  async function http(path:string,init:RequestInit = {}) {
    if (!inProcess) return fetch(`${base}${path}`,init);
    const encoded = new Request(`http://localhost${path}`,init);
    const body = encoded.body ? Buffer.from(await encoded.arrayBuffer()) : undefined;
    return inject(path,encoded.method,encoded.headers,body);
  }
  async function form(options:{count?:number;key?:string;buffer?:Buffer;type?:string;amount?:string} = {}) {
    const data = new FormData();
    data.set('amount',options.amount ?? '25.00');
    data.set('payment_date',businessDate());
    data.set('note','Receipt submitted through HTTP');
    data.set('idempotency_key',options.key ?? randomUUID());
    for (let index=0;index<(options.count ?? 1);index++) {
      const buffer = options.buffer ?? await sharp({create:{width:30,height:24,channels:3,background:{r:++imageNumber % 256,g:80,b:100}}}).png().toBuffer();
      data.append('receipts',new Blob([new Uint8Array(buffer)],{type:options.type ?? 'image/png'}),`transaction-${index}.png`);
    }
    return data;
  }
  const json = (body:unknown,cookie=adminCookie):RequestInit => ({method:'POST',headers:{...authHeaders(cookie),'Content-Type':'application/json'},body:JSON.stringify(body)});

  it('requires customer authentication, same origin and CSRF protection before accepting uploads', async () => {
    assert.equal((await http(endpoint())).status,401);
    assert.equal((await http(endpoint(),{method:'POST',headers:{Origin:config.appUrl,'X-CSRF-Protection':'1'},body:await form()})).status,401);
    assert.equal((await http(endpoint(),{method:'POST',headers:{Cookie:customerCookie,Origin:config.appUrl},body:await form()})).status,403);
    assert.equal((await http(endpoint(),{method:'POST',headers:{...authHeaders(),Origin:'https://attacker.example'},body:await form()})).status,403);
    assert.equal((await http(endpoint(),{method:'POST',headers:authHeaders(adminCookie),body:await form()})).status,403);
    assert.equal((await http(endpoint(foreignCustomerBooking,seed.secondCustomerId),{method:'POST',headers:authHeaders(),body:await form()})).status,404);
    assert.equal((await http(endpoint(),{method:'POST',headers:authHeaders(otherAdminCookie),body:await form()})).status,404);
  });

  it('accepts a real multipart submission and serves its images only to the customer and organization administrators', async () => {
    const key = randomUUID();
    const upload = await http(endpoint(),{method:'POST',headers:authHeaders(),body:await form({key,buffer:png})});
    assert.equal(upload.status,201,await upload.clone().text());
    const payment = await upload.json();
    assert.equal(payment.status,'pending');
    assert.equal(payment.receipts.length,1);
    const replay = await http(endpoint(),{method:'POST',headers:authHeaders(),body:await form({key,buffer:png})});
    assert.equal(replay.status,201,await replay.clone().text());
    assert.equal((await replay.json()).id,payment.id);
    const imageUrl = payment.receipts[0].url;
    assert.equal((await http(imageUrl)).status,401);
    const image = await http(imageUrl,{headers:{Cookie:customerCookie}});
    assert.equal(image.status,200);
    assert.match(image.headers.get('content-type') ?? '',/image\/webp/);
    assert.match(image.headers.get('content-disposition') ?? '',/^inline/);
    assert.equal(image.headers.get('x-content-type-options'),'nosniff');
    assert.equal(image.headers.get('cache-control'),'private, no-store');
    assert.match(image.headers.get('content-security-policy') ?? '',/object-src 'none'/);
    assert.equal((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).format,'webp');
    assert.equal((await http(imageUrl,{headers:{Cookie:adminCookie}})).status,200);
    assert.equal((await http(imageUrl,{headers:{Cookie:otherAdminCookie}})).status,404);
    assert.equal((await http(imageUrl.replace(first,second),{headers:{Cookie:customerCookie}})).status,404);
    assert.equal((await http(`${endpoint()}/${payment.id}/approve`,json({},customerCookie))).status,403);
    assert.equal((await http(`${endpoint()}/${payment.id}/approve`,{...json({}),headers:{Cookie:adminCookie,Origin:config.appUrl,'Content-Type':'application/json'}})).status,403);
    const approve = await http(`${endpoint()}/${payment.id}/approve`,json({}));
    assert.equal(approve.status,201,await approve.clone().text());
    const approved = await approve.json();
    assert.equal(approved.status,'approved');
    assert.ok(approved.ledger_entry_id);
    const repeated = await http(`${endpoint()}/${payment.id}/approve`,json({}));
    assert.equal(repeated.status,201);
    assert.equal((await repeated.json()).ledger_entry_id,approved.ledger_entry_id);
    const listing = await http(endpoint(),{headers:{Cookie:customerCookie}});
    assert.equal((await listing.json()).items.find((item:{id:string}) => item.id === payment.id).status,'approved');
    await database.db.query('UPDATE memberships SET is_active=false WHERE user_id=$1 AND organization_id=$2',[seed.customerUserId,seed.orgId]);
    try { assert.equal((await http(imageUrl,{headers:{Cookie:customerCookie}})).status,404); }
    finally {await database.db.query('UPDATE memberships SET is_active=true WHERE user_id=$1 AND organization_id=$2',[seed.customerUserId,seed.orgId]);}
  });

  it('accepts multiple screenshots, gives admins a tenant-scoped queue and returns rejected status to the owner', async () => {
    const upload = await http(endpoint(second),{method:'POST',headers:authHeaders(),body:await form({count:5})});
    assert.equal(upload.status,201,await upload.clone().text());
    const payment = await upload.json();
    assert.equal(payment.receipts.length,5);
    assert.equal((await http(reviewEndpoint(),{headers:{Cookie:customerCookie}})).status,403);
    const review = await http(reviewEndpoint(),{headers:{Cookie:adminCookie}});
    assert.equal(review.status,200);
    const row = (await review.json()).items.find((item:{id:string}) => item.id === payment.id);
    assert.equal(row.customer_name,'Aster Studio');
    assert.equal(row.payment_date,businessDate());
    assert.ok(row.submitted_at);
    assert.equal((await http(`${reviewEndpoint()}?status=unknown`,{headers:{Cookie:adminCookie}})).status,400);
    assert.equal((await http(`${reviewEndpoint()}?status=pending&status=approved`,{headers:{Cookie:adminCookie}})).status,400);
    assert.equal((await http(`${endpoint(second)}/${payment.id}/reject`,json({reason:''}))).status,400);
    const rejection = await http(`${endpoint(second)}/${payment.id}/reject`,json({reason:'Please provide the full transaction screenshot.'}));
    assert.equal(rejection.status,201,await rejection.clone().text());
    assert.equal((await rejection.json()).status,'rejected');
    const replay=await http(`${endpoint(second)}/${payment.id}/reject`,json({reason:'Please provide the full transaction screenshot.'}));
    assert.equal(replay.status,201);
    assert.equal((await replay.json()).id,payment.id);
    const listing = await http(endpoint(second),{headers:{Cookie:customerCookie}});
    assert.equal((await listing.json()).items[0].rejection_reason,'Please provide the full transaction screenshot.');
    assert.equal((await http(`${endpoint(second)}/${payment.id}/approve`,json({}))).status,409);
  });

  it('exposes validated search, date filters, counts and pagination through the admin review endpoint', async () => {
    const params=new URLSearchParams({status:'all',q:'Aster Studio',from:businessDate(),to:businessDate(),page:'1',page_size:'1',sort:'newest'});
    const response=await http(`${reviewEndpoint()}?${params}`,{headers:{Cookie:adminCookie}});
    assert.equal(response.status,200,await response.clone().text());
    const listing=await response.json();
    assert.equal(listing.items.length,1);
    assert.equal(listing.page,1);
    assert.equal(listing.page_size,1);
    assert.equal(listing.total,2);
    assert.equal(listing.total_pages,2);
    assert.deepEqual(listing.counts,{pending:0,approved:1,rejected:1,all:2});
    const exact=await http(`${reviewEndpoint()}?status=all&q=${listing.items[0].id}`,{headers:{Cookie:adminCookie}});
    assert.equal((await exact.json()).total,1);
    for(const query of ['page=0','page_size=101','from=2026-02-30','q=one&q=two','sort=unsupported','extra=ignored'])
      assert.equal((await http(`${reviewEndpoint()}?${query}`,{headers:{Cookie:adminCookie}})).status,400,query);
    assert.equal((await http(`${reviewEndpoint()}?status=all&q=Aster`,{headers:{Cookie:customerCookie}})).status,403);
  });

  it('rejects oversized, excessive, malformed and incorrectly typed multipart attachments', async () => {
    const before=(await database.db.query('SELECT count(*)::int AS count FROM booking_payments WHERE booking_id=$1',[first])).rows[0].count;
    const requests = [
      await form({count:6}),
      await form({buffer:Buffer.alloc(5*1024*1024+1)}),
      await form({buffer:Buffer.from('not an image')}),
      await form({buffer:png,type:'image/jpeg'}),
      await form({amount:'1.001'}),
    ];
    for (const body of requests) {
      const response = await http(endpoint(),{method:'POST',headers:authHeaders(),body});
      assert.ok([400,413].includes(response.status),`Expected a validation response, got ${response.status}: ${await response.text()}`);
    }
    const wrongField = await form({count:0});
    wrongField.append('file',new Blob([new Uint8Array(png)],{type:'image/png'}),'receipt.png');
    assert.equal((await http(endpoint(),{method:'POST',headers:authHeaders(),body:wrongField})).status,400);
    const jsonUpload = await http(endpoint(),json({amount:'25.00',payment_date:businessDate(),idempotency_key:randomUUID(),receipts:['data:image/png;fake']},customerCookie));
    assert.equal(jsonUpload.status,400);
    assert.equal((await database.db.query('SELECT count(*)::int AS count FROM booking_payments WHERE booking_id=$1',[first])).rows[0].count,before,
      'Invalid multipart requests must not leave partially created payment submissions.');
  });

  it('queues receipt acknowledgements and decisions in HTTP requests, then delivers them once without stale review notices', async () => {
    assert.equal(requestSends,0,'Payment requests must finish independently of the email provider.');
    const path = `/api/organizations/${seed.orgId}/payment-email-status`;
    assert.equal((await http(path)).status,401);
    assert.equal((await http(path,{headers:{Cookie:customerCookie}})).status,403);
    assert.equal((await http(path,{headers:{Cookie:otherAdminCookie}})).status,404);
    const pending = await http(path,{headers:{Cookie:adminCookie}});
    assert.equal(pending.status,200);
    const pendingStatus=await pending.json();
    assert.deepEqual(Object.keys(pendingStatus).sort(),['bounced','complained','delivered','failed','oldest_queued_at','queued','retrying','sent','suppressed']);
    assert.equal(pendingStatus.queued,7,'Three booking confirmations, two acknowledgements, approval and rejection remain queued.');
    assert.equal(pendingStatus.sent,0);
    for(const key of ['bounced','complained','delivered','failed','suppressed'])assert.equal(pendingStatus[key],0);
    const originalDirectory = config.mailDirectory;
    const directory = await mkdtemp(join(tmpdir(),'ledger-payment-http-mail-'));
    config.mailDirectory = directory;
    mail.send=originalSend;
    try {
      const worker = app.get(PaymentEmailOutbox);
      assert.equal(await worker.flush(),7);
      assert.equal(await worker.flush(),0,'A completed delivery must not publish another email.');
      const names = await readdir(directory);
      assert.equal(names.length,7);
      const messages = await Promise.all(names.map(async name => {
        assert.match(name,/^payment-[a-f0-9]{64}\.eml$/);
        assert.equal((await stat(join(directory,name))).mode & 0o777,0o600);
        return (await readFile(join(directory,name),'utf8')).replaceAll('\r\n','\n');
      }));
      const review = messages.filter(message => message.includes('Subject: Payment receipt submitted\n'));
      assert.equal(review.length,0,'Administrators should not receive stale review requests after decisions are recorded.');
      for (const message of messages) {
        assert.match(message,/Content-Type: text\/plain; charset=utf-8/);
        assert.doesNotMatch(message,/Content-Type: image\//);
        if(message.includes('Subject: Your booking confirmation and invoice\n')) {
          assert.match(message,/^To: (customer|beacon)@example\.test\n/);
          assert.match(message,/Content-Disposition: attachment/);
          assert.match(message,/Content-Type: application\/pdf/);
        } else {
          assert.match(message,/^To: customer@example\.test\n/);
          assert.match(message,/Amount: GBP 25\.00/);
          assert.ok(message.includes(`${config.appUrl}/o/${seed.orgId}`));
        }
      }
      const approved = messages.filter(message => message.includes('Subject: Your payment has been approved\n'));
      assert.equal(approved.length,1);
      assert.match(approved[0],/^To: customer@example\.test\n/);
      assert.match(approved[0],/credited to your account/);
      assert.match(approved[0],/Content-Disposition: attachment/);
      assert.match(approved[0],/Content-Type: application\/pdf/);
      assert.ok(approved[0].includes(`${config.appUrl}/o/${seed.orgId}`));
      const rejected=messages.filter(message=>message.includes('Subject: Your payment was not approved\n'));
      assert.equal(rejected.length,1);
      assert.match(rejected[0],/Please provide the full transaction screenshot\./);
      assert.ok(rejected[0].includes(`${config.appUrl}/o/${seed.orgId}`));
      const acknowledged=messages.filter(message=>message.includes('Subject: Your payment receipt has been received\n'));
      assert.equal(acknowledged.length,2);
      for(const message of acknowledged) {
        assert.match(message,/receiv|receipt/i);assert.match(message,/verify|review/i);
      }
      assert.ok(acknowledged.every(message=>message.includes(`${config.appUrl}/o/${seed.orgId}`)&&!message.includes('/bookings/')));
      const completed = await http(path,{headers:{Cookie:adminCookie}});
      assert.deepEqual(await completed.json(),{queued:0,retrying:0,sent:7,delivered:0,bounced:0,complained:0,failed:0,suppressed:0,oldest_queued_at:null});
      const other = await http(`/api/organizations/${seed.otherOrgId}/payment-email-status`,{headers:{Cookie:otherAdminCookie}});
      assert.deepEqual(await other.json(),{queued:0,retrying:0,sent:0,delivered:0,bounced:0,complained:0,failed:0,suppressed:0,oldest_queued_at:null});
      await database.db.query('UPDATE memberships SET is_active=false WHERE id=$1',[seed.admin.id]);
      try { assert.equal((await http(path,{headers:{Cookie:adminCookie}})).status,404); }
      finally { await database.db.query('UPDATE memberships SET is_active=true WHERE id=$1',[seed.admin.id]); }
    } finally {
      config.mailDirectory = originalDirectory;
      await rm(directory,{recursive:true,force:true});
    }
  });

  it('accepts an attachment-free multipart payment, replays it once and still requires administrator approval',async()=>{
    const key=randomUUID();
    const before=(await database.db.query('SELECT count(*)::int AS count FROM ledger_entries WHERE customer_id=$1',[seed.customerId])).rows[0].count;
    const submission=await http(endpoint(),{method:'POST',headers:authHeaders(),body:await form({count:0,key})});
    assert.equal(submission.status,201,await submission.clone().text());
    const payment=await submission.json();
    assert.equal(payment.status,'pending');assert.equal(payment.ledger_entry_id,null);assert.deepEqual(payment.receipts,[]);
    const replay=await http(endpoint(),{method:'POST',headers:authHeaders(),body:await form({count:0,key})});
    assert.equal(replay.status,201,await replay.clone().text());assert.equal((await replay.json()).id,payment.id);
    assert.equal((await database.db.query('SELECT count(*)::int AS count FROM ledger_entries WHERE customer_id=$1',[seed.customerId])).rows[0].count,before,
      'Submitting or replaying payment details does not post money.');
    assert.equal((await http(`${endpoint()}/${payment.id}/approve`,json({},customerCookie))).status,403);
    const response=await http(`${endpoint()}/${payment.id}/approve`,json({}));
    assert.equal(response.status,201,await response.clone().text());
    const approved=await response.json();assert.equal(approved.status,'approved');assert.ok(approved.ledger_entry_id);assert.deepEqual(approved.receipts,[]);
    const approvalReplay=await http(`${endpoint()}/${payment.id}/approve`,json({}));
    assert.equal(approvalReplay.status,201);assert.equal((await approvalReplay.json()).ledger_entry_id,approved.ledger_entry_id);
    assert.equal((await database.db.query('SELECT count(*)::int AS count FROM ledger_entries WHERE customer_id=$1',[seed.customerId])).rows[0].count,before+1,
      'Repeated approval must post this attachment-free payment exactly once.');
    const notices=(await database.db.query("SELECT subject,body,state FROM payment_email_outbox WHERE split_part(dedupe_key,':',2)=$1",[payment.id])).rows;
    assert.equal(notices.length,3,'One administrator review intent, acknowledgement and approval intent are recorded despite retries.');
    const review=notices.find(row=>row.subject==='Payment submitted for review')!;
    assert.equal(review.state,'cancelled');assert.match(review.body,/without an attachment/);assert.doesNotMatch(review.body,/uploaded 0|0 payment receipt/);
    const acknowledged=notices.find(row=>row.subject==='Your payment details have been received')!;
    assert.equal(acknowledged.state,'pending');assert.match(acknowledged.body,/does not credit your account/);
    assert.equal(notices.find(row=>row.subject==='Your payment has been approved')!.state,'pending');
  });


  it('records and links confirmed payments through administrator JSON endpoints with scoped access and retries',async()=>{
    const recordPath=`${endpoint()}/record`,request={amount:'10.00',payment_date:businessDate(),note:'Verified transfer',idempotency_key:randomUUID()};
    assert.equal((await http(recordPath,json(request,customerCookie))).status,403);
    assert.equal((await http(recordPath,json(request,otherAdminCookie))).status,404);
    assert.equal((await http(recordPath,{...json(request),headers:{Cookie:adminCookie,Origin:config.appUrl,'Content-Type':'application/json'}})).status,403);
    const recorded=await http(recordPath,json(request));assert.equal(recorded.status,201,await recorded.clone().text());
    const payment=await recorded.json();assert.equal(payment.status,'approved');assert.equal(payment.amount_minor,'1000');assert.deepEqual(payment.receipts,[]);
    const replay=await http(recordPath,json(request));assert.equal(replay.status,201);assert.equal((await replay.json()).id,payment.id);
    assert.equal((await http(recordPath,json({...request,amount:'11.00'}))).status,409);
    const ledger=new LedgerService(database.db,new AccessService(database.db));
    const existing=await ledger.post(seed.admin,seed.customerId,{kind:'payment',amount:'12.00',effective_date:businessDate(),description:'Already received',idempotency_key:randomUUID()});
    const before=(await database.db.query('SELECT count(*)::integer AS count FROM ledger_entries')).rows[0].count;
    const linkPath=`${endpoint()}/link`,selection={payment_entry_id:existing.id,idempotency_key:randomUUID()};
    assert.equal((await http(linkPath,json(selection,customerCookie))).status,403);
    const linked=await http(linkPath,json(selection));assert.equal(linked.status,201,await linked.clone().text());
    const assigned=await linked.json();assert.equal(assigned.ledger_entry_id,existing.id);assert.equal(assigned.amount_minor,'1200');
    const linkReplay=await http(linkPath,json(selection));assert.equal(linkReplay.status,201);assert.equal((await linkReplay.json()).id,assigned.id);
    assert.equal((await http(`${endpoint(second)}/link`,json({...selection,idempotency_key:randomUUID()}))).status,409);
    assert.equal((await database.db.query('SELECT count(*)::integer AS count FROM ledger_entries')).rows[0].count,before);
    assert.equal((await database.db.query("SELECT 1 FROM payment_email_outbox WHERE split_part(dedupe_key,':',2)=ANY($1::text[])",[ [payment.id,assigned.id] ])).rows.length,0);
  });

  it('submits and reviews an independent account payment over HTTP with private receipts and one total-balance credit',async()=>{
    await database.db.query('DELETE FROM rate_limits');
    const path=`/api/organizations/${seed.orgId}/customers/${seed.customerId}/payments`;
    assert.equal((await http(path)).status,401);
    assert.equal((await http(path,{method:'POST',headers:authHeaders(adminCookie),body:await form()})).status,403);
    assert.equal((await http(path,{method:'POST',headers:{Cookie:customerCookie,Origin:config.appUrl},body:await form()})).status,403);
    assert.equal((await http(path.replace(seed.customerId,seed.secondCustomerId),{method:'POST',headers:authHeaders(),body:await form()})).status,404);
    const before=BigInt((await database.db.query('SELECT sum(amount_minor)::text AS balance FROM ledger_entries WHERE customer_id=$1',[seed.customerId])).rows[0].balance);
    const invoices=(await database.db.query('SELECT * FROM booking_invoices ORDER BY id')).rows;
    const key=randomUUID(),buffer=await sharp({create:{width:30,height:24,channels:3,background:'#9a2bf1'}}).png().toBuffer();
    const upload=await http(path,{method:'POST',headers:authHeaders(),body:await form({key,buffer,amount:'50.00'})});
    assert.equal(upload.status,201,await upload.clone().text());
    const payment=await upload.json();assert.equal(payment.booking_id,null);assert.equal(payment.booking_reference,null);
    assert.equal(payment.status,'pending');assert.equal(payment.ledger_entry_id,null);
    const replay=await http(path,{method:'POST',headers:authHeaders(),body:await form({key,buffer,amount:'50.00'})});
    assert.equal(replay.status,201);assert.equal((await replay.json()).id,payment.id);
    const receipt=payment.receipts[0];assert.ok(receipt.url.startsWith(`${path}/${payment.id}/receipts/`));
    assert.equal((await http(receipt.url)).status,401);
    assert.equal((await http(receipt.url,{headers:{Cookie:otherAdminCookie}})).status,404);
    assert.equal((await http(receipt.url.replace(seed.customerId,seed.secondCustomerId),{headers:{Cookie:customerCookie}})).status,404);
    const preview=await http(receipt.url,{headers:{Cookie:customerCookie}});
    assert.equal(preview.status,200);assert.equal(preview.headers.get('cache-control'),'private, no-store');
    assert.match(preview.headers.get('content-type')??'',/image\/webp/);
    const queue=await http(`${reviewEndpoint()}?q=${payment.id}`,{headers:{Cookie:adminCookie}});
    assert.equal((await queue.json()).items[0].booking_id,null);
    assert.equal((await http(`${path}/${payment.id}/approve`,json({},customerCookie))).status,403);
    assert.equal((await http(`${endpoint()}/${payment.id}/approve`,json({}))).status,404);
    const decisions=await Promise.all([http(`${path}/${payment.id}/approve`,json({})),http(`${path}/${payment.id}/approve`,json({}))]);
    for(const decision of decisions) assert.equal(decision.status,201,await decision.clone().text());
    const approved=await decisions[0].json();assert.equal((await decisions[1].json()).ledger_entry_id,approved.ledger_entry_id);
    assert.equal(BigInt((await database.db.query('SELECT sum(amount_minor)::text AS balance FROM ledger_entries WHERE customer_id=$1',[seed.customerId])).rows[0].balance),before-5000n);
    assert.deepEqual((await database.db.query('SELECT * FROM booking_invoices ORDER BY id')).rows,invoices);
    const listing=await http(path,{headers:{Cookie:customerCookie}});const history=(await listing.json()).items;
    assert.ok(history.some((item:{id:string;booking_id:string|null})=>item.id===payment.id&&item.booking_id===null));
    assert.ok(history.some((item:{booking_id:string|null})=>item.booking_id===first),'Previous booking payment history remains accessible from My Account.');
    const edit=await http(`${path}/${payment.id}`,{...json({version:approved.version,amount:'50.00',payment_date:businessDate(),note:'Account transfer confirmed',reason:'Clarify note'}),method:'PATCH'});
    assert.equal(edit.status,200,await edit.clone().text());assert.equal((await edit.json()).booking_id,null);
  });

  it('rejects an attachment-free account payment without credit and supports scoped account history management',async()=>{
    const path=`/api/organizations/${seed.orgId}/customers/${seed.customerId}/payments`;
    const upload=await http(path,{method:'POST',headers:authHeaders(),body:await form({count:0})});
    assert.equal(upload.status,201,await upload.clone().text());const payment=await upload.json();
    const before=(await database.db.query('SELECT * FROM ledger_entries ORDER BY id')).rows;
    const rejected=await http(`${path}/${payment.id}/reject`,json({reason:'Transfer not received'}));
    assert.equal(rejected.status,201,await rejected.clone().text());const decision=await rejected.json();
    assert.equal(decision.status,'rejected');assert.deepEqual(decision.receipts,[]);
    assert.deepEqual((await database.db.query('SELECT * FROM ledger_entries ORDER BY id')).rows,before);
    const deleted=await http(`${path}/${payment.id}/delete`,json({version:decision.version,reason:'Remove incorrect submission'}));
    assert.equal(deleted.status,201,await deleted.clone().text());const trashed=await deleted.json();
    assert.equal((await http(`${path}?deleted=deleted`,{headers:{Cookie:customerCookie}})).status,403);
    const trash=await http(`${path}?deleted=deleted`,{headers:{Cookie:adminCookie}});
    assert.ok((await trash.json()).items.some((item:{id:string})=>item.id===payment.id));
    const restored=await http(`${path}/${payment.id}/restore`,json({version:trashed.version,reason:'Retain review history'}));
    assert.equal(restored.status,201);assert.equal((await restored.json()).deleted_at,null);
  });

});
