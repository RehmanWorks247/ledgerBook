import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import { createApp } from '../apps/api/src/app';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { config } from '../apps/api/src/config';
import { NotificationsService, type EmailMessage } from '../apps/api/src/notifications/notifications.service';
import { setupTestDatabase, testPassword, type TestDatabase, type TestSeed } from './helpers';

describe('complete customer, booking, document and payment workflow over HTTP', () => {
  let database: TestDatabase;
  let seed: TestSeed;
  let app: NestExpressApplication;
  let base: string;
  let adminCookie: string;
  let otherAdminCookie: string;
  const messages: EmailMessage[] = [];
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Title (Workflow voucher) >>\nendobj\n%%EOF\n');

  before(async () => {
    database = await setupTestDatabase();
    seed = await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1", [seed.orgId]);
    app = await createApp({ database: database.db, logger: false, paymentEmails: false });
    app.get(NotificationsService).send = async message => { messages.push(message); };
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api`;
    const auth = app.get(AuthService);
    adminCookie = `${config.sessionCookie}=${await auth.createSession(seed.adminId)}`;
    otherAdminCookie = `${config.sessionCookie}=${await auth.createSession(seed.otherAdminId)}`;
  });

  after(async () => {
    if (app) await app.close();
    if (database) await database.close();
  });

  const customersPath = () => `/organizations/${seed.orgId}/customers`;
  const headers = (cookie = adminCookie) => ({ Cookie: cookie, Origin: config.appUrl, 'X-CSRF-Protection': '1' });
  const request = (path: string, method = 'GET', body?: unknown, cookie = adminCookie) => fetch(`${base}${path}`, {
    method, headers: { ...headers(cookie), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  async function success(response: Response, expected = 200) {
    assert.equal(response.status, expected, await response.clone().text());
    return response.json();
  }
  async function account(label: string) {
    const body = { name: label, email: `${randomUUID()}@example.test`, phone: '+44 7700 900123', notes: 'Internal workflow test note', idempotency_key: randomUUID() };
    const customer = await success(await request(customersPath(), 'POST', body), 201);
    assert.equal(customer.delivery_status, 'sent');
    assert.equal(customer.invitation_status, 'pending');
    const message = messages.find(item => item.to === body.email);
    assert.ok(message, 'The invitation is delivered only to the in-memory test mail sink.');
    const token = /\/invite#([A-Za-z0-9_-]{43})/.exec(message.text)?.[1];
    assert.ok(token);
    const joined = await request('/auth/invitations/accept', 'POST', { token, password: testPassword }, '');
    const identity = await success(joined);
    const cookie = joined.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie, 'Accepting an invitation must establish a usable customer session.');
    return { customer, body, path: `${customersPath()}/${customer.id}`, cookie, userId: identity.user.id };
  }
  async function booking(path: string, label: string) {
    const body = { reference: `${label}-${randomUUID()}`, departure_at: '2030-01-01T12:00:00Z', required_services: ['flight', 'makkah'], amount: '100.00', effective_date: '2026-01-01',
      instalments: [{ due_date: '2026-01-01', amount: '40.00' }, { due_date: '2026-02-01', amount: '60.00' }], idempotency_key: randomUUID() };
    const trip = await success(await request(`${path}/bookings`, 'POST', body), 201);
    assert.equal(trip.total_minor, '10000');
    assert.equal(trip.instalments.length, 2);
    const tripPath = `${path}/bookings/${trip.id}`;
    const files = await success(await request(`${tripPath}/files`));
    assert.equal(files.items.length, 6);
    return { trip, body, path: tripPath, flight: files.items.find((item: { serviceKey: string }) => item.serviceKey === 'flight').id as string,
      hotel: files.items.find((item: { serviceKey: string }) => item.serviceKey === 'makkah').id as string };
  }
  async function upload(path: string, folder: string, name: string, key = randomUUID(), content = pdf) {
    return fetch(`${base}${path}/folders/${folder}/documents`, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), 'Idempotency-Key': key }, body: content });
  }

  it('creates and edits an invited customer, keeps two trips separate, manages documents and purges the complete account', async () => {
    const owner = await account('HTTP lifecycle customer');
    const replay = await success(await request(customersPath(), 'POST', owner.body), 201);
    assert.equal(replay.id, owner.customer.id);
    assert.equal(messages.filter(item => item.to === owner.body.email).length, 1);
    const ownProfile = await success(await request(owner.path, 'GET', undefined, owner.cookie));
    assert.equal(ownProfile.id, owner.customer.id);
    assert.equal('notes' in ownProfile, false);
    const edited = { name: 'Edited lifecycle customer', email: owner.body.email, phone: '+44 7700 900456', notes: 'Updated private note', status: 'active' };
    assert.equal((await success(await request(owner.path, 'PATCH', edited))).name, edited.name);
    assert.equal((await request(owner.path, 'PATCH', edited, owner.cookie)).status, 403);
    assert.equal((await request(owner.path, 'PATCH', { ...edited, email: 'changed@example.test' })).status, 400);
    const trip = await booking(owner.path, 'FIRST');
    const second = await booking(owner.path, 'SECOND');
    assert.equal((await success(await request(`${owner.path}/bookings`, 'GET', undefined, owner.cookie))).items.length, 2);
    assert.equal((await success(await request(`${owner.path}/statement`))).current_balance_minor, '20000');

    const nested = await success(await request(`${trip.path}/folders`, 'POST', { name: 'Party details', parent_id: trip.flight, idempotency_key: randomUUID() }), 201);
    const key = randomUUID();
    const original = await success(await upload(trip.path, nested.id, 'voucher.pdf', key), 201);
    assert.equal((await success(await upload(trip.path, nested.id, 'voucher.pdf', key), 201)).id, original.id);
    const another = await success(await upload(second.path, second.flight, 'voucher.pdf'), 201);
    const copied = await success(await upload(trip.path, nested.id, 'voucher.pdf'), 201);
    assert.equal(copied.name, 'voucher (2).pdf');
    assert.equal((await request(`${trip.path}/files/${nested.id}`, 'DELETE')).status, 409, 'A populated folder cannot be deleted.');
    assert.equal((await request(`${trip.path}/files/${trip.flight}`, 'DELETE')).status, 400);
    assert.equal((await request(`${trip.path}/files/${original.id}`, 'PATCH', { name: 'unsafe.html' })).status, 400);
    assert.equal((await request(`${trip.path}/files/${original.id}`, 'PATCH', { name: copied.name })).status, 409);
    const renamed = await success(await request(`${trip.path}/files/${original.id}`, 'PATCH', { name: 'Updated voucher.pdf' }));
    assert.equal(renamed.name, 'Updated voucher.pdf');
    const renamedFolder = await success(await request(`${trip.path}/files/${nested.id}`, 'PATCH', { name: 'Edited party details' }));
    assert.equal(renamedFolder.name, 'Edited party details');
    await success(await request(`${trip.path}/files/${nested.id}`, 'PATCH', { parent_id: trip.hotel }));
    const moved = await success(await request(`${trip.path}/files`, 'GET', undefined, owner.cookie));
    assert.equal(moved.items.find((item: { id: string }) => item.id === original.id).serviceKey, 'makkah');
    assert.equal((await request(`${trip.path}/files/${original.id}`, 'PATCH', { parent_id: second.flight })).status, 404);
    assert.equal((await request(`${second.path}/documents/${original.id}`, 'GET', undefined, owner.cookie)).status, 404);
    assert.equal((await request(`${trip.path}/files/${original.id}`, 'DELETE', undefined, owner.cookie)).status, 403);
    assert.equal((await request(`${trip.path}/documents/${original.id}`, 'GET', undefined, otherAdminCookie)).status, 404);
    const downloaded = await request(`${trip.path}/documents/${original.id}?download=1`, 'GET', undefined, owner.cookie);
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers.get('content-disposition') ?? '', /Updated voucher\.pdf/);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), pdf);
    assert.ok((await success(await request(`${trip.path}/services/makkah`, 'PATCH', { issued: true }))).issuedAt);
    assert.equal((await success(await request(`${trip.path}/services/makkah`, 'PATCH', { issued: false }))).issuedAt, null);
    for (const id of [original.id, copied.id, nested.id]) await success(await request(`${trip.path}/files/${id}`, 'DELETE'));
    assert.equal((await request(`${trip.path}/documents/${original.id}`, 'GET', undefined, owner.cookie)).status, 404);
    assert.equal((await request(`${second.path}/documents/${another.id}`, 'GET', undefined, owner.cookie)).status, 200);

    await success(await request(owner.path, 'PATCH', { ...edited, status: 'archived' }));
    assert.equal((await upload(second.path, second.flight, 'archived.pdf')).status, 409);
    assert.equal((await request(`${second.path}/files/${another.id}`, 'DELETE')).status, 409);
    assert.equal((await request(`${owner.path}/bookings`, 'POST', { ...trip.body, reference: 'ARCHIVED', idempotency_key: randomUUID() })).status, 409);
    await success(await request(owner.path, 'PATCH', edited));
    assert.equal((await request(owner.path, 'DELETE', { confirmation_email: 'wrong@example.test' })).status, 400);
    assert.equal((await request(owner.path)).status, 200, 'A failed confirmation does not partially delete the account.');
    await success(await request(owner.path, 'DELETE', { confirmation_email: owner.body.email }));
    assert.equal((await request(owner.path)).status, 404);
    assert.equal((await request(`${second.path}/documents/${another.id}`)).status, 404);
    assert.equal((await request('/auth/session', 'GET', undefined, owner.cookie)).status, 401);
    for (const table of ['customers', 'bookings', 'booking_nodes', 'booking_instalments', 'ledger_entries', 'memberships', 'invitations']) {
      const column = table === 'customers' ? 'id' : 'customer_id';
      assert.equal((await database.db.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`, [owner.customer.id])).rowCount, 0, table);
    }
    assert.equal((await request(`${customersPath()}/${seed.customerId}`)).status, 200, 'Unrelated customer survives the purge.');
  });

  it('submits a receipt from the invited customer, approves once, reverses accurately and purges receipt and outbox records', async () => {
    const owner = await account('Payment lifecycle customer');
    const trip = await booking(owner.path, 'PAYMENTS');
    const image = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#458071' } }).png().toBuffer();
    const data = new FormData();
    data.set('amount', '35.25'); data.set('payment_date', '2026-01-02'); data.set('idempotency_key', randomUUID());
    data.append('receipts', new Blob([new Uint8Array(image)], { type: 'image/png' }), 'payment.png');
    const submitted = await success(await fetch(`${base}${trip.path}/payments`, { method: 'POST', headers: headers(owner.cookie), body: data }), 201);
    assert.equal(submitted.status, 'pending');
    assert.equal((await success(await request(`${owner.path}/statement`))).current_balance_minor, '10000');
    const approved = await success(await request(`${trip.path}/payments/${submitted.id}/approve`, 'POST', {}), 201);
    assert.equal(approved.status, 'approved');
    const replay = await success(await request(`${trip.path}/payments/${submitted.id}/approve`, 'POST', {}), 201);
    assert.equal(replay.ledger_entry_id, approved.ledger_entry_id);
    assert.equal((await success(await request(`${owner.path}/statement`, 'GET', undefined, owner.cookie))).current_balance_minor, '6475');
    const reversed = await success(await request(`${owner.path}/entries`, 'POST', { kind: 'reversal', reversal_of: approved.ledger_entry_id, description: 'Correct payment posted to this account', effective_date: '2026-01-03', idempotency_key: randomUUID() }), 201);
    assert.equal(reversed.amount_minor, '3525');
    assert.equal((await success(await request(`${owner.path}/statement`))).current_balance_minor, '10000');
    const statement = await request(`${owner.path}/statement.csv`, 'GET', undefined, owner.cookie);
    assert.equal(statement.status, 200);
    assert.match(await statement.text(), /Correct payment posted to this account/);
    const receipt = submitted.receipts[0].url.replace(/^\/api/, '');
    assert.equal((await request(receipt, 'GET', undefined, owner.cookie)).status, 200);
    const notifications=(await database.db.query('SELECT dedupe_key,state,attempts FROM payment_email_outbox WHERE recipient=$1',[owner.body.email])).rows;
    assert.deepEqual(notifications.map(row=>row.dedupe_key).sort(),[`booking-created:${trip.trip.id}`,`payment-received:${submitted.id}:${owner.userId}`,`payment-approved:${submitted.id}`].sort());
    assert.ok(notifications.every(row=>row.state==='pending'&&row.attempts===0),'Acknowledgement and approval stay queued until the worker sends them.');
    await success(await request(owner.path, 'DELETE', { confirmation_email: owner.body.email }));
    for (const table of ['booking_payments', 'booking_payment_receipts', 'ledger_entries']) {
      assert.equal((await database.db.query(`SELECT 1 FROM ${table} WHERE customer_id=$1`, [owner.customer.id])).rowCount, 0, table);
    }
    assert.equal((await database.db.query('SELECT 1 FROM payment_email_outbox WHERE recipient=$1 OR body LIKE $2', [owner.body.email, `%${owner.customer.id}%`])).rowCount, 0);
    assert.equal((await request(receipt)).status, 404);
  });

  it('rolls a conflicting folder move back and retains both folders and all document bytes', async () => {
    const owner = await account('Move conflict customer');
    const trip = await booking(owner.path, 'MOVE-CONFLICT');
    const folders: { id: string }[] = [];
    for (const parent_id of [trip.flight, trip.hotel]) {
      folders.push(await success(await request(`${trip.path}/folders`, 'POST', { name: 'Shared name', parent_id, idempotency_key: randomUUID() }), 201));
    }
    const file = await success(await upload(trip.path, folders[0].id, 'ticket.pdf'), 201);
    assert.equal((await request(`${trip.path}/files/${folders[0].id}`, 'PATCH', { parent_id: trip.hotel })).status, 409);
    const files = await success(await request(`${trip.path}/files`));
    assert.equal(files.items.find((item: { id: string }) => item.id === folders[0].id).parentId, trip.flight);
    assert.equal(files.items.find((item: { id: string }) => item.id === file.id).serviceKey, 'flight');
    const bytes = await request(`${trip.path}/documents/${file.id}`, 'GET', undefined, owner.cookie);
    assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), pdf);
    await success(await request(owner.path, 'DELETE', { confirmation_email: owner.body.email }));
  });
});
