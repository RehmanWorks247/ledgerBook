import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { HttpException } from '@nestjs/common';
import { AccessService, type Membership } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { BookingManagementService } from '../apps/api/src/bookings/booking-management.service';
import type { InstalmentInput } from '../apps/api/src/bookings/booking-instalment-payments';
import { positionCtes } from '../apps/api/src/dashboard/receivables';
import { LedgerService } from '../apps/api/src/ledger/ledger.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { formatMoney } from '../apps/api/src/ledger/money';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

type Row={id:string;due_date:string;amount_minor:string;paid:boolean;paid_date:string|null;payment_entry_id:string|null};
type Trip={id:string;reference:string;total_minor:string;instalment_total_minor:string;version:number;paid_minor:string;remaining_minor:string;overpaid_minor:string;instalments:Row[]};
const request=(instalments:InstalmentInput[]=[],existing_payment_entry_ids:string[]=[])=>({reference:`REMAIN-${randomUUID()}`,
  amount:'5000.00',effective_date:'2020-01-01',departure_at:'2030-01-01T12:00:00Z',required_services:[],
  schedule_basis:'remaining_balance',existing_payment_entry_ids,instalments,idempotency_key:randomUUID()});
const unpaid=(...amounts:string[])=>amounts.map((amount,index)=>({due_date:`2020-02-${String(index%28+1).padStart(2,'0')}`,amount}));
const edit=(trip:Trip,instalments:InstalmentInput[])=>({...request(instalments),reference:trip.reference,amount:formatMoney(trip.total_minor,2),
  expected_version:trip.version,reason:'Revise the remaining payment plan'});
const failStatus=(operation:Promise<unknown>,status:number)=>assert.rejects(operation,(error:unknown)=>error instanceof HttpException&&error.getStatus()===status);

