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

  it('rejects oversized, excessive, absent, malformed and incorrectly typed multipart attachments', async () => {
    const requests = [
      await form({count:0}),
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
          assert.ok(message.includes(`${config.appUrl}/o/${seed.orgId}/users/${seed.customerId}/bookings/`));
        }
      }
      const approved = messages.filter(message => message.includes('Subject: Your payment has been approved\n'));
      assert.equal(approved.length,1);
      assert.match(approved[0],/^To: customer@example\.test\n/);
      assert.match(approved[0],/credited to your account/);
      assert.match(approved[0],/Content-Disposition: attachment/);
      assert.match(approved[0],/Content-Type: application\/pdf/);
      assert.ok(approved[0].includes(`${config.appUrl}/o/${seed.orgId}/users/${seed.customerId}/bookings/${first}`));
      const rejected=messages.filter(message=>message.includes('Subject: Your payment was not approved\n'));
      assert.equal(rejected.length,1);
      assert.match(rejected[0],/Please provide the full transaction screenshot\./);
      assert.ok(rejected[0].includes(`${config.appUrl}/o/${seed.orgId}/users/${seed.customerId}/bookings/${second}`));
      const acknowledged=messages.filter(message=>message.includes('Subject: Your payment receipt has been received\n'));
      assert.equal(acknowledged.length,2);
      for(const message of acknowledged) {
        assert.match(message,/receiv|receipt/i);assert.match(message,/verify|review/i);
      }
      assert.ok(acknowledged.some(message=>message.includes(`${config.appUrl}/o/${seed.orgId}/users/${seed.customerId}/bookings/${first}`)));
      assert.ok(acknowledged.some(message=>message.includes(`${config.appUrl}/o/${seed.orgId}/users/${seed.customerId}/bookings/${second}`)));
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
});
