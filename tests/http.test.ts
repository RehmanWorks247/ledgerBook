import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from '../apps/api/src/app';
import { config } from '../apps/api/src/config';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { RatesService } from '../apps/api/src/currency/rates.service';
import { NotificationsService, type EmailMessage } from '../apps/api/src/notifications/notifications.service';
import { setupTestDatabase, testPassword, type TestDatabase, type TestSeed } from './helpers';

describe('HTTP authentication, CSRF, and tenant authorization', () => {
  let database: TestDatabase;
  let seed: TestSeed;
  let app: NestExpressApplication;
  let base: string;
  let adminCookie: string;
  let customerCookie: string;
  let inProcess = false;
  const messages: EmailMessage[] = [];

  function httpTest(name: string, callback: () => Promise<void>) {
    it(name, callback);
  }

  /** Exercise the real Express/Nest handler with native HTTP objects, without TCP. */
  function inject(path: string, method: string, headers: Record<string, string>, body?: string): Promise<Response> {
    const chunks: Buffer[] = [];
    const socket = new Duplex({
      read() { /* Request body is supplied through IncomingMessage below. */ },
      write(chunk: Buffer, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
    });
    Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' });
    const incoming = new IncomingMessage(socket as Socket);
    incoming.method = method;
    incoming.url = `/api${path}`;
    incoming.httpVersion = '1.1';
    incoming.httpVersionMajor = 1;
    incoming.httpVersionMinor = 1;
    incoming.complete = true;
    incoming.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    incoming.headers.host = 'localhost';
    incoming.headers.connection = 'close';
    if (body !== undefined) incoming.headers['content-length'] = String(Buffer.byteLength(body));
    const outgoing = new ServerResponse(incoming);
    outgoing.assignSocket(socket as Socket);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`In-process HTTP request timed out (read=${incoming.readableEnded}, finished=${outgoing.writableFinished}, output=${chunks.reduce((total, chunk) => total + chunk.length, 0)}).`)), 10_000);
      outgoing.once('error', (error) => { clearTimeout(timeout); reject(error); });
      outgoing.once('finish', () => {
        clearTimeout(timeout);
        try {
          const raw = Buffer.concat(chunks);
          const boundary = raw.indexOf('\r\n\r\n');
          assert.ok(boundary >= 0, 'Native response must contain HTTP headers.');
          assert.notEqual(outgoing.getHeader('transfer-encoding'), 'chunked', 'Test endpoints use explicit Content-Length.');
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(outgoing.getHeaders())) {
            for (const item of Array.isArray(value) ? value : [value]) {
              if (item !== undefined) responseHeaders.append(key, String(item));
            }
          }
          const responseBody = [204, 304].includes(outgoing.statusCode) ? null : raw.subarray(boundary + 4);
          resolve(new Response(responseBody, { status: outgoing.statusCode, headers: responseHeaders }));
        } catch (error) { reject(error); }
        finally { socket.destroy(); }
      });
      if (body !== undefined) incoming.push(Buffer.from(body));
      incoming.push(null);
      app.getHttpAdapter().getInstance()(incoming, outgoing);
    });
  }

  function networkDenied(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const failure = error as { code?: string; cause?: unknown };
    return failure.code === 'EACCES' || failure.code === 'EPERM' || networkDenied(failure.cause);
  }

  async function request(path: string, options: { method?: string; body?: unknown; cookie?: string; origin?: string | null; csrf?: boolean } = {}) {
    const headers: Record<string, string> = {};
    if (options.origin !== null) headers.Origin = options.origin ?? config.appUrl;
    if (options.csrf !== false) headers['X-CSRF-Protection'] = '1';
    if (options.cookie) headers.Cookie = options.cookie;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (inProcess) return inject(path, method, headers, body);
    return fetch(`${base}/api${path}`, {
      method,
      headers,
      body,
      redirect: 'manual',
    });
  }

  async function login(email: string) {
    const response = await request('/auth/login', { body: { email, password: testPassword } });
    assert.equal(response.status, 200, await response.text());
    const setCookie = response.headers.get('set-cookie');
    assert.ok(setCookie);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Path=\//i);
    return setCookie.split(';', 1)[0];
  }

  before(async () => {
    database = await setupTestDatabase();
    seed = await database.seed();
    app = await createApp({ database: database.db, logger: false });
    app.get(NotificationsService).send = async (message: EmailMessage) => { messages.push(message); };
    try {
      await app.listen(0, '127.0.0.1');
      base = await app.getUrl();
      adminCookie = await login('admin@example.test');
      customerCookie = await login('customer@example.test');
    } catch (error) {
      if (!networkDenied(error) || process.env.CI || process.env.TEST_DATABASE_URL) throw error;
      inProcess = true;
      console.info('HTTP test mode: loopback is denied; exercising real Nest/Express middleware through native in-process HTTP request injection. TCP transport remains unverified locally.');
      adminCookie = await login('admin@example.test');
      customerCookie = await login('customer@example.test');
    }
  });

  after(async () => {
    if (app) {
      await app.get(AuthService).drainRecovery();
      await app.close();
    }
    if (database) await database.close();
  });

  httpTest('authenticates currency routes, restricts shared rates, persists preferences and exports converted CSV', async () => {
    const rates = app.get(RatesService);
    const original = rates.get.bind(rates);
    rates.get = async () => ({ fetched_at: new Date().toISOString(), unavailable: false, rates: {
      USD: { rate: '1', date: '2026-11-06', source: 'identity', stale: false },
      PKR: { rate: '277.12', date: '2026-11-06', source: 'Frankfurter', stale: false },
    } });
    try {
      const path = `/organizations/${seed.orgId}/currencies`;
      assert.equal((await request(path)).status,401);
      assert.equal((await request(`/organizations/${seed.otherOrgId}/currencies`,{cookie:adminCookie})).status,404);
      assert.equal((await request(`${path}/rates/PKR`,{cookie:customerCookie,method:'PATCH',body:{rate:'280'}})).status,403);
      assert.equal((await request(`${path}/rates/PKR`,{cookie:adminCookie,method:'PATCH',csrf:false,body:{rate:'280'}})).status,403);
      const saved = await request(`${path}/rates/PKR`,{cookie:adminCookie,method:'PATCH',body:{rate:'280'}});
      assert.equal(saved.status,200);
      const selected = await request(`${path}/preference`,{cookie:customerCookie,method:'PATCH',body:{currency:'PKR'}});
      assert.equal(selected.status,200); assert.equal((await selected.json()).display_currency,'PKR');
      const current = await request(path,{cookie:customerCookie});
      const settings = await current.json();
      assert.equal(settings.display_currency,'PKR');
      assert.equal(settings.currencies.find((c:{code:string})=>c.code==='PKR').rate,'280');
      const exported = await request(`/organizations/${seed.orgId}/customers/${seed.customerId}/statement.csv?currency=PKR`,{cookie:customerCookie});
      assert.equal(exported.status,200); assert.match(await exported.text(),/Accounting amount/);
      assert.equal((await request(`/organizations/${seed.orgId}/customers/${seed.secondCustomerId}/statement.csv?currency=PKR`,{cookie:customerCookie})).status,404);
      assert.equal((await request(`${path}/rates/PKR`,{cookie:adminCookie,method:'PATCH',body:{rate:null}})).status,200);
    } finally { rates.get=original; }
  });

  httpTest('requires a session and returns only the authenticated identity memberships', async () => {
    const anonymous = await request('/auth/session');
    assert.equal(anonymous.status, 401);
    const response = await request('/auth/session', { cookie: customerCookie });
    assert.equal(response.status, 200);
    const session = await response.json();
    assert.equal(session.user.id, seed.customerUserId);
    assert.equal(session.memberships.length, 1);
    assert.equal(session.memberships[0].organization_id, seed.orgId);
    assert.equal(session.memberships[0].customer_id, seed.customerId);
    assert.equal(JSON.stringify(session).includes('password_hash'), false);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  });

  httpTest('rejects cross-origin and missing-CSRF-header authentication requests', async () => {
    const body = { email: 'admin@example.test', password: testPassword };
    for (const options of [{ origin: 'https://attacker.example' }, { origin: null }, { csrf: false }]) {
      const response = await request('/auth/login', { body, ...options });
      assert.equal(response.status, 403);
    }
  });

  httpTest('isolates administrators by organization and customers by account', async () => {
    const ownDashboard = await request(`/organizations/${seed.orgId}/dashboard`, { cookie: adminCookie });
    assert.equal(ownDashboard.status, 200);
    assert.equal((await ownDashboard.json()).customer_count, 2);
    const otherDashboard = await request(`/organizations/${seed.otherOrgId}/dashboard`, { cookie: adminCookie });
    assert.equal(otherDashboard.status, 404);
    const customerDashboard = await request(`/organizations/${seed.orgId}/dashboard`, { cookie: customerCookie });
    assert.equal(customerDashboard.status, 403);
    const customerList = await request(`/organizations/${seed.orgId}/customers`, { cookie: customerCookie });
    assert.equal(customerList.status, 403);
    const ownStatement = await request(`/organizations/${seed.orgId}/customers/${seed.customerId}/statement`, { cookie: customerCookie });
    assert.equal(ownStatement.status, 200);
    const otherStatement = await request(`/organizations/${seed.orgId}/customers/${seed.secondCustomerId}/statement`, { cookie: customerCookie });
    assert.equal(otherStatement.status, 404);
    const foreignStatement = await request(`/organizations/${seed.otherOrgId}/customers/${seed.otherCustomerId}/statement`, { cookie: adminCookie });
    assert.equal(foreignStatement.status, 404);
  });

  httpTest('rejects customer ledger writes even with valid organization and customer IDs', async () => {
    const response = await request(`/organizations/${seed.orgId}/customers/${seed.customerId}/entries`, {
      cookie: customerCookie,
      body: { kind: 'charge', amount: '10.00', effective_date: '2026-01-01', description: 'Forbidden charge', idempotency_key: randomUUID() },
    });
    assert.equal(response.status, 403);
    const entries = await database.db.query('SELECT count(*)::integer AS count FROM ledger_entries WHERE customer_id=$1', [seed.customerId]);
    assert.equal(entries.rows[0].count, 0);
  });

  httpTest('posts an idempotent transaction and exports only the authorized customer statement', async () => {
    const body = { kind: 'charge', amount: '10.50', effective_date: '2026-01-01', description: 'Statement charge', reference: '=SUM(1,1)', idempotency_key: randomUUID() };
    const path = `/organizations/${seed.orgId}/customers/${seed.customerId}`;
    const first = await request(`${path}/entries`, { cookie: adminCookie, body });
    const replay = await request(`${path}/entries`, { cookie: adminCookie, body });
    assert.equal(first.status, 201);
    assert.equal(replay.status, 201);
    assert.equal((await first.json()).id, (await replay.json()).id);
    const statement = await request(`${path}/statement`, { cookie: customerCookie });
    const data = await statement.json();
    assert.equal(data.current_balance_minor, '1050');
    assert.equal(data.entries.length, 1);
    const csv = await request(`${path}/statement.csv?start=2026-01-01&end=2026-01-31`, { cookie: customerCookie });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(csv.headers.get('content-disposition') ?? '', /attachment/);
    const content = await csv.text();
    assert.match(content, /"10\.50"/);
    assert.ok(content.includes('"\'=SUM(1,1)"'));
    const foreign = await request(`/organizations/${seed.orgId}/customers/${seed.secondCustomerId}/statement.csv`, { cookie: customerCookie });
    assert.equal(foreign.status, 404);
  });

  httpTest('validates IDs and fields without leaking database errors', async () => {
    const response = await request('/organizations/not-a-uuid/dashboard', { cookie: adminCookie });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(JSON.stringify(body).includes('SELECT'), false);
    const invalid = await request(`/organizations/${seed.orgId}/customers/${seed.customerId}/entries`, {
      cookie: adminCookie,
      body: { kind: 'charge', amount: 0.1, effective_date: '2026-01-01', description: 'Numeric input is forbidden', idempotency_key: randomUUID() },
    });
    assert.equal(invalid.status, 400);
    for (const malformed of [null, []]) {
      const rejected = await request(`/organizations/${seed.orgId}/customers/${seed.customerId}/entries`, {
        cookie: adminCookie, body: malformed,
      });
      assert.equal(rejected.status, 400);
    }
    const repeatedDate = await request(`/organizations/${seed.orgId}/customers/${seed.customerId}/statement?start=2026-01-01&start=2026-01-02`, { cookie: adminCookie });
    assert.equal(repeatedDate.status, 400);
  });

  httpTest('returns the same recovery response for known and unknown identities', async () => {
    const known = await request('/auth/forgot-password', { body: { email: 'admin@example.test' } });
    const unknown = await request('/auth/forgot-password', { body: { email: 'unknown@example.test' } });
    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.deepEqual(await known.json(), await unknown.json());
    await app.get(AuthService).drainRecovery();
    assert.equal(messages.filter((message) => message.subject.includes('Reset')).length, 1);
  });

  httpTest('revokes a session on sign-out', async () => {
    const cookie = await login('admin@example.test');
    const logout = await request('/auth/logout', { method: 'POST', cookie });
    assert.equal(logout.status, 200);
    const session = await request('/auth/session', { cookie });
    assert.equal(session.status, 401);
  });

  httpTest('rotates the current session when signing in again', async () => {
    const previousCookie = adminCookie;
    const response = await request('/auth/login', {
      cookie: previousCookie, body: { email: 'admin@example.test', password: testPassword },
    });
    assert.equal(response.status, 200);
    adminCookie = response.headers.get('set-cookie')!.split(';', 1)[0];
    assert.notEqual(adminCookie, previousCookie);
    assert.equal((await request('/auth/session', { cookie: previousCookie })).status, 401);
    assert.equal((await request('/auth/session', { cookie: adminCookie })).status, 200);
  });

  httpTest('applies account-scoped authentication rate limits', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await request('/auth/login', { body: { email: 'rate-limit@example.test', password: 'Never a real password 42!' } });
      assert.equal(response.status, 401);
    }
    const limited = await request('/auth/login', { body: { email: 'rate-limit@example.test', password: 'Never a real password 42!' } });
    assert.equal(limited.status, 429);
  });
});
