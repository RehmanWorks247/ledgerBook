import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseService } from '../apps/api/src/database/database.service';
import { migrationDatabaseUrl } from '../apps/api/src/database/pool-config';
import { config } from '../apps/api/src/config';
import { renumberExistingInvoices } from '../apps/api/src/database/invoice-number-migration';

async function migrate() {
  const db=new DatabaseService(migrationDatabaseUrl(process.env,config.databaseUrl));
  try {
    await db.transaction(async client=>{
      // Schema changes may exceed the API's short per-query limit. Lock waits
      // stay bounded so competing deployments fail instead of waiting forever.
      await client.query("SET LOCAL statement_timeout = '5min'");
      await client.query("SET LOCAL lock_timeout = '15s'");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ledgerbook-migrations',0))");
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
      const directory=resolve('apps/api/src/database/migrations');
      const files=(await readdir(directory)).filter(name=>/^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
      for(const name of files) {
        const sql=await readFile(resolve(directory,name),'utf8');
        const checksum=createHash('sha256').update(sql).digest('hex');
        const existing=await client.query('SELECT checksum FROM schema_migrations WHERE name=$1',[name]);
        if(existing.rows[0]) {
          if(existing.rows[0].checksum!==checksum) throw new Error(`Applied migration ${name} has changed. Add a new migration instead.`);
          continue;
        }
        await client.query(sql);
        if(name==='030_sequential_invoice_numbers.sql') await renumberExistingInvoices(client);
        await client.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[name,checksum]);
        console.log(`Applied ${name}`);
      }
    });
  } finally { await db.close(); }
}
void migrate().catch(()=>{console.error('Migration failed. Verify database configuration and migration history.');process.exitCode=1;});
