import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import { AccessService } from '../apps/api/src/access/access.service';
import { createApp } from '../apps/api/src/app';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { BookingManagementService } from '../apps/api/src/bookings/booking-management.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import type { InstalmentInput } from '../apps/api/src/bookings/booking-instalment-payments';
import { config } from '../apps/api/src/config';
import { LedgerService } from '../apps/api/src/ledger/ledger.service';
import { formatMoney } from '../apps/api/src/ledger/money';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { AccountDeletionService } from '../apps/api/src/users/account-deletion.service';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

type SavedRow={id:string;due_date:string;amount_minor:string;paid:boolean;paid_date:string|null;payment_entry_id:string|null;payment_source:string|null};
type SavedBooking={id:string;reference:string;total_minor:string;version:number;instalments:SavedRow[];paid_minor:string;remaining_minor:string;overpaid_minor:string};
const input=(instalments:InstalmentInput[]=[
  {due_date:'2030-01-01',amount:'40.00',paid:true,paid_date:'2020-01-02'},
  {due_date:'2030-02-01',amount:'10.00',paid:true,paid_date:'2020-01-03'},
  {due_date:'2030-03-01',amount:'50.00'},
])=>({reference:`PAID-${randomUUID()}`,departure_at:'2030-04-01T12:00:00Z',required_services:[],amount:'100.00',
  effective_date:'2020-01-01',instalments,idempotency_key:randomUUID()});
const edit=(booking:SavedBooking)=>({reference:booking.reference,departure_at:'2030-04-01T12:00:00Z',required_services:[],
  amount:formatMoney(booking.total_minor,2),effective_date:'2020-01-01',reason:'Correct advance payment record',
  expected_version:booking.version,idempotency_key:randomUUID(),instalments:booking.instalments.map(row=>({id:row.id,due_date:row.due_date,
    amount:formatMoney(row.amount_minor,2),paid:row.paid,...(row.paid?{paid_date:row.paid_date!,payment_entry_id:row.payment_entry_id!}:{})}))});

