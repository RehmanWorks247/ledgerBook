import { mkdir, open, stat } from 'node:fs/promises';
import { resolve, sep, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { openLocalDatabase } from './local-database';

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Local export cannot run with NODE_ENV=production.');
  process.env.NODE_ENV = 'development';
  const { values } = parseArgs({ options: { output: { type: 'string' } } });
  const localRoot = resolve('.local');
  const source = resolve(localRoot, 'database');
  // Refuse to create an empty database when the expected local source is absent.
  await stat(resolve(source, 'PG_VERSION')).catch(() => { throw new Error('No existing local PostgreSQL database was found.'); });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const output = resolve(values.output ?? resolve(localRoot, 'exports', `ledgerbook-${stamp}.sql`));
  if (!output.startsWith(`${localRoot}${sep}`) || output.startsWith(`${source}${sep}`)) {
    throw new Error('Store this private export inside .local, outside the database directory.');
  }
  // The existing process lock prevents exports while the application is running.
  // Skip migrations: an export must not change the source's schema version.
  const database = await openLocalDatabase({ directory: source, migrate: false });
  try {
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    const handle = await open(output, 'wx', 0o600);
    try {
      const sql = await database.exportSql();
      await handle.writeFile(sql, 'utf8');
      await handle.sync();
      console.log(`Exported local PostgreSQL schema and data to ${output}`);
      console.log('The export contains private customer, document and account data. Restore only into an empty database.');
    } finally { await handle.close(); }
  } finally { await database.close(); }
}

void main().catch(error => {
  const known = error instanceof Error && /Local export|existing local|Store this private|already open|EEXIST/.test(error.message);
  console.error(known ? error.message : 'Local database export failed. Check that the app is stopped and the destination is writable.');
  process.exitCode = 1;
});
