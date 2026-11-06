import { PGlite, type Results } from '@electric-sql/pglite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rmdir, unlink } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { DatabaseService } from '../apps/api/src/database/database.service';

type LockOwner = { pid: number; nonce: string; created_at: string };

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

/**
 * A lock directory is the atomic acquisition boundary. Its owner filename is
 * unique, so stale recovery can never unlink a successor process's owner file.
 * A crash before writing the owner file fails closed and needs manual review.
 */
async function acquireLock(dataDirectory: string): Promise<() => Promise<void>> {
  const lockDirectory = `${dataDirectory}.lock`;
  const owner: LockOwner = { pid: process.pid, nonce: randomUUID(), created_at: new Date().toISOString() };
  const ownerFile = resolve(lockDirectory, `owner-${owner.nonce}.json`);
  await mkdir(dirname(lockDirectory), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      const names = await readdir(lockDirectory);
      if (names.length !== 1 || !/^owner-[0-9a-f-]{36}\.json$/.test(names[0])) {
        throw new Error('Local database lock is incomplete or changing. Confirm the previous process has stopped before inspecting its lock directory.', { cause: error });
      }
      const previousFile = resolve(lockDirectory, names[0]);
      let previous: LockOwner;
      try { previous = JSON.parse(await readFile(previousFile, 'utf8')) as LockOwner; }
      catch (readError) {
        if (errorCode(readError) === 'ENOENT') continue;
        throw new Error('Local database lock cannot be verified. It has not been removed.', { cause: readError });
      }
      if (!Number.isSafeInteger(previous.pid) || previous.pid < 1 || names[0] !== `owner-${previous.nonce}.json`) {
        throw new Error('Local database lock cannot be verified. It has not been removed.', { cause: error });
      }
      try {
        process.kill(previous.pid, 0);
        throw new Error(`The local database is already open by process ${previous.pid}. Stop that LedgerBook process before starting another.`, { cause: error });
      } catch (processError) {
        // A denied process probe is not evidence that its process is dead.
        if (errorCode(processError) !== 'ESRCH') throw processError;
      }
      const current = JSON.parse(await readFile(previousFile, 'utf8')) as LockOwner;
      if (current.nonce !== previous.nonce || current.pid !== previous.pid) continue;
      try { await unlink(previousFile); }
      catch (removeError) {
        if (errorCode(removeError) === 'ENOENT') continue;
        throw removeError;
      }
      // Only remove an empty directory. Never recursively remove a process lock.
      try { await rmdir(lockDirectory); }
      catch (removeError) {
        if (errorCode(removeError) !== 'ENOENT') throw removeError;
      }
      continue;
    }

    const handle = await open(ownerFile, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(owner), 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    return async () => {
      let current: LockOwner;
      try { current = JSON.parse(await readFile(ownerFile, 'utf8')) as LockOwner; }
      catch (error) { if (errorCode(error) === 'ENOENT') return; throw error; }
      if (current.nonce !== owner.nonce || current.pid !== owner.pid) {
        throw new Error('Local database lock ownership changed; the lock was preserved.');
      }
      await unlink(ownerFile);
      try { await rmdir(lockDirectory); }
      catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    };
  }
  throw new Error('Another LedgerBook process is acquiring the local database. Try again after it finishes.');
}

