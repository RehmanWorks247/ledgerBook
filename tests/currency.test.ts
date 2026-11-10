import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';
import { AccessService } from '../apps/api/src/access/access.service';
import { RatesService } from '../apps/api/src/currency/rates.service';
import { CurrencyService } from '../apps/api/src/currency/currency.service';
import { convertMinor, validRate } from '../apps/api/src/currency/math';
import { LedgerService } from '../apps/api/src/ledger/ledger.service';
import { config } from '../apps/api/src/config';

describe('currency precision, persistence, provider HTTP and tenant isolation', () => {
  let database: TestDatabase;
  let seed: TestSeed;
  let server: Server;
  let rates: RatesService;
  let currencies: CurrencyService;
  let requests = 0;
  let fail = false;
  let malformed = false;
  const originalUrl = config.exchangeRateUrl;
  const originalRedis = config.redisUrl;
  before(async () => {
    database = await setupTestDatabase(); seed = await database.seed();
    server = createServer((req, res) => {
      requests++;
      const url = new URL(req.url!, 'http://localhost');
      assert.equal(url.pathname, '/rates');
      assert.equal(url.searchParams.get('base'), 'USD');
      assert.ok(url.searchParams.get('quotes')?.includes('PKR'));
      res.setHeader('Content-Type', 'application/json');
      if (fail) { res.writeHead(503); res.end('{"message":"Unavailable"}'); return; }
      res.end(JSON.stringify(malformed ? [{ base: 'USD', quote: 'PKR', rate: -5, date: 'bad' }] :
        [{ base: 'USD', quote: 'PKR', rate: 277.12, date: new Date().toISOString().slice(0,10) },
          { base: 'USD', quote: 'JPY', rate: 158.28, date: new Date().toISOString().slice(0,10) }]));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    config.exchangeRateUrl = `http://127.0.0.1:${(server.address() as {port:number}).port}/rates`;
    config.redisUrl = undefined;
    rates = new RatesService(database.db);
    currencies = new CurrencyService(database.db, new AccessService(database.db), rates);
  });
  after(async () => {
    config.exchangeRateUrl = originalUrl; config.redisUrl = originalRedis;
    await rates?.onApplicationShutdown();
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await database?.close();
  });
  it('converts large signed amounts exactly and rounds once for 0/2/3 decimal currencies', () => {
    assert.equal(convertMinor('900719925474099399',2,2,'2'), '1801439850948198798');
    assert.equal(convertMinor('100',2,2,'277.12'), '27712');
    assert.equal(convertMinor('-100',2,0,'158.5'), '-159');
    assert.equal(convertMinor('100',2,3,'0.3091'), '309');
    assert.equal(convertMinor('27712',2,2,'277.12',true), '100');
    for (const invalid of ['0','-1','1e3','NaN','Infinity','0.0000000000001','100000001']) assert.equal(validRate(invalid),false);
  });
  it('fetches through HTTP once for concurrent callers and reuses durable cache after restart', async () => {
    const snapshots = await Promise.all([rates.get('USD'), rates.get('USD'), rates.get('USD')]);
    assert.equal(requests,1); assert.equal(snapshots[0].rates.PKR.rate,'277.12');
    const restarted = new RatesService(database.db);
    assert.equal((await restarted.get('USD')).rates.PKR.rate,'277.12');
    assert.equal(requests,1);
  });
  it('persists per-membership preferences without changing other members or ledger currency', async () => {
    await currencies.preference(seed.admin,{currency:'PKR'});
    assert.equal((await currencies.settings(seed.admin)).display_currency,'PKR');
    assert.equal((await currencies.settings(seed.customerMember)).display_currency,'USD');
    assert.equal((await currencies.settings(seed.otherAdmin)).display_currency,'USD');
    assert.equal((await database.db.query('SELECT currency FROM organizations WHERE id=$1',[seed.orgId])).rows[0].currency,'USD');
    await assert.rejects(currencies.preference(seed.admin,{currency:'XYZ'}));
  });
  it('applies manual rates only to the workspace, enforces admin access, audits changes and restores automatic rates', async () => {
    await assert.rejects(currencies.override(seed.customerMember,'PKR',{rate:'280'}));
    for (const rate of ['0','-2','1e4','NaN']) await assert.rejects(currencies.override(seed.admin,'PKR',{rate}));
    await assert.rejects(currencies.override(seed.admin,'USD',{rate:'2'}));
    await currencies.override(seed.admin,'PKR',{rate:'280'});
    assert.equal((await currencies.conversion(seed.customerMember,'PKR')).rate.source,'manual');
    assert.equal((await currencies.conversion(seed.otherAdmin,'PKR')).rate.source,'Frankfurter');
    assert.equal((await database.db.query("SELECT count(*)::int AS count FROM audit_events WHERE action='currency.rate_updated'")).rows[0].count,1);
    await currencies.override(seed.admin,'PKR',{rate:null});
    assert.equal((await currencies.conversion(seed.admin,'PKR')).rate.rate,'277.12');
  });
  it('does not mutate an in-flight rate snapshot shared by concurrent workspaces', async () => {
    const shared = await rates.get('USD');
    const sharedRates = { get: async () => shared } as unknown as RatesService;
    const concurrent = new CurrencyService(database.db,new AccessService(database.db),sharedRates);
    await database.db.query(`INSERT INTO exchange_rate_overrides(organization_id,currency,rate,updated_by)
      VALUES($1,'PKR',280,$2)`,[seed.orgId,seed.adminId]);
    try {
      const [own,other] = await Promise.all([concurrent.settings(seed.admin),concurrent.settings(seed.otherAdmin)]);
      assert.equal(own.currencies.find(row=>row.code==='PKR')?.rate,'280');
      assert.equal(other.currencies.find(row=>row.code==='PKR')?.rate,'277.12');
      assert.equal(shared.rates.PKR.rate,'277.12');
      assert.equal(shared.rates.PKR.source,'Frankfurter');
    } finally {
      await database.db.query("DELETE FROM exchange_rate_overrides WHERE organization_id=$1 AND currency='PKR'",[seed.orgId]);
    }
  });
  it('exports converted values with rate provenance and preserves posted ledger amounts', async () => {
    const ledger = new LedgerService(database.db,new AccessService(database.db));
    await ledger.post(seed.admin,seed.customerId,{kind:'charge',amount:'12.34',effective_date:'2026-01-01',description:'Test',idempotency_key:randomUUID()});
    const csv = await ledger.csv(seed.admin,seed.customerId,{},await currencies.conversion(seed.admin,'PKR'));
    assert.match(csv,/"PKR","3419.66","3419.66"/);
    assert.match(csv,/"USD","12.34","277.12"/);
    assert.equal((await ledger.statement(seed.admin,seed.customerId)).current_balance_minor,'1234');
    await assert.rejects(currencies.conversion(seed.admin,'XYZ'));
  });
  it('uses bounded stale data on provider failure, suppresses repeated retries and rejects corrupt provider responses', async () => {
    await database.db.query(`UPDATE exchange_rate_cache SET snapshot=jsonb_set(snapshot,'{fetched_at}',to_jsonb($1::text))`,[new Date(Date.now()-7200000).toISOString()]);
    fail = true;
    const before = requests;
    const stale = await rates.get('USD');
    assert.equal(stale.rates.PKR.stale,true); assert.equal(stale.unavailable,true);
    await rates.get('USD'); assert.equal(requests,before+1);
    fail=false; malformed=true;
    const invalid = await new RatesService(database.db).get('USD');
    assert.equal(invalid.rates.PKR.rate,'277.12'); assert.equal(invalid.unavailable,true);
    malformed=false; fail=true;
    await database.db.query(`UPDATE exchange_rate_cache SET snapshot=jsonb_set(snapshot,'{fetched_at}',to_jsonb($1::text))`,[new Date(Date.now()-8*86400000).toISOString()]);
    const expired = await rates.get('USD');
    assert.equal(expired.rates.PKR,undefined); assert.equal(expired.rates.USD.rate,'1');
    await currencies.override(seed.admin,'PKR',{rate:'279'});
    assert.equal((await currencies.conversion(seed.admin,'PKR')).rate.source,'manual');
  });
});
