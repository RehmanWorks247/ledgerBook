// Local Postman contract simulation only. Never sends real email.
import assert from 'node:assert/strict';
import { createHmac,randomUUID } from 'node:crypto';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { config } from '../apps/api/src/config';
import { businessDate,addDays } from '../apps/api/src/dashboard/time';
import { EmailDeliveryService,parseResendWebhook } from '../apps/api/src/notifications/email-delivery.service';
import { NotificationsService } from '../apps/api/src/notifications/notifications.service';
import { ReminderService } from '../apps/api/src/notifications/reminder.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { setupTestDatabase } from './helpers';

async function main() {
  if(config.production)throw new Error('Simulation is disabled in production.');
  const base='http://127.0.0.1:4017/resend';
  assert.equal((await fetch(`${base}/_control/reset`,{method:'POST'})).status,200);
  config.emailMode='resend';config.resendApiKey='simulation-only';
  const database=await setupTestDatabase();
  try {
    const seed=await database.seed(),access=new AccessService(database.db),today=businessDate(new Date(),'UTC');
    await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1",[seed.orgId]);
    const member=await access.membership(seed.adminId,seed.orgId);
    const bookings=new BookingsService(database.db,access);
    const booking=await bookings.create(member,seed.customerId,{reference:`SIM-${randomUUID()}`,departure_at:`${addDays(today,10)}T12:00:00Z`,
      required_services:['makkah'],amount:'100',effective_date:addDays(today,-2),schedule_basis:'reminders',
      instalments:[{due_date:addDays(today,-1),amount:'100'}],idempotency_key:randomUUID()});
    await new PaymentsService(database.db,access).record(member,seed.customerId,booking.id,
      {amount:'40',payment_date:addDays(today,-1),idempotency_key:randomUUID()});
    const updated=await bookings.get(member,seed.customerId,booking.id);
    assert.equal(updated.schedule_basis,'reminders');assert.equal(updated.paid_minor,'4000');assert.equal(updated.remaining_minor,'6000');
    assert.equal(updated.instalments[0].remaining_minor,'6000');
    const delivery=new EmailDeliveryService(database.db),mail=new NotificationsService(`${base}/emails`),worker=new ReminderService(database.db,access,mail,delivery,false);
    await worker.updateSettings(member,{enabled:true,due_soon_days:3,repeat_days:7,send_hour:0,time_zone:'UTC'});
    assert.equal(await worker.schedule(),1);assert.equal(await worker.deliver(),0);
    let row=(await database.db.query('SELECT * FROM reminder_email_outbox')).rows[0];
    assert.equal(row.state,'pending');assert.equal(row.attempts,1);
    await database.db.query('UPDATE reminder_email_outbox SET next_attempt_at=now()');
    assert.equal(await worker.deliver(),1);row=(await database.db.query('SELECT * FROM reminder_email_outbox')).rows[0];
    assert.equal(row.delivery_status,'accepted');assert.equal(row.provider_message_id,'simulated-email-id');
    await mail.send({to:row.recipient,subject:row.subject,text:row.body},{idempotencyKey:`reminder-email/${row.id}`});
    const state=await (await fetch(`${base}/_control/state`)).json() as {calls:number;accepted:number;keys:string[]};
    assert.equal(state.calls,3);assert.equal(state.accepted,1);assert.deepEqual(state.keys,[`reminder-email/${row.id}`]);
    const secret=Buffer.from('simulation-only-webhook-secret-32-bytes'),id=`msg_${randomUUID()}`,timestamp=String(Math.floor(Date.now()/1000));
    const body=Buffer.from(JSON.stringify({type:'email.delivered',created_at:new Date().toISOString(),data:{email_id:row.provider_message_id}}));
    const signature=createHmac('sha256',secret).update(`${id}.${timestamp}.`).update(body).digest('base64');
    await delivery.ingest(parseResendWebhook(body,{'svix-id':id,'svix-timestamp':timestamp,'svix-signature':`v1,${signature}`},`whsec_${secret.toString('base64')}`));
    assert.equal((await worker.history(member)).summary.delivered,1);
    console.log('PASS: reminder-only booking and separate payment leave the correct outstanding reminder; real HTTP adapter retains/retries 500 with stable key; one modeled send; provider ID correlated to signed synthetic delivery event.');
  } finally {await database.close();}
}
void main().catch(()=>{console.error('Reminder provider simulation failed.');process.exitCode=1;});
