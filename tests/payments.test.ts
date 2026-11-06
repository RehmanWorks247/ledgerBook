import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { HttpException } from '@nestjs/common';
import sharp from 'sharp';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { businessDate, addDays } from '../apps/api/src/dashboard/time';
import { LedgerService } from '../apps/api/src/ledger/ledger.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

const rejectsStatus = (operation: Promise<unknown>, status: number) => assert.rejects(operation,
  (error: unknown) => error instanceof HttpException && error.getStatus() === status);
let imageSerial = 0;
async function image(format: 'png'|'jpeg'|'webp' = 'png') {
  const color = ++imageSerial;
  const buffer = await sharp({create:{width:32,height:24,channels:3,background:{r:color % 256,g:Math.floor(color / 256) % 256,b:143}}})
    .toFormat(format).toBuffer();
  return {originalname:`receipt-${color}.${format}`,mimetype:`image/${format}`,buffer,size:buffer.length};
}
const request = (overrides: Record<string, unknown> = {}) => ({
  amount:'25.00', payment_date:businessDate(), note:'Bank transfer for this booking', idempotency_key:randomUUID(), ...overrides,
});

describe('booking payment evidence, approvals and transactional notifications', () => {
  let database:TestDatabase;
  let seed:TestSeed;
  let bookings:BookingsService;
  let payments:PaymentsService;
  let ledger:LedgerService;

  before(async () => {
    database = await setupTestDatabase();
    seed = await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP'");
    const access = new AccessService(database.db);
    seed.admin = await access.membership(seed.adminId,seed.orgId);
    seed.otherAdmin = await access.membership(seed.otherAdminId,seed.otherOrgId);
    seed.customerMember = await access.membership(seed.customerUserId,seed.orgId);
    bookings = new BookingsService(database.db,access);
    payments = new PaymentsService(database.db,access);
    ledger = new LedgerService(database.db,access);
  });
  after(async () => { if (database) await database.close(); });

  async function booking(customerId = seed.customerId) {
    return bookings.create(seed.admin,customerId,{
      reference:`PAY-${randomUUID()}`,departure_at:'2030-01-01T12:00:00Z',required_services:[],
      amount:'100.00',effective_date:businessDate(),idempotency_key:randomUUID(),
    });
  }
  const balance = async () => (await ledger.statement(seed.admin,seed.customerId)).current_balance_minor;
  const eventEmails = (paymentId:string) => database.db.query(
    'SELECT recipient,subject,body,dedupe_key FROM payment_email_outbox WHERE dedupe_key LIKE $1 ORDER BY created_at,id', [`%${paymentId}%`]);

  it('stores one or multiple real images in the booking and leaves balances pending manual approval', async () => {
    const trip = await booking();
    const before = await balance();
    const files = await Promise.all([image('png'),image('jpeg'),image('webp')]);
    const payment = await payments.submit(seed.customerMember,seed.customerId,trip.id,request(),files);
    assert.equal(payment.status,'pending');
    assert.equal(payment.amount_minor,'2500');
    assert.equal(payment.currency,'GBP');
    assert.equal(payment.payment_date,businessDate());
    assert.equal(payment.booking_reference,trip.reference);
    assert.equal(payment.customer_id,seed.customerId);
    assert.equal(payment.receipts.length,3);
    assert.equal(payment.ledger_entry_id,null);
    assert.equal(await balance(),before);
    const listing = await payments.list(seed.customerMember,seed.customerId,trip.id);
    assert.equal(listing.items.length,1);
    assert.equal(listing.items[0].id,payment.id);
    for (const file of payment.receipts) {
      const receipt = await payments.receipt(seed.customerMember,seed.customerId,trip.id,payment.id,file.id);
      const metadata = await sharp(receipt.content).metadata();
      assert.equal(metadata.format,'webp');
      assert.equal(metadata.exif,undefined);
      assert.equal(receipt.mime_type,'image/webp');
      assert.equal(receipt.size,receipt.content.length);
      assert.match(file.url,new RegExp(`${trip.id}/payments/${payment.id}/receipts/${file.id}$`));
    }
    const messages = (await eventEmails(payment.id)).rows;
    assert.equal(messages.length,1);
    assert.equal(messages[0].recipient,'admin@example.test');
    assert.ok(messages[0].body.includes(trip.reference));
    assert.ok(messages[0].body.includes('Aster Studio'));
    assert.ok(messages[0].body.includes(businessDate()));
    assert.equal(messages.some(message => message.recipient === 'customer@example.test'),false);
  });

  it('replays the same upload safely and rejects reused keys or evidence with changed contents', async () => {
    const trip = await booking();
    const raw = request();
    const files = [await image()];
    const [first,retry] = await Promise.all([
      payments.submit(seed.customerMember,seed.customerId,trip.id,raw,files),
      payments.submit(seed.customerMember,seed.customerId,trip.id,raw,files),
    ]);
    assert.equal(first.id,retry.id);
    assert.equal((await payments.list(seed.customerMember,seed.customerId,trip.id)).items.length,1);
    assert.equal((await eventEmails(first.id)).rows.length,1);
    await rejectsStatus(payments.submit(seed.customerMember,seed.customerId,trip.id,{...raw,amount:'26.00'},files),409);
    await rejectsStatus(payments.submit(seed.customerMember,seed.customerId,trip.id,raw,[await image()]),409);
    await rejectsStatus(payments.submit(seed.customerMember,seed.customerId,trip.id,request(),files),409);
    await rejectsStatus(payments.submit(seed.customerMember,seed.customerId,trip.id,request(),[files[0],files[0]]),400);
    const anotherTrip = await booking();
    await rejectsStatus(payments.submit(seed.customerMember,seed.customerId,anotherTrip.id,raw,files),409);
  });

  it('approves exactly once under concurrent requests and atomically links the ledger, audit and customer email', async () => {
    const trip = await booking();
    const payment = await payments.submit(seed.customerMember,seed.customerId,trip.id,request(),[await image()]);
    const before = BigInt(await balance());
    const [first,retry] = await Promise.all([
      payments.approve(seed.admin,seed.customerId,trip.id,payment.id,{}),
      payments.approve(seed.admin,seed.customerId,trip.id,payment.id,{}),
    ]);
    assert.equal(first.status,'approved');
    assert.equal(first.ledger_entry_id,retry.ledger_entry_id);
    assert.ok(first.reviewed_at);
    assert.equal(BigInt(await balance()),before - 2500n);
    const entries = await database.db.query('SELECT *, effective_date::text AS date FROM ledger_entries WHERE id=$1',[first.ledger_entry_id]);
    assert.equal(entries.rows[0].amount_minor,'-2500');
    assert.equal(entries.rows[0].kind,'payment');
    assert.equal(entries.rows[0].date,businessDate());
    assert.equal(entries.rows[0].customer_id,seed.customerId);
    assert.equal(entries.rows[0].created_by,seed.adminId);
    const messages = (await eventEmails(payment.id)).rows;
    assert.equal(messages.filter(message => message.recipient === 'customer@example.test').length,1);
    const approvedMessage = messages.find(message => message.recipient === 'customer@example.test')!;
    assert.match(`${approvedMessage.subject} ${approvedMessage.body}`,/approved/i);
    assert.ok(approvedMessage.body.includes(trip.reference));
    assert.ok((await database.db.query('SELECT 1 FROM audit_events WHERE object_id=$1',[payment.id])).rowCount! >= 2);
    await rejectsStatus(payments.reject(seed.admin,seed.customerId,trip.id,payment.id,{reason:'Cannot reject an approved payment'}),409);
    assert.equal((await payments.list(seed.customerMember,seed.customerId,trip.id)).items[0].status,'approved');
  });

  it('keeps rejected evidence visible without crediting the ledger and permits a corrected submission', async () => {
    const trip = await booking();
    const files = [await image()];
    const payment = await payments.submit(seed.customerMember,seed.customerId,trip.id,request(),files);
    const before = await balance();
    await rejectsStatus(payments.reject(seed.admin,seed.customerId,trip.id,payment.id,{reason:' '}),400);
    const rejected = await payments.reject(seed.admin,seed.customerId,trip.id,payment.id,{reason:'Amount does not match the bank transaction.'});
    assert.equal(rejected.status,'rejected');
    assert.equal(rejected.rejection_reason,'Amount does not match the bank transaction.');
    assert.equal(await balance(),before);
    assert.equal(rejected.ledger_entry_id,null);
    await rejectsStatus(payments.approve(seed.admin,seed.customerId,trip.id,payment.id,{}),409);
    assert.ok((await payments.receipt(seed.customerMember,seed.customerId,trip.id,payment.id,payment.receipts[0].id)).content.length);
    const correction = await payments.submit(seed.customerMember,seed.customerId,trip.id,request({amount:'20.00'}),files);
    assert.notEqual(correction.id,payment.id);
    assert.equal(correction.status,'pending');
  });

  it('enforces role, booking, customer and tenant boundaries on every operation', async () => {
    const trip = await booking();
    const otherTrip = await booking();
    const otherCustomerTrip = await booking(seed.secondCustomerId);
    const payment = await payments.submit(seed.customerMember,seed.customerId,trip.id,request(),[await image()]);
    await rejectsStatus(payments.submit(seed.admin,seed.customerId,trip.id,request(),[await image()]),403);
    await rejectsStatus(payments.submit(seed.customerMember,seed.secondCustomerId,otherCustomerTrip.id,request(),[await image()]),404);
    await rejectsStatus(payments.submit(seed.customerMember,seed.customerId,otherCustomerTrip.id,request(),[await image()]),404);
    await rejectsStatus(payments.list(seed.customerMember,seed.secondCustomerId,otherCustomerTrip.id),404);
    await rejectsStatus(payments.list(seed.otherAdmin,seed.customerId,trip.id),404);
    await rejectsStatus(payments.approve(seed.customerMember,seed.customerId,trip.id,payment.id,{}),403);
    await rejectsStatus(payments.reject(seed.customerMember,seed.customerId,trip.id,payment.id,{reason:'Forbidden'}),403);
    await rejectsStatus(payments.approve(seed.otherAdmin,seed.customerId,trip.id,payment.id,{}),404);
    await rejectsStatus(payments.approve(seed.admin,seed.customerId,otherTrip.id,payment.id,{}),404);
    await rejectsStatus(payments.receipt(seed.customerMember,seed.customerId,otherTrip.id,payment.id,payment.receipts[0].id),404);
    await rejectsStatus(payments.receipt(seed.otherAdmin,seed.customerId,trip.id,payment.id,payment.receipts[0].id),404);
    await rejectsStatus(payments.reviewQueue(seed.customerMember),403);
    assert.equal((await payments.reviewQueue(seed.otherAdmin)).items.length,0);
    assert.ok((await payments.reviewQueue(seed.admin)).items.some(item => item.id === payment.id));
    await rejectsStatus(payments.reviewQueue(seed.admin,'unknown'),400);
    assert.equal((await payments.list(seed.customerMember,seed.customerId,trip.id)).items[0].status,'pending');
  });

  it('rechecks archived customers and revoked memberships even when a cached member object is supplied', async () => {
    const trip = await booking();
    const payment = await payments.submit(seed.customerMember,seed.customerId,trip.id,request(),[await image()]);
    await database.db.query("UPDATE customers SET status='archived' WHERE id=$1",[seed.customerId]);
    try {
      await rejectsStatus(payments.submit(seed.customerMember,seed.customerId,trip.id,request(),[await image()]),409);
      await rejectsStatus(payments.approve(seed.admin,seed.customerId,trip.id,payment.id,{}),409);
      assert.equal((await payments.list(seed.customerMember,seed.customerId,trip.id)).items.length,1);
    } finally { await database.db.query("UPDATE customers SET status='active' WHERE id=$1",[seed.customerId]); }
    await database.db.query('UPDATE memberships SET is_active=false WHERE user_id=$1 AND organization_id=$2',[seed.customerUserId,seed.orgId]);
    try {
      await rejectsStatus(payments.list(seed.customerMember,seed.customerId,trip.id),404);
      await rejectsStatus(payments.submit(seed.customerMember,seed.customerId,trip.id,request(),[await image()]),404);
      await rejectsStatus(payments.receipt(seed.customerMember,seed.customerId,trip.id,payment.id,payment.receipts[0].id),404);
    } finally { await database.db.query('UPDATE memberships SET is_active=true WHERE user_id=$1 AND organization_id=$2',[seed.customerUserId,seed.orgId]); }
    await database.db.query('UPDATE memberships SET is_active=false WHERE user_id=$1 AND organization_id=$2',[seed.adminId,seed.orgId]);
    try { await rejectsStatus(payments.approve(seed.admin,seed.customerId,trip.id,payment.id,{}),404); }
    finally { await database.db.query('UPDATE memberships SET is_active=true WHERE user_id=$1 AND organization_id=$2',[seed.adminId,seed.orgId]); }
  });

  it('rejects malformed amounts, dates, filenames, MIME types and images without creating partial records', async () => {
    const trip = await booking();
    const valid = await image();
    for (const overrides of [{amount:'0'},{amount:'-1'},{amount:'1.001'},{amount:25},{payment_date:'2026-02-30'},
      {payment_date:addDays(businessDate(),1)},{idempotency_key:'invalid'},{note:'a'.repeat(1001)},{status:'approved'}]) {
      await rejectsStatus(payments.submit(seed.customerMember,seed.customerId,trip.id,request(overrides),[valid]),400);
    }
    const badImages = [
      {...valid,originalname:'../receipt.png'},
      {...valid,originalname:'receipt\r\nInjected.png'},
      {...valid,mimetype:'image/jpeg'},
      {...valid,originalname:'receipt.svg',mimetype:'image/svg+xml',buffer:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')},
      {...valid,buffer:Buffer.from('not an image')},
      {...valid,buffer:valid.buffer.subarray(0,24)},
      {...valid,buffer:Buffer.alloc(5 * 1024 * 1024 + 1),size:5 * 1024 * 1024 + 1},
    ];
    for (const invalid of badImages) await rejectsStatus(payments.submit(seed.customerMember,seed.customerId,trip.id,request(),[invalid]),400);
    await rejectsStatus(payments.submit(seed.customerMember,seed.customerId,trip.id,request(),[]),400);
    await rejectsStatus(payments.submit(seed.customerMember,seed.customerId,trip.id,request(),await Promise.all(Array.from({length:6},() => image()))),400);
    await rejectsStatus(payments.submit(seed.customerMember,seed.customerId,trip.id,request(),[valid,badImages[4]]),400);
    assert.equal((await payments.list(seed.customerMember,seed.customerId,trip.id)).items.length,0);
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM booking_payment_receipts WHERE booking_id=$1',[trip.id])).rows[0].n,0);
  });

  it('bounds decoded image dimensions and pending submissions to prevent unbounded storage', async () => {
    const trip = await booking();
    const large = await sharp({create:{width:4500,height:4500,channels:3,background:'#fff'}}).png().toBuffer();
    await rejectsStatus(payments.submit(seed.customerMember,seed.customerId,trip.id,request(),[
      {originalname:'too-many-pixels.png',mimetype:'image/png',buffer:large,size:large.length},
    ]),400);
    for (let index = 0; index < 10; index++) {
      await payments.submit(seed.customerMember,seed.customerId,trip.id,request({amount:'1.00'}),[await image()]);
    }
    await rejectsStatus(payments.submit(seed.customerMember,seed.customerId,trip.id,request({amount:'1.00'}),[await image()]),409);
    assert.equal((await payments.list(seed.customerMember,seed.customerId,trip.id)).items.length,10);
  });

  it('rolls submission, receipt and notification writes back together when persistence fails', async () => {
    const trip = await booking();
    const raw = request();
    const files = [await image()];
    await database.db.query(`CREATE FUNCTION payment_test_fail_email() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated payment notification failure'; END; $$;`);
    await database.db.query('CREATE TRIGGER payment_test_fail_email BEFORE INSERT ON payment_email_outbox FOR EACH ROW EXECUTE FUNCTION payment_test_fail_email()');
    try {
      await assert.rejects(payments.submit(seed.customerMember,seed.customerId,trip.id,raw,files),/simulated payment notification failure/);
      assert.equal((await payments.list(seed.customerMember,seed.customerId,trip.id)).items.length,0);
      assert.equal((await database.db.query('SELECT count(*)::int AS n FROM booking_payment_receipts WHERE booking_id=$1',[trip.id])).rows[0].n,0);
    } finally {
      await database.db.query('DROP TRIGGER payment_test_fail_email ON payment_email_outbox');
      await database.db.query('DROP FUNCTION payment_test_fail_email()');
    }
    const payment = await payments.submit(seed.customerMember,seed.customerId,trip.id,raw,files);
    assert.equal(payment.status,'pending');
    assert.equal((await eventEmails(payment.id)).rows.length,1);
  });

  it('rolls approval and ledger writes back together when its email cannot be queued, then retries cleanly', async () => {
    const trip = await booking();
    const payment = await payments.submit(seed.customerMember,seed.customerId,trip.id,request(),[await image()]);
    const before = await balance();
    await database.db.query(`CREATE FUNCTION payment_test_fail_approval_email() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.recipient='customer@example.test' THEN RAISE EXCEPTION 'simulated approval notification failure'; END IF; RETURN NEW; END; $$;`);
    await database.db.query('CREATE TRIGGER payment_test_fail_approval_email BEFORE INSERT ON payment_email_outbox FOR EACH ROW EXECUTE FUNCTION payment_test_fail_approval_email()');
    try {
      await assert.rejects(payments.approve(seed.admin,seed.customerId,trip.id,payment.id,{}),/simulated approval notification failure/);
      const pending = (await payments.list(seed.customerMember,seed.customerId,trip.id)).items[0];
      assert.equal(pending.status,'pending');
      assert.equal(pending.ledger_entry_id,null);
      assert.equal(await balance(),before);
    } finally {
      await database.db.query('DROP TRIGGER payment_test_fail_approval_email ON payment_email_outbox');
      await database.db.query('DROP FUNCTION payment_test_fail_approval_email()');
    }
    assert.equal((await payments.approve(seed.admin,seed.customerId,trip.id,payment.id,{})).status,'approved');
    assert.equal(BigInt(await balance()),BigInt(before)-2500n);
  });

  it('blocks submissions and approval after the booking charge has been reversed', async () => {
    const trip = await booking();
    const payment = await payments.submit(seed.customerMember,seed.customerId,trip.id,request(),[await image()]);
    await ledger.post(seed.admin,seed.customerId,{kind:'reversal',reversal_of:trip.charge_entry_id,
      effective_date:businessDate(),description:'Booking cancelled',idempotency_key:randomUUID()});
    await rejectsStatus(payments.submit(seed.customerMember,seed.customerId,trip.id,request(),[await image()]),409);
    await rejectsStatus(payments.approve(seed.admin,seed.customerId,trip.id,payment.id,{}),409);
    assert.equal((await payments.list(seed.customerMember,seed.customerId,trip.id)).items[0].status,'pending');
  });

  it('enforces evidence and completed-review immutability for direct database callers too', async () => {
    const trip = await booking();
    const emptyId = randomUUID();
    await assert.rejects(database.db.query(`INSERT INTO booking_payments
      (id,organization_id,customer_id,booking_id,amount_minor,payment_date,submitted_by,idempotency_key,request_hash)
      VALUES($1,$2,$3,$4,2500,$5,$6,$7,$8)`,
      [emptyId,seed.orgId,seed.customerId,trip.id,businessDate(),seed.customerUserId,randomUUID(),'0'.repeat(64)]),/receipt evidence/);
    assert.equal((await database.db.query('SELECT 1 FROM booking_payments WHERE id=$1',[emptyId])).rows.length,0);
    const payment = await payments.submit(seed.customerMember,seed.customerId,trip.id,request(),[await image()]);
    const receiptId = payment.receipts[0].id;
    await assert.rejects(database.db.query("UPDATE booking_payments SET note='Altered evidence' WHERE id=$1",[payment.id]),/immutable/);
    await assert.rejects(database.db.query("UPDATE booking_payment_receipts SET name='renamed.webp' WHERE id=$1",[receiptId]));
    await assert.rejects(database.db.query('DELETE FROM booking_payment_receipts WHERE id=$1',[receiptId]));
    await assert.rejects(database.db.query('DELETE FROM booking_payments WHERE id=$1',[payment.id]));
    await payments.approve(seed.admin,seed.customerId,trip.id,payment.id,{});
    await assert.rejects(database.db.query(`INSERT INTO booking_payment_receipts
      (id,organization_id,customer_id,booking_id,payment_id,name,mime_type,size,content,original_sha256)
      SELECT $1,organization_id,customer_id,booking_id,payment_id,name,mime_type,size,content,$2
      FROM booking_payment_receipts WHERE id=$3`,[randomUUID(),'f'.repeat(64),receiptId]),/pending payment/);
    await assert.rejects(database.db.query("UPDATE booking_payments SET status='pending',reviewed_at=NULL,reviewed_by=NULL,ledger_entry_id=NULL WHERE id=$1",[payment.id]),/immutable/);
    assert.equal((await payments.list(seed.customerMember,seed.customerId,trip.id)).items[0].receipts.length,1);
  });
});
