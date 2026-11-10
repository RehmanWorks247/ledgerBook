import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import { createApp } from '../apps/api/src/app';
import { AccessService } from '../apps/api/src/access/access.service';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { config } from '../apps/api/src/config';
import { businessDate } from '../apps/api/src/dashboard/time';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';
import { receiptPdf } from './pdf-fixture';

describe('PDF payment receipts over authenticated multipart HTTP', () => {
  let db: TestDatabase, seed: TestSeed, app: NestExpressApplication, base: string, path: string;
  let customer: string, admin: string, other: string, pdf: Buffer, png: Buffer, savedId: string;
  const key = randomUUID();
  before(async () => {
    db = await setupTestDatabase(); seed = await db.seed();
    await db.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1", [seed.orgId]);
    app = await createApp({ database: db.db, logger: false, paymentEmails: false, reminderEmails: false });
    await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    const session = app.get(AuthService);
    customer = `${config.sessionCookie}=${await session.createSession(seed.customerUserId)}`;
    admin = `${config.sessionCookie}=${await session.createSession(seed.adminId)}`;
    other = `${config.sessionCookie}=${await session.createSession(seed.otherAdminId)}`;
    const member = await app.get(AccessService).membership(seed.adminId, seed.orgId);
    const trip = await app.get(BookingsService).create(member, seed.customerId, {
      reference: 'PDF-RECEIPTS', departure_at: '2030-01-01T10:00:00Z', amount: '100', effective_date: businessDate(), idempotency_key: randomUUID(),
    });
    path = `/api/organizations/${seed.orgId}/customers/${seed.customerId}/bookings/${trip.id}/payments`;
    pdf = await receiptPdf();
    png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#138' } }).png().toBuffer();
  });
  after(async () => { if (app) await app.close(); if (db) await db.close(); });
  type Upload = { name: string; type: string; content: Buffer };
  const pdfFile = (): Upload => ({ name: 'bank-receipt.pdf', type: 'application/pdf', content: pdf });
  async function submit(files: Upload[], idempotencyKey = randomUUID()) {
    const body = new FormData();
    body.set('amount', '25.00'); body.set('payment_date', businessDate()); body.set('idempotency_key', idempotencyKey);
    for (const file of files) body.append('receipts', new Blob([new Uint8Array(file.content)], { type: file.type }), file.name);
    return fetch(base + path, { method: 'POST', headers: { Cookie: customer, Origin: config.appUrl, 'X-CSRF-Protection': '1' }, body });
  }
  it('accepts mixed evidence, retains original PDFs, protects preview/download and approves exactly once', async () => {
    const files = [pdfFile(), { name: 'receipt.png', type: 'image/png', content: png }];
    const response = await submit(files, key);
    assert.equal(response.status, 201, await response.clone().text());
    const saved = await response.json(); savedId = saved.id;
    assert.equal(saved.status, 'pending'); assert.equal(saved.receipts.length, 2);
    assert.equal((await (await submit(files, key)).json()).id, saved.id);
    const receipt = saved.receipts.find((item: { mime_type: string }) => item.mime_type === 'application/pdf');
    assert.equal(receipt.name, 'bank-receipt.pdf'); assert.equal(receipt.size, pdf.length);
    assert.equal((await fetch(base + receipt.url)).status, 401);
    assert.equal((await fetch(base + receipt.url, { headers: { Cookie: other } })).status, 404);
    assert.equal((await fetch(base + receipt.url.replace(seed.customerId, seed.secondCustomerId), { headers: { Cookie: customer } })).status, 404);
    for (const cookie of [customer, admin]) {
      const document = await fetch(base + receipt.url, { headers: { Cookie: cookie } });
      assert.equal(document.status, 200); assert.match(document.headers.get('content-type')!, /application\/pdf/);
      assert.equal(document.headers.get('cache-control'), 'private, no-store');
      assert.equal(document.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await document.arrayBuffer()), pdf);
    }
    const download = await fetch(base + receipt.url + '?download=1', { headers: { Cookie: customer } });
    assert.match(download.headers.get('content-disposition')!, /^attachment;.*bank-receipt.pdf/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), pdf);
    for (let i = 0; i < 2; i++) assert.equal((await fetch(base + path + `/${saved.id}/approve`, {
      method: 'POST', headers: { Cookie: admin, Origin: config.appUrl, 'X-CSRF-Protection': '1', 'Content-Type': 'application/json' }, body: '{}',
    })).status, 201);
    const payments = await db.db.query("SELECT amount_minor::text AS amount FROM ledger_entries WHERE kind='payment'");
    assert.deepEqual(payments.rows, [{ amount: '-2500' }]);
  });
  it('rejects invalid, mislabelled and oversized PDFs without partial payment records', async () => {
    const invalid = [
      { ...pdfFile(), content: Buffer.from('<html>not a PDF</html>') },
      { ...pdfFile(), content: pdf.subarray(0, 100) },
      { ...pdfFile(), content: png },
      { ...pdfFile(), name: 'fake.png', type: 'image/png' },
      { ...pdfFile(), name: 'fake.jpg' },
      { ...pdfFile(), content: Buffer.alloc(5 * 1024 * 1024 + 1) },
    ];
    for (const file of invalid) assert.ok([400, 413].includes((await submit([file])).status));
    assert.equal((await db.db.query('SELECT count(*)::int AS count FROM booking_payments')).rows[0].count, 1);
  });
  it('rejects duplicate PDF evidence within a batch or another active submission', async () => {
    assert.equal((await submit([pdfFile(), pdfFile()])).status, 400);
    assert.equal((await submit([pdfFile()])).status, 409);
    assert.equal((await db.db.query('SELECT count(*)::int AS count FROM booking_payment_receipts WHERE payment_id=$1', [savedId])).rows[0].count, 2);
  });
});
