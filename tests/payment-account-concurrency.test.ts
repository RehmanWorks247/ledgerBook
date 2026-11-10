// Run with TEST_DATABASE_URL pointing at disposable PostgreSQL; never uses live accounts.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import type { PoolClient } from 'pg';
import { AccessService } from '../apps/api/src/access/access.service';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import type { DatabaseService } from '../apps/api/src/database/database.service';
import { businessDate } from '../apps/api/src/dashboard/time';
import { InvitationService } from '../apps/api/src/invitations/invitation.service';
import { NotificationsService } from '../apps/api/src/notifications/notifications.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { UsersService } from '../apps/api/src/users/users.service';
import { setupTestDatabase } from './helpers';

async function concurrentAccountChange(operation:'upload'|'read',action:'disable'|'delete') {
  assert.ok(process.env.TEST_DATABASE_URL,'This lock-scheduling regression requires disposable PostgreSQL.');
  const database = await setupTestDatabase();
  let allowDisable!: () => void;
  let disableLocked!: () => void;
  const locked = new Promise<void>(resolve => { disableLocked = resolve; });
  const proceed = new Promise<void>(resolve => { allowDisable = resolve; });
  try {
    const seed = await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1",[seed.orgId]);
    const access = new AccessService(database.db);
    const admin = await access.membership(seed.adminId,seed.orgId);
    const booking = await new BookingsService(database.db,access).create(admin,seed.customerId,{
      reference:`CONCURRENT-${randomUUID()}`,departure_at:'2030-01-01T12:00:00Z',required_services:[],
      amount:'100.00',effective_date:businessDate(),idempotency_key:randomUUID(),
    });
    const disableDatabase = Object.create(database.db) as DatabaseService;
    disableDatabase.transaction = work => database.db.transaction(client => work(new Proxy(client,{
      get(target,property) {
        if (property !== 'query') return Reflect.get(target,property);
        return async (sql:string,params:unknown[]) => {
          const result = await target.query(sql,params);
          if (sql === 'SELECT id FROM organizations WHERE id=$1 FOR UPDATE') {
            disableLocked();
            await proceed;
          }
          return result;
        };
      },
    }) as PoolClient));
    const notifications = new NotificationsService();
    const users = new UsersService(disableDatabase,new AccessService(disableDatabase),
      new InvitationService(disableDatabase,new AccessService(disableDatabase),new AuthService(disableDatabase,notifications),notifications));
    const disable = action==='disable' ? users.update(admin,seed.customerMember.id,'disable')
      : users.deleteCustomer(admin,seed.customerId,'customer@example.test');
    // Attach a rejection handler immediately while coordinating competing transactions.
    void disable.catch(() => undefined);
    await Promise.race([locked,disable.then(() => { throw new Error('Disable finished before the concurrency checkpoint.'); })]);
    let paymentPid = 0;
    const paymentDatabase = Object.create(database.db) as DatabaseService;
    paymentDatabase.transaction = work => database.db.transaction(async client => {
      paymentPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      return work(client);
    });
    const payments = new PaymentsService(paymentDatabase,new AccessService(paymentDatabase));
    const upload = operation==='upload' ? payments.authorizeUpload(seed.customerMember,seed.customerId,booking.id)
      : payments.list(seed.customerMember,seed.customerId,booking.id);
    void upload.catch(() => undefined);
    let blocked = false;
    for (let attempt=0;attempt<200;attempt++) {
      if (paymentPid) {
        const activity = await database.db.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[paymentPid]);
        if (activity.rows[0]?.wait_event_type === 'Lock') { blocked = true; break; }
      }
      await new Promise(resolve => setTimeout(resolve,10));
    }
    allowDisable();
    const results = await Promise.allSettled([disable,upload]);
    assert.equal(blocked,true,`Payment ${operation} must overlap the account ${action} transaction.`);
    assert.equal(results[0].status,'fulfilled',`Account ${action} failed: ${results[0].status==='rejected' ? String(results[0].reason) : ''}`);
    assert.equal(results[1].status,'rejected','Revoked customer must not receive payment access.');
    if (results[1].status==='rejected') assert.equal(results[1].reason.getStatus?.(),404,
      `Expected access denial, received ${String(results[1].reason)}`);
    const membership = (await database.db.query('SELECT is_active FROM memberships WHERE id=$1',[seed.customerMember.id])).rows[0];
    if (action==='disable') assert.equal(membership.is_active,false);
    else assert.equal(membership,undefined);
  } finally {
    allowDisable();
    await database.close();
  }
}
for (const operation of ['upload','read'] as const) for (const action of ['disable','delete'] as const)
  it(`serializes payment ${operation} with account ${action} without deadlocking`,
    {skip:!process.env.TEST_DATABASE_URL,timeout:30_000},() => concurrentAccountChange(operation,action));
