import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { DashboardService } from '../apps/api/src/dashboard/dashboard.service';
import { addDays, businessDate } from '../apps/api/src/dashboard/time';
import { LedgerService } from '../apps/api/src/ledger/ledger.service';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

describe('customer overview and combined ledger', () => {
  let fixture: TestDatabase;
  let seed: TestSeed;
  let dashboard: DashboardService;
  let bookings: BookingsService;
  let ledger: LedgerService;
  let first: any;
  let second: any;
  let paymentId: string;
  const now = new Date('2026-11-06T12:00:00Z');

  before(async () => {
    fixture = await setupTestDatabase();
    seed = await fixture.seed();
    await fixture.db.query("UPDATE organizations SET currency='GBP',currency_exponent=2 WHERE id=$1", [seed.orgId]);
    const access = new AccessService(fixture.db);
    seed.admin = await access.membership(seed.adminId, seed.orgId);
    dashboard = new DashboardService(fixture.db,access);
    bookings = new BookingsService(fixture.db,access);
    ledger = new LedgerService(fixture.db,access);
  });
  after(async () => fixture?.close());

  it('uses business calendar dates across midnight and daylight-saving transitions', () => {
    assert.equal(businessDate(new Date('2026-11-06T00:30:00Z'),'America/New_York'),'2026-11-05');
    assert.equal(businessDate(new Date('2026-03-29T23:30:00Z'),'Europe/London'),'2026-03-30');
    assert.equal(addDays('2026-03-28',7),'2026-04-04');
  });

  it('counts one customer across multiple bookings and allocates partial payments to oldest instalments', async () => {
    const base = { amount:'100.00',effective_date:'2026-11-01',required_services:['makkah'],
      instalments:[{due_date:'2026-11-01',amount:'100.00'}] };
    first = await bookings.create(seed.admin,seed.customerId,{...base,reference:'FIRST',departure_at:'2026-11-07T11:00:00Z',idempotency_key:randomUUID()});
    second = await bookings.create(seed.admin,seed.customerId,{...base,reference:'SECOND',amount:'200.00',departure_at:'2026-11-08T12:00:00Z',
      instalments:[{due_date:'2026-11-10',amount:'200.00'}],idempotency_key:randomUUID()});
    await bookings.create(seed.admin,seed.secondCustomerId,{...base,reference:'THIRD',amount:'400.00',departure_at:'2026-11-20T12:00:00Z',
      instalments:[{due_date:'2026-11-02',amount:'100.00'},{due_date:'2026-12-01',amount:'300.00'}],idempotency_key:randomUUID()});
    const payment = await ledger.post(seed.admin,seed.customerId,{kind:'payment',amount:'75.00',effective_date:'2026-11-06',description:'Partial payment',idempotency_key:randomUUID()});
    paymentId = payment.id;
    const overview = await dashboard.overview(seed.admin,{},now);
    assert.equal(overview.customer_count,2);
    assert.equal((await dashboard.overview(seed.admin)).customers_added_this_month,2);
    assert.equal(overview.total_debt_minor,'62500');
    assert.equal(overview.payments_received_minor,'7500');
    assert.equal(overview.overdue_minor,'12500');
    assert.equal(overview.overdue_customer_count,2);
    assert.deepEqual(overview.period,{start:'2026-11-01',end:'2026-11-06'});
    assert.deepEqual(overview.attention.map(row => [row.due_date,row.unpaid_minor,row.status]),[
      ['2026-11-01','2500','overdue'],['2026-11-02','10000','overdue'],['2026-11-10','20000','due_soon'],
    ]);
    assert.equal(overview.attention[0].reminder_status,null);
    assert.equal((await ledger.statement(seed.admin,seed.customerId)).current_balance_minor,'22500');
    const previous = await dashboard.overview(seed.admin,{start:'2026-10-01',end:'2026-10-31'},now);
    assert.equal(previous.payments_received_minor,'0');
    assert.equal(previous.total_debt_minor,overview.total_debt_minor);
    assert.equal(previous.overdue_minor,overview.overdue_minor);
    assert.equal(previous.overdue_customer_count,overview.overdue_customer_count);
  });

  it('orders departures and only flags required empty folders, keeping uploaded and issued separate', async () => {
    const folders = await bookings.files(seed.admin,seed.customerId,first.id);
    const makkah = folders.items.find(node => node.serviceKey==='makkah')!;
    await fixture.db.query('UPDATE booking_nodes SET issued_at=now() WHERE id=$1',[makkah.id]);
    let overview = await dashboard.overview(seed.admin,{},now);
    assert.deepEqual(overview.departures.map(row => row.reference),['FIRST','SECOND']);
    assert.equal(overview.departures[0].within_24_hours,true);
    assert.equal(overview.departures[1].within_24_hours,false);
    assert.deepEqual(overview.departures[0].missing_documents,['Makkah Hotel']);
    assert.equal(overview.departures[0].services.find(service => service.key==='makkah')?.issued,true);
    assert.equal(overview.departures[0].services.find(service => service.key==='extras')?.required,false);
    const content=Buffer.from('%PDF-1.4\nFirst voucher\n%%EOF');
    await fixture.db.query(`INSERT INTO booking_nodes(id,organization_id,customer_id,booking_id,parent_id,kind,name,service_key,content,size,created_by,idempotency_key,request_hash)
      VALUES($1,$2,$3,$4,$5,'file','voucher.pdf','makkah',$6,$7,$8,$9,$10)`,
    [randomUUID(),seed.orgId,seed.customerId,first.id,makkah.id,content,content.length,seed.adminId,randomUUID(),'0'.repeat(64)]);
    overview = await dashboard.overview(seed.admin,{},now);
    assert.deepEqual(overview.departures[0].missing_documents,[]);
    assert.deepEqual(overview.departures[1].missing_documents,['Makkah Hotel']);
  });

  it('recalculates complete filtered ledger totals and preserves full running and current balances', async () => {
    const filtered = await dashboard.combinedLedger(seed.admin,{start:'2026-11-06',end:'2026-11-06',kind:'payment',status:'outstanding',page_size:1});
    assert.equal(filtered.total,1);
    assert.equal(filtered.customer_count,1);
    assert.equal(filtered.totals.payments_minor,'7500');
    assert.equal(filtered.totals.net_minor,'-7500');
    assert.equal(filtered.totals.current_balance_minor,'22500');
    assert.equal(filtered.entries[0].id,paymentId);
    assert.equal(filtered.entries[0].running_balance_minor,'22500');
    const all = await dashboard.combinedLedger(seed.admin,{page_size:1});
    assert.equal(all.entries.length,1);
    assert.equal(all.total,4);
    assert.equal(all.customer_count,2);
    assert.equal(all.totals.net_minor,'62500');
    assert.equal(all.totals.outstanding_minor,'62500');
    const minimum = await dashboard.combinedLedger(seed.admin,{min_balance:'300.00'});
    assert.equal(minimum.customer_count,1);
    assert.equal(minimum.entries[0].customer_id,seed.secondCustomerId);
    assert.equal(minimum.totals.current_balance_minor,'40000');
    const idSearch = await dashboard.combinedLedger(seed.admin,{search:seed.customerId});
    assert.equal(idSearch.customer_count,1);
    assert.equal(idSearch.total,3);
    assert.equal((await dashboard.combinedLedger(seed.admin,{status:'overdue'})).customer_count,2);
  });

  it('searches combined ledger entry IDs and dates across all results while preserving balances', async () => {
    for (const search of [`#${paymentId}`, '2026-11-06', '06 Nov 2026', 'Partial payment']) {
      const found = await dashboard.combinedLedger(seed.admin, { search, page_size: 1 });
      assert.equal(found.total, 1, search);
      assert.equal(found.entries[0].id, paymentId, search);
      assert.equal(found.entries[0].running_balance_minor, '22500');
      assert.equal(found.totals.current_balance_minor, '22500');
    }
    assert.equal((await dashboard.combinedLedger(seed.admin, { search: 'customer@example.test' })).total, 3);
    assert.equal((await dashboard.combinedLedger(seed.otherAdmin, { search: `#${paymentId}` })).total, 0);
    assert.equal((await dashboard.combinedLedger(seed.admin, { search: '%' })).total, 0);
    assert.equal((await dashboard.combinedLedger(seed.admin, { search: `#${paymentId}`, end: '2026-11-05' })).total, 0);
  });

  it('restores overdue money when a payment is reversed and removes schedules for reversed booking charges', async () => {
    await ledger.post(seed.admin,seed.customerId,{kind:'reversal',reversal_of:paymentId,effective_date:'2026-11-06',description:'Payment returned',idempotency_key:randomUUID()});
    let overview = await dashboard.overview(seed.admin,{},now);
    assert.equal(overview.payments_received_minor,'0');
    assert.equal(overview.total_debt_minor,'70000');
    assert.equal(overview.overdue_minor,'20000');
    await ledger.post(seed.admin,seed.customerId,{kind:'reversal',reversal_of:first.charge_entry_id,effective_date:'2026-11-06',description:'Booking cancelled',idempotency_key:randomUUID()});
    overview = await dashboard.overview(seed.admin,{},now);
    assert.equal(overview.total_debt_minor,'60000');
    assert.equal(overview.overdue_minor,'10000');
    assert.equal(overview.overdue_customer_count,1);
    assert.deepEqual(overview.departures.map(row=>row.id),[second.id]);
  });

  it('provides dated customer activity and the latest recorded reminder without fabricating delivery status', async () => {
    await fixture.db.query(`INSERT INTO audit_events(organization_id,actor_id,action,object_id,metadata)
      VALUES($1,$2,'reminder.sent',$3,$4::jsonb)`,[seed.orgId,seed.adminId,randomUUID(),JSON.stringify({customer_id:seed.secondCustomerId,status:'sent'})]);
    const today=businessDate();
    const overview=await dashboard.overview(seed.admin,{start:today,end:today},now);
    assert.ok(overview.activity.some(row=>row.action==='booking.created' && row.customer_id===seed.customerId));
    assert.ok(overview.activity.some(row=>row.action==='payment.received' && row.customer_id===seed.customerId));
    assert.ok(overview.activity.some(row=>row.action==='reminder.sent' && row.customer_id===seed.secondCustomerId));
    assert.equal(overview.attention.find(row=>row.customer_id===seed.secondCustomerId)?.reminder_status,'sent');
    assert.equal((await dashboard.overview(seed.admin,{start:'2000-01-01',end:'2000-01-02'},now)).activity.length,0);
  });

  it('chooses the newest applicable instalment or customer reminder without mixing bookings or tenants', async () => {
    const instalment = (await fixture.db.query('SELECT id FROM booking_instalments WHERE booking_id=$1',[second.id])).rows[0].id;
    const record = async (status:string, metadata:Record<string,string>, createdAt:string, organization=seed.orgId, actor=seed.adminId) => {
      await fixture.db.query(`INSERT INTO audit_events(organization_id,actor_id,action,object_id,metadata,created_at)
        VALUES($1,$2,'reminder.sent',$3,$4::jsonb,$5)`,
      [organization,actor,randomUUID(),JSON.stringify({...metadata,status}),createdAt]);
    };
    const current = async () => (await dashboard.overview(seed.admin,{},now)).attention.find(row=>row.id===instalment)?.reminder_status;
    await record('instalment',{instalment_id:instalment},'2026-11-08T10:00:00Z');
    assert.equal(await current(),'instalment');
    await record('customer',{customerId:seed.customerId},'2026-11-08T11:00:00Z');
    assert.equal(await current(),'customer');
    await record('booking',{customer_id:seed.customerId,booking_id:second.id},'2026-11-08T12:00:00Z');
    await record('other booking',{customer_id:seed.customerId,booking_id:first.id},'2026-11-08T13:00:00Z');
    await record('other tenant',{instalment_id:instalment},'2026-11-08T14:00:00Z',seed.otherOrgId,seed.otherAdminId);
    assert.equal(await current(),'booking');
    await record('instalment tie winner',{instalment_id:instalment},'2026-11-08T12:00:00Z');
    assert.equal(await current(),'instalment tie winner');
  });

  it('does not reuse payments that settled older unscheduled debt, and accounts for credit and later reversals', async () => {
    const customerId=randomUUID();
    await fixture.db.query(`INSERT INTO customers(id,organization_id,name,email,created_by,idempotency_key,request_hash)
      VALUES($1,$2,'Returning guest',$3,$4,$5,$6)`,[customerId,seed.orgId,`${customerId}@example.test`,seed.adminId,randomUUID(),'0'.repeat(64)]);
    await ledger.post(seed.admin,customerId,{kind:'charge',amount:'100.00',effective_date:'2026-09-01',description:'Legacy charge',idempotency_key:randomUUID()});
    await ledger.post(seed.admin,customerId,{kind:'payment',amount:'100.00',effective_date:'2026-09-02',description:'Legacy settlement',idempotency_key:randomUUID()});
    await bookings.create(seed.admin,customerId,{reference:'RETURNING',amount:'100.00',effective_date:'2026-11-01',departure_at:'2026-11-20T12:00:00Z',
      required_services:[],instalments:[{due_date:'2026-11-01',amount:'100.00'}],idempotency_key:randomUUID()});
    let overview=await dashboard.overview(seed.admin,{},now);
    assert.equal(overview.attention.find(row=>row.customer_id===customerId)?.unpaid_minor,'10000');
    const payment=await ledger.post(seed.admin,customerId,{kind:'payment',amount:'25.00',effective_date:'2026-11-06',description:'New booking partial payment',idempotency_key:randomUUID()});
    overview=await dashboard.overview(seed.admin,{},now);
    assert.equal(overview.attention.find(row=>row.customer_id===customerId)?.unpaid_minor,'7500');
    await ledger.post(seed.admin,customerId,{kind:'reversal',reversal_of:payment.id,effective_date:'2026-12-01',description:'Later returned payment',idempotency_key:randomUUID()});
    overview=await dashboard.overview(seed.admin,{},now);
    assert.equal(overview.attention.find(row=>row.customer_id===customerId)?.unpaid_minor,'10000');
    const december=await dashboard.overview(seed.admin,{start:'2026-12-01',end:'2026-12-31'},now);
    assert.equal(december.payments_received_minor,'-2500');
    assert.equal((await dashboard.combinedLedger(seed.admin,{kind:'payment',start:'2026-12-01',end:'2026-12-31'})).totals.payments_minor,'-2500');

    const creditedId=randomUUID();
    await fixture.db.query(`INSERT INTO customers(id,organization_id,name,email,created_by,idempotency_key,request_hash)
      VALUES($1,$2,'Guest with credit',$3,$4,$5,$6)`,[creditedId,seed.orgId,`${creditedId}@example.test`,seed.adminId,randomUUID(),'0'.repeat(64)]);
    await ledger.post(seed.admin,creditedId,{kind:'opening',amount:'-20.00',effective_date:'2026-09-01',description:'Existing credit',idempotency_key:randomUUID()});
    await bookings.create(seed.admin,creditedId,{reference:'CREDITED',amount:'100.00',effective_date:'2026-11-01',departure_at:'2026-11-20T12:00:00Z',
      required_services:[],instalments:[{due_date:'2026-11-01',amount:'100.00'}],idempotency_key:randomUUID()});
    overview=await dashboard.overview(seed.admin,{},now);
    assert.equal(overview.attention.find(row=>row.customer_id===creditedId)?.unpaid_minor,'8000');
    assert.equal((await ledger.statement(seed.admin,creditedId)).current_balance_minor,'8000');
  });

  it('rejects unauthorized roles and invalid filters and does not mix tenants', async () => {
    await assert.rejects(dashboard.overview({...seed.customerMember,role:'admin'}),/administrator/);
    await assert.rejects(dashboard.combinedLedger(seed.customerMember),/administrator/);
    await assert.rejects(dashboard.overview(seed.admin,{start:'2026-02-30'}),{status:400});
    await assert.rejects(dashboard.overview(seed.admin,{start:'2026-11-07',end:'2026-11-01'}),/Start date/);
    await assert.rejects(dashboard.combinedLedger(seed.admin,{min_balance:'100',max_balance:'10'}),/Minimum/);
    await assert.rejects(dashboard.combinedLedger(seed.admin,{min_balance:'0.001'}),/decimal places/);
    await assert.rejects(dashboard.combinedLedger(seed.admin,{customer_id:seed.customerId}),{status:400});
    const other=await dashboard.overview(seed.otherAdmin,{},now);
    assert.equal(other.customer_count,1);
    assert.equal(other.total_debt_minor,'0');
    assert.deepEqual(other.attention,[]);
    assert.deepEqual(other.departures,[]);
  });
});
