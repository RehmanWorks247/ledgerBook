// Run against the committed Postman simulation; never sends real email.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AccessService } from '../apps/api/src/access/access.service';
import { config } from '../apps/api/src/config';
import { NotificationsService } from '../apps/api/src/notifications/notifications.service';
import { PaymentEmailOutbox } from '../apps/api/src/payments/email-outbox.service';
import { setupTestDatabase } from './helpers';

async function main() {
  if (config.production) throw new Error('Simulation is disabled in production.');
  const base='http://127.0.0.1:4017/resend';
  const reset=await fetch(`${base}/_control/reset`,{method:'POST'});
  assert.equal(reset.status,200);
  config.emailMode='resend'; config.resendApiKey='simulation-only';
  const database=await setupTestDatabase();
  try {
    const seed=await database.seed(),id=randomUUID();
    await database.db.query(`INSERT INTO payment_email_outbox(id,organization_id,recipient,subject,body,dedupe_key)
      VALUES($1::uuid,$2,'customer@example.test','Payment approved','Simulation only',$1::text)`,[id,seed.orgId]);
    const mail=new NotificationsService(`${base}/emails`);
    const worker=new PaymentEmailOutbox(database.db,mail,new AccessService(database.db),false);
    assert.equal(await worker.flush(),0);
    let row=(await database.db.query('SELECT * FROM payment_email_outbox WHERE id=$1',[id])).rows[0];
    assert.equal(row.state,'pending'); assert.equal(row.attempts,1);
    await database.db.query('UPDATE payment_email_outbox SET next_attempt_at=now() WHERE id=$1',[id]);
    assert.equal(await worker.flush(),1);
    row=(await database.db.query('SELECT * FROM payment_email_outbox WHERE id=$1',[id])).rows[0];
    assert.equal(row.state,'sent'); assert.equal(row.attempts,2);
    // Simulate replay after an ambiguous provider response using the same body/key.
    await mail.send({to:row.recipient,subject:row.subject,text:row.body},{idempotencyKey:`payment-email/${id}`});
    const state=await (await fetch(`${base}/_control/state`)).json() as {calls:number;accepted:number;keys:string[]};
    assert.equal(state.calls,3); assert.equal(state.accepted,1);
    assert.deepEqual(state.keys,[`payment-email/${id}`]);
    console.log('PASS: real HTTP email adapter; provider 500 persisted and retried; stable key; one accepted modeled email across replay.');
  } finally {await database.close();}
}
void main().catch(()=>{console.error('Payment provider simulation failed.');process.exitCode=1;});