async function applyMigrations(engine: PGlite, directory: string): Promise<void> {
  await engine.exec('BEGIN');
  try {
    await engine.exec('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    const names = (await readdir(directory)).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
    for (const name of names) {
      const sql = await readFile(resolve(directory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await engine.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE name=$1', [name]);
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration ${name} has changed. Add a new migration instead.`);
        continue;
      }
      await engine.exec(sql);
      await engine.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [name, checksum]);
    }
    await engine.exec('COMMIT');
  } catch (error) {
    await engine.exec('ROLLBACK');
    throw error;
  }
}

export interface LocalDatabase {
  /** The application uses only query, transaction and shutdown on this adapter. */
  db: DatabaseService;
  dataDirectory: string;
  /** Logical PostgreSQL dump, for an offline export to an empty hosted database. */
  exportSql(): Promise<string>;
  close(): Promise<void>;
}

/**
 * Explicit, single-process development database. Production always uses the
 * PostgreSQL pool; this adapter is never selected by production configuration.
 */
export async function openLocalDatabase(options: { directory?: string; migrationsDirectory?: string; migrate?: boolean } = {}): Promise<LocalDatabase> {
  if (!['development', 'test'].includes(process.env.NODE_ENV ?? '')) {
    throw new Error('The local embedded database requires NODE_ENV=development or test.');
  }
  const localRoot = resolve('.local');
  const dataDirectory = resolve(options.directory ?? resolve(localRoot, 'database'));
  if (!dataDirectory.startsWith(`${localRoot}${sep}`)) {
    throw new Error('Local database files must stay inside this project’s .local directory.');
  }
  const releaseLock = await acquireLock(dataDirectory);
  let engine: PGlite | undefined;
  try {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    engine = new PGlite(dataDirectory, { relaxedDurability: false });
    await engine.waitReady;
    if (options.migrate !== false) await applyMigrations(engine, resolve(options.migrationsDirectory ?? 'apps/api/src/database/migrations'));
  } catch (error) {
    try { if (engine) await engine.close(); }
    finally { await releaseLock(); }
    throw error;
  }

  const activeEngine = engine;
  const parsers = { 20: (value: string) => value, 1700: (value: string) => value };
  const result = <T extends QueryResultRow>(sql: string, value: Results<T>): QueryResult<T> => ({
    rows: value.rows, rowCount: value.affectedRows || value.rows.length,
    command: sql.trimStart().split(/\s/, 1)[0].toUpperCase(), oid: 0, fields: [],
  });
  const query = async <T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> =>
    result(sql, await activeEngine.query<T>(sql, params, { parsers }));
  let pending: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;
  const serial = <T>(callback: () => Promise<T>): Promise<T> => {
    if (closing) return Promise.reject(new Error('The local database is shutting down.'));
    const job = pending.then(callback, callback);
    pending = job.catch(() => undefined);
    return job;
  };
  const close = (): Promise<void> => {
    if (!closing) {
      closing = pending.then(async () => {
        try { await activeEngine.close(); }
        finally { await releaseLock(); }
      });
    }
    return closing;
  };
  // PoolClient is the production callback shape. Business services call query
  // only, and serialization keeps each entire callback on one engine transaction.
  const db = {
    query: <T extends QueryResultRow = any>(sql: string, params: unknown[] = []) => serial(() => query<T>(sql, params)),
    transaction: <T>(work: (client: PoolClient) => Promise<T>) => serial(async () => {
      await activeEngine.exec('BEGIN');
      try {
        const value = await work({ query } as unknown as PoolClient);
        await activeEngine.exec('COMMIT');
        return value;
      } catch (error) {
        await activeEngine.exec('ROLLBACK');
        throw error;
      }
    }),
    close,
    onApplicationShutdown: close,
  } as unknown as DatabaseService;
  const exportSql = () => serial(async () => {
    const { pgDump } = await import('@electric-sql/pglite-tools');
    const dump = await pgDump({ pg: activeEngine, args: ['--no-owner', '--no-acl', '--schema=public', '--quote-all-identifiers'] });
    const sql = await dump.text();
    // Managed PostgreSQL already creates the standard empty public schema.
    // This still fails on existing application tables; it never overwrites them.
    // transaction_timeout was introduced in PG17; the dump also targets PG15/16.
    return sql.replace('\nCREATE SCHEMA "public";\n', '\nCREATE SCHEMA IF NOT EXISTS "public";\n')
      .replace('\nSET transaction_timeout = 0;\n', '\n');
  });
  return { db, dataDirectory, exportSql, close };
}
