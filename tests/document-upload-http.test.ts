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
      [{'Content-Type':'application/octet-stream'},415],
      [{'Content-Encoding':'gzip'},415],
      [{'X-File-Name':'../unsafe.pdf'},400],
      [{'X-File-Name':'image.png'},400],
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
});
