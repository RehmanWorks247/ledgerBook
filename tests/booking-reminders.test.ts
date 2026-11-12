import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { HttpException } from '@nestjs/common';
import { AccessService, type Membership } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { BookingManagementService } from '../apps/api/src/bookings/booking-management.service';
import { positionCtes } from '../apps/api/src/dashboard/receivables';
import { LedgerService } from '../apps/api/src/ledger/ledger.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { formatMoney } from '../apps/api/src/ledger/money';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

type Reminder={id?:string;due_date:string;amount:string};
type ReminderRow={id:string;due_date:string;amount_minor:string;remaining_minor:string;paid:boolean;payment_status:string};
type Trip={id:string;reference:string;total_minor:string;paid_minor:string;remaining_minor:string;overpaid_minor:string;payment_snapshot:string;
  version:number;schedule_basis:string;reminder_paid_baseline_minor:string;instalments:ReminderRow[]};
const request=(instalments:Reminder[]=[])=>({reference:`REMINDER-${randomUUID()}`,amount:'1000.00',effective_date:'2020-01-01',
  departure_at:'2030-01-01T12:00:00Z',required_services:[],schedule_basis:'reminders',instalments,idempotency_key:randomUUID()});
const rows=(...amounts:string[])=>amounts.map((amount,index)=>({due_date:`2020-02-${String(index+1).padStart(2,'0')}`,amount}));
const failStatus=(operation:Promise<unknown>,status:number)=>assert.rejects(operation,(error:unknown)=>error instanceof HttpException&&error.getStatus()===status);

