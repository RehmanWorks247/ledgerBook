import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after,before,describe,it } from 'node:test';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { businessDate } from '../apps/api/src/dashboard/time';
import { InvoicesService } from '../apps/api/src/invoices/invoices.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { setupTestDatabase,type TestDatabase,type TestSeed } from './helpers';

describe('consumer invoice selection',()=>{
  let database:TestDatabase,seed:TestSeed,bookings:BookingsService,payments:PaymentsService,invoices:InvoicesService;
  before(async()=>{
    database=await setupTestDatabase();seed=await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP'");
    const access=new AccessService(database.db);
    seed.admin=await access.membership(seed.adminId,seed.orgId);
    seed.customerMember=await access.membership(seed.customerUserId,seed.orgId);
    bookings=new BookingsService(database.db,access);payments=new PaymentsService(database.db,access);invoices=new InvoicesService(database.db,access);
  });
  after(async()=>database?.close());
  const create=(customerId=seed.customerId)=>bookings.create(seed.admin,customerId,{reference:randomUUID(),amount:'100',
    departure_at:'2030-12-01T12:00:00Z',effective_date:businessDate(),required_services:[],idempotency_key:randomUUID()});
  const body=(invoice_id:string,amount='25')=>({invoice_id,amount,payment_date:businessDate(),idempotency_key:randomUUID()});

  it('lists only the newest outstanding version per booking and keeps the chosen invoice on payment history',async()=>{
    const first=await create(),second=await create();
    const old=(await invoices.list(seed.customerMember,seed.customerId,first.id)).invoices[0];
    await payments.record(seed.admin,seed.customerId,first.id,{amount:'20',payment_date:businessDate(),idempotency_key:randomUUID()});
    const list=(await invoices.outstanding(seed.customerMember,seed.customerId)).invoices;
    assert.equal(list.length,2);assert.equal(list.filter(i=>i.booking_id===first.id).length,1);
    const latest=list.find(i=>i.booking_id===first.id)!;
    assert.notEqual(latest.id,old.id);assert.equal(latest.outstanding_minor,'8000');
    assert.ok(list.some(i=>i.booking_id===second.id));
    await assert.rejects(payments.submit(seed.customerMember,seed.customerId,first.id,body(old.id),[]),/no longer the latest/);
    const draft=body(latest.id),payment=await payments.submit(seed.customerMember,seed.customerId,first.id,draft,[]);
    assert.equal(payment.invoice_id,latest.id);assert.equal(payment.invoice_number,latest.invoice_number);
    await payments.approve(seed.admin,seed.customerId,first.id,payment.id);
    assert.equal((await payments.submit(seed.customerMember,seed.customerId,first.id,draft,[])).id,payment.id,'lost-response retry succeeds after a newer invoice is issued');
    assert.equal((await payments.list(seed.customerMember,seed.customerId,first.id)).items.find(i=>i.id===payment.id)?.invoice_id,latest.id);
    await assert.rejects(payments.submit(seed.customerMember,seed.customerId,first.id,body(latest.id),[]),/no longer the latest/);
  });

  it('rejects another booking/customer invoice and prevents cross-account listing',async()=>{
    const own=await create(),foreign=await create(seed.secondCustomerId);
    const invoice=(await invoices.list(seed.admin,seed.secondCustomerId,foreign.id)).invoices[0];
    await assert.rejects(payments.submit(seed.customerMember,seed.customerId,own.id,body(invoice.id),[]),/no longer the latest/);
    await assert.rejects(payments.submit(seed.customerMember,seed.customerId,null,body(invoice.id),[]),/Choose the booking/);
    await assert.rejects(invoices.outstanding(seed.customerMember,seed.secondCustomerId),/not found/);
    await assert.rejects(invoices.outstanding(seed.otherAdmin,seed.customerId),/not found/);
  });

  it('excludes fully paid invoices and rejects new payments against a settled latest revision',async()=>{
    const booking=await create();
    await payments.record(seed.admin,seed.customerId,booking.id,{amount:'100',payment_date:businessDate(),idempotency_key:randomUUID()});
    const invoice=(await invoices.list(seed.customerMember,seed.customerId,booking.id)).invoices[0];
    assert.equal(invoice.status,'paid');
    assert.ok(!(await invoices.outstanding(seed.customerMember,seed.customerId)).invoices.some(i=>i.booking_id===booking.id));
    await assert.rejects(payments.submit(seed.customerMember,seed.customerId,booking.id,body(invoice.id),[]),/no outstanding balance/);
  });

  it('hides and rejects invoice payments after independent account credits settle the full balance',async()=>{
    const booking=await create(),invoice=(await invoices.list(seed.customerMember,seed.customerId,booking.id)).invoices[0];
    const balance=BigInt((await database.db.query('SELECT SUM(amount_minor)::text AS balance FROM account_ledger_entries WHERE customer_id=$1',[seed.customerId])).rows[0].balance);
    const payment=await payments.submit(seed.customerMember,seed.customerId,null,{amount:`${balance/100n}.${String(balance%100n).padStart(2,'0')}`,
      payment_date:businessDate(),idempotency_key:randomUUID()},[]);
    await payments.approve(seed.admin,seed.customerId,null,payment.id);
    assert.deepEqual((await invoices.outstanding(seed.customerMember,seed.customerId)).invoices,[]);
    await assert.rejects(payments.submit(seed.customerMember,seed.customerId,booking.id,body(invoice.id),[]),/account has no outstanding balance/);
  });
});
