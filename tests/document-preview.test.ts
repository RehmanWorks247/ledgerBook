import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { HttpException } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import { createApp } from '../apps/api/src/app';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { DocumentPreviewService } from '../apps/api/src/bookings/document-preview';
import { DocumentVersionsService } from '../apps/api/src/bookings/document-versions.service';
import { config } from '../apps/api/src/config';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

// Synthetic OLE Word file exported by macOS textutil from plain text; it has no
// macros, external resources or customer data. Committed so CI needs no Office.
const legacyWord = () => readFile('tests/fixtures/document-preview/legacy-word.doc');
const hasStatus = (status:number) => (error:unknown) => error instanceof HttpException && error.getStatus() === status;
const makeTiff = (width=3,height=2,background='red') => sharp({create:{width,height,channels:3,background}}).tiff({compression:'lzw'}).toBuffer();

describe('bounded private document conversion',() => {
  const previews = new DocumentPreviewService();
  after(() => previews.onApplicationShutdown());

  it('extracts real legacy Word text including Unicode without interpreting HTML',async () => {
    const result = await previews.render({mimeType:'application/msword',content:await legacyWord()});
    assert.equal(result.mimeType,'text/plain; charset=utf-8');
    assert.equal(result.mode,'text-only');
    assert.match(result.content.toString(),/Legacy Word preview fixture/);
    assert.match(result.content.toString(),/café مرحبا/);
    assert.match(result.content.toString(),/<script>alert\("inert document text"\)<\/script>/);
  });

  it('converts the first TIFF page only and bounds the display dimensions',async () => {
    const raw = Buffer.from([255,0,0,255,0,0,0,0,255,0,0,255]);
    const input = await sharp(raw,{raw:{width:2,height:2,channels:3,pageHeight:1}}).tiff({compression:'lzw'}).toBuffer();
    assert.equal((await sharp(input).metadata()).pages,2);
    const first = await previews.render({mimeType:'image/tiff',content:input});
    assert.equal(first.mimeType,'image/png');
    assert.equal(first.mode,'first-page');
    const pixels = await sharp(first.content).raw().toBuffer({resolveWithObject:true});
    assert.equal(pixels.info.width,2);
    assert.equal(pixels.info.height,1);
    assert.deepEqual([...pixels.data],[255,0,0,255,0,0]);
    const resized = await previews.render({mimeType:'image/tiff',content:await makeTiff(3000,1500)});
    const dimensions = await sharp(resized.content).metadata();
    assert.equal(dimensions.width,2400);
    assert.equal(dimensions.height,1200);
  });

  it('rejects unsupported, corrupt, disguised and excessive decoded images safely',async () => {
    await assert.rejects(previews.render({mimeType:'text/html',content:Buffer.from('<script/>')}),hasStatus(415));
    await assert.rejects(previews.render({mimeType:'application/msword',content:Buffer.from('not an OLE document')}),hasStatus(422));
    await assert.rejects(previews.render({mimeType:'application/msword',content:Buffer.from('d0cf11e0a1b11ae100000000','hex')}),hasStatus(422));
    const excessiveTable = Buffer.from(await legacyWord());
    excessiveTable.writeUInt32LE(0x7fffffff,44);
    await assert.rejects(previews.render({mimeType:'application/msword',content:excessiveTable}),hasStatus(422));
    await assert.rejects(previews.render({mimeType:'image/tiff',content:Buffer.from('49492a0000000000','hex')}),hasStatus(422));
    await assert.rejects(previews.render({mimeType:'image/tiff',content:await makeTiff(4001,4000)}),hasStatus(422));
  });

  it('caps simultaneous parsing and releases slots after success and cancellation',async () => {
    const source = {mimeType:'application/msword',content:await legacyWord()};
    const first = previews.render(source);
    const second = previews.render(source);
    await assert.rejects(previews.render(source),hasStatus(503));
    await Promise.all([first,second]);
    const cancellation = new AbortController();
    const interrupted = previews.render(source,cancellation.signal);
    cancellation.abort();
    await assert.rejects(interrupted,hasStatus(503));
    assert.equal((await previews.render(source)).mode,'text-only');
  });

  it('terminates a worker at its deadline without blocking the API event loop',async () => {
    class DeadlinePreviewService extends DocumentPreviewService { protected override timeoutMs = 1; }
    const timed = new DeadlinePreviewService();
    const source = {mimeType:'application/msword',content:await legacyWord()};
    try {
      const conversion = timed.render(source);
      await assert.rejects(conversion,(error:unknown) => hasStatus(422)(error) && /too long/.test((error as Error).message));
      // A timeout must not retain a concurrency slot or reject all later work.
      const next = timed.render(source);
      await assert.rejects(next,hasStatus(422));
    } finally { await timed.onApplicationShutdown(); }
  });
});

