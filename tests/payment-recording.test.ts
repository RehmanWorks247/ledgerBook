import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { HttpException } from '@nestjs/common';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { BookingManagementService } from '../apps/api/src/bookings/booking-management.service';
import { businessDate, addDays } from '../apps/api/src/dashboard/time';
import { LedgerService } from '../apps/api/src/ledger/ledger.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

const rejectsStatus=(request:Promise<unknown>,status:number)=>assert.rejects(request,
  (error:unknown)=>error instanceof HttpException && error.getStatus()===status);

describe('standalone confirmed payment recording',()=>{
  let database:TestDatabase,seed:TestSeed,payments:PaymentsService,bookings:BookingsService,management:BookingManagementService,ledger:LedgerService;
  before(async()=>{
    database=await setupTestDatabase();seed=await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP'");
    const access=new AccessService(database.db);
    seed.admin=await access.membership(seed.adminId,seed.orgId);seed.customerMember=await access.membership(seed.customerUserId,seed.orgId);
    payments=new PaymentsService(database.db,access);bookings=new BookingsService(database.db,access);
    management=new BookingManagementService(database.db,access);ledger=new LedgerService(database.db,access);
  });
  after(async()=>{if(database) await database.close();});
  const booking=(customerId=seed.customerId)=>bookings.create(seed.admin,customerId,{reference:`RECORD-${randomUUID()}`,
    departure_at:'2030-01-01T12:00:00Z',required_services:[],amount:'1000.00',effective_date:businessDate(),idempotency_key:randomUUID()});
  const body=(extra:Record<string,unknown>={})=>({amount:'300.00',payment_date:addDays(businessDate(),-10),note:'Past transfer',idempotency_key:randomUUID(),...extra});
  const existing=(customerId=seed.customerId,extra:Record<string,unknown>={})=>ledger.post(seed.admin,customerId,
    {kind:'payment',amount:'250.00',effective_date:addDays(businessDate(),-3),description:'Already received',idempotency_key:randomUUID(),...extra});
  const entries=async()=>(await database.db.query('SELECT * FROM ledger_entries ORDER BY id')).rows;
  const invoice=async(bookingId:string)=>(await database.db.query('SELECT paid_minor::text,balance_minor::text FROM booking_invoices WHERE booking_id=$1 ORDER BY version DESC LIMIT 1',[bookingId])).rows[0];

  it('records an approved past payment exactly once, preserves reminder rows, refreshes invoice and audits without mail',async()=>{
    const trip=await booking(),request=body();
    const schedule=(await database.db.query('SELECT * FROM booking_instalments WHERE booking_id=$1 ORDER BY id',[trip.id])).rows;
    const before=(await entries()).length;
    const [payment,retry]=await Promise.all([payments.record(seed.admin,seed.customerId,trip.id,request),payments.record(seed.admin,seed.customerId,trip.id,request)]);
    assert.equal(retry.id,payment.id);assert.equal(payment.status,'approved');assert.equal(payment.amount_minor,'30000');assert.equal(payment.payment_date,request.payment_date);
    assert.equal(payment.note,'Past transfer');assert.equal(payment.source,'booking_instalment');assert.deepEqual(payment.receipts,[]);
    assert.equal((await entries()).length,before+1);
    const entry=(await database.db.query('SELECT amount_minor::text,effective_date::text FROM ledger_entries WHERE id=$1',[payment.ledger_entry_id])).rows[0];
    assert.deepEqual(entry,{amount_minor:'-30000',effective_date:request.payment_date});
    assert.deepEqual((await database.db.query('SELECT * FROM booking_instalments WHERE booking_id=$1 ORDER BY id',[trip.id])).rows,schedule);
    const detail=await bookings.get(seed.admin,seed.customerId,trip.id);
    assert.equal(detail.paid_minor,'30000');assert.equal(detail.remaining_minor,'70000');
    assert.deepEqual(await invoice(trip.id),{paid_minor:'30000',balance_minor:'70000'});
    assert.equal((await database.db.query("SELECT 1 FROM audit_events WHERE object_id=$1 AND action='payment.recorded'",[payment.id])).rows.length,1);
    assert.equal((await database.db.query("SELECT 1 FROM payment_email_outbox WHERE split_part(dedupe_key,':',2)=$1",[payment.id])).rows.length,0);
    await rejectsStatus(payments.record(seed.admin,seed.customerId,trip.id,{...request,amount:'301.00'}),409);
  });

  it('links an existing whole payment using its true date and amount without a second ledger credit',async()=>{
    const trip=await booking(),entry=await existing(),request={payment_entry_id:entry.id,idempotency_key:randomUUID()};
    const before=await entries();
    const [payment,retry]=await Promise.all([payments.link(seed.admin,seed.customerId,trip.id,request),payments.link(seed.admin,seed.customerId,trip.id,request)]);
    assert.equal(payment.id,retry.id);assert.equal(payment.ledger_entry_id,entry.id);assert.equal(payment.amount_minor,'25000');
    assert.equal(payment.payment_date,addDays(businessDate(),-3));assert.equal(payment.note,'Already received');
    assert.deepEqual(await entries(),before);assert.deepEqual(await invoice(trip.id),{paid_minor:'25000',balance_minor:'75000'});
    assert.equal((await database.db.query("SELECT 1 FROM audit_events WHERE object_id=$1 AND action='payment.linked'",[payment.id])).rows.length,1);
    await rejectsStatus(payments.link(seed.admin,seed.customerId,trip.id,{...request,idempotency_key:randomUUID()}),409);
    const other=await booking();
    await rejectsStatus(payments.link(seed.admin,seed.customerId,other.id,{...request,idempotency_key:randomUUID()}),409);
    assert.deepEqual(await entries(),before.concat((await entries()).filter(row=>row.id===other.charge_entry_id)));
  });

  it('rejects non-admin, foreign, reversed, future and malformed payments without changing money',async()=>{
    const trip=await booking(),entry=await existing(seed.secondCustomerId),before=await entries();
    await rejectsStatus(payments.record(seed.customerMember,seed.customerId,trip.id,body()),403);
    await rejectsStatus(payments.record(seed.otherAdmin,seed.customerId,trip.id,body()),404);
    for(const amount of ['0','-1','1.001','1e2']) await rejectsStatus(payments.record(seed.admin,seed.customerId,trip.id,body({amount})),400);
    await rejectsStatus(payments.record(seed.admin,seed.customerId,trip.id,body({payment_date:addDays(businessDate(),1)})),400);
    await rejectsStatus(payments.record(seed.admin,seed.customerId,trip.id,body({payment_date:'2026-02-31'})),400);
    await rejectsStatus(payments.link(seed.admin,seed.customerId,trip.id,{payment_entry_id:entry.id,idempotency_key:randomUUID()}),400);
    await rejectsStatus(payments.link(seed.admin,seed.customerId,trip.id,{payment_entry_id:'bad',idempotency_key:randomUUID()}),400);
    await rejectsStatus(payments.link(seed.admin,seed.customerId,trip.id,{payment_entry_id:entry.id,amount:'1',idempotency_key:randomUUID()}),400);
    assert.deepEqual(await entries(),before);
    const reversed=await existing();
    await ledger.post(seed.admin,seed.customerId,{kind:'reversal',reversal_of:reversed.id,effective_date:businessDate(),description:'Correction',idempotency_key:randomUUID()});
    await rejectsStatus(payments.link(seed.admin,seed.customerId,trip.id,{payment_entry_id:reversed.id,idempotency_key:randomUUID()}),400);
    const future=await existing(seed.customerId,{effective_date:addDays(businessDate(),1)});
    await rejectsStatus(payments.link(seed.admin,seed.customerId,trip.id,{payment_entry_id:future.id,idempotency_key:randomUUID()}),400);
  });

  it('keeps pending submissions outside paid totals and supports existing history corrections',async()=>{
    const trip=await booking();
    await payments.submit(seed.customerMember,seed.customerId,trip.id,body(),[]);
    assert.equal((await bookings.get(seed.admin,seed.customerId,trip.id)).paid_minor,'0');
    const payment=await payments.record(seed.admin,seed.customerId,trip.id,body());
    await payments.manage(seed.admin,seed.customerId,trip.id,payment.id,'delete',{version:payment.version,reason:'Wrong payment'});
    assert.equal((await bookings.get(seed.admin,seed.customerId,trip.id)).paid_minor,'0');
    const trash=(await payments.list(seed.admin,seed.customerId,trip.id,{deleted:'deleted'})).items[0];
    await payments.manage(seed.admin,seed.customerId,trip.id,payment.id,'restore',{version:trash.version,reason:'Verified received'});
    assert.equal((await bookings.get(seed.admin,seed.customerId,trip.id)).paid_minor,'30000');
  });

  it('rejects cancelled/reversed bookings and rolls back ledger, history and invoice if audit fails',async()=>{
    const trip=await booking(),detail=await bookings.get(seed.admin,seed.customerId,trip.id);
    await management.cancel(seed.admin,seed.customerId,trip.id,{confirmation:trip.reference,expected_version:detail.version,reason:'Cancelled',effective_date:businessDate(),idempotency_key:randomUUID()});
    await rejectsStatus(payments.record(seed.admin,seed.customerId,trip.id,body()),409);
    const reversed=await booking();
    await ledger.post(seed.admin,seed.customerId,{kind:'reversal',reversal_of:reversed.charge_entry_id,effective_date:businessDate(),description:'Correction',idempotency_key:randomUUID()});
    await rejectsStatus(payments.record(seed.admin,seed.customerId,reversed.id,body()),409);
    const active=await booking(),before=await entries(),beforeInvoice=await invoice(active.id);
    await database.db.query(`CREATE FUNCTION fail_recorded_payment_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='payment.recorded' THEN RAISE EXCEPTION 'recording audit unavailable'; END IF; RETURN NEW; END; $$`);
    await database.db.query('CREATE TRIGGER fail_recorded_payment_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_recorded_payment_audit()');
    try {await assert.rejects(payments.record(seed.admin,seed.customerId,active.id,body()),/recording audit unavailable/);}
    finally {await database.db.query('DROP TRIGGER fail_recorded_payment_audit ON audit_events');await database.db.query('DROP FUNCTION fail_recorded_payment_audit()');}
    assert.deepEqual(await entries(),before);assert.deepEqual(await invoice(active.id),beforeInvoice);
    assert.equal((await payments.list(seed.admin,seed.customerId,active.id)).items.length,0);
  });
});
