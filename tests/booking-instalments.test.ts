import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from '../apps/api/src/app';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { config } from '../apps/api/src/config';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

describe('booking instalment rounding over HTTP', () => {
  let database: TestDatabase, seed: TestSeed, app: NestExpressApplication, base: string, cookie: string;
  before(async () => {
    database = await setupTestDatabase();
    seed = await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1", [seed.orgId]);
    app = await createApp({ database: database.db, logger: false, paymentEmails: false, reminderEmails: false });
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api/organizations/${seed.orgId}/customers/${seed.customerId}/bookings`;
    cookie = `${config.sessionCookie}=${await app.get(AuthService).createSession(seed.adminId)}`;
  });
  after(async () => { if (app) await app.close(); if (database) await database.close(); });

  const request = (second = '60.00') => ({
    reference: `ROUND-${randomUUID()}`, departure_at: '2026-12-20T10:30:00Z', required_services: [],
    amount: '100.00', effective_date: '2026-11-01', idempotency_key: randomUUID(),
    instalments: [{ due_date: '2026-11-02', amount: '40.00' }, { due_date: '2026-11-09', amount: second }],
  });
  const send = (body: unknown, id?: string) => fetch(id ? `${base}/${id}` : base, {
    method: id ? 'PATCH' : 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: config.appUrl, 'X-CSRF-Protection': '1' },
  });
  const accepted = [['55.00', '5500'], ['55.01', '5501'], ['60.00', '6000'], ['64.99', '6499'], ['65.00', '6500']];

  it('creates exact and rounded schedules through both inclusive £5 boundaries without changing the charge', async () => {
    for (const [amount, pennies] of accepted) {
      const input = request(amount), response = await send(input);
      assert.equal(response.status, 201, await response.clone().text());
      const saved = await response.json();
      assert.equal(saved.total_minor, '10000');
      assert.deepEqual(saved.instalments.map((item: { amount_minor: string }) => item.amount_minor), ['4000', pennies]);
      const charge = await database.db.query('SELECT amount_minor::text AS amount FROM ledger_entries WHERE id=$1', [saved.charge_entry_id]);
      assert.equal(charge.rows[0].amount, '10000');
      const retry = await send(input);
      assert.equal(retry.status, 201);
      assert.equal((await retry.json()).id, saved.id);
    }
  });

  it('rejects a penny outside either boundary and invalid individual amounts without creating bookings or charges', async () => {
    for (const amount of ['54.99', '65.01', '0', '-1', '60.001']) {
      const input = request(amount), response = await send(input);
      assert.equal(response.status, 400);
      if (['54.99', '65.01'].includes(amount)) assert.match((await response.json()).message, /within £5.00/);
      const charge = await database.db.query('SELECT count(*)::int AS count FROM ledger_entries WHERE reference=$1', [input.reference]);
      assert.equal(charge.rows[0].count, 0);
      const booking = await database.db.query('SELECT count(*)::int AS count FROM bookings WHERE reference=$1', [input.reference]);
      assert.equal(booking.rows[0].count, 0);
    }
    const input = request();
    input.instalments = input.instalments.map(item => ({ ...item, amount: '47.00' }));
    assert.equal((await send(input)).status, 400, 'The tolerance applies once to the complete schedule.');
  });

  it('edits schedules through both £5 boundaries and preserves the booking charge and entered amounts', async () => {
    for (const [amount, pennies] of accepted) {
      const input = request(), created = await send(input);
      assert.equal(created.status, 201);
      const original = await created.json();
      const update = { ...input, idempotency_key: randomUUID(), expected_version: 1, reason: 'Round instalment amounts',
        instalments: [input.instalments[0], { ...input.instalments[1], amount }] };
      const response = await send(update, original.id);
      assert.equal(response.status, 200, await response.clone().text());
      const saved = await response.json();
      assert.equal(saved.total_minor, '10000');
      assert.equal(saved.version, 2);
      assert.equal(String(saved.charge_entry_id), String(original.charge_entry_id));
      assert.deepEqual(saved.instalments.map((item: { amount_minor: string }) => item.amount_minor), ['4000', pennies]);
      const charge = await database.db.query('SELECT count(*)::int AS count FROM ledger_entries WHERE reference=$1', [input.reference]);
      assert.equal(charge.rows[0].count, 1);
      const retry = await send(update, original.id);
      assert.equal(retry.status, 200);
      assert.deepEqual(await retry.json(), saved);
    }
  });

  it('rejects edits outside the tolerance without changing the schedule, version or charge', async () => {
    const input = request(), original = await (await send(input)).json();
    for (const amount of ['54.99', '65.01']) {
      const update = { ...input, idempotency_key: randomUUID(), expected_version: 1, reason: 'Invalid rounded total',
        instalments: [input.instalments[0], { ...input.instalments[1], amount }] };
      const response = await send(update, original.id);
      assert.equal(response.status, 400);
      assert.match((await response.json()).message, /within £5.00/);
      const current = await (await fetch(`${base}/${original.id}`, { headers: { Cookie: cookie } })).json();
      assert.equal(current.version, 1);
      assert.equal(current.total_minor, '10000');
      assert.equal(String(current.charge_entry_id), String(original.charge_entry_id));
      assert.deepEqual(current.instalments, original.instalments);
    }
  });

  it('validates against a separate persisted calculation total while keeping charges and invoices at the booking total', async () => {
    for (const total of ['195.00', '205.00']) {
      const input = { ...request(), instalment_total: '200.00', instalments: [{ due_date: '2026-11-02', amount: total }] };
      const response = await send(input);
      assert.equal(response.status, 201, await response.clone().text());
      const original = await response.json();
      assert.equal(original.total_minor, '10000');
      assert.equal(original.instalment_total_minor, '20000');
      assert.equal((await (await send(input)).json()).id, original.id);
      const conflict = await send({ ...input, instalment_total: total });
      assert.equal(conflict.status, 409, 'The calculation total is part of the submission identity.');

      const update = { ...input, instalment_total: '300.00', instalments: [{ due_date: '2026-11-02', amount: '305.00' }],
        idempotency_key: randomUUID(), expected_version: 1, reason: 'Separate payment-plan calculation' };
      const edited = await send(update, original.id);
      assert.equal(edited.status, 200, await edited.clone().text());
      const saved = await edited.json();
      assert.equal(saved.instalment_total_minor, '30000');
      assert.equal(saved.total_minor, '10000');
      assert.equal(String(saved.charge_entry_id), String(original.charge_entry_id));
      assert.deepEqual(await (await send(update, original.id)).json(), saved);
      const reloaded = await (await fetch(`${base}/${original.id}`, { headers: { Cookie: cookie } })).json();
      assert.equal(reloaded.instalment_total_minor, '30000');
      const charges = await database.db.query('SELECT amount_minor::text AS amount FROM ledger_entries WHERE reference=$1', [input.reference]);
      assert.deepEqual(charges.rows, [{ amount: '10000' }]);
      const invoices = await database.db.query('SELECT DISTINCT total_minor::text AS total FROM booking_invoices WHERE booking_id=$1', [original.id]);
      assert.deepEqual(invoices.rows, [{ total: '10000' }]);
    }
  });

  it('rejects schedules outside the calculation total, invalid calculation amounts, and invalid edits', async () => {
    for (const amount of ['194.99', '205.01', '100.00']) {
      const input = { ...request(), instalment_total: '200.00', instalments: [{ due_date: '2026-11-02', amount }] };
      const response = await send(input);
      assert.equal(response.status, 400);
      assert.match((await response.json()).message, /instalment calculation total/);
    }
    for (const instalment_total of ['0', '-1', '200.001', '1000000000001', ''])
      assert.equal((await send({ ...request(), instalment_total })).status, 400);
    const input = { ...request(), instalment_total: '200.00', instalments: [] };
    const original = await (await send(input)).json();
    assert.equal(original.instalments[0].amount_minor, '20000', 'An unscheduled calculation total becomes the single instalment.');
    const edited = await send({ ...input, instalment_total: '300.00', instalments: [{ due_date: '2026-11-02', amount: '305.01' }],
      idempotency_key: randomUUID(), expected_version: 1, reason: 'Invalid plan' }, original.id);
    assert.equal(edited.status, 400);
    const reloaded = await (await fetch(`${base}/${original.id}`, { headers: { Cookie: cookie } })).json();
    assert.equal(reloaded.version, 1);
    assert.equal(reloaded.instalment_total_minor, '20000');
    await database.db.query('UPDATE bookings SET instalment_total_minor=NULL WHERE id=$1', [original.id]);
    const legacy = await (await fetch(`${base}/${original.id}`, { headers: { Cookie: cookie } })).json();
    assert.equal(legacy.instalment_total_minor, '10000', 'Existing records use their booking total.');
  });
});