describe('remaining-balance booking plans and explicit existing payments',()=>{
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
      VALUES($1,$2,'Remaining plan guest',$3,$4,$5,$6)`,[id,seed.orgId,email,seed.adminId,randomUUID(),'0'.repeat(64)]);
    await database.db.query("INSERT INTO memberships(id,organization_id,user_id,role,customer_id) VALUES($1,$2,$3,'customer',$4)",[randomUUID(),seed.orgId,user,id]);
    return {id,member:await access.membership(user,seed.orgId)};
  }
  const transfer=(id:string,amount='2000.00')=>ledger.post(seed.admin,id,{kind:'payment',amount,effective_date:'2020-01-01',description:'Existing customer payment',idempotency_key:randomUUID()});
  const dueTotal=async(id:string)=>BigInt((await database.db.query(`WITH ${positionCtes} SELECT coalesce(sum(unpaid),0)::text AS unpaid FROM positioned WHERE booking_id=$2`,[seed.orgId,id])).rows[0].unpaid);
  const entryCount=async(id:string)=>(await database.db.query('SELECT count(*)::int AS n FROM ledger_entries WHERE customer_id=$1',[id])).rows[0].n as number;
  const paymentCount=async(id:string)=>(await database.db.query('SELECT count(*)::int AS n FROM booking_payments WHERE booking_id=$1',[id])).rows[0].n as number;
  const dueRows=(trip:Trip)=>trip.instalments.filter(row=>!row.paid);

  it('links selected £2000 once and schedules only £3000 of a £5000 booking, with stable replay and invoices',async()=>{
    const owner=await customer(),entry=await transfer(owner.id),body=request(unpaid('1000','1000','1000'),[entry.id]);
    const original=(await database.db.query('SELECT * FROM ledger_entries WHERE id=$1',[entry.id])).rows[0];
    const [trip,replay]:Trip[]=await Promise.all([bookings.create(seed.admin,owner.id,body),bookings.create(seed.admin,owner.id,body)]);
    assert.equal(trip.id,replay.id);assert.equal(trip.paid_minor,'200000');assert.equal(trip.remaining_minor,'300000');
    assert.equal(trip.instalment_total_minor,'500000');assert.equal(dueRows(trip).length,3);assert.equal(trip.instalments.filter(row=>row.paid).length,1);
    assert.equal(trip.instalments.find(row=>row.paid)!.payment_entry_id,entry.id);assert.equal(await entryCount(owner.id),2);assert.equal(await paymentCount(trip.id),1);
    assert.equal(await dueTotal(trip.id),300000n,'The selected payment must not be subtracted from the reduced future plan again.');
    assert.deepEqual((await database.db.query('SELECT * FROM ledger_entries WHERE id=$1',[entry.id])).rows[0],original);
    assert.equal((await database.db.query('SELECT paid_minor::text,balance_minor::text FROM booking_invoices WHERE booking_id=$1',[trip.id])).rows[0].balance_minor,'300000');
    assert.equal((await bookings.paymentOptions(seed.admin,owner.id)).items.some(row=>row.id===entry.id),false);
  });

  it('does not automatically assign unselected customer payments and preserves legacy schedule contracts',async()=>{
    const owner=await customer(),entry=await transfer(owner.id);
    const trip:Trip=await bookings.create(seed.admin,owner.id,request());
    assert.equal(trip.paid_minor,'0');assert.equal(trip.remaining_minor,'500000');assert.equal(dueRows(trip)[0].amount_minor,'500000');
    assert.ok((await bookings.paymentOptions(seed.admin,owner.id)).items.some(row=>row.id===entry.id));
    const legacy={...request(unpaid('4500')),instalment_total:'4500'};
    const {schedule_basis:_basis,existing_payment_entry_ids:_ids,...legacyBody}=legacy;
    const old:Trip=await bookings.create(seed.admin,owner.id,legacyBody);assert.equal(old.instalment_total_minor,'450000');
    await failStatus(bookings.create(seed.admin,owner.id,{...request(unpaid('4500')),instalment_total:'4500'}),400);
  });

  it('validates the unpaid target atomically with exact £5 boundaries and authoritative required/current details',async()=>{
    for(const amount of ['2995.00','3005.00']) {
      const owner=await customer(),entry=await transfer(owner.id);assert.equal((await bookings.create(seed.admin,owner.id,request(unpaid(amount),[entry.id]))).paid_minor,'200000');
    }
    for(const amount of ['2994.99','3005.01','5000.00']) {
      const owner=await customer(),entry=await transfer(owner.id),body=request(unpaid(amount),[entry.id]);
      await assert.rejects(bookings.create(seed.admin,owner.id,body),(error:unknown)=>{
        assert.ok(error instanceof HttpException);assert.equal(error.getStatus(),400);
        const detail=error.getResponse() as {required_minor:string;scheduled_minor:string;message:string};
        assert.equal(detail.required_minor,'300000');assert.equal(detail.scheduled_minor,amount.replace('.',''));assert.match(detail.message,/remaining booking balance/);return true;
      });
      assert.equal(await entryCount(owner.id),1);assert.equal((await database.db.query('SELECT id FROM bookings WHERE reference=$1',[body.reference])).rows.length,0);
      assert.ok((await bookings.paymentOptions(seed.admin,owner.id)).items.some(row=>row.id===entry.id));
    }
  });

  it('defaults empty plans to the remaining balance and permits fully paid or overpaid bookings with zero upcoming installments',async()=>{
    for(const amount of ['2000','5000','6000']) {
      const owner=await customer(),entry=await transfer(owner.id,amount),trip:Trip=await bookings.create(seed.admin,owner.id,request([],[entry.id]));
      assert.equal(dueRows(trip).length,amount==='2000'?1:0);
      assert.equal(trip.remaining_minor,amount==='2000'?'300000':'0');assert.equal(trip.overpaid_minor,amount==='6000'?'100000':'0');
      assert.equal(await dueTotal(trip.id),amount==='2000'?300000n:0n);
      const savedPaid=trip.instalments.find(row=>row.paid)!;
      await management.update(seed.admin,owner.id,trip.id,edit(trip,[]));
      const updated:Trip=await bookings.get(seed.admin,owner.id,trip.id);assert.ok(updated.instalments.some(row=>row.id===savedPaid.id&&row.paid));
      assert.equal(dueRows(updated).length,amount==='2000'?1:0);assert.equal(await entryCount(owner.id),2);
    }
    const owner=await customer();await failStatus(bookings.create(seed.admin,owner.id,request([{due_date:'2020-01-01',amount:'2000',paid:true,paid_date:'2020-01-01'}])),400);
    assert.equal(await entryCount(owner.id),0);
  });

  it('combines selected previous payments with newly received installments without duplicating either',async()=>{
    const owner=await customer(),entry=await transfer(owner.id),trip:Trip=await bookings.create(seed.admin,owner.id,request([
      {due_date:'2020-01-01',amount:'1000',paid:true,paid_date:'2020-01-01'},...unpaid('1000','1000'),
    ],[entry.id]));
    assert.equal(trip.paid_minor,'300000');assert.equal(trip.remaining_minor,'200000');assert.equal(await entryCount(owner.id),3);assert.equal(await dueTotal(trip.id),200000n);
    const paid=trip.instalments.filter(row=>row.paid).map(row=>({id:row.id,entry:row.payment_entry_id}));
    const update=edit(trip,unpaid('500','1500'));
    await management.update(seed.admin,owner.id,trip.id,update);await management.update(seed.admin,owner.id,trip.id,update);
    const current:Trip=await bookings.get(seed.admin,owner.id,trip.id);
    assert.deepEqual(current.instalments.filter(row=>row.paid).map(row=>({id:row.id,entry:row.payment_entry_id})),paid);
    assert.equal(await entryCount(owner.id),3);assert.equal(await paymentCount(trip.id),2);assert.equal(await dueTotal(trip.id),200000n);
  });

  it('handles future receipt approval, remaining-plan edits, and payment reversal without losing or double-counting debt',async()=>{
    const owner=await customer(),entry=await transfer(owner.id),trip:Trip=await bookings.create(seed.admin,owner.id,request(unpaid('1000','1000','1000'),[entry.id]));
    const pending=await payments.submit(owner.member,owner.id,trip.id,{amount:'500',payment_date:'2020-01-02',idempotency_key:randomUUID()},[]);
    const receipt=await payments.approve(seed.admin,owner.id,trip.id,pending.id,{});
    assert.equal(await dueTotal(trip.id),250000n);
    const before:Trip=await bookings.get(seed.admin,owner.id,trip.id);
    await management.update(seed.admin,owner.id,trip.id,edit(before,unpaid('1250','1250')));
    const replanned:Trip=await bookings.get(seed.admin,owner.id,trip.id);
    assert.equal(replanned.paid_minor,'250000');assert.equal(dueRows(replanned).length,2);assert.equal(replanned.instalments.filter(row=>row.paid).length,2);
    assert.equal(await entryCount(owner.id),3);assert.equal(await dueTotal(trip.id),250000n);
    await ledger.post(seed.admin,owner.id,{kind:'reversal',reversal_of:receipt.ledger_entry_id!,effective_date:'2020-01-03',description:'Payment returned',idempotency_key:randomUUID()});
    const reversed:Trip=await bookings.get(seed.admin,owner.id,trip.id);assert.equal(reversed.remaining_minor,'300000');assert.equal(await dueTotal(trip.id),300000n);
    const restoredDebt=reversed.instalments.find(row=>row.id===replanned.instalments.find(item=>item.payment_entry_id===receipt.ledger_entry_id)!.id)!;
    assert.equal(restoredDebt.paid,false);assert.equal(restoredDebt.amount_minor,'50000');assert.equal(restoredDebt.due_date,'2020-01-02');
    assert.equal(reversed.instalments.find(row=>row.payment_entry_id===entry.id)!.paid,true);
  });

  it('rejects cross-customer, claimed, duplicate and reversed selected payments without partial booking writes',async()=>{
    const owner=await customer(),other=await customer(),foreign=await transfer(other.id),entry=await transfer(owner.id);
    await failStatus(bookings.create(seed.admin,owner.id,request(unpaid('3000'),[foreign.id])),400);
    await failStatus(bookings.create(seed.admin,owner.id,request(unpaid('1000'),[entry.id,entry.id])),400);
    const first:Trip=await bookings.create(seed.admin,owner.id,request(unpaid('3000'),[entry.id]));
    await failStatus(bookings.create(seed.admin,owner.id,request(unpaid('3000'),[entry.id])),409);
    const reversed=await transfer(owner.id);
    await ledger.post(seed.admin,owner.id,{kind:'reversal',reversal_of:reversed.id,effective_date:'2020-01-01',description:'Payment refunded',idempotency_key:randomUUID()});
    await failStatus(bookings.create(seed.admin,owner.id,request(unpaid('3000'),[reversed.id])),400);
    assert.equal((await database.db.query('SELECT id FROM bookings WHERE customer_id=$1',[owner.id])).rows.length,1);assert.equal(await paymentCount(first.id),1);
    await failStatus(bookings.create(seed.otherAdmin,owner.id,request()),404);await failStatus(bookings.create(owner.member,owner.id,request()),403);
  });

  it('serializes concurrent claims of the same existing payment and rolls back the losing booking charge',async()=>{
    const owner=await customer(),entry=await transfer(owner.id);
    const results=await Promise.allSettled([bookings.create(seed.admin,owner.id,request(unpaid('3000'),[entry.id])),bookings.create(seed.admin,owner.id,request(unpaid('3000'),[entry.id]))]);
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.filter(result=>result.status==='rejected').length,1);
    assert.equal(await entryCount(owner.id),2);assert.equal((await database.db.query('SELECT id FROM booking_payments WHERE ledger_entry_id=$1',[entry.id])).rows.length,1);
  });

  it('rechecks payment changes at save time and cannot recreate reversed money from a stale paid row',async()=>{
    const owner=await customer(),entry=await transfer(owner.id),trip:Trip=await bookings.create(seed.admin,owner.id,request(unpaid('3000'),[entry.id]));
    const paid=trip.instalments.find(row=>row.paid)!;
    await ledger.post(seed.admin,owner.id,{kind:'reversal',reversal_of:entry.id,effective_date:'2020-01-02',description:'Refunded outside planner',idempotency_key:randomUUID()});
    const oldRows=[{id:paid.id,due_date:paid.due_date,amount:'2000',paid:true,paid_date:paid.paid_date!,payment_entry_id:entry.id},...unpaid('3000')];
    const count=await entryCount(owner.id);await failStatus(management.update(seed.admin,owner.id,trip.id,edit(trip,oldRows)),400);assert.equal(await entryCount(owner.id),count);
    await assert.rejects(management.update(seed.admin,owner.id,trip.id,edit(trip,unpaid('3000'))),(error:unknown)=>{
      assert.ok(error instanceof HttpException);assert.equal((error.getResponse() as {required_minor:string}).required_minor,'500000');return true;
    });
    const unchanged:Trip=await bookings.get(seed.admin,owner.id,trip.id);assert.equal(unchanged.version,trip.version);assert.equal(unchanged.remaining_minor,'500000');
  });

  it('accepts 100 upcoming rows alongside paid history but rejects more and preserves legacy limits',async()=>{
    const owner=await customer(),entry=await transfer(owner.id),rows=unpaid(...Array.from({length:100},()=> '30'));
    const trip:Trip=await bookings.create(seed.admin,owner.id,request(rows,[entry.id]));assert.equal(trip.instalments.length,101);assert.equal(dueRows(trip).length,100);
    const all=trip.instalments.map(row=>({id:row.id,due_date:row.due_date,amount:formatMoney(row.amount_minor,2),paid:row.paid,
      ...(row.paid?{paid_date:row.paid_date!,payment_entry_id:row.payment_entry_id!}:{})}));
    await management.update(seed.admin,owner.id,trip.id,edit(trip,all));assert.equal(await entryCount(owner.id),2);
    await failStatus(bookings.create(seed.admin,owner.id,request(unpaid(...Array.from({length:101},()=> '50')))),400);
    const legacy=request(unpaid(...Array.from({length:101},()=> '50')));const {schedule_basis:_basis,existing_payment_entry_ids:_ids,...old}=legacy;
    await failStatus(bookings.create(seed.admin,owner.id,old),400);
  });
});
