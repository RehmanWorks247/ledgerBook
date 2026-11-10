import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import sharp from 'sharp';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import type { DatabaseService } from '../apps/api/src/database/database.service';
import { businessDate } from '../apps/api/src/dashboard/time';
import { NotificationsService, type EmailMessage } from '../apps/api/src/notifications/notifications.service';
import { PaymentEmailOutbox } from '../apps/api/src/payments/email-outbox.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

describe('durable payment notification delivery', () => {
  let database:TestDatabase;
  let seed:TestSeed;
  let outbox:PaymentEmailOutbox;
  let mail:NotificationsService;
  let deliveries:{message:EmailMessage;key?:string}[];
  before(async () => {
    database = await setupTestDatabase(); seed = await database.seed();
    deliveries=[];
    mail = new NotificationsService();
    mail.send=async (message,options) => { deliveries.push({message,key:options?.idempotencyKey}); };
    outbox = new PaymentEmailOutbox(database.db,mail,new AccessService(database.db),false);
  });
  after(async () => { await outbox?.beforeApplicationShutdown(); await database?.close(); });

  async function enqueue() {
    const id = randomUUID();
    await database.db.query(`INSERT INTO payment_email_outbox(id,organization_id,recipient,subject,body,dedupe_key)
      VALUES($1::uuid,$2,'customer@example.test','Payment approved','Your payment was approved.',$1::text)`,[id,seed.orgId]);
    return id;
  }
  async function row(id:string) { return (await database.db.query('SELECT * FROM payment_email_outbox WHERE id=$1',[id])).rows[0]; }

  it('commits delivery state and does not resend completed messages', async () => {
    const id=await enqueue();
    assert.equal(await outbox.flush(),1);
    const saved=await row(id);
    assert.equal(saved.state,'sent'); assert.equal(saved.attempts,1); assert.ok(saved.sent_at);
    assert.equal(deliveries.at(-1)?.key,`payment-email/${id}`);
    assert.equal(await outbox.flush(),0);
  });

  it('preserves an event through provider failure, backs off, and reuses its key after restart', async () => {
    const id=await enqueue(); const send=mail.send;
    const keys:string[]=[];
    mail.send=async (_message,options) => { keys.push(options!.idempotencyKey!); throw new Error('secret provider payload'); };
    assert.equal(await outbox.flush(),0);
    let saved=await row(id);
    assert.equal(saved.state,'pending'); assert.equal(saved.attempts,1);
    assert.ok(new Date(saved.next_attempt_at).getTime()>Date.now());
    assert.doesNotMatch(saved.last_error,/secret/);
    assert.equal(await outbox.flush(),0); // not due: no busy retry
    mail.send=async (message,options) => { keys.push(options!.idempotencyKey!); await send(message,options); };
    await database.db.query('UPDATE payment_email_outbox SET next_attempt_at=now() WHERE id=$1',[id]);
    const restarted=new PaymentEmailOutbox(database.db,mail,new AccessService(database.db),false);
    assert.equal(await restarted.flush(),1);
    saved=await row(id);
    assert.equal(saved.state,'sent'); assert.equal(saved.attempts,2); assert.equal(saved.last_error,null);
    assert.deepEqual(keys,[`payment-email/${id}`,`payment-email/${id}`]);
    mail.send=send;
  });

  it('recovers expired leases while leaving an active worker lease alone', async () => {
    const expired=await enqueue(), active=await enqueue();
    await database.db.query(`UPDATE payment_email_outbox SET state='processing',lease_token=$1,
      lease_until=now()+CASE WHEN id=$2 THEN interval '-1 minute' ELSE interval '1 minute' END WHERE id IN ($2,$3)`,[randomUUID(),expired,active]);
    assert.equal(await outbox.flush(),1);
    assert.equal((await row(expired)).state,'sent');
    assert.equal((await row(active)).state,'processing');
    await database.db.query("UPDATE payment_email_outbox SET lease_until=now()-interval '1 minute' WHERE id=$1",[active]);
    assert.equal(await outbox.flush(),1);
  });

  it('does not deliver the same event from two workers', async () => {
    const id=await enqueue(); const count=deliveries.length;
    const second=new PaymentEmailOutbox(database.db,mail,new AccessService(database.db),false);
    await Promise.all([outbox.flush(),second.flush()]);
    assert.equal(deliveries.length,count+1);
    assert.equal((await row(id)).attempts,1);
  });

  it('recovers a lost acknowledgement after provider acceptance using the same provider key', async () => {
    const id=await enqueue();
    const send=mail.send;
    const attempts:string[]=[];
    const accepted=new Set<string>();
    mail.send=async (_message,options) => {
      const key=options!.idempotencyKey!;
      attempts.push(key);
      // Model the provider's idempotency contract: an accepted retry does not send twice.
      accepted.add(key);
    };
    await database.db.query(`CREATE FUNCTION payment_test_lose_acknowledgement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.state='processing' THEN RAISE EXCEPTION 'simulated acknowledgement outage'; END IF; RETURN NEW; END; $$;`);
    await database.db.query('CREATE TRIGGER payment_test_lose_acknowledgement BEFORE UPDATE ON payment_email_outbox FOR EACH ROW EXECUTE FUNCTION payment_test_lose_acknowledgement()');
    try {
      await assert.rejects(outbox.flush(),/simulated acknowledgement outage/);
      assert.equal(accepted.size,1);
      assert.equal((await row(id)).state,'processing');
    } finally {
      await database.db.query('DROP TRIGGER payment_test_lose_acknowledgement ON payment_email_outbox');
      await database.db.query('DROP FUNCTION payment_test_lose_acknowledgement()');
    }
    try {
      await database.db.query("UPDATE payment_email_outbox SET lease_until=now()-interval '1 minute' WHERE id=$1",[id]);
      const restarted=new PaymentEmailOutbox(database.db,mail,new AccessService(database.db),false);
      assert.equal(await restarted.flush(),1);
      assert.equal((await row(id)).state,'sent');
      assert.equal((await row(id)).attempts,2);
      assert.deepEqual(attempts,[`payment-email/${id}`,`payment-email/${id}`]);
      assert.equal(accepted.size,1,'The provider must see the same event key after a lost acknowledgement.');
    } finally {mail.send=send;}
  });

  it('does not retain an email when its business transaction rolls back', async () => {
    const id=randomUUID();
    await assert.rejects(database.db.transaction(async client => {
      await client.query(`INSERT INTO payment_email_outbox(id,organization_id,recipient,subject,body,dedupe_key)
        VALUES($1::uuid,$2,'customer@example.test','Payment approved','Approved',$1::text)`,[id,seed.orgId]);
      throw new Error('rollback');
    }),/rollback/);
    assert.equal(await row(id),undefined);
  });

  it('cancels queued receipt-review emails after the recipient loses administrator access',async()=>{
    const membershipId=randomUUID(),id=randomUUID(),count=deliveries.length;
    await database.db.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'admin')",[membershipId,seed.orgId,seed.otherAdminId]);
    await database.db.query(`INSERT INTO payment_email_outbox(id,organization_id,recipient,subject,body,dedupe_key)
      VALUES($1,$2,'other-admin@example.test','Receipt awaiting review','Customer private details',$3)`,[id,seed.orgId,`payment-submitted:${randomUUID()}:other-admin@example.test`]);
    await database.db.query('UPDATE memberships SET is_active=false WHERE id=$1',[membershipId]);
    assert.equal(await outbox.flush(),0);assert.equal(deliveries.length,count);
    assert.equal((await row(id)).state,'cancelled');assert.equal((await row(id)).delivery_status,'cancelled');
  });

  it('restricts notification health to active admins in their own organization', async () => {
    await assert.rejects(outbox.status(seed.customerMember));
    const own=await outbox.status(seed.admin),other=await outbox.status(seed.otherAdmin);
    assert.ok(own.sent>0); assert.equal(other.sent,0); assert.equal(other.queued,0);
  });
});

