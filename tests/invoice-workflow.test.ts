import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import { createApp } from '../apps/api/src/app';
import { AccessService } from '../apps/api/src/access/access.service';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { BookingManagementService } from '../apps/api/src/bookings/booking-management.service';
import { config } from '../apps/api/src/config';
import { LedgerService } from '../apps/api/src/ledger/ledger.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

describe('booking invoice lifecycle and private HTTP downloads', () => {
  let database:TestDatabase, seed:TestSeed, bookings:BookingsService, payments:PaymentsService, management:BookingManagementService;
  let app:NestExpressApplication, base:string, customerCookie:string, adminCookie:string;
  before(async () => {
    database=await setupTestDatabase();seed=await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1",[seed.orgId]);
    const access=new AccessService(database.db);
    seed.admin=await access.membership(seed.adminId,seed.orgId);
    seed.customerMember=await access.membership(seed.customerUserId,seed.orgId);
    bookings=new BookingsService(database.db,access);payments=new PaymentsService(database.db,access);
    management=new BookingManagementService(database.db,access);
    app=await createApp({database:database.db,logger:false,paymentEmails:false});
    await app.listen(0,'127.0.0.1');base=await app.getUrl();
    customerCookie=`${config.sessionCookie}=${await app.get(AuthService).createSession(seed.customerUserId)}`;
    adminCookie=`${config.sessionCookie}=${await app.get(AuthService).createSession(seed.adminId)}`;
  });
  after(async()=>{await app?.close();await database?.close();});
  const input=()=>({reference:`INVOICE-${randomUUID()}`,departure_at:'2030-12-01T12:00:00Z',amount:'100.00',
    effective_date:'2026-01-01',required_services:['flight'],idempotency_key:randomUUID()});
  const create=()=>bookings.create(seed.admin,seed.customerId,input());
  const versions=async (id:string)=>(await database.db.query(`SELECT * FROM booking_invoices WHERE booking_id=$1 ORDER BY version`,[id])).rows;
  const url=(id:string,customerId=seed.customerId)=>`${base}/api/organizations/${seed.orgId}/customers/${customerId}/bookings/${id}/invoices`;
  async function submit(id:string,amount='25.00') {
    const buffer=await sharp({create:{width:8,height:8,channels:3,background:`#${randomUUID().replaceAll('-','').slice(0,6)}`}}).png().toBuffer();
    return payments.submit(seed.customerMember,seed.customerId,id,{amount,payment_date:'2026-01-02',idempotency_key:randomUUID()},
      [{originalname:'receipt.png',mimetype:'image/png',buffer,size:buffer.length}]);
  }

  it('commits one initial PDF and one confirmation for concurrent booking retries',async()=>{
    const body=input();const results=await Promise.all(Array.from({length:5},()=>bookings.create(seed.admin,seed.customerId,body)));
    assert.ok(results.every(row=>row.id===results[0].id));
    const history=await versions(results[0].id);assert.equal(history.length,1);
    assert.equal(history[0].version,1);assert.equal(history[0].reason,'booking_created');
    assert.equal(String(history[0].paid_minor),'0');assert.equal(String(history[0].balance_minor),'10000');
    assert.match(Buffer.from(history[0].pdf).subarray(0,8).toString(),/^%PDF-/);
    const emails=(await database.db.query('SELECT invoice_id FROM payment_email_outbox WHERE dedupe_key=$1',[`booking-created:${results[0].id}`])).rows;
    assert.deepEqual(emails,[{invoice_id:history[0].id}]);
  });

  it('counts approved money, preserves old PDF bytes, and appends reversals and overpayment credit',async()=>{
    const trip=await create(),initial=(await versions(trip.id))[0],payment=await submit(trip.id);
    assert.equal((await versions(trip.id)).length,1,'Pending evidence is not paid money.');
    const approved=await payments.approve(seed.admin,seed.customerId,trip.id,payment.id);
    await payments.approve(seed.admin,seed.customerId,trip.id,payment.id);
    let history=await versions(trip.id);assert.equal(history.length,2);
    assert.equal(String(history[1].paid_minor),'2500');assert.equal(String(history[1].balance_minor),'7500');
    assert.equal(history[1].status,'partially_paid');assert.deepEqual(history[0].pdf,initial.pdf);
    const ledger=new LedgerService(database.db,new AccessService(database.db));
    const reverse={kind:'reversal' as const,reversal_of:approved.ledger_entry_id!,description:'Wrong transfer',effective_date:'2026-01-03',idempotency_key:randomUUID()};
    await ledger.post(seed.admin,seed.customerId,reverse);await ledger.post(seed.admin,seed.customerId,reverse);
    history=await versions(trip.id);assert.equal(history.length,3);
    assert.equal(history[2].reason,'payment_reversed');assert.equal(String(history[2].paid_minor),'0');
    const overpaid=await submit(trip.id,'120.00');await payments.approve(seed.admin,seed.customerId,trip.id,overpaid.id);
    history=await versions(trip.id);assert.equal(history.length,4);
    assert.equal(history[3].status,'overpaid');assert.equal(String(history[3].balance_minor),'-2000');
    const rejected=await submit(trip.id,'5.00');await payments.reject(seed.admin,seed.customerId,trip.id,rejected.id,{reason:'Wrong evidence'});
    assert.equal((await versions(trip.id)).length,4,'Rejected evidence must not change the invoice.');
  });

  it('serializes distinct approvals and repeated approval attempts without missing a version',async()=>{
    const trip=await create(),one=await submit(trip.id,'30'),two=await submit(trip.id,'70');
    await Promise.all([payments.approve(seed.admin,seed.customerId,trip.id,one.id),payments.approve(seed.admin,seed.customerId,trip.id,two.id),payments.approve(seed.admin,seed.customerId,trip.id,one.id)]);
    const history=await versions(trip.id);assert.deepEqual(history.map(row=>row.version),[1,2,3]);
    assert.equal(String(history[2].paid_minor),'10000');assert.equal(history[2].status,'paid');
    assert.ok(['3000','7000'].includes(String(history[1].paid_minor)));
  });

  it('appends booking amendments and cancellations while retaining a protected history',async()=>{
    const trip=await create(),payment=await submit(trip.id);await payments.approve(seed.admin,seed.customerId,trip.id,payment.id);
    const edit={reference:trip.reference,departure_at:'2030-12-02T12:00:00Z',required_services:['flight'],amount:'80',
      instalments:[{due_date:'2026-01-04',amount:'80'}],effective_date:'2026-01-03',expected_version:1,reason:'Changed package',idempotency_key:randomUUID()};
    await management.update(seed.admin,seed.customerId,trip.id,edit);await management.update(seed.admin,seed.customerId,trip.id,edit);
    let history=await versions(trip.id);assert.equal(history.length,3);assert.equal(String(history[2].balance_minor),'5500');
    await management.cancel(seed.admin,seed.customerId,trip.id,{confirmation:trip.reference,effective_date:'2026-01-04',expected_version:2,reason:'Cancelled trip',idempotency_key:randomUUID()});
    history=await versions(trip.id);assert.equal(history.length,4);assert.equal(history[3].status,'cancelled');
    assert.equal(String(history[3].total_minor),'0');assert.equal(String(history[3].balance_minor),'-2500');
    const listing=await fetch(url(trip.id),{headers:{Cookie:customerCookie}});assert.equal(listing.status,200);
    assert.equal((await listing.json()).invoices.length,4);
    const download=await fetch(`${url(trip.id)}/${history[0].id}/pdf`,{headers:{Cookie:customerCookie}});
    assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),Buffer.from(history[0].pdf));
  });

  it('requires live tenant/customer authorization, scopes invoice IDs and validates pagination',async()=>{
    const trip=await create(),invoice=(await versions(trip.id))[0];
    const downloadUrl=`${url(trip.id)}/${invoice.id}/pdf`;
    assert.equal((await fetch(downloadUrl)).status,401);
    const downloaded=await fetch(downloadUrl,{headers:{Cookie:customerCookie}});
    assert.equal(downloaded.status,200);assert.match(downloaded.headers.get('content-type')!,/application\/pdf/);
    assert.equal(downloaded.headers.get('cache-control'),'private, no-store');
    assert.equal(downloaded.headers.get('x-content-type-options'),'nosniff');
    assert.match(downloaded.headers.get('content-disposition')!,/^attachment;/);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),Buffer.from(invoice.pdf));
    const other=await bookings.create(seed.admin,seed.secondCustomerId,input());
    for(const [target,cookie] of [[`${url(other.id,seed.secondCustomerId)}/${invoice.id}/pdf`,adminCookie],[url(other.id,seed.secondCustomerId),customerCookie]])
      assert.equal((await fetch(target,{headers:{Cookie:cookie}})).status,404);
    for(const query of ['limit=101','limit=0','before_version=0','limit=1&limit=2'])
      assert.equal((await fetch(`${url(trip.id)}?${query}`,{headers:{Cookie:adminCookie}})).status,400,query);
    await database.db.query('UPDATE memberships SET is_active=false WHERE id=$1',[seed.customerMember.id]);
    try {assert.equal((await fetch(downloadUrl,{headers:{Cookie:customerCookie}})).status,404);}
    finally {await database.db.query('UPDATE memberships SET is_active=true WHERE id=$1',[seed.customerMember.id]);}
  });

  it('rolls booking, invoice, and outbox back together when queue persistence fails',async()=>{
    const body=input();
    await database.db.query(`CREATE FUNCTION fail_invoice_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.dedupe_key LIKE 'booking-created:%' THEN RAISE EXCEPTION 'confirmation persistence failed'; END IF; RETURN NEW; END; $$`);
    await database.db.query('CREATE TRIGGER fail_invoice_confirmation BEFORE INSERT ON payment_email_outbox FOR EACH ROW EXECUTE FUNCTION fail_invoice_confirmation()');
    try {
      await assert.rejects(bookings.create(seed.admin,seed.customerId,body),/confirmation persistence failed/);
      assert.equal((await database.db.query('SELECT id FROM bookings WHERE idempotency_key=$1',[body.idempotency_key])).rowCount,0);
      assert.equal((await database.db.query('SELECT id FROM ledger_entries WHERE reference=$1',[body.reference])).rowCount,0);
    } finally {await database.db.query('DROP TRIGGER fail_invoice_confirmation ON payment_email_outbox');await database.db.query('DROP FUNCTION fail_invoice_confirmation()');}
    const trip=await bookings.create(seed.admin,seed.customerId,body);assert.equal((await versions(trip.id)).length,1);
  });
});