describe('paid booking instalments and existing payment allocation',()=>{
  let database:TestDatabase,seed:TestSeed,access:AccessService,bookings:BookingsService,management:BookingManagementService,
    ledger:LedgerService,payments:PaymentsService,app:NestExpressApplication,base:string,adminCookie:string,customerCookie:string;
  before(async()=>{
    database=await setupTestDatabase();seed=await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP'");
    access=new AccessService(database.db);seed.admin=await access.membership(seed.adminId,seed.orgId);
    seed.otherAdmin=await access.membership(seed.otherAdminId,seed.otherOrgId);
    seed.customerMember=await access.membership(seed.customerUserId,seed.orgId);
    bookings=new BookingsService(database.db,access);management=new BookingManagementService(database.db,access);
    ledger=new LedgerService(database.db,access);payments=new PaymentsService(database.db,access);
    app=await createApp({database:database.db,logger:false,paymentEmails:false,reminderEmails:false});await app.listen(0,'127.0.0.1');
    base=`${await app.getUrl()}/api/organizations/${seed.orgId}/customers/${seed.customerId}/bookings`;
    adminCookie=`${config.sessionCookie}=${await app.get(AuthService).createSession(seed.adminId)}`;
    customerCookie=`${config.sessionCookie}=${await app.get(AuthService).createSession(seed.customerUserId)}`;
  });
  after(async()=>{if(app) await app.close();if(database) await database.close();});
  const create=(rows?:InstalmentInput[]):Promise<SavedBooking>=>bookings.create(seed.admin,seed.customerId,input(rows));
  const latestInvoice=async(id:string)=>(await database.db.query('SELECT paid_minor::text,balance_minor::text,status FROM booking_invoices WHERE booking_id=$1 ORDER BY version DESC LIMIT 1',[id])).rows[0];
  const postPayment=(amount='40.00',customer=seed.customerId,member=seed.admin)=>ledger.post(member,customer,{kind:'payment',amount,
    effective_date:'2020-01-02',description:'Previously received customer transfer',idempotency_key:randomUUID()});

  it('creates two paid instalments, credits real money and invoices once, with safe retries',async()=>{
    const request=input();
    const [booking,retry]=await Promise.all([bookings.create(seed.admin,seed.customerId,request),bookings.create(seed.admin,seed.customerId,request)]);
    assert.equal(booking.id,retry.id);assert.equal(booking.paid_minor,'5000');assert.equal(booking.remaining_minor,'5000');assert.equal(booking.overpaid_minor,'0');
    assert.deepEqual(booking.instalments.map((row:SavedRow)=>[row.paid,row.paid_date]),[[true,'2020-01-02'],[true,'2020-01-03'],[false,null]]);
    assert.ok(booking.instalments[0].payment_entry_id);assert.equal(booking.instalments[2].payment_entry_id,null);
    assert.equal(booking.instalments[0].payment_source,'booking_instalment');
    assert.deepEqual(await latestInvoice(booking.id),{paid_minor:'5000',balance_minor:'5000',status:'partially_paid'});
    const posted=(await database.db.query(`SELECT p.source,p.submitted_by,p.amount_minor::text,e.amount_minor::text AS posted
      FROM booking_payments p JOIN ledger_entries e ON e.id=p.ledger_entry_id WHERE p.booking_id=$1 ORDER BY p.payment_date`,[booking.id])).rows;
    assert.deepEqual(posted,[{source:'booking_instalment',submitted_by:null,amount_minor:'4000',posted:'-4000'},
      {source:'booking_instalment',submitted_by:null,amount_minor:'1000',posted:'-1000'}]);
    await assert.rejects(bookings.create(seed.admin,seed.customerId,{...request,instalments:request.instalments.map((row,index)=>index?row:{...row,paid_date:'2020-01-04'})}),/submission key/);
  });

  it('retains stable paid rows, reverses and replaces corrections, unchecks atomically, and replays exactly',async()=>{
    const original=await create(),first=original.instalments[0];
    const unchanged=edit(original);
    await management.update(seed.admin,seed.customerId,original.id,unchanged);
    let current=await bookings.get(seed.admin,seed.customerId,original.id);
    assert.deepEqual(current.instalments,original.instalments);
    const change=edit(current);change.instalments[0].amount='35.00';change.instalments[0].paid_date='2020-01-05';change.instalments[2].amount='55.00';
    const updated=await management.update(seed.admin,seed.customerId,original.id,change);
    assert.deepEqual(await management.update(seed.admin,seed.customerId,original.id,change),updated);
    current=await bookings.get(seed.admin,seed.customerId,original.id);
    assert.equal(current.instalments[0].id,first.id);assert.notEqual(current.instalments[0].payment_entry_id,first.payment_entry_id);
    assert.equal(current.instalments[0].paid_date,'2020-01-05');assert.equal(current.paid_minor,'4500');
    assert.equal((await database.db.query('SELECT amount_minor::text FROM ledger_entries WHERE reversal_of=$1',[first.payment_entry_id])).rows[0].amount_minor,'4000');
    const clear=edit(current);clear.instalments[0]={id:first.id,due_date:first.due_date,amount:'35.00',paid:false};
    await management.update(seed.admin,seed.customerId,original.id,clear);
    current=await bookings.get(seed.admin,seed.customerId,original.id);
    assert.equal(current.instalments[0].paid,false);assert.equal(current.instalments[0].payment_entry_id,null);assert.equal(current.paid_minor,'1000');
    assert.deepEqual(await latestInvoice(original.id),{paid_minor:'1000',balance_minor:'9000',status:'partially_paid'});
  });

  it('preserves paid rows for legacy unchanged clients and rejects silent removal or stale/cross-booking identities',async()=>{
    const original=await create(),legacy=edit(original);
    const legacyRows=legacy.instalments.map(({due_date,amount})=>({due_date,amount}));
    await management.update(seed.admin,seed.customerId,original.id,{...legacy,instalments:legacyRows});
    const current=await bookings.get(seed.admin,seed.customerId,original.id);assert.equal(current.paid_minor,'5000');
    await assert.rejects(management.update(seed.admin,seed.customerId,original.id,{...edit(current),instalments:[{due_date:'2030-05-01',amount:'100.00'}]}),/Mark the paid instalment as due/);
    const foreign=await create();const invalid=edit(current);invalid.instalments[0].id=foreign.instalments[0].id;
    await assert.rejects(management.update(seed.admin,seed.customerId,original.id,invalid),/not found in this booking/);
    await assert.rejects(management.update(seed.admin,seed.customerId,original.id,edit(original)),/another session/);
    assert.equal((await bookings.get(seed.admin,seed.customerId,original.id)).version,current.version);
  });

  it('does not recreate money when a stale paid form references a payment reversed in the ledger',async()=>{
    const booking=await create(),stale=edit(booking),entry=booking.instalments[0].payment_entry_id!;
    await ledger.post(seed.admin,seed.customerId,{kind:'reversal',reversal_of:entry,effective_date:'2020-01-04',
      description:'Payment returned outside booking editor',idempotency_key:randomUUID()});
    const before=(await database.db.query('SELECT count(*)::int AS n FROM ledger_entries WHERE customer_id=$1',[seed.customerId])).rows[0].n;
    await assert.rejects(management.update(seed.admin,seed.customerId,booking.id,stale),/unreversed payment from this customer/);
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM ledger_entries WHERE customer_id=$1',[seed.customerId])).rows[0].n,before);
    const current=await bookings.get(seed.admin,seed.customerId,booking.id);
    assert.equal(current.paid_minor,'1000');assert.equal(current.instalments[0].paid,false);
  });

  it('links an already-posted account payment without double credit and derives its received date',async()=>{
    const payment=await postPayment();
    const options=await bookings.paymentOptions(seed.admin,seed.customerId);
    assert.deepEqual(options.items.find(item=>item.id===payment.id),{id:payment.id,amount_minor:'4000',payment_date:'2020-01-02',
      description:'Previously received customer transfer',reference:'',already_recorded_for_booking:false});
    const before=(await database.db.query('SELECT count(*)::int AS n FROM ledger_entries WHERE customer_id=$1',[seed.customerId])).rows[0].n;
    const request=input([{due_date:'2030-01-01',amount:'40.00',paid:true,payment_entry_id:payment.id},{due_date:'2030-02-01',amount:'60.00'}]);
    const booking=await bookings.create(seed.admin,seed.customerId,request);
    assert.equal(booking.instalments[0].payment_entry_id,payment.id);assert.equal(booking.instalments[0].paid_date,'2020-01-02');
    assert.equal(booking.paid_minor,'4000');assert.equal((await database.db.query('SELECT count(*)::int AS n FROM ledger_entries WHERE customer_id=$1',[seed.customerId])).rows[0].n,before+1);
    assert.deepEqual(await latestInvoice(booking.id),{paid_minor:'4000',balance_minor:'6000',status:'partially_paid'});
    assert.equal((await bookings.paymentOptions(seed.admin,seed.customerId)).items.some(item=>item.id===payment.id),false);
    assert.equal((await bookings.create(seed.admin,seed.customerId,request)).id,booking.id);
    await assert.rejects(bookings.create(seed.admin,seed.customerId,{...request,reference:`CLAIM-${randomUUID()}`,idempotency_key:randomUUID()}),/already assigned/);
  });

  it('rejects mismatched, cross-account, reversed and duplicate existing allocations without any partial charge',async()=>{
    const available=await postPayment(),otherAccount=await postPayment('40.00',seed.secondCustomerId),otherOrg=await postPayment('40.00',seed.otherCustomerId,seed.otherAdmin);
    const reversed=await postPayment();await ledger.post(seed.admin,seed.customerId,{kind:'reversal',reversal_of:reversed.id,
      effective_date:'2020-01-03',description:'Returned transfer',idempotency_key:randomUUID()});
    for(const selected of [otherAccount.id,otherOrg.id,reversed.id]) {
      const request=input([{due_date:'2030-01-01',amount:'40.00',paid:true,payment_entry_id:selected},{due_date:'2030-02-01',amount:'60.00'}]);
      await assert.rejects(bookings.create(seed.admin,seed.customerId,request),/unreversed payment from this customer/);
      assert.equal((await database.db.query('SELECT id FROM ledger_entries WHERE reference=$1',[request.reference])).rowCount,0);
    }
    await assert.rejects(create([{due_date:'2030-01-01',amount:'41.00',paid:true,payment_entry_id:available.id},{due_date:'2030-02-01',amount:'59.00'}]),/match the whole instalment/);
    await assert.rejects(create([{due_date:'2030-01-01',amount:'40.00',paid:true,payment_entry_id:available.id,paid_date:'2020-01-04'},{due_date:'2030-02-01',amount:'60.00'}]),/match the existing payment date/);
    await assert.rejects(create([{due_date:'2030-01-01',amount:'40.00',paid:true,payment_entry_id:available.id},{due_date:'2030-02-01',amount:'40.00',paid:true,payment_entry_id:available.id},{due_date:'2030-03-01',amount:'20.00'}]),/only be assigned to one/);
  });

  it('can allocate an approved receipt already in this booking but never silently correct its money',async()=>{
    const booking=await create([{due_date:'2030-01-01',amount:'40.00'},{due_date:'2030-02-01',amount:'60.00'}]);
    const buffer=await sharp({create:{width:4,height:4,channels:3,background:'#090a0b'}}).png().toBuffer();
    const submitted=await payments.submit(seed.customerMember,seed.customerId,booking.id,{amount:'40',payment_date:'2020-01-02',idempotency_key:randomUUID()},
      [{originalname:'proof.png',mimetype:'image/png',buffer,size:buffer.length}]);
    const approved=await payments.approve(seed.admin,seed.customerId,booking.id,submitted.id);
    const option=(await bookings.paymentOptions(seed.admin,seed.customerId,booking.id)).items.find(item=>item.id===approved.ledger_entry_id)!;
    assert.equal(option.already_recorded_for_booking,true);
    const change=edit(booking);change.instalments[0]={...change.instalments[0],paid:true,payment_entry_id:approved.ledger_entry_id!,paid_date:'2020-01-02'};
    await management.update(seed.admin,seed.customerId,booking.id,change);
    const current=await bookings.get(seed.admin,seed.customerId,booking.id);
    assert.equal(current.instalments[0].payment_source,'customer_receipt');assert.equal(current.paid_minor,'4000');
    const clear=edit(current);clear.instalments[0]={id:current.instalments[0].id,due_date:'2030-01-01',amount:'40.00',paid:false};
    await assert.rejects(management.update(seed.admin,seed.customerId,booking.id,clear),/approved customer receipt/);
    assert.equal((await database.db.query('SELECT id FROM ledger_entries WHERE reversal_of=$1',[approved.ledger_entry_id])).rowCount,0);
  });

  it('validates dates and schedules in the HTTP boundary and protects payment-option authorization',async()=>{
    const headers={Cookie:adminCookie,'Content-Type':'application/json',Origin:config.appUrl,'X-CSRF-Protection':'1'};
    for(const row of [{due_date:'2030-01-01',amount:'100.00',paid:true},{due_date:'2030-01-01',amount:'100.00',paid:true,paid_date:'9999-12-31'},
      {due_date:'2030-01-01',amount:'100.00',paid:false,paid_date:'2020-01-01'},{due_date:'2030-01-01',amount:'100.00',paid:true,paid_date:'2020-02-30'},
      {due_date:'2030-01-01',amount:'100.00',paid:true,payment_entry_id:'9223372036854775808'}]) {
      const request=input([row]);const response=await fetch(base,{method:'POST',headers,body:JSON.stringify(request)});
      assert.equal(response.status,400,await response.text());
      assert.equal((await database.db.query('SELECT id FROM ledger_entries WHERE reference=$1',[request.reference])).rowCount,0);
    }
    assert.equal((await fetch(`${base}/payment-options`,{headers:{Cookie:adminCookie}})).status,200);
    assert.equal((await fetch(`${base}/payment-options`,{headers:{Cookie:customerCookie}})).status,403);
    assert.equal((await fetch(`${base}/payment-options?booking_id=${randomUUID()}`,{headers:{Cookie:adminCookie}})).status,404);
    assert.equal((await fetch(base,{method:'POST',headers:{...headers,Cookie:customerCookie},body:JSON.stringify(input())})).status,403);
    await assert.rejects(bookings.create(seed.otherAdmin,seed.customerId,input()),/not found/);
  });

  it('rolls back payment corrections when audit persistence fails and cancellation preserves the historical invoice',async()=>{
    const booking=await create(),change=edit(booking);change.instalments[0].amount='35.00';change.instalments[2].amount='55.00';
    await database.db.query(`CREATE FUNCTION fail_paid_edit_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='booking.updated' THEN RAISE EXCEPTION 'simulated paid audit failure'; END IF; RETURN NEW; END; $$;`);
    await database.db.query('CREATE TRIGGER fail_paid_edit_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_paid_edit_audit()');
    try {await assert.rejects(management.update(seed.admin,seed.customerId,booking.id,change),/simulated paid audit failure/);}
    finally {await database.db.query('DROP TRIGGER fail_paid_edit_audit ON audit_events');await database.db.query('DROP FUNCTION fail_paid_edit_audit()');}
    assert.deepEqual((await bookings.get(seed.admin,seed.customerId,booking.id)).instalments,booking.instalments);
    assert.equal((await database.db.query('SELECT id FROM ledger_entries WHERE reversal_of=$1',[booking.instalments[0].payment_entry_id])).rowCount,0);
    const cancel=await management.cancel(seed.admin,seed.customerId,booking.id,{confirmation:booking.reference,expected_version:booking.version,
      effective_date:'2020-01-05',idempotency_key:randomUUID(),reason:'Travel cancelled'});
    assert.equal(cancel.retained_payments_minor,'0'); assert.equal(cancel.excluded_payments_minor,'5000');
    assert.deepEqual(await latestInvoice(booking.id),{paid_minor:'5000',balance_minor:'-5000',status:'cancelled'});
  });

  it('keeps database payment/evidence guards and supports administrator and customer deletion',async()=>{
    const actor=randomUUID(),membership=randomUUID(),email=`${actor}@example.test`;
    await database.db.query('INSERT INTO users(id,email) VALUES($1,$2)',[actor,email]);
    await database.db.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'admin')",[membership,seed.orgId,actor]);
    const admin=await access.membership(actor,seed.orgId);
    const booking=await bookings.create(admin,seed.secondCustomerId,input());
    const paid=(await database.db.query('SELECT * FROM booking_payments WHERE booking_id=$1 ORDER BY payment_date',[booking.id])).rows[0];
    await assert.rejects(database.db.query('UPDATE booking_payments SET amount_minor=999 WHERE id=$1',[paid.id]),/immutable/);
    await assert.rejects(database.db.query('UPDATE booking_instalments SET amount_minor=999 WHERE payment_id=$1',[paid.id]),/must match/);
    await assert.rejects(database.db.query(`INSERT INTO booking_payments(id,organization_id,customer_id,booking_id,amount_minor,payment_date,
      submitted_by,idempotency_key,request_hash) VALUES($1,$2,$3,$4,1000,'2020-01-01',$5,$6,$7)`,
      [randomUUID(),seed.orgId,seed.secondCustomerId,booking.id,actor,randomUUID(),'a'.repeat(64)]),/active customer membership/);
    await assert.rejects(database.db.query(`INSERT INTO booking_payments(id,organization_id,customer_id,booking_id,amount_minor,payment_date,
      status,submitted_by,idempotency_key,request_hash,reviewed_by,reviewed_at,ledger_entry_id,source)
      VALUES($1,$2,$3,$4,4000,'2020-01-02','approved',NULL,$5,$6,$7,now(),$8,'booking_instalment')`,
      [randomUUID(),seed.orgId,seed.secondCustomerId,booking.id,randomUUID(),'a'.repeat(64),seed.customerUserId,paid.ledger_entry_id]),/active administrator/);
    const cancelled=await bookings.create(admin,seed.secondCustomerId,input());
    await management.cancel(admin,seed.secondCustomerId,cancelled.id,{confirmation:cancelled.reference,expected_version:cancelled.version,
      effective_date:'2020-01-05',idempotency_key:randomUUID(),reason:'Cancelled before administrator departure'});
    const deletion=new AccountDeletionService(database.db,access);
    await deletion.removeMembership(seed.admin,membership,email);
    assert.equal((await bookings.get(seed.admin,seed.secondCustomerId,booking.id)).paid_minor,'5000');
    assert.equal((await database.db.query('SELECT reviewed_by FROM booking_payments WHERE id=$1',[paid.id])).rows[0].reviewed_by,null);
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM booking_payments WHERE booking_id=$1 AND reviewed_by IS NULL',[cancelled.id])).rows[0].n,2);
    await deletion.removeCustomer(seed.admin,seed.secondCustomerId,'beacon@example.test');
    assert.equal((await database.db.query('SELECT id FROM booking_payments WHERE booking_id=$1',[booking.id])).rowCount,0);
    assert.equal((await database.db.query('SELECT id FROM booking_instalments WHERE booking_id=$1',[booking.id])).rowCount,0);
  });
});
