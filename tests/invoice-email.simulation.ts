// Run against the existing committed Postman simulation; never sends real email.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { config } from '../apps/api/src/config';
import { businessDate } from '../apps/api/src/dashboard/time';
import { NotificationsService } from '../apps/api/src/notifications/notifications.service';
import { PaymentEmailOutbox } from '../apps/api/src/payments/email-outbox.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { setupTestDatabase } from './helpers';

type OutboxRow={id:string;recipient:string;subject:string;body:string;invoice_id:string;dedupe_key:string;state:string;attempts:number;delivery_status:string};
async function main() {
  if(config.production || config.nodeEnv!=='test' || config.authProvider!=='local')throw new Error('Use the isolated test environment.');
  if(process.env.TEST_DATABASE_URL && !['localhost','127.0.0.1','[::1]'].includes(new URL(process.env.TEST_DATABASE_URL).hostname))
    throw new Error('This simulation requires an isolated local database.');
  const base='http://127.0.0.1:4029/resend';
  config.emailMode='resend';config.resendApiKey='simulation-only';config.emailFrom='LedgerBook Simulation <no-reply@example.test>';
  const database=await setupTestDatabase();
  try {
    const seed=await database.seed(),access=new AccessService(database.db),today=businessDate();
    await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1",[seed.orgId]);
    const bookings=new BookingsService(database.db,access),payments=new PaymentsService(database.db,access);
    const body={reference:`SIM-INVOICE-${randomUUID()}`,departure_at:'2030-01-01T12:00:00Z',required_services:[],amount:'100.00',effective_date:today,idempotency_key:randomUUID()};
    const booking=await bookings.create(seed.admin,seed.customerId,body);
    assert.equal((await bookings.create(seed.admin,seed.customerId,body)).id,booking.id);
    const confirmation=(await database.db.query<OutboxRow>('SELECT * FROM payment_email_outbox WHERE dedupe_key=$1',[`booking-created:${booking.id}`])).rows[0];
    assert.ok(confirmation?.invoice_id);
    const mail=new NotificationsService(`${base}/emails`),worker=new PaymentEmailOutbox(database.db,mail,access,false);
    const row=async(id:string)=>(await database.db.query<OutboxRow>('SELECT * FROM payment_email_outbox WHERE id=$1',[id])).rows[0];
    async function sendWithRetry(email:OutboxRow,beforeRetry?:()=>Promise<void>) {
      const invoice=(await database.db.query('SELECT filename,pdf FROM booking_invoices WHERE id=$1',[email.invoice_id])).rows[0];
      const content=Buffer.from(invoice.pdf);assert.equal(content.subarray(0,5).toString(),'%PDF-');
      const expectedHash=createHash('sha256').update(content).digest('hex');
      assert.equal((await fetch(`${base}/_control/reset`,{method:'POST'})).status,200);
      await database.db.query("UPDATE payment_email_outbox SET next_attempt_at=now()+interval '1 day' WHERE id<>$1",[email.id]);
      await database.db.query('UPDATE payment_email_outbox SET next_attempt_at=now() WHERE id=$1',[email.id]);
      assert.equal(await worker.flush(),0);assert.equal((await row(email.id)).state,'pending');
      await beforeRetry?.();
      await database.db.query("UPDATE payment_email_outbox SET next_attempt_at=now()+interval '1 day' WHERE id<>$1",[email.id]);
      await database.db.query('UPDATE payment_email_outbox SET next_attempt_at=now() WHERE id=$1',[email.id]);
      assert.equal(await worker.flush(),1);
      const saved=await row(email.id);assert.equal(saved.state,'sent');assert.equal(saved.delivery_status,'accepted');assert.equal(saved.attempts,2);
      await mail.send({to:saved.recipient,subject:saved.subject,text:saved.body,attachments:[{filename:invoice.filename,content,contentType:'application/pdf'}]},
        {idempotencyKey:`payment-email/${saved.id}`});
      const state=await (await fetch(`${base}/_control/state`)).json() as {calls:number;accepted:number;keys:string[];messages:{to:string[];attachments:{filename:string;sha256:string}[]}[]};
      assert.equal(state.calls,3);assert.equal(state.accepted,1);assert.deepEqual(state.keys,[`payment-email/${email.id}`]);
      assert.deepEqual(state.messages,[{to:['customer@example.test'],attachments:[{filename:invoice.filename,sha256:expectedHash}]}]);
      console.log(`PASS: ${email.dedupe_key.split(':')[0]} PDF bytes and filename survived HTTP 500/retry/replay with one modeled acceptance.`);
    }
    let approval:OutboxRow|undefined;
    await sendWithRetry(confirmation,async()=>{
      const buffer=await sharp({create:{width:8,height:8,channels:3,background:'#285'}}).png().toBuffer();
      const payment=await payments.submit(seed.customerMember,seed.customerId,booking.id,{amount:'25.00',payment_date:today,idempotency_key:randomUUID()},
        [{originalname:'receipt.png',mimetype:'image/png',buffer,size:buffer.length}]);
      await payments.approve(seed.admin,seed.customerId,booking.id,payment.id);await payments.approve(seed.admin,seed.customerId,booking.id,payment.id);
      approval=(await database.db.query<OutboxRow>('SELECT * FROM payment_email_outbox WHERE dedupe_key=$1',[`payment-approved:${payment.id}`])).rows[0];
      assert.ok(approval?.invoice_id);assert.notEqual(approval.invoice_id,confirmation.invoice_id);
    });
    assert.ok(approval);await sendWithRetry(approval);
    assert.equal((await database.db.query('SELECT count(*)::int AS count FROM booking_invoices WHERE booking_id=$1',[booking.id])).rows[0].count,2);
    await worker.beforeApplicationShutdown();
    console.log('PASS: booking and approval invoice attachments, immutable retry snapshots, and business idempotency against the local contract stand-in. Inbox delivery was not exercised.');
  } finally {await database.close();}
}
void main().catch(error=>{console.error('Invoice email simulation failed.',error);process.exitCode=1;});
