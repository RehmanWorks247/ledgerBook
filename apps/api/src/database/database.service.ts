import { Inject, Injectable, Optional, type OnApplicationShutdown } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { config } from '../config';
import { databasePoolConfig } from './pool-config';

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  readonly pool: Pool;
  constructor(@Optional() @Inject('DATABASE_URL') connectionString?: string) {
    this.pool = new Pool(databasePoolConfig({
      connectionString: connectionString ?? config.databaseUrl,
      poolSize: config.poolSize,
      ssl: config.databaseSsl,
      production: config.production,
      caFile: process.env.DATABASE_SSL_CA_FILE,
    }));
    this.pool.on('error', () => console.error('An idle database connection failed.'));
  }
  query<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.pool.query<T>(sql, params);
  }
  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  async close(): Promise<void> { if (!this.pool.ended) await this.pool.end(); }
  async onApplicationShutdown(): Promise<void> { await this.close(); }
}
