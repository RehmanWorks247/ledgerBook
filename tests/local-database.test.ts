import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openLocalDatabase } from '../scripts/local-database';

describe('persistent local development database', () => {
  let directory: string;
  let originalMode: string | undefined;
  before(async () => {
    originalMode = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    await mkdir(resolve('.local'), { recursive: true });
    directory = await mkdtemp(resolve('.local', 'database-test-'));
  });
  after(async () => {
    if (originalMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalMode;
    // Test-created temporary tree only; never remove the normal database path.
    const target = resolve(directory);
    assert.ok(target.startsWith(`${resolve('.local')}${sep}database-test-`));
    await rm(target, { recursive: true, force: true });
  });

  it('persists records and migration checksums across a clean close and reopen', async () => {
    const path = resolve(directory, 'persist');
    let local = await openLocalDatabase({ directory: path });
    const id = randomUUID();
    await local.db.query('INSERT INTO organizations(id,name,currency,currency_exponent) VALUES($1,$2,$3,$4)', [id, 'Local business', 'PKR', 2]);
    assert.equal((await local.db.query('SELECT 9223372036854775807::bigint AS exact')).rows[0].exact, '9223372036854775807');
    assert.equal((await local.db.query('SELECT * FROM organizations')).rowCount, 1);
    await Promise.all([local.close(), local.close()]);
    local = await openLocalDatabase({ directory: path });
    try {
      assert.equal((await local.db.query('SELECT name FROM organizations WHERE id=$1', [id])).rows[0].name, 'Local business');
      const migrations = (await readdir(resolve('apps/api/src/database/migrations'))).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name));
      assert.equal((await local.db.query('SELECT count(*)::int AS total FROM schema_migrations')).rows[0].total, migrations.length);
    } finally { await local.close(); }
  });

  it('rejects a second owner, rolls back failures, and serializes complete transactions', async () => {
    const path = resolve(directory, 'locks');
    const local = await openLocalDatabase({ directory: path });
    try {
      await assert.rejects(openLocalDatabase({ directory: path }), /already open/);
      await local.db.query('CREATE TABLE local_counter(value int NOT NULL)');
      await local.db.query('INSERT INTO local_counter(value) VALUES(0)');
      await assert.rejects(local.db.transaction(async (client) => {
        await client.query('UPDATE local_counter SET value=99');
        throw new Error('Expected rollback');
      }), /Expected rollback/);
      await Promise.all(Array.from({ length: 12 }, () => local.db.transaction(async (client) => {
        const row = await client.query<{ value: number }>('SELECT value FROM local_counter');
        await new Promise<void>((done) => setImmediate(done));
        await client.query('UPDATE local_counter SET value=$1', [row.rows[0].value + 1]);
      })));
      assert.equal((await local.db.query('SELECT value FROM local_counter')).rows[0].value, 12);
    } finally { await local.close(); }
  });

  it('refuses edited applied migrations and releases its process lock after startup failure', async () => {
    const migrations = resolve(directory, 'migrations');
    const data = resolve(directory, 'migration-check');
    await cp(resolve('apps/api/src/database/migrations'), migrations, { recursive: true });
    const local = await openLocalDatabase({ directory: data, migrationsDirectory: migrations });
    await local.close();
    const migration = resolve(migrations, '001_initial.sql');
    const source = await readFile(migration, 'utf8');
    await writeFile(migration, `${source}\n-- deliberate test edit\n`);
    await assert.rejects(openLocalDatabase({ directory: data, migrationsDirectory: migrations }), /has changed/);
    await writeFile(migration, source);
    const restored = await openLocalDatabase({ directory: data, migrationsDirectory: migrations });
    await restored.close();
  });

  it('recovers a confirmed dead owner without allowing two simultaneous new owners', async () => {
    const exited = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true });
    assert.equal(exited.status, 0);
    const pid = Number(exited.stdout);
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    const data = resolve(directory, 'stale-owner');
    const lock = `${data}.lock`;
    const nonce = randomUUID();
    await mkdir(lock);
    await writeFile(resolve(lock, `owner-${nonce}.json`), JSON.stringify({ pid, nonce, created_at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    const starts = await Promise.allSettled([openLocalDatabase({ directory: data }), openLocalDatabase({ directory: data })]);
    const opened = starts.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof openLocalDatabase>>> => item.status === 'fulfilled');
    assert.equal(opened.length, 1);
    assert.equal(starts.filter((item) => item.status === 'rejected').length, 1);
    try { assert.equal((await opened[0].value.db.query('SELECT 1 AS ready')).rows[0].ready, 1); }
    finally { await opened[0].value.close(); }
  });

  it('rejects production mode and paths outside the local data directory', async () => {
    process.env.NODE_ENV = 'production';
    await assert.rejects(openLocalDatabase(), /requires NODE_ENV/);
    process.env.NODE_ENV = 'test';
    await assert.rejects(openLocalDatabase({ directory: resolve('data-not-local') }), /must stay inside/);
  });
});
