import assert from 'node:assert/strict';
import { createHmac,randomUUID } from 'node:crypto';
import { afterEach,beforeEach,describe,it } from 'node:test';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { LedgerService } from '../apps/api/src/ledger/ledger.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { AccountDeletionService } from '../apps/api/src/users/account-deletion.service';
import { EmailDeliveryService,parseResendWebhook,verifyResendSignature } from '../apps/api/src/notifications/email-delivery.service';
import { NotificationsService } from '../apps/api/src/notifications/notifications.service';
import { ReminderService } from '../apps/api/src/notifications/reminder.service';
import { addDays,businessDate } from '../apps/api/src/dashboard/time';
import { setupTestDatabase,type TestDatabase,type TestSeed } from './helpers';

const secret=`whsec_${Buffer.from('test-only-signing-key-at-least-32-bytes').toString('base64')}`;
const today=businessDate(new Date(),'UTC');
const scanDate=new Date(`${today}T18:00:00Z`);
const settings={enabled:true,due_soon_days:3,repeat_days:7,send_hour:0,time_zone:'UTC'};
export function signedEvent(type:string,providerId:string,id=`msg_${randomUUID()}`,at=new Date().toISOString()) {
  const body=Buffer.from(JSON.stringify({type,created_at:at,data:{email_id:providerId,from:'Ledger <sender@example.test>',to:['customer@example.test'],subject:'Payment reminder'}}));
  const timestamp=String(Math.floor(Date.now()/1000));
  const signature=createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(`${id}.${timestamp}.`).update(body).digest('base64');
  return {body,headers:{'svix-id':id,'svix-timestamp':timestamp,'svix-signature':`v1,${signature}`}};
}

describe('verified Resend webhook signatures',()=>{
  it('matches the official Svix test vector and multiple signature rotation header',()=>{
    const headers={'svix-id':'msg_loFOjxBNrRLzqYUf','svix-timestamp':'1731705121','svix-signature':'v2,ignored v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0='};
    assert.equal(verifyResendSignature(Buffer.from('{"event_type":"ping","data":{"success":true}}'),headers,'whsec_plJ3nmyCDGBKInavdOK15jsl',1731705121000),headers['svix-id']);
  });
  it('rejects forged bodies, identifiers, missing headers, stale and future signatures',()=>{
    const event=signedEvent('email.delivered','provider-1');
    assert.equal(parseResendWebhook(event.body,event.headers,secret)?.status,'delivered');
    assert.throws(()=>parseResendWebhook(Buffer.concat([event.body,Buffer.from(' ')]),event.headers,secret),/signature/);
    assert.throws(()=>parseResendWebhook(event.body,{...event.headers,'svix-id':'forged'},secret),/signature/);
    assert.throws(()=>parseResendWebhook(event.body,{},secret),/signature/);
    assert.throws(()=>parseResendWebhook(event.body,event.headers,secret,Date.now()+301_000),/signature/);
    assert.throws(()=>parseResendWebhook(event.body,event.headers,secret,Date.now()-301_000),/signature/);
    assert.throws(()=>parseResendWebhook(event.body,event.headers,undefined),/not configured/);
  });
});