describe('payment notification review and recipient regressions',()=>{
  let database:TestDatabase,seed:TestSeed,payments:PaymentsService,bookings:BookingsService;
  let mail:NotificationsService,outbox:PaymentEmailOutbox,deliveries:{message:EmailMessage;key?:string}[];
  beforeEach(async()=>{
    database=await setupTestDatabase();seed=await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1",[seed.orgId]);
    const access=new AccessService(database.db);
    seed.admin=await access.membership(seed.adminId,seed.orgId);
    seed.customerMember=await access.membership(seed.customerUserId,seed.orgId);
    payments=new PaymentsService(database.db,access);bookings=new BookingsService(database.db,access);
    mail=new NotificationsService();deliveries=[];
    mail.send=async(message,options)=>{deliveries.push({message,key:options?.idempotencyKey});return {providerMessageId:randomUUID()};};
    outbox=new PaymentEmailOutbox(database.db,mail,access,false);
  });
  afterEach(async()=>{await outbox?.beforeApplicationShutdown();await database?.close();});

  async function submit() {
    const booking=await bookings.create(seed.admin,seed.customerId,{reference:`NOTICE-${randomUUID()}`,departure_at:'2030-01-01T12:00:00Z',
      required_services:[],amount:'100.00',effective_date:businessDate(),idempotency_key:randomUUID()});
    const buffer=await sharp({create:{width:8,height:8,channels:3,background:'#249a67'}}).png().toBuffer();
    const payment=await payments.submit(seed.customerMember,seed.customerId,booking.id,
      {amount:'25.00',payment_date:businessDate(),note:'Synthetic receipt',idempotency_key:randomUUID()},
      [{originalname:'receipt.png',mimetype:'image/png',buffer,size:buffer.length}]);
    const submitted=(await database.db.query('SELECT * FROM payment_email_outbox WHERE dedupe_key LIKE $1',
      [`payment-submitted:${payment.id}:%`])).rows[0];
    assert.ok(submitted,'The active administrator receives a receipt-submission notification.');
    // This suite exercises payment-recipient membership checks. Booking
    // confirmations have their own active-customer authorization tests.
    await database.db.query("UPDATE payment_email_outbox SET next_attempt_at=now()+interval '1 day' WHERE dedupe_key=$1",[`booking-created:${booking.id}`]);
    return {booking,payment,submitted};
  }
  async function row(id:string) {return (await database.db.query('SELECT * FROM payment_email_outbox WHERE id=$1',[id])).rows[0];}
  async function isolate(id:string) {
    await database.db.query("UPDATE payment_email_outbox SET next_attempt_at=now()+interval '1 day' WHERE id<>$1",[id]);
  }

  for(const review of ['approve','reject'] as const) it(`cancels unattempted administrator notices when a receipt is ${review==='approve'?'approved':'rejected'}`,async()=>{
    const {booking,payment,submitted}=await submit();assert.equal(submitted.attempts,0);
    if(review==='approve')await payments.approve(seed.admin,seed.customerId,booking.id,payment.id);
    else await payments.reject(seed.admin,seed.customerId,booking.id,payment.id,{reason:'The transfer reference does not match.'});
    const cancelled=await row(submitted.id);
    assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.delivery_status,'cancelled');
    assert.equal(cancelled.attempts,0);assert.equal(cancelled.lease_token,null);assert.equal(cancelled.lease_until,null);
    await outbox.flush();
    assert.equal(deliveries.some(item=>item.message.to==='admin@example.test'),false,'A completed review must not produce a late awaiting-review notice.');
    assert.ok(deliveries.some(item=>item.message.to==='customer@example.test'&&item.message.subject===
      (review==='approve'?'Your payment has been approved':'Your payment was not approved')));
  });

  it('rechecks administrator access for a real pending payment before disclosing receipt details',async()=>{
    const membershipId=randomUUID();
    await database.db.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'admin')",
      [membershipId,seed.orgId,seed.otherAdminId]);
    const {payment}=await submit();
    const email=(await database.db.query('SELECT * FROM payment_email_outbox WHERE dedupe_key=$1',
      [`payment-submitted:${payment.id}:other-admin@example.test`])).rows[0];
    assert.ok(email);await isolate(email.id);
    await database.db.query('UPDATE memberships SET is_active=false WHERE id=$1',[membershipId]);
    await outbox.flush();
    assert.equal(deliveries.length,0);assert.equal((await row(email.id)).state,'cancelled');
  });

  it('rechecks a first claimed administrator notice when review commits before the send starts',async()=>{
    const {booking,payment,submitted}=await submit();await isolate(submitted.id);
    let claimed!:()=>void,release!:()=>void;
    const checkpoint=new Promise<void>(resolve=>{claimed=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const workerDb=Object.create(database.db) as DatabaseService;
    workerDb.transaction=async work=>{
      const result=await database.db.transaction(work);
      const first=(result as {rows?:{id:string;state:string}[]}|undefined)?.rows?.[0];
      if(first&&first.id===submitted.id&&first.state==='processing'){claimed();await gate;}
      return result;
    };
    const worker=new PaymentEmailOutbox(workerDb,mail,new AccessService(workerDb),false);
    const sending=worker.flush();void sending.catch(()=>undefined);
    try {
      await Promise.race([checkpoint,sending.then(()=>{throw new Error('Worker finished before claiming the submission notice.');})]);
      assert.equal((await row(submitted.id)).attempts,1);
      await payments.approve(seed.admin,seed.customerId,booking.id,payment.id);
      release();await sending;
      assert.equal((await row(submitted.id)).state,'cancelled');
      assert.equal(deliveries.some(item=>item.message.to==='admin@example.test'),false);
    } finally {release();await sending;await worker.beforeApplicationShutdown();}
  });

  it('preserves an ambiguous attempted administrator send after review with identical body and provider key',async()=>{
    const {booking,payment,submitted}=await submit();await isolate(submitted.id);
    const attempted:{message:EmailMessage;key?:string}[]=[],accepted=new Set<string>();
    let loseAcknowledgement=true;
    mail.send=async(message,options)=>{
      if(message.to==='admin@example.test') {
        attempted.push({message,key:options?.idempotencyKey});accepted.add(options!.idempotencyKey!);
        if(loseAcknowledgement)throw new Error('Provider accepted but acknowledgement was lost.');
      }
      return {providerMessageId:randomUUID()};
    };
    assert.equal(await outbox.flush(),0);
    assert.equal((await row(submitted.id)).attempts,1);
    await payments.reject(seed.admin,seed.customerId,booking.id,payment.id,{reason:'Use the correct transfer reference.'});
    const attemptedRow=await row(submitted.id);
    assert.equal(attemptedRow.state,'pending','A potentially accepted request must retain its idempotent retry.');
    assert.equal(attemptedRow.body,submitted.body);assert.equal(attemptedRow.subject,submitted.subject);
    loseAcknowledgement=false;
    await database.db.query('UPDATE payment_email_outbox SET next_attempt_at=now() WHERE id=$1',[submitted.id]);
    await outbox.flush();
    assert.equal((await row(submitted.id)).state,'sent');assert.equal((await row(submitted.id)).attempts,2);
    assert.equal(attempted.length,2);assert.deepEqual(attempted[1],attempted[0]);assert.equal(accepted.size,1);
    assert.doesNotMatch(`${submitted.subject}\n${submitted.body}`,/awaiting review/i,
      'New submission notices must describe an upload without claiming its review is still pending.');
  });

  for(const change of ['login email','queued recipient','disabled access','deleted access','different customer'] as const)
    it(`does not disclose customer payment notifications after ${change} changes`,async()=>{
      const {booking,payment}=await submit();
      await payments.reject(seed.admin,seed.customerId,booking.id,payment.id,{reason:'Private reviewer explanation.'});
      const customerRows=(await database.db.query(`SELECT * FROM payment_email_outbox WHERE dedupe_key IN ($1,$2)`,
        [`payment-received:${payment.id}:${seed.customerUserId}`,`payment-rejected:${payment.id}:${seed.customerUserId}`])).rows;
      assert.equal(customerRows.length,2,'Both receipt acknowledgment and rejection must be queued for the original submitter.');
      if(change==='login email')await database.db.query("UPDATE users SET email='changed-login@example.test' WHERE id=$1",[seed.customerUserId]);
      if(change==='queued recipient') {
        // The customer's access email is immutable. A stale/misrouted row must
        // fail even when it matches the login's current email address.
        await database.db.query("UPDATE users SET email='changed-login@example.test' WHERE id=$1",[seed.customerUserId]);
        await database.db.query("UPDATE payment_email_outbox SET recipient='changed-login@example.test' WHERE id=ANY($1::uuid[])",[customerRows.map(email=>email.id)]);
      }
      if(change==='disabled access')await database.db.query('UPDATE memberships SET is_active=false WHERE id=$1',[seed.customerMember.id]);
      if(change==='deleted access')await database.db.query('UPDATE memberships SET is_active=false,deleted_at=now() WHERE id=$1',[seed.customerMember.id]);
      if(change==='different customer') {
        const otherUser=randomUUID();
        await database.db.query("INSERT INTO users(id,email,password_hash) SELECT $1,'beacon@example.test',password_hash FROM users WHERE id=$2",[otherUser,seed.customerUserId]);
        await database.db.query("INSERT INTO memberships(id,organization_id,user_id,role,customer_id) VALUES($1,$2,$3,'customer',$4)",
          [randomUUID(),seed.orgId,otherUser,seed.secondCustomerId]);
        await database.db.query("UPDATE payment_email_outbox SET recipient='beacon@example.test',dedupe_key=replace(dedupe_key,$1,$2) WHERE id=ANY($3::uuid[])",
          [seed.customerUserId,otherUser,customerRows.map(email=>email.id)]);
      }
      await outbox.flush();
      assert.equal(deliveries.length,0,'Private receipt and rejection details must not reach stale or unrelated recipients.');
      for(const email of customerRows) {
        const saved=await row(email.id);assert.equal(saved.state,'cancelled');assert.equal(saved.delivery_status,'cancelled');
      }
    });

  it('does not send a notification whose payment belongs to another organization',async()=>{
    const {payment}=await submit();
    const id=randomUUID();
    await database.db.query(`INSERT INTO payment_email_outbox(id,organization_id,recipient,subject,body,dedupe_key)
      VALUES($1,$2,'customer@example.test','Private payment information','Cross-organization fixture',$3)`,
      [id,seed.otherOrgId,`payment-rejected:${payment.id}:${seed.customerUserId}`]);
    await isolate(id);await outbox.flush();
    assert.equal(deliveries.length,0);assert.equal((await row(id)).state,'cancelled');
  });

  it('rechecks the original customer access before sending an approval notification',async()=>{
    const {booking,payment}=await submit();
    await payments.approve(seed.admin,seed.customerId,booking.id,payment.id);
    const approval=(await database.db.query('SELECT * FROM payment_email_outbox WHERE dedupe_key=$1',[`payment-approved:${payment.id}`])).rows[0];
    assert.ok(approval);await isolate(approval.id);
    await database.db.query('UPDATE memberships SET is_active=false WHERE id=$1',[seed.customerMember.id]);
    await outbox.flush();
    assert.equal(deliveries.length,0);assert.equal((await row(approval.id)).state,'cancelled');
  });

  it('serializes review with an administrator notification already being sent',{skip:!process.env.TEST_DATABASE_URL,timeout:20_000},async()=>{
    const {booking,payment,submitted}=await submit();await isolate(submitted.id);
    let started!:()=>void,release!:()=>void;
    const checkpoint=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    mail.send=async(message,options)=>{
      if(message.to==='admin@example.test'){started();await gate;}
      deliveries.push({message,key:options?.idempotencyKey});return {providerMessageId:randomUUID()};
    };
    const sending=outbox.flush();void sending.catch(()=>undefined);
    let reviewing:Promise<unknown>|undefined;
    try {
      await Promise.race([checkpoint,sending.then(()=>{throw new Error('Worker finished before provider send checkpoint.');})]);
      let pid=0;
      const reviewDb=Object.create(database.db) as DatabaseService;
      reviewDb.transaction=work=>database.db.transaction(async client=>{
        pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return work(client);
      });
      reviewing=new PaymentsService(reviewDb,new AccessService(reviewDb)).approve(seed.admin,seed.customerId,booking.id,payment.id);
      void reviewing.catch(()=>undefined);
      let blocked=false;
      for(let attempt=0;attempt<200;attempt++) {
        if(pid&&(await database.db.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.wait_event_type==='Lock'){blocked=true;break;}
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(blocked,true,'Review must wait for the final notification eligibility check and provider acceptance.');
      release();
      const results=await Promise.allSettled([sending,reviewing]);
      for(const result of results)assert.equal(result.status,'fulfilled',result.status==='rejected'?String(result.reason):'');
      assert.equal(deliveries.filter(item=>item.message.to==='admin@example.test').length,1);
      assert.equal((await row(submitted.id)).state,'sent');
    } finally {release();await Promise.allSettled([sending,...(reviewing?[reviewing]:[])]);}
  });
});
