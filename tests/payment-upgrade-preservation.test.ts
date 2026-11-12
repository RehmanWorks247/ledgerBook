import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';
import { setupTestDatabase } from './helpers';

it('upgrades populated migration024 without altering production financial data, evidence, invoices or histories',async()=>{
  const database=await setupTestDatabase({throughMigration:24});
  try {
    const seed=await database.seed(),booking=randomUUID(),approved=randomUUID(),pending=randomUUID(),hash='a'.repeat(64);
    await database.db.query("UPDATE organizations SET currency='GBP'");
    await database.db.transaction(async client=>{
      const charge=await client.query(`INSERT INTO ledger_entries(organization_id,customer_id,kind,amount_minor,currency,effective_date,description,created_by,idempotency_key,request_hash)
        VALUES($1,$2,'charge',10000,'GBP','2026-01-01','Preserved booking charge',$3,$4,$5) RETURNING id`,[seed.orgId,seed.customerId,seed.adminId,randomUUID(),hash]);
      await client.query(`INSERT INTO bookings(id,organization_id,customer_id,reference,departure_at,total_minor,charge_entry_id,created_by,idempotency_key,request_hash,instalment_total_minor)
        VALUES($1,$2,$3,'PRESERVED-BOOKING','2030-01-01',10000,$4,$5,$6,$7,10000)`,[booking,seed.orgId,seed.customerId,charge.rows[0].id,seed.adminId,randomUUID(),hash]);
      await client.query(`INSERT INTO booking_instalments(id,organization_id,customer_id,booking_id,due_date,amount_minor)
        VALUES($1,$2,$3,$4,'2026-01-01',10000)`,[randomUUID(),seed.orgId,seed.customerId,booking]);
      const receipt=Buffer.from('%PDF-1.4\nPreserved immutable receipt\n%%EOF');
      for(const payment of [approved,pending]) {
        await client.query(`INSERT INTO booking_payments(id,organization_id,customer_id,booking_id,amount_minor,payment_date,note,submitted_by,idempotency_key,request_hash)
          VALUES($1,$2,$3,$4,2500,'2026-01-01','Preserved customer evidence',$5,$6,$7)`,[payment,seed.orgId,seed.customerId,booking,seed.customerUserId,randomUUID(),hash]);
        await client.query(`INSERT INTO booking_payment_receipts(id,organization_id,customer_id,booking_id,payment_id,name,mime_type,size,content,original_sha256)
          VALUES($1,$2,$3,$4,$5,'receipt.pdf','application/pdf',$6,$7,$8)`,[randomUUID(),seed.orgId,seed.customerId,booking,payment,receipt.length,receipt,hash]);
      }
      const payment=await client.query(`INSERT INTO ledger_entries(organization_id,customer_id,kind,amount_minor,currency,effective_date,description,created_by,idempotency_key,request_hash)
        VALUES($1,$2,'payment',-2500,'GBP','2026-01-01','Preserved approved payment',$3,$4,$5) RETURNING id`,[seed.orgId,seed.customerId,seed.adminId,randomUUID(),hash]);
      await client.query("UPDATE booking_payments SET status='approved',reviewed_by=$1,reviewed_at=now(),ledger_entry_id=$2 WHERE id=$3",[seed.adminId,payment.rows[0].id,approved]);
      const pdf=Buffer.from('%PDF-1.4\nPreserved immutable invoice\n%%EOF');
      await client.query(`INSERT INTO booking_invoices(id,organization_id,customer_id,booking_id,invoice_number,version,reason,event_key,issued_at,total_minor,paid_minor,balance_minor,currency,status,filename,snapshot,pdf)
        VALUES($1,$2,$3,$4,'PRESERVED-INVOICE',1,'payment_approved','preserved',now(),10000,2500,7500,'GBP','partially_paid',$5,$6,$7)`,
      [randomUUID(),seed.orgId,seed.customerId,booking,`inv-${booking.replaceAll('-','')}-v1.pdf`,JSON.stringify({total_minor:'10000',paid_minor:'2500',balance_minor:'7500',fixture:'preserved'}),pdf]);
      await client.query("INSERT INTO audit_events(organization_id,actor_id,action,object_id,metadata) VALUES($1,$2,'payment.approved',$3,$4)",
        [seed.orgId,seed.adminId,approved,JSON.stringify({customer_id:seed.customerId,booking_id:booking,amount_minor:'2500'})]);
    });
    const tables=['organizations','customers','memberships','bookings','booking_instalments','booking_payments','booking_payment_receipts','ledger_entries','booking_invoices','audit_events'];
    const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>{
      const omit=table==='booking_payments'?['source','version','deleted_at','deletion_reason','restore_credit']
        :table==='booking_instalments'?['payment_id','is_reminder']:table==='bookings'?['schedule_basis','reminder_paid_baseline_minor','reminder_payment_baseline']:[];
      return [table,(await database.db.query(`SELECT to_jsonb(t)-$1::text[] AS row FROM ${table} t ORDER BY id`,[omit])).rows.map(row=>row.row)];
    })));
    const before=await snapshot();
    for(const migration of ['025_booking_paid_instalments.sql','026_payment_history_management.sql','027_booking_reminders.sql','028_account_payments.sql'])
      await database.applyMigration(await readFile(`apps/api/src/database/migrations/${migration}`,'utf8'));
    assert.deepEqual(await snapshot(),before);
    assert.deepEqual((await database.db.query('SELECT schedule_basis,reminder_paid_baseline_minor::text,reminder_payment_baseline FROM bookings')).rows,
      [{schedule_basis:'legacy',reminder_paid_baseline_minor:'0',reminder_payment_baseline:{}}]);
    assert.equal((await database.db.query('SELECT is_reminder FROM booking_instalments')).rows[0].is_reminder,false);
    assert.deepEqual((await database.db.query('SELECT source,version,deleted_at,deletion_reason,restore_credit FROM booking_payments ORDER BY id')).rows,
      Array.from({length:2},()=>({source:'customer_receipt',version:1,deleted_at:null,deletion_reason:null,restore_credit:null})));
    assert.equal((await database.db.query('SELECT sum(amount_minor)::text AS balance FROM ledger_entries WHERE customer_id=$1',[seed.customerId])).rows[0].balance,'7500');
    assert.equal((await database.db.query('SELECT 1 FROM payment_history_context')).rows.length,0);
    // During rolling deployment an old application instance can still review;
    // the trigger supplies the new version without touching any other history.
    await database.db.transaction(async client=>{
      const entry=await client.query(`INSERT INTO ledger_entries(organization_id,customer_id,kind,amount_minor,currency,effective_date,description,created_by,idempotency_key,request_hash)
        VALUES($1,$2,'payment',-2500,'GBP','2026-01-01','Old application approval',$3,$4,$5) RETURNING id`,[seed.orgId,seed.customerId,seed.adminId,randomUUID(),hash]);
      await client.query("UPDATE booking_payments SET status='approved',reviewed_by=$1,reviewed_at=now(),ledger_entry_id=$2 WHERE id=$3",[seed.adminId,entry.rows[0].id,pending]);
    });
    assert.equal((await database.db.query('SELECT version FROM booking_payments WHERE id=$1',[pending])).rows[0].version,2);
  } finally {await database.close();}
});
