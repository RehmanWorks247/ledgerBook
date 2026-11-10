import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { DashboardService } from '../apps/api/src/dashboard/dashboard.service';
import { ReportCache } from '../apps/api/src/dashboard/report-cache';
import { LedgerService } from '../apps/api/src/ledger/ledger.service';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

it('coalesces simultaneous reports, copies mutable results, evicts and retries failures',async()=>{
  const cache=new ReportCache(1,5000);
  let calls=0;
  const run=async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,10));return {count:1};};
  const [a,b]=await Promise.all([cache.get('a',run),cache.get('a',run)]);
  assert.equal(calls,1);a.count=9;assert.equal(b.count,1);
  assert.equal((await cache.get('a',run)).count,1);
  await cache.get('b',run);await cache.get('a',run);assert.equal(calls,3);
  await assert.rejects(cache.get('fail',()=>Promise.reject(new Error('temporary'))));
  assert.equal(await cache.get('fail',async()=>42),42);
});

describe('report cache coherence and access control',()=>{
  let fixture:TestDatabase;let seed:TestSeed;let dashboard:DashboardService;let secondInstance:DashboardService;
  let bookings:BookingsService;let ledger:LedgerService;let booking:any;
  const now=new Date('2026-11-09T12:00:00Z');
  before(async()=>{
    fixture=await setupTestDatabase();seed=await fixture.seed();
    await fixture.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1",[seed.orgId]);
    const access=new AccessService(fixture.db);seed.admin=await access.membership(seed.adminId,seed.orgId);
    dashboard=new DashboardService(fixture.db,access);secondInstance=new DashboardService(fixture.db,access);
    bookings=new BookingsService(fixture.db,access);ledger=new LedgerService(fixture.db,access);
    booking=await bookings.create(seed.admin,seed.customerId,{reference:'CACHE',amount:'100',effective_date:'2026-11-01',
      departure_at:'2026-11-10T12:00:00Z',required_services:['flight'],idempotency_key:randomUUID()});
  });
  after(async()=>fixture?.close());

  it('coalesces cold reporting work while retaining independent response objects',async()=>{
    const original=fixture.db.transaction.bind(fixture.db);let transactions=0;
    fixture.db.transaction=async work=>{transactions++;return original(work);};
    try {
      const rows=await Promise.all(Array.from({length:10},()=>dashboard.overview(seed.admin,{},now)));
      assert.equal(transactions,1);assert.equal(rows[0].total_debt_minor,'10000');
      rows[0].attention.length=0;assert.equal(rows[1].attention.length,1);
    } finally {fixture.db.transaction=original;}
  });
  it('invalidates across service instances immediately after financial, document and customer edits',async()=>{
    await secondInstance.overview(seed.admin,{},now);
    await ledger.post(seed.admin,seed.customerId,{kind:'payment',amount:'25',effective_date:'2026-11-09',description:'Cache check',idempotency_key:randomUUID()});
    for(const service of [dashboard,secondInstance]) assert.equal((await service.overview(seed.admin,{},now)).total_debt_minor,'7500');
    await fixture.db.query('UPDATE customers SET name=$1 WHERE id=$2',['Renamed customer',seed.customerId]);
    assert.equal((await dashboard.overview(seed.admin,{},now)).attention[0].customer_name,'Renamed customer');
    await bookings.issuance(seed.admin,seed.customerId,booking.id,'flight',{issued:true});
    assert.equal((await dashboard.overview(seed.admin,{},now)).departures[0].services.find(s=>s.key==='flight')?.issued,true);
  });
  it('invalidates reminder activity and does not cache revoked access or tenant data',async()=>{
    await fixture.db.query(`INSERT INTO audit_events(organization_id,action,object_id,metadata) VALUES($1,'reminder.delivered',$2,$3)`,
      [seed.orgId,booking.id,JSON.stringify({customer_id:seed.customerId,booking_id:booking.id,status:'delivered'})]);
    assert.equal((await dashboard.overview(seed.admin,{},now)).attention[0].reminder_status,'delivered');
    assert.equal((await dashboard.overview(seed.otherAdmin,{},now)).total_debt_minor,'0');
    await fixture.db.query('UPDATE memberships SET is_active=false WHERE organization_id=$1 AND user_id=$2',[seed.orgId,seed.adminId]);
    await assert.rejects(dashboard.overview(seed.admin,{},now),/unavailable/);
    await assert.rejects(dashboard.overview(seed.customerMember,{},now),/administrator/);
  });
});
