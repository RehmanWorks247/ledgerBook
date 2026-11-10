import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AccessService } from '../apps/api/src/access/access.service';
import { createApp } from '../apps/api/src/app';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { BookingsService, MAX_DOCUMENT_BYTES } from '../apps/api/src/bookings/bookings.service';
import { config } from '../apps/api/src/config';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

type HttpResult = {status:number;headers:IncomingHttpHeaders;body:string};

describe('document uploads reject unsafe requests before body buffering',() => {
  let database:TestDatabase;
  let seed:TestSeed;
  let app:NestExpressApplication;
  let url:string;
  let headers:Record<string,string>;
  let customerCookie:string;

  before(async () => {
    database = await setupTestDatabase();
    seed = await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1",[seed.orgId]);
    seed.admin = await new AccessService(database.db).membership(seed.adminId,seed.orgId);
    app = await createApp({database:database.db,logger:false,paymentEmails:false});
    await app.listen(0,'127.0.0.1');
    const bookings = app.get(BookingsService);
    const booking = await bookings.create(seed.admin,seed.customerId,{reference:'HTTP-UPLOAD-GATE',departure_at:'2026-11-12T10:30:00Z',
      amount:'100.00',effective_date:'2026-11-06',idempotency_key:randomUUID()});
    const folder = (await bookings.files(seed.admin,seed.customerId,String(booking.id))).items.find(node => node.serviceKey === 'extras')!;
    url = `${await app.getUrl()}/api/organizations/${seed.orgId}/customers/${seed.customerId}/bookings/${booking.id}/folders/${folder.id}/documents`;
    headers = {Cookie:`${config.sessionCookie}=${await app.get(AuthService).createSession(seed.adminId)}`,
      Origin:config.appUrl,'X-CSRF-Protection':'1','Content-Type':'application/pdf','X-File-Name':'document.pdf','Idempotency-Key':randomUUID()};
    customerCookie = `${config.sessionCookie}=${await app.get(AuthService).createSession(seed.customerUserId)}`;
  });
  after(async () => { if (app) await app.close(); if (database) await database.close(); });

  // Deliberately send only headers: a response proves the server did not wait to buffer a body.
  function begin(target=url,custom:Record<string,string>=headers,body?:Buffer) {
    let request!:ClientRequest;
    const result = new Promise<HttpResult>((resolve,reject) => {
      request = httpRequest(target,{method:'POST',headers:custom},response => {
        const chunks:Buffer[] = [];
        response.on('data',chunk => chunks.push(Buffer.from(chunk)));
        response.once('error',reject);
        response.once('end',() => {
          resolve({status:response.statusCode!,headers:response.headers,body:Buffer.concat(chunks).toString('utf8')});
          request.destroy();
        });
      });
      request.once('error',reject);
      request.setTimeout(5000,() => request.destroy(new Error('Response waited for an upload body.')));
      request.flushHeaders();
      if (body) request.write(body);
    });
    return {request,result};
  }

  it('checks session, admin permission and destination before accepting bytes',async () => {
    const declared = {...headers,'Content-Length':'1000'};
    assert.equal((await begin(url,{...declared,Cookie:''}).result).status,401);
    assert.equal((await begin(url,{...declared,Cookie:customerCookie}).result).status,403);
    assert.equal((await begin(url.replace(/\/folders\/[^/]+\//,`/folders/${randomUUID()}/`),declared).result).status,404);
    assert.equal((await begin(url,{...declared,Origin:'https://wrong-origin.example'}).result).status,403);
  });

  it('rejects unsupported media, encoding, filename, retry keys and declared oversized bodies immediately',async () => {
    const declared = {...headers,'Content-Length':'1000'};
    for (const [override,status] of [
      [{'Content-Type':'multipart/form-data'},415],
      [{'Content-Encoding':'gzip'},415],
      [{'X-File-Name':'../unsafe.pdf'},400],
      [{'X-File-Name':'..'},400],
      [{'Idempotency-Key':'not-a-uuid'},400],
      [{'Content-Length':String(MAX_DOCUMENT_BYTES+1)},413],
    ] as const) {
      const response = await begin(url,{...declared,...override}).result;
      assert.equal(response.status,status,response.body);
    }
  });

  it('returns 413 when a chunked body crosses the limit without waiting for the sender to finish',async () => {
    const response = await begin(url,{...headers,'Transfer-Encoding':'chunked'},Buffer.alloc(MAX_DOCUMENT_BYTES+1,65)).result;
    assert.equal(response.status,413,response.body);
    assert.match(response.body,/10 MB/);
    assert.equal(response.headers.connection,'close');
    assert.equal((await database.db.query("SELECT count(*)::int AS n FROM booking_nodes WHERE kind='file'")).rows[0].n,0);
  });

  it('round-trips file types with their names, MIME metadata, private access and safe download behavior',async () => {
    const cases = [
      {name:'voucher.pdf',type:'application/pdf',bytes:Buffer.from('%PDF-1.4\n%%EOF'),inline:true},
      {name:'.pdf',type:'application/pdf',bytes:Buffer.from('%PDF-1.4\n%%EOF'),inline:true},
      {name:'letter.doc',type:'application/msword',bytes:Buffer.from([0xd0,0xcf,0x11,0xe0,0xff,0,0x80]),inline:false},
      {name:'letter.docx',type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',bytes:Buffer.from([0x50,0x4b,3,4,0xff,0,0x80]),inline:false},
      {name:'photo.png',type:'image/png',bytes:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4l8AAAAASUVORK5CYII=','base64'),inline:true},
      {name:'photo.jpg',type:'image/jpeg',bytes:Buffer.from([0xff,0xd8,0xff,0xe0,0,0xff,0xd9]),inline:true},
      {name:'list.csv',type:'text/csv',bytes:Buffer.from('name,amount\nExample,10\n'),inline:false},
      {name:'archive.zip',type:'application/zip',bytes:Buffer.from([0x50,0x4b,5,6,0,0xff,0x80]),inline:false},
      {name:'settings.json',type:'application/json',bytes:Buffer.from('{"ok":true}'),inline:false},
      {name:'custom.unknown',type:'application/octet-stream',bytes:Buffer.from([0xff]),inline:false},
      {name:'README',type:'application/octet-stream',bytes:Buffer.from('a'),inline:false},
      {name:'page.html',type:'application/octet-stream',bytes:Buffer.from('<script>alert(1)</script>'),inline:false},
      {name:'drawing.svg',type:'image/svg+xml',bytes:Buffer.from('<svg onload="alert(1)"></svg>'),inline:false},
    ];
    for (const item of cases) {
      const uploadHeaders={...headers,'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(item.name),'Idempotency-Key':randomUUID()};
      const response=await fetch(url,{method:'POST',headers:uploadHeaders,body:item.bytes});
      assert.equal(response.status,201,await response.clone().text());
      const saved=await response.json();
      assert.equal(saved.name,item.name);
      assert.equal(saved.mimeType,item.type);
      const downloadUrl=new URL(saved.url,url);
      const downloaded=await fetch(downloadUrl,{headers:{Cookie:customerCookie}});
      assert.equal(downloaded.status,200);
      assert.equal(downloaded.headers.get('content-type')?.split(';')[0],item.type);
      assert.match(downloaded.headers.get('content-disposition')!,item.inline ? /^inline;/ : /^attachment;/);
      assert.equal(downloaded.headers.get('x-content-type-options'),'nosniff');
      assert.equal(downloaded.headers.get('cache-control'),'private, no-store');
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),item.bytes);
      assert.equal((await fetch(downloadUrl)).status,401);
      const retry=await fetch(url,{method:'POST',headers:uploadHeaders,body:item.bytes});
      assert.equal((await retry.json()).id,saved.id);
      const copy=await fetch(url,{method:'POST',headers:{...uploadHeaders,'Idempotency-Key':randomUUID()},body:item.bytes});
      const expected=item.name.includes('.') ? item.name.replace(/(\.[^.]+)$/, ' (2)$1') : `${item.name} (2)`;
      assert.equal((await copy.json()).name,expected);
    }
    const invalidPdf=await fetch(url,{method:'POST',headers:{...headers,'X-File-Name':'.pdf'},body:'not a PDF'});
    assert.equal(invalidPdf.status,400);
  });

  it('accepts exactly 10 MiB and rejects empty or larger files without saving them',async () => {
    const uploadHeaders={...headers,'Content-Type':'application/octet-stream','X-File-Name':'boundary.bin','Idempotency-Key':randomUUID()};
    const bytes=Buffer.alloc(MAX_DOCUMENT_BYTES,0xa5);
    const response=await fetch(url,{method:'POST',headers:uploadHeaders,body:bytes});
    assert.equal(response.status,201,await response.clone().text());
    const saved=await response.json();
    assert.equal(saved.size,MAX_DOCUMENT_BYTES);
    const downloaded=await fetch(new URL(saved.url,url),{headers:{Cookie:customerCookie}});
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),bytes);
    const count=(await database.db.query("SELECT count(*)::int AS n FROM booking_nodes WHERE kind='file'")).rows[0].n;
    for (const [body,status] of [[Buffer.alloc(0),400],[Buffer.alloc(MAX_DOCUMENT_BYTES+1),413]] as const) {
      assert.equal((await fetch(url,{method:'POST',headers:{...uploadHeaders,'Idempotency-Key':randomUUID()},body})).status,status);
    }
    assert.equal((await database.db.query("SELECT count(*)::int AS n FROM booking_nodes WHERE kind='file'")).rows[0].n,count);
  });
});
