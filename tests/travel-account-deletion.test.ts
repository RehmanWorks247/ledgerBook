import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import sharp from 'sharp';
import { AccessService, type Membership } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { AccountDeletionService } from '../apps/api/src/users/account-deletion.service';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

describe('merged travel records and permanent account deletion', () => {
  let context:TestDatabase;
  let seed:TestSeed;
  let access:AccessService;
  let bookings:BookingsService;
  let payments:PaymentsService;
  let deletion:AccountDeletionService;
  let serial=0;
  before(async () => {
    context=await setupTestDatabase(); seed=await context.seed(); access=new AccessService(context.db);
    await context.db.query("UPDATE organizations SET currency='GBP'");
    seed.admin=await access.membership(seed.adminId,seed.orgId);
    seed.customerMember=await access.membership(seed.customerUserId,seed.orgId);
    bookings=new BookingsService(context.db,access); payments=new PaymentsService(context.db,access);
    deletion=new AccountDeletionService(context.db,access);
  });
  after(async () => context?.close());
  async function booking(actor:Membership=seed.admin,customerId=seed.customerId) {
    return bookings.create(actor,customerId,{reference:`PURGE-${randomUUID()}`,departure_at:'2030-01-01T12:00:00Z',
      required_services:['flight'],amount:'100.00',effective_date:'2026-01-01',idempotency_key:randomUUID()});
  }
  async function payment(bookingId:string) {
    const bytes=await sharp({create:{width:4,height:4,channels:3,background:{r:++serial,g:18,b:42}}}).png().toBuffer();
    return payments.submit(seed.customerMember,seed.customerId,bookingId,
      {amount:'25.00',payment_date:'2026-01-01',idempotency_key:randomUUID()},
      [{originalname:'proof.png',mimetype:'image/png',buffer:bytes,size:bytes.length}]);
  }

  it('anonymizes deleted administrators on bookings, documents and reviews while preserving customer money and evidence',async () => {
    const id=randomUUID(),membershipId=randomUUID(),email=`${id}@example.test`;
    await context.db.query('INSERT INTO users(id,email) VALUES($1,$2)',[id,email]);
    await context.db.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'admin')",[membershipId,seed.orgId,id]);
    const admin=await access.membership(id,seed.orgId);
    await context.db.query("INSERT INTO exchange_rate_overrides(organization_id,currency,rate,updated_by) VALUES($1,'PKR',350,$2)",[seed.orgId,id]);
    const rateBefore=(await context.db.query('SELECT * FROM exchange_rate_overrides WHERE updated_by=$1',[id])).rows[0];
    const trip=await booking(admin);
    const evidence=await payment(trip.id);
    const approved=await payments.approve(admin,seed.customerId,trip.id,evidence.id);
    const rejected=await payment(trip.id);
    await payments.reject(admin,seed.customerId,trip.id,rejected.id,{reason:'Not received'});
    const folder=(await bookings.files(admin,seed.customerId,trip.id)).items[0];
    const content=Buffer.from('%PDF-1.4\n%%EOF\n');
    const file=await bookings.upload(admin,seed.customerId,trip.id,folder.id,'ticket.pdf',randomUUID(),content);
    const before=(await context.db.query('SELECT * FROM booking_payments WHERE id=$1',[approved.id])).rows[0];
    await assert.rejects(context.db.query('UPDATE booking_payments SET reviewed_by=NULL WHERE id=$1',[approved.id]),/immutable/);
    await assert.rejects(context.db.query('UPDATE bookings SET created_by=NULL WHERE id=$1',[trip.id]),/immutable/);
    await deletion.removeMembership(seed.admin,membershipId,email);
    assert.equal((await context.db.query('SELECT id FROM users WHERE id=$1',[id])).rowCount,0);
    assert.equal((await bookings.get(seed.admin,seed.customerId,trip.id)).created_by,null);
    assert.deepEqual((await context.db.query("SELECT * FROM exchange_rate_overrides WHERE organization_id=$1 AND currency='PKR'",[seed.orgId])).rows[0],{...rateBefore,updated_by:null});
    assert.equal((await context.db.query('SELECT created_by FROM booking_nodes WHERE id=$1',[file.id])).rows[0].created_by,null);
    assert.deepEqual((await bookings.document(seed.customerMember,seed.customerId,trip.id,file.id)).content,content);
    assert.deepEqual((await context.db.query('SELECT * FROM booking_payments WHERE id=$1',[approved.id])).rows[0],{...before,reviewed_by:null});
    assert.equal((await context.db.query('SELECT reviewed_by FROM booking_payments WHERE id=$1',[rejected.id])).rows[0].reviewed_by,null);
    assert.equal((await payments.list(seed.customerMember,seed.customerId,trip.id)).items.length,2);
    assert.equal((await context.db.query('SELECT amount_minor::text AS amount,created_by FROM ledger_entries WHERE id=$1',[approved.ledger_entry_id])).rows[0].amount,'-2500');
    await assert.rejects(context.db.query('UPDATE booking_payments SET reviewed_by=$1 WHERE id=$2',[seed.adminId,approved.id]),/immutable/);
    await assert.rejects(context.db.query('DELETE FROM booking_payment_receipts WHERE payment_id=$1',[approved.id]),/cannot be edited or deleted/);
    // Existing bookings remain repairable after their creator has been removed.
    await context.db.query('SELECT ensure_booking_folders($1)',[trip.id]);
    assert.equal((await context.db.query('SELECT * FROM account_purge_context')).rowCount,0);
  });

  it('deletes customer trips, schedules, nested documents, pending and approved receipts, ledger and queued mail without touching another customer',async () => {
    const trip=await booking();
    const retained=await booking(seed.admin,seed.secondCustomerId);
    const evidence=await payment(trip.id);
    await payments.approve(seed.admin,seed.customerId,trip.id,evidence.id);
    await payment(trip.id);
    const folder=(await bookings.files(seed.admin,seed.customerId,trip.id)).items[0];
    const nested=await bookings.createFolder(seed.admin,seed.customerId,trip.id,{name:'Nested',parent_id:folder.id,idempotency_key:randomUUID()});
    await bookings.upload(seed.admin,seed.customerId,trip.id,nested.id,'document.pdf',randomUUID(),Buffer.from('%PDF-1.4\n%%EOF\n'));
    await context.db.query(`INSERT INTO payment_email_outbox(organization_id,recipient,subject,body,dedupe_key)
      VALUES($1,'beacon@example.test','Keep this','Other customer notification',$2)`,[seed.orgId,`retained-${randomUUID()}`]);
    await deletion.removeCustomer(seed.admin,seed.customerId,'customer@example.test');
    for(const table of ['bookings','booking_instalments','booking_nodes','booking_payments','booking_payment_receipts','document_objects','ledger_entries','memberships','invitations']) {
      assert.equal((await context.db.query(`SELECT 1 FROM ${table} WHERE customer_id=$1`,[seed.customerId])).rowCount,0,table);
    }
    assert.equal((await context.db.query('SELECT id FROM users WHERE id=$1',[seed.customerUserId])).rowCount,0);
    assert.equal((await context.db.query('SELECT id FROM audit_events WHERE metadata->>\'customer_id\'=$1',[seed.customerId])).rowCount,0);
    assert.equal((await context.db.query('SELECT recipient FROM payment_email_outbox')).rowCount,1);
    assert.equal((await bookings.get(seed.admin,seed.secondCustomerId,retained.id)).total_minor,'10000');
    await assert.rejects(context.db.query('DELETE FROM ledger_entries WHERE id=$1',[retained.charge_entry_id]),/cannot be edited or deleted/);
    assert.equal((await context.db.query('SELECT * FROM account_purge_context')).rowCount,0);
  });
});

it('upgrades either previously deployed migration history without changing its existing migrations',async () => {
  const directory=resolve('apps/api/src/database/migrations');
  const names=(await readdir(directory)).filter(name=>/^\d+.*\.sql$/.test(name)).sort();
  const clerk=new Set(['001_initial.sql','002_clerk_accounts.sql','003_stable_clerk_identity.sql','004_permanent_account_deletion.sql']);
  const travel=names.filter(name=>name<'009_'&&(!clerk.has(name)||name==='001_initial.sql'));
  for(const prior of [names.filter(name=>clerk.has(name)),travel]) {
    const engine=new PGlite();
    try {
      for(const name of [...prior,...names.filter(name=>!prior.includes(name))]) await engine.exec(await readFile(resolve(directory,name),'utf8'));
      const result=await engine.query<{name:string}>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public'");
      for(const name of ['users','bookings','booking_payments','account_purge_context','document_purge_outbox']) {
        assert.ok(result.rows.some(row=>row.name===name),`${prior.join(',')}: ${name}`);
      }
    } finally { await engine.close(); }
  }
});
