import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';
import type { PoolConfig } from 'pg';

interface DatabasePoolSettings {
  connectionString: string;
  ssl: boolean;
  production: boolean;
  poolSize: number;
  caFile?: string;
}

/** Keep node-postgres URL parsing from overriding certificate verification. */
export function databasePoolConfig(settings: DatabasePoolSettings): PoolConfig {
  let url: URL;
  try { url = new URL(settings.connectionString); }
  catch { throw new Error('Database connection must be a valid PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash) {
    throw new Error('Database connection must be a valid PostgreSQL URL with a hostname.');
  }
  const mode = url.searchParams.get('sslmode');
  const flag = url.searchParams.get('ssl');
  if (mode && !['disable', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(mode)) {
    throw new Error('Database sslmode must enable certificate verification or explicitly disable local TLS.');
  }
  if (flag && !['true', '1', 'false', '0'].includes(flag)) {
    throw new Error('Database ssl must be true or false; unverified TLS is not supported.');
  }
  const disabled = mode === 'disable' || flag === 'false' || flag === '0';
  const requested = Boolean((mode && mode !== 'disable') || flag === 'true' || flag === '1'
    || url.searchParams.get('sslrootcert') || url.searchParams.get('sslcert') || url.searchParams.get('sslkey')
    || url.searchParams.get('sslnegotiation') === 'direct' || settings.caFile);
  if (disabled && (settings.production || settings.ssl || requested)) {
    throw new Error('Database TLS settings conflict: production and verified TLS cannot use sslmode=disable.');
  }
  const tls = settings.production || settings.ssl || requested;
  const ssl: ConnectionOptions = { rejectUnauthorized: true, minVersion: 'TLSv1.2' };
  for (const [parameter, property] of [['sslrootcert', 'ca'], ['sslcert', 'cert'], ['sslkey', 'key']] as const) {
    const path = parameter === 'sslrootcert' ? settings.caFile ?? url.searchParams.get(parameter) : url.searchParams.get(parameter);
    if (path && !(parameter === 'sslrootcert' && path === 'system')) {
      try { ssl[property] = readFileSync(path, 'utf8'); }
      catch { throw new Error(`Cannot read database ${parameter} certificate file.`); }
    }
  }
  // These query parameters otherwise replace `ssl` during pg connection parsing.
  for (const name of ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) url.searchParams.delete(name);
  return {
    connectionString: url.toString(),
    ssl: tls ? ssl : false,
    max: settings.poolSize,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
    idle_in_transaction_session_timeout: 15000,
    keepAlive: true,
    enableChannelBinding: true,
    application_name: 'ledgerbook',
  };
}

export function migrationDatabaseUrl(environment: NodeJS.ProcessEnv, fallback: string): string {
  const direct = environment.DATABASE_MIGRATION_URL;
  if (direct !== undefined && !direct.trim()) throw new Error('DATABASE_MIGRATION_URL must not be empty when set.');
  return direct ?? fallback;
}
