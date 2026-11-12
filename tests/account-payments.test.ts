import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { HttpException } from '@nestjs/common';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { businessDate } from '../apps/api/src/dashboard/time';
import { config } from '../apps/api/src/config';
import { LedgerService } from '../apps/api/src/ledger/ledger.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

const denied=(promise:Promise<unknown>,status:number)=>assert.rejects(promise,
  (error:unknown)=>error instanceof HttpException&&error.getStatus()===status);
const input=(amount='25.00')=>({amount,payment_date:businessDate(),note:'Account transfer',idempotency_key:randomUUID()});
const receipt=()=>{
  const buffer=Buffer.from(`%PDF-1.4\nAccount receipt ${randomUUID()}\n%%EOF`);
  return {originalname:'transfer.pdf',mimetype:'application/pdf',buffer,size:buffer.length};
};

describe('independent customer account payment evidence and settlement',()=>{
  let database:TestDatabase,seed:TestSeed,payments:PaymentsService,bookings:BookingsService,ledger:LedgerService;
  before(async()=>{
    database=await setupTestDatabase();seed=await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP'");
    const access=new AccessService(database.db);
    seed.admin=await access.membership(seed.adminId,seed.orgId);
    seed.customerMember=await access.membership(seed.customerUserId,seed.orgId);
    payments=new PaymentsService(database.db,access);bookings=new BookingsService(database.db,access);ledger=new LedgerService(database.db,access);
  });
  after(async()=>database?.close());
  const balance=async()=>BigInt((await ledger.statement(seed.customerMember,seed.customerId)).current_balance_minor);
  const booking=()=>bookings.create(seed.admin,seed.customerId,{reference:`ACCOUNT-${randomUUID()}`,
    departure_at:'2030-01-01T12:00:00Z',required_services:[],amount:'100.00',effective_date:businessDate(),idempotency_key:randomUUID()});

  it('accepts a payment without any booking, retains its receipt scope, and credits the account only after review',async()=>{
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n,0);
    const body=input(),file=receipt(),before=await balance();
    const payment=await payments.submit(seed.customerMember,seed.customerId,null,body,[file]);
    assert.equal(payment.booking_id,null);assert.equal(payment.booking_reference,null);assert.equal(payment.status,'pending');
    assert.equal(payment.ledger_entry_id,null);assert.equal(await balance(),before);
    assert.equal(payment.receipts[0].url,`/api/organizations/${seed.orgId}/customers/${seed.customerId}/payments/${payment.id}/receipts/${payment.receipts[0].id}`);
    assert.deepEqual((await payments.receipt(seed.customerMember,seed.customerId,null,payment.id,payment.receipts[0].id)).content,file.buffer);
    assert.equal((await payments.submit(seed.customerMember,seed.customerId,null,body,[file])).id,payment.id);
    await denied(payments.submit(seed.customerMember,seed.customerId,null,{...body,amount:'26'},[file]),409);
    await denied(payments.submit(seed.customerMember,seed.customerId,null,input(),[file]),409);
    const reviewed=await payments.approve(seed.admin,seed.customerId,null,payment.id);
    assert.equal(await balance(),before-2500n);assert.ok(reviewed.ledger_entry_id);
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n,0);
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM booking_invoices')).rows[0].n,0);
    const notices=(await database.db.query("SELECT * FROM payment_email_outbox WHERE split_part(dedupe_key,':',2)=$1",[payment.id])).rows;
    assert.equal(notices.length,3);
    const adminNotice=notices.find(row=>row.dedupe_key.startsWith('payment-submitted:'))!;
    assert.ok(adminNotice.body.includes(`${config.appUrl}/o/${seed.orgId}/payment-reviews?q=${payment.id}`));
    for(const notice of notices.filter(row=>row.recipient==='customer@example.test')) {
      assert.ok(notice.body.includes(`${config.appUrl}/o/${seed.orgId}`));
      assert.doesNotMatch(notice.body,/\/bookings\/|Booking: null/);assert.equal(notice.invoice_id,null);
    }
  });

  it('settles the total across two bookings exactly once while preserving booking allocations and old history',async()=>{
    const first=await booking(),second=await booking();
    const legacy=await payments.submit(seed.customerMember,seed.customerId,first.id,input('10'),[]);
    await payments.approve(seed.admin,seed.customerId,first.id,legacy.id);
    const snapshots=(await database.db.query('SELECT * FROM booking_invoices ORDER BY id')).rows;
    const bookingRows=(await database.db.query('SELECT * FROM bookings ORDER BY id')).rows;
    const before=await balance(),body=input('150');
    const pending=await payments.submit(seed.customerMember,seed.customerId,null,body,[]);
    assert.equal(await balance(),before);
    const [approved,retry]=await Promise.all([payments.approve(seed.admin,seed.customerId,null,pending.id),payments.approve(seed.admin,seed.customerId,null,pending.id)]);
    assert.equal(approved.ledger_entry_id,retry.ledger_entry_id);assert.equal(await balance(),before-15000n);
    assert.deepEqual((await database.db.query('SELECT * FROM bookings ORDER BY id')).rows,bookingRows);
    assert.deepEqual((await database.db.query('SELECT * FROM booking_invoices ORDER BY id')).rows,snapshots);
    assert.equal((await payments.list(seed.customerMember,seed.customerId,first.id)).items.length,1);
    assert.equal((await payments.list(seed.customerMember,seed.customerId,second.id)).items.length,0);
    const history=(await payments.list(seed.customerMember,seed.customerId,null)).items;
    assert.equal(history.find(item=>item.id===legacy.id)?.booking_id,first.id);
    assert.equal(history.find(item=>item.id===pending.id)?.booking_id,null);
    assert.ok((await payments.reviewQueue(seed.admin,{status:'all'})).items.some(item=>item.id===pending.id&&item.booking_id===null));
    await denied(payments.approve(seed.admin,seed.customerId,first.id,pending.id),404);
    await denied(payments.approve(seed.admin,seed.customerId,null,legacy.id),404);
  });

  it('enforces ownership and nullable receipt parent integrity across accounts, bookings and tenants',async()=>{
    const trip=await booking(),file=receipt();
    const payment=await payments.submit(seed.customerMember,seed.customerId,null,input(),[file]);
    await denied(payments.list(seed.customerMember,seed.secondCustomerId,null),404);
    await denied(payments.submit(seed.customerMember,seed.secondCustomerId,null,input(),[]),404);
    await denied(payments.submit(seed.admin,seed.customerId,null,input(),[]),403);
    await denied(payments.approve(seed.customerMember,seed.customerId,null,payment.id),403);
    await denied(payments.approve(seed.otherAdmin,seed.customerId,null,payment.id),404);
    await denied(payments.receipt(seed.otherAdmin,seed.customerId,null,payment.id,payment.receipts[0].id),404);
    await denied(payments.receipt(seed.customerMember,seed.customerId,trip.id,payment.id,payment.receipts[0].id),404);
    for(const [org,customer,bookingId] of [[seed.orgId,seed.secondCustomerId,null],[seed.otherOrgId,seed.otherCustomerId,null],[seed.orgId,seed.customerId,trip.id]]) {
      await assert.rejects(database.db.query(`INSERT INTO booking_payment_receipts(id,organization_id,customer_id,booking_id,payment_id,name,mime_type,size,content,original_sha256)
        VALUES($1,$2,$3,$4,$5,'forged.pdf','application/pdf',$6,$7,$8)`,[randomUUID(),org,customer,bookingId,payment.id,file.size,file.buffer,'f'.repeat(64)]),/scope/);
    }
    await denied(payments.submit(seed.customerMember,seed.customerId,trip.id,input(),[file]),409);
    const before=await balance();
    const rejected=await payments.reject(seed.admin,seed.customerId,null,payment.id,{reason:'Transfer not received'});
    assert.equal(rejected.status,'rejected');assert.equal(await balance(),before);
    assert.equal((await payments.reject(seed.admin,seed.customerId,null,payment.id,{reason:'Transfer not received'})).id,payment.id);
    await denied(payments.approve(seed.admin,seed.customerId,null,payment.id),409);
    await database.db.query("UPDATE customers SET status='archived' WHERE id=$1",[seed.customerId]);
    try {await denied(payments.submit(seed.customerMember,seed.customerId,null,input(),[]),409);}
    finally {await database.db.query("UPDATE customers SET status='active' WHERE id=$1",[seed.customerId]);}
  });

  it('corrects, trashes, restores and purges account payments using compensating ledger entries and immutable receipts',async()=>{
    const body=input(),file=receipt(),before=await balance();
    const payment=await payments.submit(seed.customerMember,seed.customerId,null,body,[file]);
    const approved=await payments.approve(seed.admin,seed.customerId,null,payment.id);
    const change=(version:number,operation:'edit'|'delete'|'restore'|'permanent-delete',extra:Record<string,unknown>={})=>
      payments.manage(seed.admin,seed.customerId,null,payment.id,operation,{version,reason:'Correct account transfer',...extra});
    await change(approved.version,'edit',{amount:'30',payment_date:businessDate(),note:'Corrected transfer'});
    assert.equal(await balance(),before-3000n);
    const current=async(deleted='active')=>(await payments.list(seed.admin,seed.customerId,null,{deleted})).items.find(item=>item.id===payment.id)!;
    const edited=await current();assert.notEqual(edited.ledger_entry_id,approved.ledger_entry_id);
    assert.deepEqual((await payments.receipt(seed.customerMember,seed.customerId,null,payment.id,payment.receipts[0].id)).content,file.buffer);
    await denied(change(approved.version,'delete'),409);
    await change(edited.version,'delete');assert.equal(await balance(),before);
    const trashed=await current('deleted');assert.equal(trashed.restore_credit,true);
    await denied(payments.receipt(seed.customerMember,seed.customerId,null,payment.id,payment.receipts[0].id),404);
    const restores=await Promise.allSettled([change(trashed.version,'restore'),change(trashed.version,'restore')]);
    assert.equal(restores.filter(result=>result.status==='fulfilled').length,1);assert.equal(await balance(),before-3000n);
    const restored=await current();await change(restored.version,'delete');const trash=await current('deleted');
    const ledgerRows=(await database.db.query('SELECT * FROM ledger_entries ORDER BY id')).rows;
    const result={id:payment.id,deleted:true};
    assert.deepEqual(await change(trash.version,'permanent-delete',{confirmation:'DELETE'}),result);
    assert.deepEqual(await change(trash.version,'permanent-delete',{confirmation:'DELETE'}),result);
    assert.deepEqual((await database.db.query('SELECT * FROM ledger_entries ORDER BY id')).rows,ledgerRows);
    assert.equal((await database.db.query('SELECT 1 FROM booking_payment_receipts WHERE payment_id=$1',[payment.id])).rows.length,0);
    await denied(payments.submit(seed.customerMember,seed.customerId,null,body,[file]),409);
  });
});
