import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { DatabaseService } from '../apps/api/src/database/database.service';
import { AccessService, type Membership } from '../apps/api/src/access/access.service';
import { hashPassword } from '../apps/api/src/auth/crypto';

export const integrationEnabled = true;
export const integrationBackend = process.env.TEST_DATABASE_URL ? 'postgres' : 'pglite';
export const testPassword = 'Test-only password 47!';

export interface TestSeed {
  orgId: string;
  otherOrgId: string;
  adminId: string;
  otherAdminId: string;
  customerUserId: string;
  customerId: string;
  secondCustomerId: string;
  otherCustomerId: string;
  admin: Membership;
  otherAdmin: Membership;
  customerMember: Membership;
}

export interface TestDatabase {
  db: DatabaseService;
  close(): Promise<void>;
  seed(): Promise<TestSeed>;
}

/**
 * Every suite gets a fresh schema or a fresh PostgreSQL WASM instance. PGlite
 * exercises real SQL, foreign keys and triggers; TEST_DATABASE_URL additionally
 * exercises independent connections and PostgreSQL's production row locks.
 */
export async function setupTestDatabase(): Promise<TestDatabase> {
  const directory = resolve('apps/api/src/database/migrations');
  const names = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  const migration = (await Promise.all(names.map((name) => readFile(resolve(directory, name), 'utf8')))).join('\n');
  let db: DatabaseService;
  let close: () => Promise<void>;

  if (process.env.TEST_DATABASE_URL) {
    const schema = `test_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const connectionUrl = new URL(process.env.TEST_DATABASE_URL);
    connectionUrl.searchParams.set('options', `-c search_path=${schema}`);
    db = new DatabaseService(connectionUrl.toString());
    try {
      await db.query(migration);
    } catch (error) {
      await db.close();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
      throw error;
    }
    close = async () => {
      await db.close();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    };
  } else {
    const engine = new PGlite();
    await engine.exec(migration);
    // pg returns int8/numeric as strings, which is a required API invariant.
    const parsers = { 20: (value: string) => value, 1700: (value: string) => value };
    const query = async <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> => {
      const result = await engine.query<T>(sql, params, { parsers });
      return {
        rows: result.rows,
        // PGlite reports affectedRows=0 for SELECT even when rows are returned.
        rowCount: result.affectedRows || result.rows.length,
        command: sql.trimStart().split(/\s/, 1)[0].toUpperCase(),
        oid: 0,
        fields: [],
      };
    };
    // One PGlite instance is one connection. Queue complete transactions so
    // requests cannot interleave BEGIN/COMMIT on that connection.
    let queue: Promise<unknown> = Promise.resolve();
    const serial = <T>(callback: () => Promise<T>): Promise<T> => {
      const pending = queue.then(callback, callback);
      queue = pending.catch(() => undefined);
      return pending;
    };
    db = {
      query: <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) => serial(() => query<T>(sql, params)),
      transaction: <T>(callback: (client: PoolClient) => Promise<T>) => serial(async () => {
        await engine.exec('BEGIN');
        try {
          const result = await callback({ query } as unknown as PoolClient);
          await engine.exec('COMMIT');
          return result;
        } catch (error) {
          await engine.exec('ROLLBACK');
          throw error;
        }
      }),
      close: async () => { await queue; await engine.close(); },
      onModuleDestroy: async () => undefined,
    } as unknown as DatabaseService;
    close = () => db.close();
  }

  return { db, close, seed: () => seedDatabase(db) };
}

async function seedDatabase(db: DatabaseService): Promise<TestSeed> {
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const adminId = randomUUID();
  const otherAdminId = randomUUID();
  const customerUserId = randomUUID();
  const customerId = randomUUID();
  const secondCustomerId = randomUUID();
  const otherCustomerId = randomUUID();
  const passwordHash = await hashPassword(testPassword);
  await db.transaction(async (client) => {
    for (const [id, name] of [[orgId, 'North Trading'], [otherOrgId, 'South Trading']]) {
      await client.query('INSERT INTO organizations(id,name,currency,currency_exponent) VALUES($1,$2,$3,$4)', [id, name, 'USD', 2]);
    }
    for (const [id, email] of [[adminId, 'admin@example.test'], [otherAdminId, 'other-admin@example.test'], [customerUserId, 'customer@example.test']]) {
      await client.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [id, email, passwordHash]);
    }
    for (const [organization, user] of [[orgId, adminId], [otherOrgId, otherAdminId]]) {
      await client.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'admin')", [randomUUID(), organization, user]);
    }
    for (const [id, organization, name, email, creator] of [
      [customerId, orgId, 'Aster Studio', 'customer@example.test', adminId],
      [secondCustomerId, orgId, 'Beacon Store', 'beacon@example.test', adminId],
      [otherCustomerId, otherOrgId, 'Cedar Supply', 'cedar@example.test', otherAdminId],
    ]) {
      await client.query(
        'INSERT INTO customers(id,organization_id,name,email,created_by,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [id, organization, name, email, creator, randomUUID(), '0'.repeat(64)],
      );
    }
    await client.query("INSERT INTO memberships(id,organization_id,user_id,role,customer_id) VALUES($1,$2,$3,'customer',$4)", [randomUUID(), orgId, customerUserId, customerId]);
  });
  const access = new AccessService(db);
  return {
    orgId, otherOrgId, adminId, otherAdminId, customerUserId, customerId, secondCustomerId, otherCustomerId,
    admin: await access.membership(adminId, orgId),
    otherAdmin: await access.membership(otherAdminId, otherOrgId),
    customerMember: await access.membership(customerUserId, orgId),
  };
}
