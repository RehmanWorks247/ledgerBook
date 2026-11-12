import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from '../apps/api/src/app';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { config } from '../apps/api/src/config';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

describe('standalone companies HTTP workflow', () => {
  let database: TestDatabase, seed: TestSeed, app: NestExpressApplication, base: string;
  let admin: string, customer: string, other: string;

  before(async () => {
    database = await setupTestDatabase();
    seed = await database.seed();
    app = await createApp({ database: database.db, logger: false, paymentEmails: false, reminderEmails: false });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    const auth = app.get(AuthService);
    [admin, customer, other] = await Promise.all([seed.adminId, seed.customerUserId, seed.otherAdminId]
      .map(async id => `${config.sessionCookie}=${await auth.createSession(id)}`));
  });
  after(async () => { await app?.close(); await database?.close(); });

  const path = (orgId = seed.orgId, id?: string) => `/organizations/${orgId}/companies${id ? `/${id}` : ''}`;
  const input = (fields: Record<string, unknown> = {}) => ({
    company_name: `Company ${randomUUID().slice(0, 8)}`, idempotency_key: randomUUID(), ...fields,
  });
  const request = (url: string, method = 'GET', body?: unknown, cookie = admin, csrf = true) => fetch(`${base}/api${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json', Cookie: cookie,
      ...(csrf ? { Origin: config.appUrl, 'X-CSRF-Protection': '1' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  async function create(fields: Record<string, unknown> = {}, orgId = seed.orgId, cookie = admin) {
    const response = await request(path(orgId), 'POST', input(fields), cookie);
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  }
  async function list(query: Record<string, string> = {}, orgId = seed.orgId, cookie = admin) {
    const response = await request(`${path(orgId)}?${new URLSearchParams(query)}`, 'GET', undefined, cookie);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }

  it('persists all spreadsheet fields, retries creation once, and protects edits and deletion from stale versions', async () => {
    const body = input({
      company_name: `Manual company ${randomUUID()}`, hotel_name: 'Pullman Zamzam Madinah',
      customer_name: 'Syed Ahsan Yousuf', check_in: '2026-06-16', check_out: '2026-06-21',
      quantity: 3, room_type: 'Dbl / Triple With BB', booking_date: '2026-05-21', voucher_number: '002825',
      voucher_price: '6625.10', remarks: 'Voucher from the company sheet.',
    });
    const response = await request(path(), 'POST', body);
    assert.equal(response.status, 201, await response.clone().text());
    const row = await response.json();
    assert.equal(row.organization_id, seed.orgId);
    assert.equal(row.version, 1);
    assert.equal(row.voucher_price_minor, '662510');
    assert.equal('paid_minor' in row, false, 'Paid belongs to the company, not an individual voucher.');
    assert.equal(row.quantity, 3);
    for (const field of ['company_name', 'hotel_name', 'customer_name', 'check_in', 'check_out', 'room_type', 'booking_date', 'voucher_number', 'remarks']) {
      assert.equal(row[field], body[field as keyof typeof body], field);
    }
    assert.ok(!Number.isNaN(Date.parse(row.created_at)));
    assert.ok(!Number.isNaN(Date.parse(row.updated_at)));
    const retry = await request(path(), 'POST', body);
    assert.equal(retry.status, 201, await retry.clone().text());
    assert.deepEqual(await retry.json(), row);
    assert.equal((await request(path(), 'POST', { ...body, company_name: 'Changed retry' })).status, 409);

    const found = await list({ search: body.company_name });
    assert.equal(found.total, 1);
    assert.equal(found.currency, 'USD');
    assert.equal(found.currency_exponent, 2);
    assert.deepEqual(found.items, [row]);

    const edited = await request(path(seed.orgId, row.id), 'PATCH', {
      company_name: `${body.company_name} edited`, quantity: 8, booking_date: null, remarks: 'Revised independently', expected_version: 1,
    });
    assert.equal(edited.status, 200, await edited.clone().text());
    const updated = await edited.json();
    assert.equal(updated.version, 2);
    assert.equal(updated.quantity, 8);
    assert.equal(updated.booking_date, null);
    assert.equal(updated.voucher_price_minor, row.voucher_price_minor);
    const retryAfterEdit = await request(path(), 'POST', { ...body, voucher_price: '6625.1' });
    assert.equal(retryAfterEdit.status, 201);
    assert.deepEqual(await retryAfterEdit.json(), row, 'The same creation retry returns its original result after edits.');
    assert.equal((await request(path(seed.orgId, row.id), 'PATCH', { remarks: 'Stale', expected_version: 1 })).status, 409);
    assert.equal((await request(path(seed.orgId, row.id), 'DELETE', { expected_version: 1 })).status, 409);
    assert.deepEqual((await list({ search: body.company_name })).items, [updated]);
    const deleted = await request(path(seed.orgId, row.id), 'DELETE', { expected_version: 2 });
    assert.equal(deleted.status, 200, await deleted.clone().text());
    assert.equal((await list({ search: body.company_name })).total, 0);
    assert.equal((await request(path(), 'POST', body)).status, 409, 'A delayed creation retry cannot resurrect a deleted company.');
    assert.equal((await list({ search: body.company_name })).total, 0);
    const receipt = (await database.db.query('SELECT company_id,response FROM company_create_requests WHERE organization_id=$1 AND idempotency_key=$2',
      [seed.orgId, body.idempotency_key])).rows[0];
    assert.deepEqual(receipt, { company_id: null, response: null });
  });

  it('accepts blank optional fields and exact zero amounts, while rejecting malformed input', async () => {
    const row = await create();
    for (const field of ['check_in', 'check_out', 'booking_date', 'voucher_price_minor']) {
      assert.equal(row[field], null, field);
    }
    const zero = await create({ voucher_price: '0' });
    for (const field of ['voucher_price_minor']) assert.equal(zero[field], '0');
    const large = await create({ voucher_price: '1000000000000.00', quantity: 1000000 });
    assert.equal(large.voucher_price_minor, '100000000000000');
    const invalid = [
      { company_name: ' ' }, { company_name: 'Bad\0name' }, { voucher_price: '-1' }, { paid: '-1' }, { unpaid: '-1' },
      { voucher_price: '1.001' }, { paid: '1e3' }, { balance: 'NaN' }, { paid: 12 },
      { check_in: '2026-02-30' }, { check_out: '31-12-2026' }, { booking_date: '2026-13-01' },
      { check_in: '2026-07-02', check_out: '2026-07-01' },
      { customer_id: seed.customerId }, { booking_id: randomUUID() },
    ];
    for (const fields of invalid) {
      const response = await request(path(), 'POST', input(fields));
      assert.equal(response.status, 400, `${JSON.stringify(fields)}: ${await response.text()}`);
    }
    assert.equal((await request(path(seed.orgId, row.id), 'PATCH', { remarks: 'Missing version' })).status, 400);
    assert.equal((await request(path(seed.orgId, row.id), 'DELETE', {})).status, 400);
  });

  it('checks partial date edits against the saved stay and clears date and money fields without changing other values', async () => {
    const row = await create({
      company_name: `Cleared fields ${randomUUID()}`, check_in: '2026-07-01', check_out: '2026-07-02',
      booking_date: '2026-06-10', voucher_price: '30', remarks: 'Preserve this note',
    });
    for (const changes of [{ check_in: '2026-07-03' }, { check_out: '2026-06-30' }]) {
      assert.equal((await request(path(seed.orgId, row.id), 'PATCH', { ...changes, expected_version: 1 })).status, 400);
    }
    assert.deepEqual((await list({ search: row.company_name })).items, [row]);
    const response = await request(path(seed.orgId, row.id), 'PATCH', {
      check_in: null, check_out: null, booking_date: null, voucher_price: null, expected_version: 1,
    });
    assert.equal(response.status, 200, await response.clone().text());
    const cleared = await response.json();
    assert.equal(cleared.version, 2);
    assert.equal(cleared.remarks, 'Preserve this note');
    for (const field of ['check_in', 'check_out', 'booking_date', 'voucher_price_minor']) {
      assert.equal(cleared[field], null, field);
    }
    assert.deepEqual((await list({ search: row.company_name })).items, [cleared]);
  });

  it('filters each date field inclusively, excludes blank dates, and validates filter boundaries', async () => {
    const name = `Date range ${randomUUID()}`;
    const first = await create({ company_name: `${name} first`, booking_date: '2026-04-01', check_in: '2026-05-01', check_out: '2026-05-04' });
    const middle = await create({ company_name: `${name} middle`, booking_date: '2026-04-02', check_in: '2026-05-02', check_out: '2026-05-05' });
    const last = await create({ company_name: `${name} last`, booking_date: '2026-04-03', check_in: '2026-05-03', check_out: '2026-05-06' });
    await create({ company_name: `${name} undated` });
    for (const [dateField, start, end] of [
      ['booking_date', '2026-04-01', '2026-04-02'],
      ['check_in', '2026-05-01', '2026-05-02'],
      ['check_out', '2026-05-04', '2026-05-05'],
    ]) {
      const filtered = await list({ search: name, date_field: dateField, start, end });
      assert.equal(filtered.total, 2);
      assert.deepEqual(filtered.items.map((item: { id: string }) => item.id).sort(), [first.id, middle.id].sort());
      const exact = await list({ search: name, date_field: dateField, start: end, end });
      assert.deepEqual(exact.items.map((item: { id: string }) => item.id), [middle.id]);
    }
    assert.deepEqual((await list({ search: name, start: '2026-04-03' })).items.map((item: { id: string }) => item.id), [last.id]);
    assert.deepEqual((await list({ search: name, end: '2026-04-01' })).items.map((item: { id: string }) => item.id), [first.id]);
    const invalidQueries: Record<string, string>[] = [
      { start: '2026-02-30' }, { end: 'yesterday' }, { start: '2026-05-02', end: '2026-05-01' },
      { date_field: 'created_at' }, { page: '0' }, { page_size: '0' },
    ];
    for (const query of invalidQueries) {
      assert.equal((await request(`${path()}?${new URLSearchParams(query)}`)).status, 400, JSON.stringify(query));
    }
  });

  it('searches entered names and voucher text literally and paginates without duplicating rows', async () => {
    const prefix = `Search-${randomUUID()}`;
    const percent = await create({ company_name: `${prefix} 100% Travel`, hotel_name: 'Literal Hotel', voucher_number: `V-${prefix}` });
    const underscore = await create({ company_name: `${prefix} 100_ Travel` });
    await create({ company_name: `${prefix} 100X Travel` });
    assert.deepEqual((await list({ search: `${prefix} 100%` })).items.map((item: { id: string }) => item.id), [percent.id]);
    assert.deepEqual((await list({ search: `${prefix} 100_` })).items.map((item: { id: string }) => item.id), [underscore.id]);
    assert.deepEqual((await list({ search: `v-${prefix.toLowerCase()}` })).items.map((item: { id: string }) => item.id), [percent.id]);
    const first = await list({ search: prefix, page: '1', page_size: '2' });
    const second = await list({ search: prefix, page: '2', page_size: '2' });
    assert.equal(first.total, 3);
    assert.equal(second.total, 3);
    assert.equal(first.page, 1);
    assert.equal(second.page, 2);
    assert.equal(first.page_size, 2);
    assert.equal(first.items.length, 2);
    assert.equal(second.items.length, 1);
    assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 3);
    assert.equal((await list({ search: prefix, page: '3', page_size: '2' })).items.length, 0);
  });

  it('requires login, CSRF, administrator access and the matching workspace for every operation', async () => {
    const row = await create({ company_name: `Private ${randomUUID()}` });
    const another = await create({ company_name: `Other private ${randomUUID()}` }, seed.otherOrgId, other);
    assert.equal((await request(path(), 'GET', undefined, '')).status, 401);
    assert.equal((await request(path(), 'POST', input(), '')).status, 401);
    assert.equal((await request(path(), 'POST', input(), admin, false)).status, 403);
    assert.equal((await request(path(seed.orgId, row.id), 'PATCH', { remarks: 'Forged', expected_version: 1 }, admin, false)).status, 403);
    assert.equal((await request(path(seed.orgId, row.id), 'DELETE', { expected_version: 1 }, admin, false)).status, 403);
    for (const [url, method, body] of [
      [path(), 'GET', undefined], [path(), 'POST', input()],
      [path(seed.orgId, row.id), 'PATCH', { remarks: 'Unauthorized', expected_version: 1 }],
      [path(seed.orgId, row.id), 'DELETE', { expected_version: 1 }],
    ] as const) {
      assert.equal((await request(url, method, body, customer)).status, 403, `${method} as customer`);
      assert.equal((await request(url, method, body, other)).status, 404, `${method} from another workspace`);
    }
    assert.equal((await request(path(seed.otherOrgId))).status, 404);
    assert.equal((await request(path(seed.otherOrgId), 'POST', input())).status, 404);
    assert.equal((await request(path(seed.orgId, another.id), 'PATCH', { remarks: 'Cross-tenant ID', expected_version: 1 })).status, 404);
    assert.equal((await request(path(seed.orgId, another.id), 'DELETE', { expected_version: 1 })).status, 404);
    assert.deepEqual((await list({ search: row.company_name })).items, [row]);
    assert.deepEqual((await list({ search: another.company_name }, seed.otherOrgId, other)).items, [another]);
  });

  it('scopes customer records, search, dates and pagination to an exact company within the workspace', async () => {
    const name = 'Muhabiya Hotels';
    const first = await create({ company_name: name, customer_name: 'Shared customer', booking_date: '2026-06-01' });
    const second = await create({ company_name: name.toLowerCase(), customer_name: 'Shared customer', booking_date: '2026-06-02' });
    await create({ company_name: 'Aden Golden', customer_name: 'Shared customer', booking_date: '2026-06-01', remarks: name });
    await create({ company_name: 'Al Subaee', customer_name: 'Shared customer', booking_date: '2026-06-01' });
    await create({ company_name: `${name} Annex`, customer_name: 'Shared customer', booking_date: '2026-06-01' });
    await create({ company_name: name, customer_name: 'Shared customer' }, seed.otherOrgId, other);
    const query = { company_name: ` ${name.toUpperCase()} `, search: 'shared', page_size: '1' };
    const pageOne = await list(query);
    const pageTwo = await list({ ...query, page: '2' });
    assert.equal(pageOne.total, 2);
    assert.equal(pageTwo.total, 2);
    assert.equal(pageOne.items.length, 1);
    assert.equal(pageTwo.items.length, 1);
    assert.deepEqual([...pageOne.items, ...pageTwo.items].map(row => row.id).sort(), [first.id, second.id].sort());
    assert.deepEqual((await list({ company_name: name, start: '2026-06-02', end: '2026-06-02' })).items, [second]);
    assert.equal((await list({ company_name: name, search: 'Aden Golden' })).total, 0);
    assert.equal((await list({ company_name: name, page: '3', page_size: '1' })).items.length, 0);
    assert.equal((await list({ company_name: 'Unknown company' })).total, 0);
    for (const company_name of [' ', 'x'.repeat(201), 'bad\0name']) {
      assert.equal((await request(`${path()}?${new URLSearchParams({ company_name })}`)).status, 400);
    }
    assert.equal((await request(`${path()}?${new URLSearchParams({ company_name: name })}`, 'GET', undefined, customer)).status, 403);
  });

  it('uses one company paid amount across every voucher, independent of quantity, filters and pagination', async () => {
    const company_name = `Company totals ${randomUUID()}`;
    const first = await create({ company_name, customer_name: 'First voucher', quantity: 5, voucher_price: '100.30', booking_date: '2026-06-01' });
    const second = await create({ company_name, customer_name: 'Second voucher', voucher_price: '50', booking_date: '2026-06-02' });
    const setPaid = (paid: string, version: number, name = company_name) => request(`${path()}/paid`, 'PATCH', { company_name: name, paid, expected_version: version });
    assert.deepEqual((await list({ company_name })).totals, {
      total_minor: '15030', paid_minor: '0', balance_minor: '15030', unpaid_minor: '15030', unpriced_count: 0, voucher_count: 2, paid_version: 0,
    });
    const paid = await setPaid('60.30', 0);
    assert.equal(paid.status, 200, await paid.clone().text());
    assert.deepEqual(await paid.json(), { company_name, paid_minor: '6030', version: 1 });
    const totals = { total_minor: '15030', paid_minor: '6030', balance_minor: '9000', unpaid_minor: '9000', unpriced_count: 0, voucher_count: 2, paid_version: 1 };
    const tableFilters: Record<string, string>[] = [{ page_size: '1' }, { search: 'First voucher' }, { start: '2026-06-02' }, { search: 'No matching voucher' }];
    for (const filters of tableFilters) {
      assert.deepEqual((await list({ company_name, ...filters })).totals, totals, 'Company totals ignore table filters and pagination.');
    }
    const same = await setPaid('60.3', 1, company_name.toUpperCase());
    assert.equal(same.status, 200);
    assert.equal((await same.json()).version, 1);
    assert.equal((await setPaid('100', 0)).status, 409);
    assert.equal((await request(path(seed.orgId, first.id), 'PATCH', { quantity: 9, voucher_price: '120.30', expected_version: 1 })).status, 200);
    assert.deepEqual((await list({ company_name })).totals, { ...totals, total_minor: '17030', balance_minor: '11000', unpaid_minor: '11000' });
    assert.equal((await setPaid('180', 1)).status, 200);
    assert.equal((await list({ company_name })).totals.balance_minor, '-970');
    assert.equal((await list({ company_name })).totals.unpaid_minor, '0');
    const unknown = await create({ company_name });
    assert.deepEqual((await list({ company_name })).totals, { ...totals, total_minor: null, paid_minor: '18000', balance_minor: null, unpaid_minor: null, unpriced_count: 1, voucher_count: 3, paid_version: 2 });
    for (const [id, version] of [[first.id, 2], [second.id, 1], [unknown.id, 1]] as const)
      assert.equal((await request(path(seed.orgId, id), 'DELETE', { expected_version: version })).status, 200);
    assert.deepEqual((await list({ company_name })).totals, { ...totals, total_minor: '0', paid_minor: '18000', balance_minor: '-18000', unpaid_minor: '0', voucher_count: 0, paid_version: 2 });
    const unconnected = await create({ company_name: `${company_name} Other`, voucher_price: '20' });
    assert.equal((await list({ company_name: unconnected.company_name })).totals.paid_minor, '0');
    assert.equal((await setPaid('0', 2)).status, 200, 'Company paid can be cleared independently.');
    assert.equal((await list({ company_name })).totals.paid_minor, '0');
  });

  it('protects the company paid field from stale edits, invalid amounts, customers and other workspaces', async () => {
    const company_name = `Paid access ${randomUUID()}`;
    const paidPath = `${path()}/paid`;
    const body = { company_name, paid: '10.30', expected_version: 0 };
    assert.equal((await request(paidPath, 'PATCH', body, '')).status, 401);
    assert.equal((await request(paidPath, 'PATCH', body, customer)).status, 403);
    assert.equal((await request(paidPath, 'PATCH', body, other)).status, 404);
    assert.equal((await request(paidPath, 'PATCH', body, admin, false)).status, 403);
    for (const paid of ['', ' ', '-1', '1.001', '1e2', '1,000', 'NaN'])
      assert.equal((await request(paidPath, 'PATCH', { ...body, paid })).status, 400);
    assert.equal((await request(paidPath, 'PATCH', { company_name, paid: '10' })).status, 400);
    assert.equal((await request(paidPath, 'PATCH', body)).status, 200);
    const edits = await Promise.all(['20', '30'].map(paid => request(paidPath, 'PATCH', { company_name, paid, expected_version: 1 })));
    assert.deepEqual(edits.map(edit => edit.status).sort(), [200, 409]);
    assert.equal((await list({ company_name })).totals.paid_version, 2);
    const otherPaid = await request(`${path(seed.otherOrgId)}/paid`, 'PATCH', { company_name, paid: '500', expected_version: 0 }, other);
    assert.equal(otherPaid.status, 200);
    assert.notEqual((await list({ company_name })).totals.paid_minor, '50000');
    assert.equal((await list({ company_name }, seed.otherOrgId, other)).totals.paid_minor, '50000');
    for (const fields of [{ quantity: 0 }, { quantity: 1.5 }, { quantity: '2' }, { quantity: 1000001 }, { paid: '10' }, { unpaid: '5' }, { balance: '5' }, { payments: [] }])
      assert.equal((await request(path(), 'POST', input(fields))).status, 400);
  });

  it('exports every company voucher and shared totals in one scoped snapshot, beyond the table page limit', async () => {
    const company_name = `Export ${randomUUID()}`;
    const first = await create({ company_name, customer_name: '=Literal text', voucher_number: '002825', quantity: 7, voucher_price: '6625.10' });
    await database.db.query(`INSERT INTO companies(id,organization_id,company_name,customer_name,voucher_price_minor)
      SELECT gen_random_uuid(),$1,$2,'Export row ' || n,100 FROM generate_series(1,100) AS n`, [seed.orgId, company_name]);
    await create({ company_name: `${company_name} Other`, customer_name: 'Different company', voucher_price: '50' });
    await create({ company_name, customer_name: 'Different workspace', voucher_price: '50' }, seed.otherOrgId, other);
    assert.equal((await request(`${path()}/paid`, 'PATCH', { company_name, paid: '125.25', expected_version: 0 })).status, 200);
    const url = `${path()}/export?${new URLSearchParams({ company_name: company_name.toUpperCase() })}`;
    const response = await request(url);
    assert.equal(response.status, 200, await response.clone().text());
    const exported = await response.json() as {
      currency: string; currency_exponent: number; total: number;
      items: { id: string; company_name: string; organization_id: string }[];
      totals: Record<string, string | number>;
    };
    assert.equal(exported.currency, 'SAR');
    assert.equal(exported.currency_exponent, 2);
    assert.equal(exported.total, 101);
    assert.equal(exported.items.length, 101);
    assert.equal(exported.items.filter(row => row.id === first.id).length, 1);
    assert.ok(exported.items.every(row => row.company_name === company_name && row.organization_id === seed.orgId));
    assert.deepEqual(exported.totals, { total_minor: '672510', paid_minor: '12525', balance_minor: '659985', unpaid_minor: '659985', unpriced_count: 0, voucher_count: 101, paid_version: 1 });
    assert.equal((await request(url, 'GET', undefined, '')).status, 401);
    assert.equal((await request(url, 'GET', undefined, customer)).status, 403);
    assert.equal((await request(url, 'GET', undefined, other)).status, 404);
    assert.equal((await request(`${path()}/export`)).status, 400);
    assert.equal((await request(`${url}&page=2`)).status, 400);
    const empty = await request(`${path()}/export?${new URLSearchParams({ company_name: `Empty ${randomUUID()}` })}`);
    assert.equal(empty.status, 200);
    assert.equal((await empty.json()).items.length, 0);
  });

  it('stays independent from customers, bookings and money movements and cascades with its own workspace', async () => {
    const tables = ['customers', 'bookings', 'ledger_entries', 'booking_payments', 'payment_email_outbox', 'reminder_email_outbox'];
    const counts = async () => {
      const result: Record<string, number> = {};
      for (const table of tables) result[table] = (await database.db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
      return result;
    };
    const before = await counts();
    const row = await create({ customer_name: 'Free text without a customer account', voucher_price: '100' });
    assert.equal((await request(path(seed.orgId, row.id), 'PATCH', { voucher_price: '120', expected_version: 1 })).status, 200);
    assert.equal((await request(path(seed.orgId, row.id), 'DELETE', { expected_version: 2 })).status, 200);
    assert.deepEqual(await counts(), before);
    const columns = await database.db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='companies' AND column_name IN ('customer_id','booking_id','ledger_entry_id')`);
    assert.deepEqual(columns.rows, []);

    const workspaceName = `Company workspace ${randomUUID()}`;
    const workspaceResponse = await request('/organizations', 'POST', {
      name: workspaceName, description: '', color: '#13795b', idempotency_key: randomUUID(),
    });
    assert.equal(workspaceResponse.status, 201, await workspaceResponse.clone().text());
    const workspace = await workspaceResponse.json();
    const scoped = await create({ company_name: 'Workspace-only company' }, workspace.id);
    assert.equal((await request(`${path(workspace.id)}/paid`, 'PATCH', { company_name: 'Workspace-only company', paid: '50', expected_version: 0 })).status, 200);
    const preserved = await create({ company_name: `Preserved ${randomUUID()}` });
    const deleted = await request(`/organizations/${workspace.id}`, 'DELETE', {
      confirmation_name: workspaceName, expected_version: workspace.version,
    });
    assert.equal(deleted.status, 200, await deleted.clone().text());
    assert.equal((await database.db.query('SELECT 1 FROM companies WHERE id=$1', [scoped.id])).rowCount, 0);
    assert.equal((await database.db.query('SELECT 1 FROM company_balances WHERE organization_id=$1', [workspace.id])).rowCount, 0);
    assert.equal((await request(path(workspace.id))).status, 404);
    assert.deepEqual((await list({ search: preserved.company_name })).items, [preserved]);
  });
});