describe('automatic reminders and delivery tracking',()=>{
  let database:TestDatabase,seed:TestSeed,access:AccessService,bookings:BookingsService,reminders:ReminderService,delivery:EmailDeliveryService,mail:NotificationsService;
  let calls:{key:string;body:string}[];
  beforeEach(async()=>{
    database=await setupTestDatabase();seed=await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1",[seed.orgId]);
    access=new AccessService(database.db);seed.admin=await access.membership(seed.adminId,seed.orgId);
    mail=new NotificationsService();delivery=new EmailDeliveryService(database.db);calls=[];
    mail.send=async(message,options)=>{calls.push({key:options!.idempotencyKey!,body:message.text});return {providerMessageId:`provider-${options!.idempotencyKey!.split('/')[1]}`};};
    bookings=new BookingsService(database.db,access);reminders=new ReminderService(database.db,access,mail,delivery,false);
  });
  afterEach(async()=>{await reminders?.beforeApplicationShutdown();await database?.close();});
  const makeBooking=async(customerId=seed.customerId)=>bookings.create(seed.admin,customerId,{reference:`TRIP-${randomUUID()}`,
    departure_at:`${addDays(today,14)}T12:00:00Z`,required_services:['makkah'],amount:'100',effective_date:addDays(today,-4),
    instalments:[{due_date:addDays(today,-1),amount:'40'},{due_date:addDays(today,2),amount:'60'}],idempotency_key:randomUUID()});
  async function queued(){return (await database.db.query('SELECT * FROM reminder_email_outbox ORDER BY created_at,id')).rows;}
  async function enable(){await reminders.updateSettings(seed.admin,settings);}

  it('defaults to off and validates admin-only settings and own-customer preferences',async()=>{
    await makeBooking();assert.equal((await reminders.settings(seed.admin)).enabled,false);
    assert.equal(await reminders.schedule(scanDate),0);assert.equal(calls.length,0);
    await assert.rejects(reminders.updateSettings(seed.customerMember,settings),/administrator/);
    await assert.rejects(reminders.updateSettings(seed.admin,{...settings,repeat_days:0}),/Bad Request/);
    await assert.rejects(reminders.updateSettings(seed.admin,{...settings,time_zone:'Not/AZone'}),/Bad Request/);
    await assert.rejects(reminders.preference(seed.customerMember,seed.secondCustomerId),/not found/);
    assert.equal((await reminders.preference(seed.customerMember,seed.customerId,{enabled:false})).enabled,false);
    assert.equal((await reminders.settings(seed.otherAdmin)).enabled,false);
  });

  it('queues only one oldest unpaid instalment per customer and enforces daily scans plus repeat interval',async()=>{
    await makeBooking();await makeBooking();await enable();
    assert.equal(await reminders.schedule(scanDate),1);assert.equal(await reminders.schedule(scanDate),0);
    assert.equal(await reminders.deliver(),1);assert.equal(await reminders.deliver(),0);
    const row=(await queued())[0];assert.equal(row.state,'sent');assert.equal(row.delivery_status,'accepted');assert.ok(row.provider_message_id);
    assert.equal(await reminders.schedule(new Date(`${addDays(today,1)}T18:00:00Z`)),0);
    assert.equal(await reminders.schedule(new Date(`${addDays(today,7)}T18:00:00Z`)),1);
    assert.match(calls[0].body,/current account balance/);
    assert.equal((await reminders.history(seed.admin)).summary.sent,1);
  });

  it('respects local send hour and never runs an organization twice across workers',async()=>{
    await makeBooking();await reminders.updateSettings(seed.admin,{...settings,send_hour:9,time_zone:'Asia/Karachi'});
    assert.equal(await reminders.schedule(new Date(`${today}T03:00:00Z`)),0);
    const second=new ReminderService(database.db,access,mail,delivery,false);
    const counts=await Promise.all([reminders.schedule(new Date(`${today}T04:00:00Z`)),second.schedule(new Date(`${today}T04:00:00Z`))]);
    assert.equal(counts.reduce((sum,value)=>sum+value,0),1);
    await Promise.all([reminders.deliver(),second.deliver()]);assert.equal(calls.length,1);
  });

  it('suppresses queued and future booking reminders once independent account payments settle the whole account',async()=>{
    for(let index=0;index<2;index++) await bookings.create(seed.admin,seed.customerId,{reference:`ACCOUNT-REMINDER-${randomUUID()}`,
      departure_at:`${addDays(today,14)}T12:00:00Z`,required_services:[],amount:'100',effective_date:addDays(today,-4),
      schedule_basis:'reminders',instalments:[{due_date:addDays(today,-1),amount:'100'}],idempotency_key:randomUUID()});
    await enable();assert.equal(await reminders.schedule(scanDate),1);
    assert.ok((await queued())[0].body.includes(`/o/${seed.orgId}`));assert.doesNotMatch((await queued())[0].body,/\/bookings\//);
    const payments=new PaymentsService(database.db,access);
    const payment=await payments.submit(seed.customerMember,seed.customerId,null,{amount:'200',payment_date:today,idempotency_key:randomUUID()},[]);
    await payments.approve(seed.admin,seed.customerId,null,payment.id);
    assert.equal(await reminders.deliver(),0);assert.equal(calls.length,0);assert.equal((await queued())[0].state,'cancelled');
    assert.equal(await reminders.schedule(new Date(`${addDays(today,7)}T18:00:00Z`)),0);
  });

  it('persists provider failures and retries the same immutable body and provider key after restart',async()=>{
    await makeBooking();await enable();await reminders.schedule(scanDate);
    const original=mail.send;let first=true;
    mail.send=async(message,options)=>{if(first){first=false;calls.push({key:options!.idempotencyKey!,body:message.text});throw new Error('secret provider payload');}return original(message,options);};
    assert.equal(await reminders.deliver(),0);
    let row=(await queued())[0];assert.equal(row.state,'pending');assert.equal(row.attempts,1);assert.doesNotMatch(row.last_error,/secret/);
    assert.equal(await reminders.deliver(),0);
    await database.db.query('UPDATE reminder_email_outbox SET next_attempt_at=now()');
    const restarted=new ReminderService(database.db,access,mail,delivery,false);
    assert.equal(await restarted.deliver(),1);assert.deepEqual(calls[0],calls[1]);
    row=(await queued())[0];assert.equal(row.attempts,2);assert.equal(row.last_error,null);
  });

  it('recovers expired leases and stops retries before provider idempotency expires',async()=>{
    await makeBooking();await enable();await reminders.schedule(scanDate);
    await database.db.query(`UPDATE reminder_email_outbox SET state='processing',lease_token=$1,lease_until=now()+interval '1 minute'`,[randomUUID()]);
    assert.equal(await reminders.deliver(),0);
    await database.db.query("UPDATE reminder_email_outbox SET lease_until=now()-interval '1 minute',first_attempt_at=now()-interval '24 hours'");
    assert.equal(await reminders.deliver(),0);assert.equal((await queued())[0].state,'failed');assert.equal(calls.length,0);
  });

  it('rechecks settlement before sending a previously queued reminder',async()=>{
    await makeBooking();await enable();await reminders.schedule(scanDate);
    await new LedgerService(database.db,access).post(seed.admin,seed.customerId,{kind:'payment',amount:'100',effective_date:today,description:'Settled',idempotency_key:randomUUID()});
    assert.equal(await reminders.deliver(),0);assert.equal((await queued())[0].state,'cancelled');assert.equal(calls.length,0);
  });

  it('uses booking payments for reminder-only plans and cancels a queued reminder when its amount becomes complete',async()=>{
    const trip=await bookings.create(seed.admin,seed.customerId,{reference:`REMIND-${randomUUID()}`,departure_at:`${addDays(today,14)}T12:00:00Z`,
      required_services:[],amount:'100',effective_date:today,schedule_basis:'reminders',
      instalments:[{due_date:today,amount:'40'},{due_date:addDays(today,2),amount:'60'}],idempotency_key:randomUUID()});
    await new LedgerService(database.db,access).post(seed.admin,seed.customerId,{kind:'payment',amount:'10',effective_date:today,
      description:'Partial account credit',idempotency_key:randomUUID()});
    await enable();assert.equal(await reminders.schedule(scanDate),1,'A reminder remains eligible while the account and scheduled amount are still outstanding.');
    const payments=new PaymentsService(database.db,access);
    const pending=await payments.submit(seed.customerMember,seed.customerId,trip.id,{amount:'40',payment_date:today,idempotency_key:randomUUID()},[]);
    await payments.approve(seed.admin,seed.customerId,trip.id,pending.id,{});
    assert.equal(await reminders.deliver(),0);assert.equal((await queued())[0].state,'cancelled');assert.equal(calls.length,0);
    const next=await bookings.get(seed.admin,seed.customerId,trip.id);
    assert.equal(next.remaining_minor,'6000');assert.equal(next.instalments[0].remaining_minor,'0');assert.equal(next.instalments[1].remaining_minor,'6000');
  });

  it('sends a still-due reminder after partial payment using a balance link without a stale amount',async()=>{
    const trip=await bookings.create(seed.admin,seed.customerId,{reference:`PARTIAL-${randomUUID()}`,departure_at:`${addDays(today,14)}T12:00:00Z`,
      required_services:[],amount:'100',effective_date:today,schedule_basis:'reminders',
      instalments:[{due_date:today,amount:'100'}],idempotency_key:randomUUID()});
    await enable();await reminders.schedule(scanDate);
    const payments=new PaymentsService(database.db,access),pending=await payments.submit(seed.customerMember,seed.customerId,trip.id,
      {amount:'25',payment_date:today,idempotency_key:randomUUID()},[]);
    await payments.approve(seed.admin,seed.customerId,trip.id,pending.id,{});
    assert.equal(await reminders.deliver(),1);assert.match(calls[0].body,/current account balance/);assert.doesNotMatch(calls[0].body,/GBP|£100/);
    assert.equal((await bookings.get(seed.admin,seed.customerId,trip.id)).instalments[0].remaining_minor,'7500');
  });

  it('skips archived accounts, cancelled bookings and customer opt-outs',async()=>{
    await makeBooking();await makeBooking(seed.secondCustomerId);await enable();
    await database.db.query("UPDATE customers SET status='archived' WHERE id=$1",[seed.secondCustomerId]);
    await reminders.preference(seed.customerMember,seed.customerId,{enabled:false});assert.equal(await reminders.schedule(scanDate),0);
    await reminders.preference(seed.customerMember,seed.customerId,{enabled:true});
    await database.db.query('UPDATE reminder_settings SET last_scheduled_date=NULL');assert.equal(await reminders.schedule(scanDate),1);
    await database.db.query('UPDATE bookings SET deleted_at=now() WHERE customer_id=$1',[seed.customerId]);
    assert.equal(await reminders.deliver(),0);assert.equal(calls.length,0);
  });

  it('honors opt-out and organization disable after queueing',async()=>{
    await makeBooking();await makeBooking(seed.secondCustomerId);await enable();assert.equal(await reminders.schedule(scanDate),2);
    await reminders.preference(seed.customerMember,seed.customerId,{enabled:false});
    await reminders.updateSettings(seed.admin,{...settings,enabled:false});assert.equal(await reminders.deliver(),0);
    assert.ok((await queued()).every(row=>row.state==='cancelled'));assert.equal(calls.length,0);
  });

  it('purges queued reminders and related audit events when the account is removed',async()=>{
    await makeBooking();await enable();await reminders.schedule(scanDate);
    await new AccountDeletionService(database.db,access).removeCustomer(seed.admin,seed.customerId,'customer@example.test');
    assert.equal((await queued()).length,0);assert.equal(await reminders.deliver(),0);assert.equal(calls.length,0);
    assert.equal((await database.db.query("SELECT id FROM audit_events WHERE metadata->>'customer_id'=$1",[seed.customerId])).rows.length,0);
  });

  it('correlates early provider delivery events, rejects duplicate processing and never regresses delivery state',async()=>{
    await makeBooking();await enable();await reminders.schedule(scanDate);
    const row=(await queued())[0],providerId=`provider-${row.id}`;
    const early=signedEvent('email.delivered',providerId);
    await delivery.ingest(parseResendWebhook(early.body,early.headers,secret));
    assert.equal(await reminders.deliver(),1);assert.equal((await queued())[0].delivery_status,'delivered');
    const before=(await database.db.query("SELECT count(*)::int AS n FROM audit_events WHERE action='reminder.delivered'")).rows[0].n;
    assert.deepEqual(await delivery.ingest(parseResendWebhook(early.body,early.headers,secret)),{received:true,duplicate:true});
    const sent=signedEvent('email.sent',providerId);await delivery.ingest(parseResendWebhook(sent.body,sent.headers,secret));
    assert.equal((await queued())[0].delivery_status,'delivered');
    assert.equal((await database.db.query("SELECT count(*)::int AS n FROM audit_events WHERE action='reminder.delivered'")).rows[0].n,before);
  });

  it('records bounces/complaints and suppresses future reminders without exposing another organization',async()=>{
    await makeBooking();await enable();await reminders.schedule(scanDate);await reminders.deliver();
    const row=(await queued())[0],bounce=signedEvent('email.bounced',row.provider_message_id);
    await delivery.ingest(parseResendWebhook(bounce.body,bounce.headers,secret));
    assert.equal((await queued())[0].delivery_status,'bounced');assert.equal((await reminders.preference(seed.admin,seed.customerId)).suppressed,true);
    assert.equal(await reminders.schedule(new Date(`${addDays(today,8)}T18:00:00Z`)),0);
    const complaint=signedEvent('email.complained',row.provider_message_id);await delivery.ingest(parseResendWebhook(complaint.body,complaint.headers,secret));
    assert.equal((await reminders.history(seed.admin)).summary.complained,1);
    assert.equal((await reminders.history(seed.otherAdmin)).messages.length,0);
    await assert.rejects(reminders.history(seed.customerMember),/administrator/);
  });
});
