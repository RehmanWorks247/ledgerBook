import assert from 'node:assert/strict';
import { Client } from 'pg';
import { describe, it } from 'node:test';
import { databasePoolConfig, migrationDatabaseUrl } from '../apps/api/src/database/pool-config';

const settings = { connectionString: 'postgresql://app:secret@localhost:5432/ledgerbook', ssl: false, production: false, poolSize: 10 };

describe('hosted PostgreSQL connection configuration', () => {
  it('preserves bounded local pooling without TLS and accepts a direct migration URL', () => {
    const pool = databasePoolConfig(settings);
    assert.equal(pool.ssl, false);
    assert.equal(pool.max, 10);
    assert.equal(pool.connectionTimeoutMillis, 5000);
    assert.equal(pool.statement_timeout, 15000);
    assert.equal(migrationDatabaseUrl({}, settings.connectionString), settings.connectionString);
    assert.equal(migrationDatabaseUrl({ DATABASE_MIGRATION_URL: 'postgresql://direct/db' }, settings.connectionString), 'postgresql://direct/db');
    assert.throws(() => migrationDatabaseUrl({ DATABASE_MIGRATION_URL: ' ' }, settings.connectionString), /must not be empty/);
  });

  it('keeps certificate and hostname verification after the actual pg URL parser runs', () => {
    for (const mode of ['require', 'prefer', 'verify-ca', 'verify-full']) {
      const pool = databasePoolConfig({ ...settings, connectionString: `${settings.connectionString}?sslmode=${mode}&uselibpqcompat=true&options=-c%20search_path%3Dtest` });
      const client = new Client(pool);
      assert.equal(typeof client.ssl, 'object');
      assert.equal((client.ssl as unknown as { rejectUnauthorized?: boolean }).rejectUnauthorized, true);
      assert.equal((client.ssl as unknown as { checkServerIdentity?: unknown }).checkServerIdentity, undefined);
      assert.equal(new URL(pool.connectionString!).searchParams.get('options'), '-c search_path=test');
      assert.equal(new URL(pool.connectionString!).searchParams.has('sslmode'), false);
    }
  });

  it('enforces TLS in production even without a URL flag and refuses insecure overrides', () => {
    const client = new Client(databasePoolConfig({ ...settings, production: true }));
    assert.equal((client.ssl as unknown as { rejectUnauthorized?: boolean }).rejectUnauthorized, true);
    for (const query of ['sslmode=no-verify', 'ssl=no-verify', 'sslmode=disable', 'ssl=false', 'ssl=0']) {
      assert.throws(() => databasePoolConfig({ ...settings, production: true, connectionString: `${settings.connectionString}?${query}` }), /TLS|ssl/);
    }
    assert.throws(() => databasePoolConfig({ ...settings, ssl: true, connectionString: `${settings.connectionString}?sslmode=disable` }), /conflict/);
  });

  it('does not leak connection credentials in invalid URL or CA errors', () => {
    assert.throws(() => databasePoolConfig({ ...settings, connectionString: 'secret:broken:password' }), error => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /secret|password/);
      return true;
    });
    assert.throws(() => databasePoolConfig({ ...settings, caFile: 'missing-private-certificate.pem' }), /Cannot read database sslrootcert certificate file/);
  });
});