describe('reminder-only booking plans',()=>{
  let database:TestDatabase,seed:TestSeed,access:AccessService,bookings:BookingsService,management:BookingManagementService,ledger:LedgerService,payments:PaymentsService;
  before(async()=>{
    database=await setupTestDatabase();seed=await database.seed();await database.db.query("UPDATE organizations SET currency='GBP'");
    access=new AccessService(database.db);seed.admin=await access.membership(seed.adminId,seed.orgId);
    bookings=new BookingsService(database.db,access);management=new BookingManagementService(database.db,access);
    ledger=new LedgerService(database.db,access);payments=new PaymentsService(database.db,access);
  });
  after(async()=>database?.close());
  async function customer():Promise<{id:string;member:Membership}> {
    const id=randomUUID(),user=randomUUID(),email=`${id}@example.test`;
    await database.db.query('INSERT INTO users(id,email) VALUES($1,$2)',[user,email]);
    await database.db.query(`INSERT INTO customers(id,organization_id,name,email,created_by,idempotency_key,request_hash)
      VALUES($1,$2,'Reminder guest',$3,$4,$5,$6)`,[id,seed.orgId,email,seed.adminId,randomUUID(),'0'.repeat(64)]);
    await database.db.query("INSERT INTO memberships(id,organization_id,user_id,role,customer_id) VALUES($1,$2,$3,'customer',$4)",[randomUUID(),seed.orgId,user,id]);
    return {id,member:await access.membership(user,seed.orgId)};
  }
  const get=(customerId:string,bookingId:string):Promise<Trip>=>bookings.get(seed.admin,customerId,bookingId);
  const approve=async(owner:{id:string;member:Membership},bookingId:string,amount:string)=>{
    const pending=await payments.submit(owner.member,owner.id,bookingId,{amount,payment_date:'2020-01-01',idempotency_key:randomUUID()},[]);
    return payments.approve(seed.admin,owner.id,bookingId,pending.id,{});
  };
  const editBody=(trip:Awaited<ReturnType<typeof get>>,instalments:Reminder[])=>({...request(instalments),reference:trip.reference,amount:formatMoney(trip.total_minor,2),
    expected_version:trip.version,expected_paid_minor:trip.paid_minor,expected_payment_snapshot:trip.payment_snapshot,reason:'Revise reminder dates'});
  const save=async(owner:{id:string},bookingId:string,instalments:Reminder[])=>{
    const trip=await get(owner.id,bookingId);await management.update(seed.admin,owner.id,bookingId,editBody(trip,instalments));return get(owner.id,bookingId);
  };
  const positions=async(bookingId:string)=>(await database.db.query<{id:string;remaining_minor:string}>(`WITH ${positionCtes}
    SELECT id,unpaid::text AS remaining_minor FROM positioned WHERE booking_id=$2 ORDER BY due_date,created_at,id`,[seed.orgId,bookingId])).rows;
  const money=async(customerId:string)=>(await database.db.query('SELECT * FROM ledger_entries WHERE customer_id=$1 ORDER BY id',[customerId])).rows;

  it('accepts partial and empty plans without altering the total or creating a default installment',async()=>{
    const owner=await customer(),body=request(rows('250','250'));
    const trip=await bookings.create(seed.admin,owner.id,body),replay=await bookings.create(seed.admin,owner.id,body);
    assert.equal(trip.id,replay.id);assert.equal(trip.schedule_basis,'reminders');assert.equal(trip.reminder_paid_baseline_minor,'0');
    assert.equal(trip.total_minor,'100000');assert.equal(trip.remaining_minor,'100000');assert.equal(trip.instalments.length,2);
    const before=await money(owner.id),empty=await save(owner,trip.id,[]);
    assert.equal(empty.instalments.length,0);assert.equal(empty.remaining_minor,'100000');assert.deepEqual(await positions(trip.id),[]);
    assert.deepEqual(await money(owner.id),before);
    const none=await bookings.create(seed.admin,owner.id,request());assert.equal(none.instalments.length,0);
  });

  it('deducts past money once and new approved payments oldest first consistently in detail and reminders',async()=>{
    const owner=await customer(),created=await bookings.create(seed.admin,owner.id,request());
    await approve(owner,created.id,'300');const trip=await save(owner,created.id,rows('350','350'));
    assert.equal(trip.reminder_paid_baseline_minor,'30000');assert.deepEqual(trip.instalments.map(row=>row.remaining_minor),['35000','35000']);
    const pending=await payments.submit(owner.member,owner.id,trip.id,{amount:'200',payment_date:'2020-01-02',idempotency_key:randomUUID()},[]);
    assert.equal((await get(owner.id,trip.id)).paid_minor,'30000');
    await payments.approve(seed.admin,owner.id,trip.id,pending.id,{});
    const updated=await get(owner.id,trip.id);
    assert.equal(updated.paid_minor,'50000');assert.equal(updated.remaining_minor,'50000');
    assert.deepEqual(updated.instalments.map(row=>row.remaining_minor),['15000','35000']);
    assert.deepEqual((await positions(trip.id)).map(row=>row.remaining_minor),['15000','35000']);
    const reset=await save(owner,trip.id,updated.instalments.map(row=>({id:row.id,due_date:row.due_date,amount:formatMoney(row.remaining_minor,2)})));
    assert.deepEqual(reset.instalments.map(row=>row.remaining_minor),['15000','35000']);
    assert.equal(reset.reminder_paid_baseline_minor,'50000');
  });

  it('converts legacy plans while retaining actual payments and completed payment history',async()=>{
    const owner=await customer(),base=request();
    const {schedule_basis:_basis,...legacy}=base;
    const created:Trip=await bookings.create(seed.admin,owner.id,{...legacy,instalments:[
      {due_date:'2020-01-01',amount:'300',paid:true,paid_date:'2020-01-01'},...rows('700')]});
    const paid=created.instalments.find(row=>row.paid)!;
    const before=await money(owner.id),trip=await save(owner,created.id,rows('350','350'));
    assert.equal(trip.paid_minor,'30000');assert.equal(trip.instalments.length,2);assert.deepEqual(await money(owner.id),before);
    assert.ok((await database.db.query('SELECT 1 FROM booking_instalments WHERE id=$1 AND payment_id IS NOT NULL',[paid.id])).rows.length);
    await save(owner,created.id,[]);assert.deepEqual(await money(owner.id),before);
    await failStatus(management.update(seed.admin,owner.id,created.id,{...editBody(await get(owner.id,created.id),rows('700')),schedule_basis:'remaining_balance'}),400);
  });

  it('rejects financial fields, nonpositive amounts, duplicate ids, and over-plans without partial writes',async()=>{
    const owner=await customer();
    for(const invalid of [rows('0'),rows('-1'),rows('1000.01'),[{...rows('200')[0],paid:false}], [{...rows('200')[0],paid:true,paid_date:'2020-01-01'}]]) {
      await failStatus(bookings.create(seed.admin,owner.id,request(invalid)),400);
    }
    for(const extra of [{instalment_total:'1000'},{existing_payment_entry_ids:[]}]) await failStatus(bookings.create(seed.admin,owner.id,{...request(),...extra}),400);
    assert.deepEqual(await money(owner.id),[]);
    const trip=await bookings.create(seed.admin,owner.id,request(rows('100'))),row=trip.instalments[0];
    await failStatus(save(owner,trip.id,[{id:row.id,due_date:row.due_date,amount:'100'},{id:row.id,due_date:row.due_date,amount:'100'}]),400);
    assert.equal((await get(owner.id,trip.id)).version,trip.version);
  });

  for(const correction of ['reversed','trashed'] as const) it(`converts outstanding legacy rows after their payment is ${correction} without changing history`,async()=>{
    const owner=await customer(),{schedule_basis:_basis,...legacy}=request();
    const created:Trip=await bookings.create(seed.admin,owner.id,{...legacy,instalments:[
      {due_date:'2020-01-01',amount:'300',paid:true,paid_date:'2020-01-01'},...rows('700')]});
    const old=created.instalments.find(row=>row.paid)!;
    await failStatus(save(owner,created.id,[{id:old.id,due_date:old.due_date,amount:'300'}]),400);
    const payment=(await database.db.query<{id:string;ledger_entry_id:string;version:number}>(`SELECT p.id,p.ledger_entry_id::text,p.version
      FROM booking_payments p JOIN booking_instalments i ON i.payment_id=p.id WHERE i.id=$1`,[old.id])).rows[0];
    if(correction==='reversed') await ledger.post(seed.admin,owner.id,{kind:'reversal',reversal_of:payment.ledger_entry_id,
      effective_date:'2020-01-02',description:'Legacy payment returned',idempotency_key:randomUUID()});
    else await payments.manage(seed.admin,owner.id,created.id,payment.id,'delete',{version:payment.version,reason:'Legacy payment entered incorrectly'});
    const current=await get(owner.id,created.id),beforeMoney=await money(owner.id);
    assert.equal(current.paid_minor,'0');assert.equal(current.instalments.find(row=>row.id===old.id)!.paid,false);
    const oldRow=(await database.db.query('SELECT * FROM booking_instalments WHERE id=$1',[old.id])).rows[0];
    const oldPayment=(await database.db.query('SELECT * FROM booking_payments WHERE id=$1',[payment.id])).rows[0];
    const converted=await save(owner,created.id,current.instalments.map(row=>({id:row.id,due_date:row.due_date,amount:formatMoney(row.amount_minor,2)})));
    assert.equal(converted.instalments.length,2);assert.equal(converted.remaining_minor,'100000');
    assert.ok(converted.instalments.every(row=>row.id!==old.id));
    assert.deepEqual(converted.instalments.map(row=>row.remaining_minor),['30000','70000']);
    assert.deepEqual((await positions(created.id)).map(row=>row.remaining_minor),['30000','70000']);
    assert.deepEqual(await money(owner.id),beforeMoney);
    assert.deepEqual((await database.db.query('SELECT * FROM booking_instalments WHERE id=$1',[old.id])).rows[0],oldRow);
    assert.deepEqual((await database.db.query('SELECT * FROM booking_payments WHERE id=$1',[payment.id])).rows[0],oldPayment);
  });

  it('rejects stale edits even if an old payment is replaced with the same total from a new payment',async()=>{
    const owner=await customer(),created=await bookings.create(seed.admin,owner.id,request());
    const old=await approve(owner,created.id,'300'),trip=await save(owner,created.id,rows('350','350'));
    await ledger.post(seed.admin,owner.id,{kind:'reversal',reversal_of:old.ledger_entry_id!,effective_date:'2020-01-02',description:'Correct historical payment',idempotency_key:randomUUID()});
    await approve(owner,created.id,'300');
    const now=await get(owner.id,created.id);assert.equal(now.paid_minor,trip.paid_minor);assert.notEqual(now.payment_snapshot,trip.payment_snapshot);
    const before=await money(owner.id);
    await failStatus(management.update(seed.admin,owner.id,created.id,editBody(trip,rows('350','350'))),409);
    assert.deepEqual(await money(owner.id),before);assert.deepEqual(now.instalments.map(row=>row.remaining_minor),['5000','35000']);
  });

  it('restores a reversed new payment and treats reversal of a past payment as unscheduled debt',async()=>{
    const owner=await customer(),created=await bookings.create(seed.admin,owner.id,request());
    const old=await approve(owner,created.id,'300');await save(owner,created.id,rows('350','350'));
    const current=await approve(owner,created.id,'200');
    await ledger.post(seed.admin,owner.id,{kind:'reversal',reversal_of:current.ledger_entry_id!,effective_date:'2020-01-02',description:'Current payment returned',idempotency_key:randomUUID()});
    assert.deepEqual((await positions(created.id)).map(row=>row.remaining_minor),['35000','35000']);
    await ledger.post(seed.admin,owner.id,{kind:'reversal',reversal_of:old.ledger_entry_id!,effective_date:'2020-01-02',description:'Past payment returned',idempotency_key:randomUUID()});
    assert.equal((await get(owner.id,created.id)).remaining_minor,'100000');
    await approve(owner,created.id,'200');
    assert.deepEqual((await positions(created.id)).map(row=>row.remaining_minor),['15000','35000']);
  });

  it('tracks corrections to both new and baseline payment amounts without double deduction',async()=>{
    const owner=await customer(),created=await bookings.create(seed.admin,owner.id,request());
    const old=await approve(owner,created.id,'300');await save(owner,created.id,rows('350','350'));
    await payments.manage(seed.admin,owner.id,created.id,old.id,'edit',{version:old.version,reason:'Correct prior amount',amount:'350',payment_date:'2020-01-01',note:''});
    assert.deepEqual((await positions(created.id)).map(row=>row.remaining_minor),['30000','35000']);
    const current=await approve(owner,created.id,'200');
    await payments.manage(seed.admin,owner.id,created.id,current.id,'edit',{version:current.version,reason:'Correct recent amount',amount:'100',payment_date:'2020-01-01',note:''});
    assert.deepEqual((await positions(created.id)).map(row=>row.remaining_minor),['20000','35000']);
  });

  it('never allocates another booking or unassigned account credit to reminder plans',async()=>{
    const owner=await customer(),first=await bookings.create(seed.admin,owner.id,request(rows('1000'))),second=await bookings.create(seed.admin,owner.id,request(rows('1000')));
    await approve(owner,first.id,'500');
    await ledger.post(seed.admin,owner.id,{kind:'payment',amount:'100',effective_date:'2020-01-01',description:'Unassigned account payment',idempotency_key:randomUUID()});
    assert.deepEqual((await positions(first.id)).map(row=>row.remaining_minor),['50000']);
    assert.deepEqual((await positions(second.id)).map(row=>row.remaining_minor),['100000']);
    const {schedule_basis:_basis,...legacy}=request(rows('1000'));
    const third=await bookings.create(seed.admin,owner.id,legacy);
    assert.deepEqual((await positions(third.id)).map(row=>row.remaining_minor),['90000'],'Only the unassigned account payment may settle legacy debt.');
  });

  it('completes reminders when fully paid or overpaid without negative debt',async()=>{
    const owner=await customer(),trip=await bookings.create(seed.admin,owner.id,request(rows('200','300')));
    await approve(owner,trip.id,'1100');const updated=await get(owner.id,trip.id);
    assert.equal(updated.remaining_minor,'0');assert.equal(updated.overpaid_minor,'10000');
    assert.ok(updated.instalments.every(row=>row.payment_status==='Completed'&&row.remaining_minor==='0'));
    assert.ok((await positions(trip.id)).every(row=>row.remaining_minor==='0'));
    assert.equal((await save(owner,trip.id,[])).instalments.length,0);
  });
});
