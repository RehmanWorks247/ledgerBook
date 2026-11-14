// Real application services and HTTP adapter against the committed local Resend stand-in.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AccessService } from '../apps/api/src/access/access.service';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { config } from '../apps/api/src/config';
import { businessDate } from '../apps/api/src/dashboard/time';
import { InvitationService } from '../apps/api/src/invitations/invitation.service';
import { EmailDeliveryService } from '../apps/api/src/notifications/email-delivery.service';
import { NotificationsService } from '../apps/api/src/notifications/notifications.service';
import { ReminderService } from '../apps/api/src/notifications/reminder.service';
import { PaymentEmailOutbox } from '../apps/api/src/payments/email-outbox.service';
import { setupTestDatabase,testPassword } from './helpers';

async function main() {
  assert.equal(config.nodeEnv,'test');assert.equal(config.authProvider,'local');assert.equal(config.production,false);
  if(process.env.TEST_DATABASE_URL && !['localhost','127.0.0.1','[::1]'].includes(new URL(process.env.TEST_DATABASE_URL).hostname)) throw new Error('Use an isolated local database.');
  const base='http://127.0.0.1:4017/resend';
  config.emailMode='resend';config.resendApiKey='simulation-only';config.emailFrom='Simulation <no-reply@example.test>';
  const database=await setupTestDatabase();
  try {
    const seed=await database.seed(),access=new AccessService(database.db);
    await database.db.query("UPDATE organizations SET currency='GBP'");
    const admin=await access.membership(seed.adminId,seed.orgId),departure=new Date(Date.now()+5*24*3600_000);
    await new BookingsService(database.db,access).create(admin,seed.customerId,{reference:randomUUID(),amount:'100',departure_at:departure.toISOString(),
      effective_date:businessDate(),required_services:[],idempotency_key:randomUUID()});
    const mail=new NotificationsService(`${base}/emails`),reminders=new ReminderService(database.db,access,mail,new EmailDeliveryService(database.db),false);
    async function retry(table:'reminder_email_outbox'|'payment_email_outbox',id:string,flush:()=>Promise<number>) {
      assert.equal((await fetch(`${base}/_control/reset`,{method:'POST'})).status,200);
      assert.equal(await flush(),0);
      let row=(await database.db.query(`SELECT * FROM ${table} WHERE id=$1`,[id])).rows[0];
      assert.equal(row.state,'pending');assert.equal(row.attempts,1);
      await database.db.query(`UPDATE ${table} SET next_attempt_at=now() WHERE id=$1`,[id]);
      assert.equal(await flush(),1);
      row=(await database.db.query(`SELECT * FROM ${table} WHERE id=$1`,[id])).rows[0];
      assert.equal(row.state,'sent');assert.equal(row.delivery_status,'accepted');
      const key=`${table==='reminder_email_outbox'?'reminder':'payment'}-email/${id}`;
      await mail.send({to:row.recipient,subject:row.subject,text:row.body},{idempotencyKey:key});
      const state=await (await fetch(`${base}/_control/state`)).json() as {calls:number;accepted:number;keys:string[]};
      assert.equal(state.calls,3);assert.equal(state.accepted,1);assert.deepEqual(state.keys,[key]);
      return row;
    }
    for(const hours of [72,6]) {
      const now=new Date(departure.getTime()-hours*3600_000);
      assert.equal(await reminders.scheduleDepartures(now),1);
      const row=(await database.db.query("SELECT id FROM reminder_email_outbox WHERE state='pending'")).rows[0];
      const sent=await retry('reminder_email_outbox',row.id,()=>reminders.deliver(now));
      assert.equal(sent.recipient,'customer@example.test');assert.match(sent.body,hours===72?/luggage/:/taxi.*airport/);
      assert.equal(await reminders.scheduleDepartures(now),0);
      console.log(`PASS: departure ${hours} hours; 500/retry/replay, stable key, one modeled acceptance.`);
    }
    assert.equal(await reminders.scheduleDepartures(departure),0);assert.equal(await reminders.deliver(departure),0);
    await database.db.query("UPDATE payment_email_outbox SET next_attempt_at=now()+interval '1 day' WHERE state='pending'");
    const capture=new NotificationsService();let token='';
    capture.send=async message=>{token=message.text.match(/#([A-Za-z0-9_-]{43})/)?.[1]??'';};
    const invitations=new InvitationService(database.db,access,new AuthService(database.db,capture),capture);
    const invitation=await invitations.invite(admin,seed.secondCustomerId);assert.ok(token);
    await invitations.accept(token,undefined,testPassword);
    await assert.rejects(invitations.accept(token,undefined,testPassword),/already been accepted/);
    const alerts=(await database.db.query("SELECT id FROM payment_email_outbox WHERE dedupe_key LIKE 'invitation-accepted:%'")).rows;
    assert.equal(alerts.length,1);
    const worker=new PaymentEmailOutbox(database.db,mail,access,false);
    const sent=await retry('payment_email_outbox',alerts[0].id,()=>worker.flush());
    assert.equal(sent.recipient,'admin@example.test');assert.match(sent.body,/just accepted/);assert.ok(sent.dedupe_key.includes(invitation.id));
    console.log('PASS: invitation acceptance admin alert; 500/retry/replay, stable key, one modeled acceptance; repeated acceptance queues nothing.');
  } finally {await database.close();}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
