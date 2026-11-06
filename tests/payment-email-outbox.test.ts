import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { AccessService } from '../apps/api/src/access/access.service';
import { NotificationsService, type EmailMessage } from '../apps/api/src/notifications/notifications.service';
import { PaymentEmailOutbox } from '../apps/api/src/payments/email-outbox.service';
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

  it('restricts notification health to active admins in their own organization', async () => {
    await assert.rejects(outbox.status(seed.customerMember));
    const own=await outbox.status(seed.admin),other=await outbox.status(seed.otherAdmin);
    assert.ok(own.sent>0); assert.equal(other.sent,0); assert.equal(other.queued,0);
  });
});
