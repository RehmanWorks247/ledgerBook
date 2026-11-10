import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHmac,randomUUID } from 'node:crypto';
import { afterEach,beforeEach,describe,it } from 'node:test';
import type { DatabaseService } from '../apps/api/src/database/database.service';
import { LedgerService } from '../apps/api/src/ledger/ledger.service';
import { AccountDeletionService } from '../apps/api/src/users/account-deletion.service';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { businessDate } from '../apps/api/src/dashboard/time';
import { EmailDeliveryService,parseResendWebhook } from '../apps/api/src/notifications/email-delivery.service';
import { NotificationsService } from '../apps/api/src/notifications/notifications.service';
import { ReminderService } from '../apps/api/src/notifications/reminder.service';
import { setupTestDatabase,type TestDatabase,type TestSeed } from './helpers';

const schedule={enabled:true,due_soon_days:3,repeat_days:7,send_hour:0,time_zone:'UTC'};
describe('reminder independent-review regressions',()=>{
  let database:TestDatabase,seed:TestSeed,reminders:ReminderService,bookings:BookingsService;
  let recipients:string[],mail:NotificationsService,delivery:EmailDeliveryService;
  beforeEach(async()=>{
    database=await setupTestDatabase();seed=await database.seed();await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1",[seed.orgId]);
    const access=new AccessService(database.db);seed.admin=await access.membership(seed.adminId,seed.orgId);bookings=new BookingsService(database.db,access);
    mail=new NotificationsService();recipients=[];mail.send=async message=>{recipients.push(message.to);return {providerMessageId:randomUUID()};};
    delivery=new EmailDeliveryService(database.db);reminders=new ReminderService(database.db,access,mail,delivery,false);
  });
  afterEach(async()=>{await reminders.beforeApplicationShutdown();await database.close();});
  it('cancels mismatched queued recipients and cannot bypass their suppression',async()=>{
    const today=businessDate(new Date(),'UTC');
    await bookings.create(seed.admin,seed.customerId,{reference:'EMAIL-CHANGE',departure_at:'2030-01-01T12:00:00Z',required_services:[],amount:'100.00',effective_date:today,instalments:[{due_date:today,amount:'100.00'}],idempotency_key:randomUUID()});
    await reminders.updateSettings(seed.admin,schedule);assert.equal(await reminders.schedule(new Date(`${today}T18:00:00Z`)),1);
    await database.db.query(`INSERT INTO email_suppressions(organization_id,recipient_hash,reason) VALUES($1,encode(sha256(convert_to('old-customer@example.test','UTF8')),'hex'),'bounced')`,[seed.orgId]);
    await database.db.query("UPDATE reminder_email_outbox SET recipient='old-customer@example.test' WHERE customer_id=$1",[seed.customerId]);
    assert.equal(await reminders.deliver(),0);assert.deepEqual(recipients,[]);
    const row=(await database.db.query('SELECT state,delivery_status FROM reminder_email_outbox')).rows[0];assert.deepEqual(row,{state:'cancelled',delivery_status:'cancelled'});
  });
  it('guards stale administrator settings and concurrent first-time initialization atomically',async()=>{
    assert.equal((await reminders.settings(seed.admin)).version,0);
    const results=await Promise.allSettled([reminders.updateSettings(seed.admin,{...schedule,expected_version:0}),reminders.updateSettings(seed.admin,{...schedule,enabled:false,expected_version:0})]);
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.filter(result=>result.status==='rejected').length,1);
    const first=await reminders.settings(seed.admin);assert.equal(first.version,1);
    const saved=await reminders.updateSettings(seed.admin,{...schedule,enabled:false,expected_version:1});assert.equal(saved.version,2);
    await assert.rejects(reminders.updateSettings(seed.admin,{...schedule,enabled:true,expected_version:1}),/changed in another session/);
    assert.equal((await reminders.settings(seed.admin)).enabled,false);
    assert.equal((await database.db.query("SELECT count(*)::int AS n FROM audit_events WHERE action='notification.settings_updated' AND organization_id=$1",[seed.orgId])).rows[0].n,2);
  });
  it('normalizes named time zones consistently for PostgreSQL and JavaScript and rejects fixed offsets',async()=>{
    const alias=new Intl.DateTimeFormat('en',{timeZone:'CST'}).resolvedOptions().timeZone;
    assert.equal((await reminders.updateSettings(seed.admin,{...schedule,time_zone:'CST'})).time_zone,alias);
    await assert.rejects(reminders.updateSettings(seed.admin,{...schedule,time_zone:'+05:00'}),/Bad Request/);
    await assert.rejects(reminders.updateSettings(seed.admin,{...schedule,time_zone:'-03:00'}),/Bad Request/);
  });
  async function queueOne() {
    const today=businessDate(new Date(),'UTC');
    await bookings.create(seed.admin,seed.customerId,{reference:'CONCURRENT-SEND',departure_at:'2030-01-01T12:00:00Z',required_services:[],amount:'100.00',effective_date:today,instalments:[{due_date:today,amount:'100.00'}],idempotency_key:randomUUID()});
    await reminders.updateSettings(seed.admin,schedule);assert.equal(await reminders.schedule(new Date(`${today}T18:00:00Z`)),1);
    return (await database.db.query('SELECT * FROM reminder_email_outbox')).rows[0];
  }
  for(const operation of ['settlement','deletion'] as const) it(`serializes ${operation} with an in-flight provider send without deadlock`,{skip:!process.env.TEST_DATABASE_URL,timeout:20_000},async()=>{
    await queueOne();let release!:()=>void,started!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),checkpoint=new Promise<void>(resolve=>{started=resolve;});
    mail.send=async message=>{started();await gate;recipients.push(message.to);return {providerMessageId:randomUUID()};};
    const sending=reminders.deliver();void sending.catch(()=>undefined);let action:Promise<unknown>|undefined;
    try{
      await checkpoint;let pid=0;const actionDb=Object.create(database.db) as DatabaseService;
      actionDb.transaction=work=>database.db.transaction(async client=>{pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return work(client);});
      const access=new AccessService(actionDb);
      action=operation==='settlement'?new LedgerService(actionDb,access).post(seed.admin,seed.customerId,{kind:'payment',amount:'100.00',effective_date:businessDate(),description:'Concurrent settlement',idempotency_key:randomUUID()}):new AccountDeletionService(actionDb,access).removeCustomer(seed.admin,seed.customerId,'customer@example.test');
      void action.catch(()=>undefined);let blocked=false;
      for(let attempt=0;attempt<200;attempt++){
        if(pid&&(await database.db.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.wait_event_type==='Lock'){blocked=true;break;}
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(blocked,true,'Customer mutation must wait for provider acceptance.');release();
      const results=await Promise.allSettled([sending,action]);for(const result of results)assert.equal(result.status,'fulfilled',result.status==='rejected'?String(result.reason):'');
      assert.equal(recipients.length,1);assert.equal(await reminders.deliver(),0);
      if(operation==='deletion')assert.equal((await database.db.query('SELECT id FROM reminder_email_outbox')).rowCount,0);
    }finally{release();await Promise.allSettled([sending,...(action?[action]:[])]);}
  });
  it('correlates a signed webhook arriving during provider acceptance without advisory-lock inversion',{skip:!process.env.TEST_DATABASE_URL,timeout:20_000},async()=>{
    const row=await queueOne(),providerId=`provider-${row.id}`;let release!:()=>void,started!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),checkpoint=new Promise<void>(resolve=>{started=resolve;});
    mail.send=async()=>{started();await gate;return {providerMessageId:providerId};};
    const sending=reminders.deliver();void sending.catch(()=>undefined);
    try{
      await checkpoint;
      const secret=Buffer.from('test-only-32-byte-webhook-secret-key');const id=`msg_${randomUUID()}`,timestamp=String(Math.floor(Date.now()/1000));
      const body=Buffer.from(JSON.stringify({type:'email.delivered',created_at:new Date().toISOString(),data:{email_id:providerId}}));
      const signature=createHmac('sha256',secret).update(`${id}.${timestamp}.`).update(body).digest('base64');
      const event=parseResendWebhook(body,{'svix-id':id,'svix-timestamp':timestamp,'svix-signature':`v1,${signature}`},`whsec_${secret.toString('base64')}`);
      const received=await delivery.ingest(event);assert.equal(received.received,true);
      release();assert.equal(await sending,1);
      const delivered=(await database.db.query('SELECT delivery_status,state FROM reminder_email_outbox WHERE id=$1',[row.id])).rows[0];
      assert.deepEqual(delivered,{delivery_status:'delivered',state:'sent'});
      assert.equal((await database.db.query("SELECT action FROM audit_events WHERE object_id=$1 AND action LIKE 'reminder.%' ORDER BY id DESC LIMIT 1",[row.id])).rows[0].action,'reminder.delivered');
    }finally{release();await sending;}
  });

});
