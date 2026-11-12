import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { HttpException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { BookingManagementService } from '../apps/api/src/bookings/booking-management.service';
import { businessDate, addDays } from '../apps/api/src/dashboard/time';
import { LedgerService } from '../apps/api/src/ledger/ledger.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

const rejectsStatus=(operation:Promise<unknown>,status:number)=>assert.rejects(operation,
  (error:unknown)=>error instanceof HttpException && error.getStatus()===status);
const pdf=Buffer.from('%PDF-1.4\npayment-history-fixture\n%%EOF');
const files=[{originalname:'receipt.pdf',mimetype:'application/pdf',buffer:pdf,size:pdf.length}];

describe('administrator payment history lifecycle',()=>{
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
  const booking=()=>bookings.create(seed.admin,seed.customerId,{reference:`HISTORY-${randomUUID()}`,departure_at:'2030-01-01T12:00:00Z',
    required_services:[],amount:'100.00',effective_date:businessDate(),idempotency_key:randomUUID()});
  const submit=(bookingId:string,attachments=files)=>payments.submit(seed.customerMember,seed.customerId,bookingId,
    {amount:'25.00',payment_date:businessDate(),note:'Original evidence',idempotency_key:randomUUID()},attachments);
  const rows=async(bookingId:string)=>await payments.list(seed.admin,seed.customerId,bookingId);
  const balance=async()=>BigInt((await ledger.statement(seed.admin,seed.customerId)).current_balance_minor);
  const action=(bookingId:string,id:string,operation:'edit'|'delete'|'restore'|'permanent-delete',version:number,extra:Record<string,unknown>={})=>
    payments.manage(seed.admin,seed.customerId,bookingId,id,operation,{version,reason:'Correct the recorded payment',...extra});
  const current=async(bookingId:string,id:string)=>(await rows(bookingId)).items.find(item=>item.id===id)!;

  it('allows payment submission with no attachment, replay, manual approval and rejection',async()=>{
    const trip=await booking(),raw={amount:'25.00',payment_date:businessDate(),note:'Cash payment',idempotency_key:randomUUID()};
    const before=await balance();
    const payment=await payments.submit(seed.customerMember,seed.customerId,trip.id,raw,[]);
    assert.equal(payment.status,'pending');assert.deepEqual(payment.receipts,[]);assert.equal(await balance(),before);
    const notices=(await database.db.query("SELECT subject,body FROM payment_email_outbox WHERE split_part(dedupe_key,':',2)=$1",[payment.id])).rows;
    assert.equal(notices.length,2);assert.ok(notices.every(row=>/payment details|payment submitted/i.test(`${row.subject} ${row.body}`)));
    assert.ok(notices.every(row=>!/uploaded 0|0 payment receipt|receipt has been received/i.test(`${row.subject} ${row.body}`)));
    assert.ok(notices.some(row=>/does not credit your account/.test(row.body)));
    const replay=await payments.submit(seed.customerMember,seed.customerId,trip.id,raw,[]);assert.equal(replay.id,payment.id);
    const approved=await payments.approve(seed.admin,seed.customerId,trip.id,payment.id,{});
    assert.equal(approved.status,'approved');assert.equal(approved.version,2);assert.equal(await balance(),before-2500n);
    const next=await submit(trip.id,[]);
    const rejected=await payments.reject(seed.admin,seed.customerId,trip.id,next.id,{reason:'Not received'});
    assert.equal(rejected.status,'rejected');assert.equal(rejected.version,2);assert.equal(await balance(),before-2500n);
  });

  it('edits approved amount/date with reversal and replacement, preserving receipt bytes and source history',async()=>{
    const trip=await booking(),pending=await submit(trip.id),approved=await payments.approve(seed.admin,seed.customerId,trip.id,pending.id,{});
    const before=await balance(),receipt=await payments.receipt(seed.admin,seed.customerId,trip.id,approved.id,approved.receipts[0].id);
    const original=(await database.db.query('SELECT * FROM ledger_entries WHERE id=$1',[approved.ledger_entry_id])).rows[0];
    const oldBooking=(await bookings.get(seed.admin,seed.customerId,trip.id)).version;
    await action(trip.id,approved.id,'edit',approved.version,{amount:'30.00',payment_date:addDays(businessDate(),-1),note:'Corrected amount'});
    const edited=await current(trip.id,approved.id);
    assert.equal(edited.amount_minor,'3000');assert.notEqual(edited.ledger_entry_id,approved.ledger_entry_id);assert.equal(edited.version,3);
    assert.equal(edited.submitted_at instanceof Date?edited.submitted_at.toISOString():edited.submitted_at,
      approved.submitted_at instanceof Date?approved.submitted_at.toISOString():approved.submitted_at);
    assert.equal(await balance(),before-500n);
    assert.deepEqual((await database.db.query('SELECT * FROM ledger_entries WHERE id=$1',[approved.ledger_entry_id])).rows[0],original);
    assert.deepEqual((await payments.receipt(seed.admin,seed.customerId,trip.id,edited.id,edited.receipts[0].id)).content,receipt.content);
    assert.equal((await bookings.get(seed.admin,seed.customerId,trip.id)).version,oldBooking+1);
    assert.equal((await database.db.query('SELECT paid_minor::text FROM booking_invoices WHERE booking_id=$1 ORDER BY version DESC LIMIT 1',[trip.id])).rows[0].paid_minor,'3000');
    assert.equal((await database.db.query("SELECT 1 FROM payment_email_outbox WHERE split_part(dedupe_key,':',2)=$1 AND state IN ('pending','processing')",[edited.id])).rows.length,0);
    await rejectsStatus(action(trip.id,edited.id,'edit',approved.version,{amount:'35.00',payment_date:businessDate(),note:''}),409);
    assert.equal(await balance(),before-500n);
    const entries=(await database.db.query('SELECT count(*)::int AS n FROM ledger_entries')).rows[0].n;
    await action(trip.id,edited.id,'edit',edited.version,{amount:'30.00',payment_date:edited.payment_date,note:'Only update the note'});
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM ledger_entries')).rows[0].n,entries);
  });

  it('soft-deletes, restores exactly once, and permanently removes only trash while preserving ledger/audit',async()=>{
    const trip=await booking(),pending=await submit(trip.id),approved=await payments.approve(seed.admin,seed.customerId,trip.id,pending.id,{});
    const before=await balance();
    await rejectsStatus(action(trip.id,approved.id,'permanent-delete',approved.version,{confirmation:'DELETE'}),409);
    await action(trip.id,approved.id,'delete',approved.version);
    assert.equal((await rows(trip.id)).items.length,0);assert.equal((await payments.list(seed.customerMember,seed.customerId,trip.id)).items.length,0);
    assert.equal(await balance(),before+2500n);
    const trash=(await payments.list(seed.admin,seed.customerId,trip.id,{deleted:'deleted'})).items[0];
    assert.ok(trash.deleted_at);assert.equal(trash.receipts.length,1);assert.equal(trash.reversed,true);
    await rejectsStatus(payments.list(seed.customerMember,seed.customerId,trip.id,{deleted:'deleted'}),403);
    await rejectsStatus(payments.receipt(seed.customerMember,seed.customerId,trip.id,trash.id,trash.receipts[0].id),404);
    assert.deepEqual((await payments.receipt(seed.admin,seed.customerId,trip.id,trash.id,trash.receipts[0].id)).content,pdf);
    const attempts=await Promise.allSettled([action(trip.id,trash.id,'restore',trash.version),action(trip.id,trash.id,'restore',trash.version)]);
    assert.equal(attempts.filter(item=>item.status==='fulfilled').length,1);assert.equal(await balance(),before);
    const restored=await current(trip.id,approved.id);assert.equal(restored.deleted_at,null);assert.notEqual(restored.ledger_entry_id,approved.ledger_entry_id);
    await action(trip.id,restored.id,'delete',restored.version);
    const again=(await payments.list(seed.admin,seed.customerId,trip.id,{deleted:'deleted'})).items[0];
    const money=(await database.db.query('SELECT * FROM ledger_entries ORDER BY id')).rows;
    await rejectsStatus(action(trip.id,again.id,'permanent-delete',again.version,{confirmation:'YES'}),400);
    assert.deepEqual(await action(trip.id,again.id,'permanent-delete',again.version,{confirmation:'DELETE'}),{id:again.id,deleted:true});
    assert.deepEqual(await action(trip.id,again.id,'permanent-delete',again.version,{confirmation:'DELETE'}),{id:again.id,deleted:true});
    assert.deepEqual((await database.db.query('SELECT * FROM ledger_entries ORDER BY id')).rows,money);
    assert.equal((await database.db.query('SELECT 1 FROM booking_payment_receipts WHERE payment_id=$1',[again.id])).rows.length,0);
    assert.equal((await database.db.query("SELECT 1 FROM audit_events WHERE object_id=$1 AND action='payment.permanently_deleted'",[again.id])).rows.length,1);
    assert.equal((await payments.list(seed.admin,seed.customerId,trip.id,{deleted:'deleted'})).items.length,0);
  });

  it('changes pending and rejected details without posting money and blocks stale review edits',async()=>{
    const trip=await booking(),pending=await submit(trip.id,[]),before=await balance();
    await action(trip.id,pending.id,'edit',pending.version,{amount:'27.00',payment_date:businessDate(),note:'Customer confirmed transfer amount'});
    const edited=await current(trip.id,pending.id);assert.equal(edited.amount_minor,'2700');assert.equal(edited.status,'pending');assert.equal(await balance(),before);
    const approved=await payments.approve(seed.admin,seed.customerId,trip.id,pending.id,{});
    await rejectsStatus(action(trip.id,edited.id,'edit',edited.version,{amount:'29.00',payment_date:businessDate(),note:''}),409);
    assert.equal(approved.version,edited.version+1);
    const rejected=await payments.reject(seed.admin,seed.customerId,trip.id,(await submit(trip.id,[])).id,{reason:'Not received'});
    await action(trip.id,rejected.id,'edit',rejected.version,{amount:'40.00',payment_date:businessDate(),note:'Correction'});
    assert.equal((await current(trip.id,rejected.id)).status,'rejected');assert.equal(await balance(),before-2700n);
  });

  it('unlinks only an amount-mismatched installment while preserving the scheduled amount and booking credit',async()=>{
    const trip=await bookings.create(seed.admin,seed.customerId,{reference:`PAID-${randomUUID()}`,departure_at:'2030-01-01T12:00:00Z',required_services:[],
      amount:'100.00',effective_date:businessDate(),idempotency_key:randomUUID(),instalments:[{due_date:businessDate(),amount:'100.00',paid:true,paid_date:businessDate()}]});
    const paid=(await rows(trip.id)).items[0];
    await action(trip.id,paid.id,'edit',paid.version,{amount:'90.00',payment_date:businessDate(),note:'Corrected recorded advance'});
    const detail=await bookings.get(seed.admin,seed.customerId,trip.id);
    assert.equal(detail.instalments[0].amount_minor,'10000');assert.equal(detail.instalments[0].paid,false);assert.equal(detail.paid_minor,'9000');assert.equal(detail.remaining_minor,'1000');
  });

  it('rejects unauthorized, cross-tenant, malformed and externally reversed financial edits',async()=>{
    const trip=await booking(),pending=await submit(trip.id,[]),approved=await payments.approve(seed.admin,seed.customerId,trip.id,pending.id,{});
    const body={version:approved.version,reason:'Correction'};
    await rejectsStatus(payments.manage(seed.customerMember,seed.customerId,trip.id,approved.id,'delete',body),403);
    await rejectsStatus(payments.manage(seed.otherAdmin,seed.customerId,trip.id,approved.id,'delete',body),404);
    await rejectsStatus(action(trip.id,approved.id,'edit',approved.version,{amount:'0',payment_date:businessDate(),note:''}),400);
    await rejectsStatus(action(trip.id,approved.id,'edit',approved.version,{amount:'10',payment_date:addDays(businessDate(),1),note:''}),400);
    await ledger.post(seed.admin,seed.customerId,{kind:'reversal',reversal_of:approved.ledger_entry_id!,effective_date:businessDate(),description:'Already reversed',idempotency_key:randomUUID()});
    await rejectsStatus(action(trip.id,approved.id,'edit',approved.version,{amount:'30',payment_date:businessDate(),note:''}),409);
    const before=await balance();await action(trip.id,approved.id,'delete',approved.version);assert.equal(await balance(),before);
    const trashed=(await payments.list(seed.admin,seed.customerId,trip.id,{deleted:'deleted'})).items[0];
    assert.equal(trashed.restore_credit,false);await action(trip.id,approved.id,'restore',trashed.version);
    assert.equal(await balance(),before);assert.equal((await current(trip.id,approved.id)).reversed,true);
  });

  it('rolls back reversals and details if audit persistence fails and rejects bypass writes',async()=>{
    const trip=await booking(),pending=await submit(trip.id,[]),approved=await payments.approve(seed.admin,seed.customerId,trip.id,pending.id,{});
    const before=await balance();
    await database.db.query(`CREATE FUNCTION fail_history_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='payment.edited' THEN RAISE EXCEPTION 'history audit unavailable'; END IF; RETURN NEW; END; $$`);
    await database.db.query('CREATE TRIGGER fail_history_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_history_audit()');
    try {await assert.rejects(action(trip.id,approved.id,'edit',approved.version,{amount:'30.00',payment_date:businessDate(),note:''}),/history audit unavailable/);}
    finally {await database.db.query('DROP TRIGGER fail_history_audit ON audit_events');await database.db.query('DROP FUNCTION fail_history_audit()');}
    assert.equal(await balance(),before);assert.equal((await current(trip.id,approved.id)).ledger_entry_id,approved.ledger_entry_id);
    assert.equal((await database.db.query('SELECT 1 FROM payment_history_context')).rows.length,0);
    await assert.rejects(database.db.query("UPDATE booking_payments SET deleted_at=now(),deletion_reason='bypass',version=version+1 WHERE id=$1",[approved.id]),/immutable/);
    await assert.rejects(database.db.query('DELETE FROM booking_payments WHERE id=$1',[approved.id]),/immutable/);
    await assert.rejects(database.db.query('SELECT manage_booking_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [seed.customerUserId,seed.orgId,seed.customerId,trip.id,approved.id,approved.version,'delete',2500,businessDate(),'','','bypass']),/administrator|invalid input syntax/);
  });

  it('restores history on cancelled bookings without permitting approval and keeps purge idempotency',async()=>{
    const trip=await booking(),raw={amount:'25.00',payment_date:businessDate(),note:'No attachment',idempotency_key:randomUUID()};
    const pending=await payments.submit(seed.customerMember,seed.customerId,trip.id,raw,[]);
    await action(trip.id,pending.id,'delete',pending.version);
    const trash=(await payments.list(seed.admin,seed.customerId,trip.id,{deleted:'deleted'})).items[0];
    await rejectsStatus(payments.submit(seed.customerMember,seed.customerId,trip.id,raw,[]),409);
    await action(trip.id,pending.id,'permanent-delete',trash.version,{confirmation:'DELETE'});
    await rejectsStatus(payments.submit(seed.customerMember,seed.customerId,trip.id,raw,[]),409);
    const next=await submit(trip.id,[]);await action(trip.id,next.id,'delete',next.version);
    const detail=await bookings.get(seed.admin,seed.customerId,trip.id);
    await management.cancel(seed.admin,seed.customerId,trip.id,{confirmation:trip.reference,expected_version:detail.version,reason:'Cancelled',effective_date:businessDate(),idempotency_key:randomUUID()});
    const deleted=(await payments.list(seed.admin,seed.customerId,trip.id,{deleted:'deleted'})).items[0];
    await action(trip.id,deleted.id,'restore',deleted.version);
    const restored=await current(trip.id,deleted.id);assert.equal(restored.status,'pending');assert.equal(restored.deleted_at,null);
    await rejectsStatus(payments.approve(seed.admin,seed.customerId,trip.id,restored.id,{}),409);
    await action(trip.id,restored.id,'delete',restored.version);
    const retrash=(await payments.list(seed.admin,seed.customerId,trip.id,{deleted:'deleted'})).items[0];
    await action(trip.id,retrash.id,'permanent-delete',retrash.version,{confirmation:'DELETE'});
  });

  it('restores archived or cancelled history without resurrecting credit and still blocks financial restoration',async()=>{
    const trip=await booking(),pending=await submit(trip.id,[]),approved=await payments.approve(seed.admin,seed.customerId,trip.id,pending.id,{});
    await ledger.post(seed.admin,seed.customerId,{kind:'reversal',reversal_of:approved.ledger_entry_id!,effective_date:businessDate(),description:'Already reversed',idempotency_key:randomUUID()});
    await action(trip.id,approved.id,'delete',approved.version);
    const oldReversal=(await payments.list(seed.admin,seed.customerId,trip.id,{deleted:'deleted'})).items[0];assert.equal(oldReversal.restore_credit,false);
    const rejected=await payments.reject(seed.admin,seed.customerId,trip.id,(await submit(trip.id,[])).id,{reason:'Not received'});
    await action(trip.id,rejected.id,'delete',rejected.version);
    const active=await payments.approve(seed.admin,seed.customerId,trip.id,(await submit(trip.id,[])).id,{});
    await action(trip.id,active.id,'delete',active.version);
    const deleted=(await payments.list(seed.admin,seed.customerId,trip.id,{deleted:'deleted'})).items;
    const activeTrash=deleted.find(item=>item.id===active.id)!;assert.equal(activeTrash.restore_credit,true);
    await database.db.query("UPDATE customers SET status='archived' WHERE id=$1",[seed.customerId]);
    const before=await balance();
    try {
      await action(trip.id,oldReversal.id,'restore',oldReversal.version);assert.equal((await current(trip.id,oldReversal.id)).reversed,true);
      const rejectedTrash=deleted.find(item=>item.id===rejected.id)!;
      await action(trip.id,rejectedTrash.id,'restore',rejectedTrash.version);assert.equal((await current(trip.id,rejected.id)).status,'rejected');
      await rejectsStatus(action(trip.id,activeTrash.id,'restore',activeTrash.version),409);assert.equal(await balance(),before);
    } finally {await database.db.query("UPDATE customers SET status='active' WHERE id=$1",[seed.customerId]);}
    const detail=await bookings.get(seed.admin,seed.customerId,trip.id);
    await management.cancel(seed.admin,seed.customerId,trip.id,{confirmation:trip.reference,expected_version:detail.version,reason:'Cancelled',effective_date:businessDate(),idempotency_key:randomUUID()});
    await rejectsStatus(action(trip.id,activeTrash.id,'restore',activeTrash.version),409);
    const reversed=await current(trip.id,oldReversal.id);await action(trip.id,reversed.id,'delete',reversed.version);
    const cancelledTrash=(await payments.list(seed.admin,seed.customerId,trip.id,{deleted:'deleted'})).items.find(item=>item.id===reversed.id)!;
    const afterCancellation=await balance();await action(trip.id,cancelledTrash.id,'restore',cancelledTrash.version);
    assert.equal((await current(trip.id,reversed.id)).reversed,true);assert.equal(await balance(),afterCancellation);
  });

  it('protects private mutation authorization for the nonowner runtime role',{skip:!process.env.TEST_DATABASE_URL},async()=>{
    const trip=await booking(),pending=await submit(trip.id,[]);
    const schema=(await database.db.query('SELECT current_schema() AS name')).rows[0].name as string;
    const role=`payment_runtime_${randomUUID().replaceAll('-','')}`;
    await database.db.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    const runtime=<T>(work:(client:PoolClient)=>Promise<T>)=>database.db.transaction(async client=>{await client.query(`SET LOCAL ROLE "${role}"`);return work(client);});
    try {
      await database.db.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
      await database.db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
      await database.db.query(`REVOKE ALL ON TABLE "${schema}".payment_history_context,"${schema}".account_purge_context FROM "${role}"`);
      await database.db.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${role}"`);
      await database.db.query(`GRANT EXECUTE ON FUNCTION "${schema}".manage_booking_payment(uuid,uuid,uuid,uuid,uuid,integer,text,bigint,date,text,bigint,text) TO "${role}"`);
      await assert.rejects(runtime(client=>client.query('SELECT * FROM payment_history_context')),/permission denied/);
      await assert.rejects(runtime(client=>client.query("SELECT payment_history_allows('booking_payments','DELETE','{}',NULL)")),/permission denied/);
      await assert.rejects(runtime(client=>client.query('DELETE FROM booking_payments WHERE id=$1',[pending.id])),/immutable/);
      const args=[seed.adminId,seed.orgId,seed.customerId,trip.id,pending.id,pending.version,'edit',2700,businessDate(),'Correction',null,'Verified transfer'];
      await assert.rejects(runtime(client=>client.query('SELECT manage_booking_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[seed.customerUserId,...args.slice(1)])),/administrator/);
      await runtime(client=>client.query('SELECT manage_booking_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',args));
      assert.equal((await current(trip.id,pending.id)).amount_minor,'2700');
    } finally {await database.db.query(`DROP OWNED BY "${role}"`);await database.db.query(`DROP ROLE "${role}"`);}
  });
});