describe('authenticated document preview HTTP contract',() => {
  let database:TestDatabase,seed:TestSeed,app:NestExpressApplication,bookings:BookingsService;
  let base:string,bookingId:string,folderId:string,adminCookie:string,customerCookie:string,otherCookie:string;
  const path = (id:string) => `${base}/organizations/${seed.orgId}/customers/${seed.customerId}/bookings/${bookingId}/documents/${id}/preview`;
  const preview = (id:string,cookie=customerCookie) => fetch(path(id),{headers:{Cookie:cookie}});
  const upload = (name:string,content:Buffer) => bookings.upload(seed.admin,seed.customerId,bookingId,folderId,name,randomUUID(),content);

  before(async () => {
    database = await setupTestDatabase();
    seed = await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1",[seed.orgId]);
    seed.admin = await new AccessService(database.db).membership(seed.adminId,seed.orgId);
    app = await createApp({database:database.db,logger:false,paymentEmails:false});
    await app.listen(0,'127.0.0.1');
    base = `${await app.getUrl()}/api`;
    bookings = app.get(BookingsService);
    const booking = await bookings.create(seed.admin,seed.customerId,{reference:'FILE-PREVIEW',departure_at:'2030-01-01T10:00:00Z',
      amount:'100.00',effective_date:'2026-11-09',idempotency_key:randomUUID()});
    bookingId = String(booking.id);
    folderId = (await bookings.files(seed.admin,seed.customerId,bookingId)).items.find(node => node.serviceKey === 'extras')!.id;
    const auth = app.get(AuthService);
    adminCookie = `${config.sessionCookie}=${await auth.createSession(seed.adminId)}`;
    customerCookie = `${config.sessionCookie}=${await auth.createSession(seed.customerUserId)}`;
    otherCookie = `${config.sessionCookie}=${await auth.createSession(seed.otherAdminId)}`;
  });
  after(async () => { if(app) await app.close(); if(database) await database.close(); });

  it('returns inert Word text and a private, non-cacheable PNG for TIFF',async () => {
    const word = await upload('letter.doc',await legacyWord());
    const text = await preview(word.id);
    assert.equal(text.status,200,await text.clone().text());
    assert.equal(text.headers.get('content-type'),'text/plain; charset=utf-8');
    assert.equal(text.headers.get('x-document-preview'),'text-only');
    assert.equal(text.headers.get('cache-control'),'private, no-store');
    assert.equal(text.headers.get('x-content-type-options'),'nosniff');
    assert.match(text.headers.get('content-security-policy')!,/sandbox/);
    assert.match(await text.text(),/café مرحبا/);
    const image = await upload('scan.tiff',await makeTiff());
    const png = await preview(image.id,adminCookie);
    assert.equal(png.status,200);
    assert.equal(png.headers.get('content-type'),'image/png');
    assert.equal(png.headers.get('x-document-preview'),'first-page');
    assert.equal(png.headers.get('cache-control'),'private, no-store');
    assert.equal((await sharp(Buffer.from(await png.arrayBuffer())).metadata()).format,'png');
  });

  it('requires a live session and customer/tenant access on every request',async () => {
    const word = await upload('private.doc',await legacyWord());
    assert.equal((await preview(word.id,'')).status,401);
    assert.equal((await preview(word.id,otherCookie)).status,404);
    const otherCustomer = path(word.id).replace(seed.customerId,seed.secondCustomerId);
    assert.equal((await fetch(otherCustomer,{headers:{Cookie:customerCookie}})).status,404);
    assert.equal((await preview(word.id)).status,200);
    await database.db.query('UPDATE memberships SET is_active=false WHERE id=$1',[seed.customerMember.id]);
    try { assert.equal((await preview(word.id)).status,404); }
    finally { await database.db.query('UPDATE memberships SET is_active=true WHERE id=$1',[seed.customerMember.id]); }
    await bookings.remove(seed.admin,seed.customerId,bookingId,word.id);
    assert.equal((await preview(word.id)).status,404);
  });

  it('previews replacement content immediately without retaining the previous conversion',async () => {
    const file = await upload('replace.tif',await makeTiff(3,2,'red'));
    const before = Buffer.from(await (await preview(file.id)).arrayBuffer());
    await app.get(DocumentVersionsService).proxy(seed.admin,seed.customerId,bookingId,file.id,folderId,'replace.tif',randomUUID(),1,await makeTiff(7,4,'blue'));
    const after = Buffer.from(await (await preview(file.id)).arrayBuffer());
    assert.notDeepEqual(before,after);
    assert.equal((await sharp(after).metadata()).width,7);
  });

  it('returns actionable errors for unsupported and damaged files',async () => {
    const unsupported = await upload('notes.txt',Buffer.from('ordinary text'));
    const response = await preview(unsupported.id);
    assert.equal(response.status,415);
    assert.match((await response.json()).message,/original file/);
    const damaged = await upload('damaged.doc',Buffer.from('corrupt word bytes'));
    const failed = await preview(damaged.id);
    assert.equal(failed.status,422);
    assert.equal(failed.headers.get('cache-control'),'private, no-store');
    assert.match((await failed.json()).message,/Download the original/);
  });
});
