import assert from 'node:assert/strict';
import { createHmac,randomUUID } from 'node:crypto';
import { after,before,describe,it } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from '../apps/api/src/app';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { config } from '../apps/api/src/config';
import { NotificationsService } from '../apps/api/src/notifications/notifications.service';
import { PaymentEmailOutbox } from '../apps/api/src/payments/email-outbox.service';
import { setupTestDatabase,type TestDatabase,type TestSeed } from './helpers';

describe('notification HTTP authorization, raw webhooks and payment delivery status',()=>{
  let database:TestDatabase,seed:TestSeed,app:NestExpressApplication,base:string,admin:string,customer:string;
  const previousSecret=config.resendWebhookSecret;
  const secret=`whsec_${Buffer.from('notification-http-signing-fixture-key').toString('base64')}`;
  const settings={enabled:false,due_soon_days:3,repeat_days:7,send_hour:9,time_zone:'Asia/Karachi'};
  before(async()=>{
    database=await setupTestDatabase();seed=await database.seed();config.resendWebhookSecret=secret;
    app=await createApp({database:database.db,logger:false,paymentEmails:false,reminderEmails:false});
    await app.listen(0,'127.0.0.1');base=await app.getUrl();
    admin=`${config.sessionCookie}=${await app.get(AuthService).createSession(seed.adminId)}`;
    customer=`${config.sessionCookie}=${await app.get(AuthService).createSession(seed.customerUserId)}`;
    app.get(NotificationsService).send=async()=>({providerMessageId:'provider-http-test'});
  });
  after(async()=>{config.resendWebhookSecret=previousSecret;await app?.close();await database?.close();});
  const path=()=>`/organizations/${seed.orgId}/notifications`;
  function request(url:string,cookie=admin,method='GET',body?:unknown,csrf=true) {
    return fetch(`${base}/api${url}`,{method,headers:{'Content-Type':'application/json',Cookie:cookie,
      ...(csrf?{Origin:config.appUrl,'X-CSRF-Protection':'1'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  }
  function webhook(type='email.delivered',id=`msg_${randomUUID()}`,data:unknown={email_id:'provider-http-test'},raw?:string) {
    const body=raw??JSON.stringify({type,created_at:new Date().toISOString(),data});
    const timestamp=String(Math.floor(Date.now()/1000));
    const signature=createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(`${id}.${timestamp}.${body}`).digest('base64');
    return {body,headers:{'Content-Type':'application/json','svix-id':id,'svix-timestamp':timestamp,'svix-signature':`v1,${signature}`}};
  }
  const postWebhook=(event:ReturnType<typeof webhook>)=>fetch(`${base}/api/webhooks/resend`,{method:'POST',...event});

  it('offers admin-only settings/history, validates settings and preserves ordinary CSRF protection',async()=>{
    assert.equal((await request(`${path()}/settings`)).status,200);
    assert.equal((await request(`${path()}/history`)).status,200);
    assert.equal((await request(`${path()}/settings`,customer)).status,403);
    assert.equal((await request(`${path()}/history`,customer)).status,403);
    assert.equal((await request(`/organizations/${seed.otherOrgId}/notifications/settings`)).status,404);
    assert.equal((await request(`${path()}/settings`,admin,'PATCH',settings,false)).status,403);
    assert.equal((await request(`${path()}/settings`,admin,'PATCH',{...settings,send_hour:24})).status,400);
    const saved=await request(`${path()}/settings`,admin,'PATCH',settings);
    assert.equal(saved.status,200);assert.equal((await saved.json()).time_zone,'Asia/Karachi');
    assert.equal((await request(`${path()}/settings`,admin,'PATCH',{...settings,enabled:true},false)).status,403);
  });

  it('lets customers opt out only their own account and blocks cross-account access',async()=>{
    const own=`/organizations/${seed.orgId}/customers/${seed.customerId}/reminder-preferences`;
    assert.equal((await request(own,customer,'PATCH',{enabled:false})).status,200);
    assert.equal((await (await request(own,customer)).json()).enabled,false);
    assert.equal((await request(`/organizations/${seed.orgId}/customers/${seed.secondCustomerId}/reminder-preferences`,customer)).status,404);
  });

  it('accepts only signature-verified raw POST webhooks without browser CSRF headers and deduplicates provider events',async()=>{
    const id=randomUUID();await database.db.query(`INSERT INTO payment_email_outbox(id,organization_id,recipient,subject,body,dedupe_key)
      VALUES($1::uuid,$2,'customer@example.test','Payment approved','Approved',$1::text)`,[id,seed.orgId]);
    assert.equal(await app.get(PaymentEmailOutbox).flush(),1);
    const event=webhook();assert.equal((await postWebhook(event)).status,200);
    assert.deepEqual(await (await postWebhook(event)).json(),{received:true,duplicate:true});
    const status=await (await request(`/organizations/${seed.orgId}/payment-email-status`)).json();
    assert.equal(status.sent,1);assert.equal(status.delivered,1);
    const forged={...event,body:event.body+' '};assert.equal((await postWebhook(forged)).status,401);
    assert.equal((await fetch(`${base}/api/webhooks/resend`,{method:'POST',headers:{'Content-Type':'application/json'},body:event.body})).status,401);
    assert.equal((await fetch(`${base}/api/webhooks/resend`)).status,405);
    assert.equal((await postWebhook(webhook('email.opened'))).status,200);
    assert.equal((await postWebhook(webhook('email.delivered',undefined,{}))).status,400);
    assert.equal((await postWebhook(webhook('email.delivered',undefined,{},'{broken json'))).status,400);
    assert.equal((await postWebhook(webhook('email.delivered',undefined,{},'x'.repeat(65537)))).status,413);
  });

  it('records a hard bounce and suppresses later notifications to that recipient',async()=>{
    assert.equal((await postWebhook(webhook('email.bounced'))).status,200);
    const id=randomUUID();await database.db.query(`INSERT INTO payment_email_outbox(id,organization_id,recipient,subject,body,dedupe_key)
      VALUES($1::uuid,$2,'customer@example.test','Payment approved','Approved',$1::text)`,[id,seed.orgId]);
    assert.equal(await app.get(PaymentEmailOutbox).flush(),0);
    const history=await (await request(`${path()}/history`)).json();
    assert.equal(history.summary.bounced,1);assert.equal(history.summary.suppressed,1);
    assert.equal(history.messages.find((row:{id:string})=>row.id===id).delivery_status,'suppressed');
  });
});
