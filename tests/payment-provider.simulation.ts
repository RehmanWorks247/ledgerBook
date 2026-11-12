// Run against the committed Postman simulation; never sends real email.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { config } from '../apps/api/src/config';
import { addDays, businessDate } from '../apps/api/src/dashboard/time';
import { NotificationsService } from '../apps/api/src/notifications/notifications.service';
import { PaymentEmailOutbox } from '../apps/api/src/payments/email-outbox.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { setupTestDatabase } from './helpers';

type OutboxRow = { id:string; recipient:string; subject:string; body:string; dedupe_key:string; state:string;
  attempts:number; delivery_status:string; provider_message_id:string|null; invoice_id:string|null };

async function main() {
  if (config.production || config.nodeEnv!=='test' || config.authProvider!=='local')
    throw new Error('Run this simulation with tests/test-environment.cjs.');
  if (process.env.TEST_DATABASE_URL && !['localhost','127.0.0.1','[::1]'].includes(new URL(process.env.TEST_DATABASE_URL).hostname))
    throw new Error('The simulation requires an isolated local test database.');
  const base='http://127.0.0.1:4017/resend';
  config.emailMode='resend'; config.resendApiKey='simulation-only';
  config.emailFrom='LedgerBook Simulation <no-reply@example.test>';
  const database=await setupTestDatabase();
  try {
    const seed=await database.seed(),access=new AccessService(database.db),today=businessDate();
    await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1",[seed.orgId]);
    const admin=await access.membership(seed.adminId,seed.orgId);
    const customer=await access.membership(seed.customerUserId,seed.orgId);
    const booking=await new BookingsService(database.db,access).create(admin,seed.customerId,{
      reference:`SIM-NOTIFY-${randomUUID()}`,departure_at:`${addDays(today,10)}T12:00:00Z`,required_services:[],
      amount:'100.00',effective_date:today,idempotency_key:randomUUID(),
    });
    const payments=new PaymentsService(database.db,access);
    const accountPayments=new Set<string>();
    async function submit(bookingId:string|null,color:string) {
      const buffer=await sharp({create:{width:30,height:24,channels:3,background:color}}).png().toBuffer();
      const files=[{originalname:'simulation-receipt.png',mimetype:'image/png',buffer,size:buffer.length}];
      const body={amount:'25.00',payment_date:today,note:'Synthetic provider simulation',idempotency_key:randomUUID()};
      const payment=await payments.submit(customer,seed.customerId,bookingId,body,files);
      const replay=await payments.submit(customer,seed.customerId,bookingId,body,files);
      assert.equal(replay.id,payment.id,'submission replay must not queue another notification');
      assert.equal(payment.booking_id,bookingId);
      if(!bookingId)accountPayments.add(payment.id);
      return payment;
    }
    function checkMessage(message:OutboxRow) {
      const adminAlert=message.dedupe_key.startsWith('payment-submitted:');
      const accountPayment=accountPayments.has(message.dedupe_key.split(':')[1]);
      assert.equal(message.recipient,adminAlert?'admin@example.test':'customer@example.test');
      if(accountPayment) {
        assert.match(message.body,/account/i);
        assert.ok(!message.body.includes(booking.reference),'account notices must not claim a booking allocation');
        assert.equal(message.invoice_id,null,'account payments must not issue a booking invoice');
      } else assert.ok(message.body.includes(booking.reference));
      if(!adminAlert) {
        assert.ok(message.body.split(/\s+/).includes(`${config.appUrl}/o/${seed.orgId}`),'customer notices must link to My Account');
        assert.ok(!message.body.includes(`/bookings/${booking.id}`),'payment history now lives on My Account');
      } else assert.ok(message.body.split(/\s+/).includes(accountPayment
        ? `${config.appUrl}/o/${seed.orgId}/payment-reviews?q=${message.dedupe_key.split(':')[1]}`
        : `${config.appUrl}/o/${seed.orgId}/users/${seed.customerId}/bookings/${booking.id}`),'administrator alert must link to a working review page');
      assert.ok(message.body.includes('25.00'));
      if(message.dedupe_key.startsWith('payment-received:')) {
        assert.match(message.body,/verify|review|pending/i);
        assert.match(message.body,/does not credit your account/i);
      }
    }

    const mail=new NotificationsService(`${base}/emails`);
    const worker=new PaymentEmailOutbox(database.db,mail,access,false);
    // Exercise every event independently so each receives its own modeled 500,
    // retry and replay instead of only failing the first message in a batch.
    async function sendWithRetry(message:OutboxRow) {
      checkMessage(message);
      await database.db.query("UPDATE payment_email_outbox SET next_attempt_at=now()+interval '1 day' WHERE state='pending'");
      assert.equal((await fetch(`${base}/_control/reset`,{method:'POST'})).status,200);
      await database.db.query('UPDATE payment_email_outbox SET next_attempt_at=now() WHERE id=$1',[message.id]);
      assert.equal(await worker.flush(),0);
      let row=(await database.db.query<OutboxRow>('SELECT * FROM payment_email_outbox WHERE id=$1',[message.id])).rows[0];
      assert.equal(row.state,'pending'); assert.equal(row.attempts,1);
      await database.db.query('UPDATE payment_email_outbox SET next_attempt_at=now() WHERE id=$1',[message.id]);
      assert.equal(await worker.flush(),1);
      row=(await database.db.query<OutboxRow>('SELECT * FROM payment_email_outbox WHERE id=$1',[message.id])).rows[0];
      assert.equal(row.state,'sent'); assert.equal(row.delivery_status,'accepted'); assert.equal(row.attempts,2);
      assert.equal(row.provider_message_id,'simulated-email-id');
      const invoice=row.invoice_id ? (await database.db.query('SELECT filename,pdf FROM booking_invoices WHERE id=$1',[row.invoice_id])).rows[0] : null;
      await mail.send({to:row.recipient,subject:row.subject,text:row.body,
        ...(invoice ? {attachments:[{filename:invoice.filename,content:Buffer.from(invoice.pdf),contentType:'application/pdf'}]} : {})},
      {idempotencyKey:`payment-email/${row.id}`});
      const state=await (await fetch(`${base}/_control/state`)).json() as {calls:number;accepted:number;keys:string[]};
      assert.equal(state.calls,3); assert.equal(state.accepted,1);
      assert.deepEqual(state.keys,[`payment-email/${row.id}`]);
      console.log(`PASS: ${row.dedupe_key.split(':')[0]} real HTTP 500/retry/replay; one modeled acceptance.`);
    }
    for(const bookingId of [booking.id,null]) for(const decision of ['approved','rejected'] as const) {
      const payment=await submit(bookingId,bookingId ? decision==='approved'?'#225599':'#228855' : decision==='approved'?'#552299':'#882255');
      const list=async()=>(await database.db.query<OutboxRow>('SELECT * FROM payment_email_outbox WHERE dedupe_key LIKE $1 ORDER BY created_at,id',[`%${payment.id}%`])).rows;
      const initial=await list();
      const expectedKeys=[`payment-submitted:${payment.id}:admin@example.test`,`payment-received:${payment.id}:${seed.customerUserId}`];
      assert.deepEqual(initial.map(message=>message.dedupe_key).sort(),expectedKeys.sort());
      // Review alerts are sent while the submission is pending. A never-attempted
      // administrator alert is intentionally cancelled when review is complete.
      for(const message of initial) await sendWithRetry(message);
      const reason='The reported amount does not match this synthetic transfer.';
      if(decision==='approved') {
        await payments.approve(admin,seed.customerId,bookingId,payment.id);
        await payments.approve(admin,seed.customerId,bookingId,payment.id);
        expectedKeys.push(`payment-approved:${payment.id}`);
      } else {
        await payments.reject(admin,seed.customerId,bookingId,payment.id,{reason});
        await payments.reject(admin,seed.customerId,bookingId,payment.id,{reason});
        expectedKeys.push(`payment-rejected:${payment.id}:${seed.customerUserId}`);
      }
      const all=await list();
      assert.deepEqual(all.map(message=>message.dedupe_key).sort(),expectedKeys.sort());
      const reviewed=all.find(message=>message.dedupe_key.startsWith(`payment-${decision}:`));
      assert.ok(reviewed);
      if(decision==='rejected') assert.ok(reviewed.body.includes(reason));
      await sendWithRetry(reviewed);
    }
    assert.equal((await worker.status(admin)).sent,12);
    console.log('PASS: booking and account submission acknowledgments, administrator alerts, approval and rejection; business replays queue no duplicates. Acceptance is not inbox delivery.');
  } finally {await database.close();}
}
void main().catch(error=>{console.error('Payment provider simulation failed.',error);process.exitCode=1;});
