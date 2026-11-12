import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { BadRequestException } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { BookingManagementService } from '../apps/api/src/bookings/booking-management.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { createApp } from '../apps/api/src/app';
import { config } from '../apps/api/src/config';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

const createInput = () => ({reference:`MANAGE-${randomUUID().slice(0,8)}`,departure_at:'2026-11-12T10:30:00+00:00',required_services:['makkah'],amount:'100.00',effective_date:'2026-01-01',
  instalments:[{due_date:'2026-11-02',amount:'100.00'}],idempotency_key:randomUUID()});
const editInput = (reference:string,version=1) => ({reference,departure_at:'2026-11-13T11:45:00+00:00',required_services:['flight','makkah'],amount:'120.00',effective_date:'2026-02-01',
  instalments:[{due_date:'2026-11-02',amount:'50.00'},{due_date:'2026-11-10',amount:'70.00'}],idempotency_key:randomUUID(),expected_version:version,reason:'Corrected travel package'});
const cancelInput = (reference:string,version=1) => ({confirmation:reference,effective_date:'2026-03-01',idempotency_key:randomUUID(),expected_version:version,reason:'Customer cancelled travel'});

describe('booking edits and cancellations preserve financial history', () => {
  let database:TestDatabase,seed:TestSeed,bookings:BookingsService,management:BookingManagementService,payments:PaymentsService;
  let app:NestExpressApplication,base:string,adminCookie:string,customerCookie:string;
  before(async()=>{
    database=await setupTestDatabase(); seed=await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1",[seed.orgId]);
    const access=new AccessService(database.db);
    seed.admin=await access.membership(seed.adminId,seed.orgId); seed.customerMember=await access.membership(seed.customerUserId,seed.orgId);
    bookings=new BookingsService(database.db,access); management=new BookingManagementService(database.db,access); payments=new PaymentsService(database.db,access);
    app=await createApp({database:database.db,logger:false}); await app.listen(0,'127.0.0.1'); base=await app.getUrl();
    adminCookie=`${config.sessionCookie}=${await app.get(AuthService).createSession(seed.adminId)}`;
    customerCookie=`${config.sessionCookie}=${await app.get(AuthService).createSession(seed.customerUserId)}`;
  });
  after(async()=>{if(app) await app.close(); if(database) await database.close();});
  const create=()=>bookings.create(seed.admin,seed.customerId,createInput());
  const path=(id:string,customer=seed.customerId)=>`${base}/api/organizations/${seed.orgId}/customers/${customer}/bookings/${id}`;
  const headers=(cookie=adminCookie)=>({'Content-Type':'application/json',Cookie:cookie,Origin:config.appUrl,'X-CSRF-Protection':'1'});
  async function receipt(color:string) {
    const buffer=await sharp({create:{width:4,height:4,channels:3,background:color}}).png().toBuffer();
    return {originalname:'receipt.png',mimetype:'image/png',buffer,size:buffer.length};
  }

  it('atomically corrects amounts, schedules and metadata without mutating a posted entry, with exact retry replay',async()=>{
    const original=await create(),id=original.id as string;
    const before=(await database.db.query('SELECT * FROM ledger_entries WHERE id=$1',[original.charge_entry_id])).rows[0];
    const request=editInput(`${original.reference}-EDIT`);
    const [updated,retry]=await Promise.all([management.update(seed.admin,seed.customerId,id,request),management.update(seed.admin,seed.customerId,id,request)]);
    assert.deepEqual(updated,retry); assert.equal(updated.version,2); assert.equal(updated.total_minor,'12000');
    assert.deepEqual((updated.instalments as {amount_minor:string}[]).map(item=>item.amount_minor),['5000','7000']);
    assert.equal(updated.reference,request.reference); assert.notEqual(updated.charge_entry_id,String(original.charge_entry_id));
    assert.deepEqual((await database.db.query('SELECT * FROM ledger_entries WHERE id=$1',[original.charge_entry_id])).rows[0],before);
    const reversed=(await database.db.query('SELECT amount_minor::text AS amount FROM ledger_entries WHERE reversal_of=$1',[original.charge_entry_id])).rows;
    assert.deepEqual(reversed,[{amount:'-10000'}]);
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM ledger_entries WHERE request_hash=(SELECT request_hash FROM booking_operations WHERE idempotency_key=$1)',[request.idempotency_key])).rows[0].n,2);
    await assert.rejects(management.update(seed.admin,seed.customerId,id,{...request,reason:'Changed payload'}),/submission key/);
    const second={...editInput(request.reference,2),amount:'120',instalments:request.instalments};
    const again=await management.update(seed.admin,seed.customerId,id,second);
    assert.deepEqual(again.instalments,updated.instalments,'Metadata-only edits preserve schedule IDs and reminder deduplication.');
    assert.deepEqual(await management.update(seed.admin,seed.customerId,id,request),updated,'A retry replays its result, even after a later edit.');
    const audit=(await database.db.query("SELECT metadata FROM audit_events WHERE action='booking.updated' AND object_id=$1 ORDER BY id",[id])).rows[0].metadata;
    assert.equal(audit.before.total_minor,'10000'); assert.equal(audit.after.total_minor,'12000'); assert.equal(audit.reason,request.reason);
  });

  it('rejects stale concurrent changes and malformed corrections without partial financial writes',async()=>{
    const original=await create(),id=original.id as string;
    const one=editInput(original.reference),two={...editInput(original.reference),reference:`OTHER-${randomUUID()}`};
    const settled=await Promise.allSettled([management.update(seed.admin,seed.customerId,id,one),management.update(seed.admin,seed.customerId,id,two)]);
    assert.equal(settled.filter(result=>result.status==='fulfilled').length,1);
    assert.match(String((settled.find(result=>result.status==='rejected') as PromiseRejectedResult).reason),/another session/);
    const another=await create(),invalid=editInput(another.reference);
    await assert.rejects(management.update(seed.admin,seed.customerId,another.id as string,{...invalid,effective_date:'2025-12-31'}),/before the current booking charge/);
    await assert.rejects(management.update(seed.admin,seed.customerId,another.id as string,{...invalid,reason:' '}),BadRequestException);
    await assert.rejects(management.update(seed.admin,seed.customerId,another.id as string,{...invalid,instalments:[{due_date:'2026-11-01',amount:'114.99'}]}),/within £5.00/);
    assert.equal((await bookings.get(seed.admin,seed.customerId,another.id as string)).version,1);
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM ledger_entries WHERE reversal_of=$1',[another.charge_entry_id])).rows[0].n,0);
  });

  it('rolls back the correction and schedule when audit persistence fails',async()=>{
    const original=await create(),id=original.id as string,request=editInput(original.reference);
    await database.db.query(`CREATE FUNCTION reject_booking_edit_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='booking.updated' THEN RAISE EXCEPTION 'simulated booking audit failure'; END IF; RETURN NEW; END; $$;`);
    await database.db.query('CREATE TRIGGER reject_booking_edit_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_booking_edit_audit()');
    try {await assert.rejects(management.update(seed.admin,seed.customerId,id,request),/simulated booking audit failure/);}
    finally {await database.db.query('DROP TRIGGER reject_booking_edit_audit ON audit_events'); await database.db.query('DROP FUNCTION reject_booking_edit_audit()');}
    const current=await bookings.get(seed.admin,seed.customerId,id);
    assert.equal(current.total_minor,'10000'); assert.equal(current.version,1); assert.equal(current.instalments.length,1);
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM booking_operations WHERE booking_id=$1',[id])).rows[0].n,0);
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM ledger_entries WHERE reversal_of=$1',[original.charge_entry_id])).rows[0].n,0);
    assert.equal((await management.update(seed.admin,seed.customerId,id,request)).version,2);
  });

  it('retains delivered reminder history and cancels obsolete queued reminders when an instalment schedule changes',async()=>{
    const booking=await create(),id=booking.id as string,instalment=booking.instalments[0].id;
    const sent=randomUUID(),queued=randomUUID();
    await database.db.query(`INSERT INTO reminder_email_outbox(id,organization_id,customer_id,booking_id,instalment_id,scheduled_date,recipient,subject,body,state,sent_at,delivery_status)
      VALUES($1,$3,$4,$5,$6,'2026-01-01','customer@example.test','Due reminder','sent fixture','sent',now(),'delivered'),
      ($2,$3,$4,$5,$6,'2026-01-02','customer@example.test','Due reminder','queued fixture','pending',NULL,'queued')`,[sent,queued,seed.orgId,seed.customerId,id,instalment]);
    await management.update(seed.admin,seed.customerId,id,editInput(booking.reference));
    const history=(await database.db.query('SELECT id,instalment_id,state,delivery_status FROM reminder_email_outbox WHERE booking_id=$1',[id])).rows;
    assert.equal(history.length,2);
    assert.deepEqual(history.find(row=>row.id===sent),{id:sent,instalment_id:null,state:'sent',delivery_status:'delivered'});
    assert.deepEqual(history.find(row=>row.id===queued),{id:queued,instalment_id:null,state:'cancelled',delivery_status:'cancelled'});
  });

  it('cancels independently, revokes files and new payments, and preserves payment audit records',async()=>{
    const original=await create(),id=original.id as string;
    const folder=(await bookings.files(seed.admin,seed.customerId,id)).items.find(item=>item.serviceKey==='makkah')!;
    const document=await bookings.upload(seed.admin,seed.customerId,id,folder.id,'voucher.txt',randomUUID(),Buffer.from('private booking voucher'));
    const paid=await payments.submit(seed.customerMember,seed.customerId,id,{amount:'40',payment_date:'2026-01-02',idempotency_key:randomUUID()},[await receipt('#ff0000')]);
    await payments.approve(seed.admin,seed.customerId,id,paid.id);
    const pending=await payments.submit(seed.customerMember,seed.customerId,id,{amount:'10',payment_date:'2026-01-03',idempotency_key:randomUUID()},[await receipt('#0000ff')]);
    const request=cancelInput(original.reference);
    await assert.rejects(management.cancel(seed.admin,seed.customerId,id,{...request,confirmation:'wrong'}),/exact booking reference/);
    const cancelled=await management.cancel(seed.admin,seed.customerId,id,request);
    assert.equal(cancelled.cancelled,true); assert.equal(cancelled.retained_payments_minor,'0'); assert.equal(cancelled.excluded_payments_minor,'4000');
    assert.deepEqual(await management.cancel(seed.admin,seed.customerId,id,request),cancelled);
    assert.equal((await bookings.list(seed.admin,seed.customerId)).items.some(item=>item.id===id),false);
    await assert.rejects(bookings.get(seed.admin,seed.customerId,id),/not found/);
    await assert.rejects(bookings.document(seed.customerMember,seed.customerId,id,document.id),/not found/);
    await assert.rejects(bookings.upload(seed.admin,seed.customerId,id,folder.id,'again.txt',randomUUID(),Buffer.from('retry')),/not found/);
    await assert.rejects(payments.submit(seed.customerMember,seed.customerId,id,{amount:'5',payment_date:'2026-01-03',idempotency_key:randomUUID()},[await receipt('#00ff00')]),/cancelled/);
    await assert.rejects(payments.approve(seed.admin,seed.customerId,id,pending.id),/cancelled/);
    const history=await payments.list(seed.customerMember,seed.customerId,id);
    assert.equal(history.items.find(item=>item.id===paid.id)?.status,'approved');
    assert.equal(history.items.find(item=>item.id===pending.id)?.status,'rejected');
    const staleMail=await database.db.query('SELECT state,delivery_status FROM payment_email_outbox WHERE dedupe_key LIKE $1',[`payment-submitted:${pending.id}:%`]);
    assert.ok(staleMail.rows.length); assert.ok(staleMail.rows.every(row=>row.state==='cancelled' && row.delivery_status==='cancelled'));
    assert.equal((await database.db.query('SELECT state FROM payment_email_outbox WHERE dedupe_key=$1',[`payment-approved:${paid.id}`])).rows[0].state,'pending','Approval notifications remain valid.');
    assert.equal((await payments.receipt(seed.customerMember,seed.customerId,id,paid.id,paid.receipts[0].id)).content.length>0,true);
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM booking_nodes WHERE id=$1',[document.id])).rows[0].n,1,'Retain document audit while denying access.');
    const balance=await database.db.query(`SELECT sum(amount_minor)::text AS balance FROM ledger_entries WHERE id=$1 OR reversal_of=$1 OR id=(SELECT ledger_entry_id FROM booking_payments WHERE id=$2)`,[original.charge_entry_id,paid.id]);
    assert.equal(balance.rows[0].balance,'-4000');
  });

  it('enforces HTTP role, tenant, CSRF, optimistic concurrency and retry boundaries',async()=>{
    const original=await create(),id=original.id as string,request=editInput(original.reference);
    assert.equal((await fetch(path(id),{method:'PATCH',headers:headers(customerCookie),body:JSON.stringify(request)})).status,403);
    assert.equal((await fetch(path(id,seed.secondCustomerId),{method:'PATCH',headers:headers(),body:JSON.stringify(request)})).status,404);
    assert.equal((await fetch(path(id),{method:'PATCH',headers:{'Content-Type':'application/json',Cookie:adminCookie},body:JSON.stringify(request)})).status,403);
    await assert.rejects(management.update(seed.otherAdmin,seed.customerId,id,request),/not found/);
    const updated=await fetch(path(id),{method:'PATCH',headers:headers(),body:JSON.stringify(request)});
    assert.equal(updated.status,200); assert.equal((await updated.json()).version,2);
    assert.equal((await fetch(path(id),{method:'PATCH',headers:headers(),body:JSON.stringify({...request,idempotency_key:randomUUID()})})).status,409);
    const cancellation=cancelInput(original.reference,2);
    assert.equal((await fetch(path(id),{method:'DELETE',headers:headers(customerCookie),body:JSON.stringify(cancellation)})).status,403);
    const deleted=await fetch(path(id),{method:'DELETE',headers:headers(),body:JSON.stringify(cancellation)});
    assert.equal(deleted.status,200); assert.equal((await deleted.json()).cancelled,true);
    assert.equal((await fetch(path(id),{method:'DELETE',headers:headers(),body:JSON.stringify(cancellation)})).status,200);
    assert.equal((await fetch(path(id),{headers:headers()})).status,404);
  });

  it('preserves a cancelled booking when its administrator is removed',async()=>{
    const user=randomUUID(),membership=randomUUID(),email=`cancel-admin-${randomUUID()}@example.test`;
    await database.db.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'unused-test-password')",[user,email]);
    await database.db.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'admin')",[membership,seed.orgId,user]);
    const member=await new AccessService(database.db).membership(user,seed.orgId,true);
    const booking=await bookings.create(member,seed.customerId,createInput());
    await management.cancel(member,seed.customerId,booking.id as string,cancelInput(booking.reference));
    await database.db.query('SELECT permanently_delete_administrator($1,$2,$3,$4)',[seed.adminId,seed.orgId,membership,email]);
    const retained=(await database.db.query('SELECT deleted_at,deleted_by,created_by FROM bookings WHERE id=$1',[booking.id])).rows[0];
    assert.ok(retained.deleted_at); assert.equal(retained.deleted_by,null); assert.equal(retained.created_by,null);
  });
});
