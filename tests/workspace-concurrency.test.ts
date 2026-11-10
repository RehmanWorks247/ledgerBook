// Independent PostgreSQL connections are required to exercise production locks.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import type { PoolClient } from 'pg';
import { AccessService } from '../apps/api/src/access/access.service';
import type { DatabaseService } from '../apps/api/src/database/database.service';
import { LedgerService } from '../apps/api/src/ledger/ledger.service';
import { OrganizationsService } from '../apps/api/src/organizations/organizations.service';
import { setupTestDatabase } from './helpers';

const options = { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 };
function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
async function waitForDatabaseLock(db: DatabaseService, pid: () => number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const backend = pid();
    if (backend && (await db.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [backend])).rows[0]?.wait_event_type === 'Lock') return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('The competing transaction did not reach its expected database lock.');
}

it('serializes concurrent workspace retries into one organization, membership, request and audit', options, async () => {
  const database = await setupTestDatabase();
  try {
    const seed = await database.seed();
    const service = new OrganizationsService(database.db, new AccessService(database.db));
    const request = { name: 'Concurrent creation', description: 'One workspace', idempotency_key: randomUUID() };
    const results = await Promise.all(Array.from({ length: 12 }, () => service.create(seed.adminId, request)));
    for (const result of results) assert.deepEqual(result, results[0]);
    const id = results[0].id;
    for (const [table, predicate, values] of [
      ['organizations', 'id=$1', [id]],
      ['memberships', 'organization_id=$1', [id]],
      ['workspace_create_requests', 'actor_id=$1 AND idempotency_key=$2', [seed.adminId, request.idempotency_key]],
      ['audit_events', "organization_id=$1 AND action='workspace.created'", [id]],
    ] as const) assert.equal((await database.db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${predicate}`, [...values])).rows[0].n, 1, table);
  } finally { await database.close(); }
});

it('allows exactly one competing profile edit per expected version without lost updates', options, async () => {
  const database = await setupTestDatabase();
  try {
    const seed = await database.seed();
    const service = new OrganizationsService(database.db, new AccessService(database.db));
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
      service.update(seed.adminId, seed.orgId, { name: `Concurrent edit ${index}`, expected_version: 1 })));
    const successes = results.filter(result => result.status === 'fulfilled');
    const conflicts = results.filter(result => result.status === 'rejected');
    assert.equal(successes.length, 1);
    assert.equal(conflicts.length, 7);
    for (const conflict of conflicts) assert.equal(conflict.reason.getStatus?.(), 409, String(conflict.reason));
    const current = await service.get(seed.adminId, seed.orgId);
    assert.equal(current.name, successes[0].value.name);
    assert.equal(current.version, 2);
    assert.equal((await database.db.query("SELECT count(*)::int AS n FROM audit_events WHERE organization_id=$1 AND action='workspace.updated'", [seed.orgId])).rows[0].n, 1);
  } finally { await database.close(); }
});

for (const operation of ['read', 'ledger write', 'workspace create'] as const) {
  const title = operation === 'workspace create'
    ? 'grants a waiting creator fresh-workspace access after their last workspace is deleted'
    : `blocks a concurrent ${operation} behind workspace deletion and rejects it after commit`;
  it(title, options, async () => {
    const database = await setupTestDatabase();
    const locked = gate(), proceed = gate();
    const active: Promise<unknown>[] = [];
    try {
      const seed = await database.seed();
      const deletionDb = Object.create(database.db) as DatabaseService;
      deletionDb.transaction = work => database.db.transaction(client => work(new Proxy(client, {
        get(target, property) {
          if (property !== 'query') return Reflect.get(target, property);
          return async (sql: string, params: unknown[]) => {
            const result = await target.query(sql, params);
            if (sql.includes('FROM organizations WHERE id=$1 FOR UPDATE')) { locked.release(); await proceed.promise; }
            return result;
          };
        },
      }) as PoolClient));
      const removal = new OrganizationsService(deletionDb, new AccessService(deletionDb)).remove(seed.adminId, seed.orgId,
        { confirmation_name: 'North Trading', expected_version: 1 });
      active.push(removal); void removal.catch(() => undefined);
      await Promise.race([locked.promise, removal.then(() => { throw new Error('Deletion missed its row-lock checkpoint.'); })]);
      let competingPid = 0;
      const competingDb = Object.create(database.db) as DatabaseService;
      competingDb.transaction = work => database.db.transaction(async client => {
        competingPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        return work(client);
      });
      const access = new AccessService(competingDb);
      const competing = operation === 'read'
        ? new OrganizationsService(competingDb, access).get(seed.customerUserId, seed.orgId)
        : operation === 'ledger write' ? new LedgerService(competingDb, access).post(seed.admin, seed.customerId, {
          kind: 'charge', amount: '1.00', effective_date: '2026-11-10', description: 'Must not be posted', idempotency_key: randomUUID(),
        }) : new OrganizationsService(competingDb, access).create(seed.adminId, { name: 'Replacement workspace', idempotency_key: randomUUID() });
      active.push(competing); void competing.catch(() => undefined);
      await waitForDatabaseLock(database.db, () => competingPid);
      proceed.release();
      const results = await Promise.allSettled([removal, competing]);
      assert.equal(results[0].status, 'fulfilled', results[0].status === 'rejected' ? String(results[0].reason) : '');
      if (operation === 'workspace create') {
        assert.equal(results[1].status, 'fulfilled', results[1].status === 'rejected' ? String(results[1].reason) : '');
        if (results[1].status === 'fulfilled') {
          assert.equal((await access.membership(seed.adminId, results[1].value.id, true)).role, 'admin');
        }
      } else {
        assert.equal(results[1].status, 'rejected');
        if (results[1].status === 'rejected') assert.equal(results[1].reason.getStatus?.(), 404, String(results[1].reason));
      }
      assert.equal((await database.db.query('SELECT count(*)::int AS n FROM organizations WHERE id=$1', [seed.orgId])).rows[0].n, 0);
      assert.equal((await database.db.query('SELECT count(*)::int AS n FROM ledger_entries WHERE organization_id=$1', [seed.orgId])).rows[0].n, 0);
    } finally { proceed.release(); await Promise.allSettled(active); await database.close(); }
  });
}

it('lets an authorized in-flight write commit before deletion then purges that write without deadlocking', options, async () => {
  const database = await setupTestDatabase();
  const locked = gate(), proceed = gate();
  const active: Promise<unknown>[] = [];
  try {
    const seed = await database.seed();
    const writerDb = Object.create(database.db) as DatabaseService;
    writerDb.transaction = work => database.db.transaction(client => work(new Proxy(client, {
      get(target, property) {
        if (property !== 'query') return Reflect.get(target, property);
        return async (sql: string, params: unknown[]) => {
          const result = await target.query(sql, params);
          if (sql === 'SELECT id FROM organizations WHERE id=$1 AND deleted_at IS NULL FOR SHARE') { locked.release(); await proceed.promise; }
          return result;
        };
      },
    }) as PoolClient));
    const write = new LedgerService(writerDb, new AccessService(writerDb)).post(seed.admin, seed.customerId, {
      kind: 'charge', amount: '2.00', effective_date: '2026-11-10', description: 'Written before deletion', idempotency_key: randomUUID(),
    });
    active.push(write); void write.catch(() => undefined);
    await Promise.race([locked.promise, write.then(() => { throw new Error('Writer missed its row-lock checkpoint.'); })]);
    let deletionPid = 0;
    const deletionDb = Object.create(database.db) as DatabaseService;
    deletionDb.transaction = work => database.db.transaction(async client => {
      deletionPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      return work(client);
    });
    const removal = new OrganizationsService(deletionDb, new AccessService(deletionDb)).remove(seed.adminId, seed.orgId,
      { confirmation_name: 'North Trading', expected_version: 1 });
    active.push(removal); void removal.catch(() => undefined);
    await waitForDatabaseLock(database.db, () => deletionPid);
    proceed.release();
    const results = await Promise.allSettled([write, removal]);
    for (const result of results) assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? String(result.reason) : '');
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM ledger_entries WHERE organization_id=$1', [seed.orgId])).rows[0].n, 0);
  } finally { proceed.release(); await Promise.allSettled(active); await database.close(); }
});
