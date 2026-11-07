import 'reflect-metadata';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';

async function workspaceOrigin(): Promise<string> {
  try {
    const status = JSON.parse(await readFile(resolve('.local/local-status.json'), 'utf8')) as { publicUrl?: string; url?: string };
    const url = new URL(status.publicUrl ?? status.url ?? '');
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.origin;
  } catch { /* A database may be seeded before the local server has started. */ }
  return 'http://localhost:3000';
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Demo fixtures cannot run in production.');
  const { values } = parseArgs({ options: { 'admin-email': { type: 'string' }, verify: { type: 'boolean' } } });
  process.env.NODE_ENV = 'development';
  // This command never loads .env, Resend credentials, or application workers.
  process.env.EMAIL_MODE = 'file';
  const [{ openLocalDatabase }, { seedDemoWorkspace, verifyDemoWorkspace }] = await Promise.all([import('./local-database'), import('./demo-seed')]);
  const local = await openLocalDatabase();
  try {
    let report;
    if (values.verify) {
      report = await verifyDemoWorkspace(local.db);
      if (!report.customers) throw new Error('The demo workspace has not been imported yet. Run seed:demo without --verify first.');
    } else {
      const email = values['admin-email'] ? z.email().parse(values['admin-email'].trim()).toLowerCase() : null;
      const admins = await local.db.query<{ id: string }>(`SELECT DISTINCT u.id FROM users u
        JOIN memberships m ON m.user_id=u.id
        WHERE m.role='admin' AND m.is_active AND m.deleted_at IS NULL AND ($1::text IS NULL OR u.email=$1)`, [email]);
      if (!admins.rows.length) throw new Error('Start LedgerBook and provision an active administrator before importing fixtures.');
      if (admins.rows.length !== 1) throw new Error('More than one administrator exists. Choose the demo workspace owner with --admin-email.');
      report = await seedDemoWorkspace(local.db, admins.rows[0].id);
    }
    const output = { ...report, workspaceUrl: `${await workspaceOrigin()}/o/${report.organizationId}`, notifications: 'No fixture notifications enqueued', customerLogins: 'Disabled; use the existing administrator' };
    await mkdir(resolve('.local'), { recursive: true, mode: 0o700 });
    await writeFile(resolve('.local/demo-seed-report.json'), JSON.stringify(output, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(output, null, 2));
  } finally { await local.close(); }
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Demo import failed.'); process.exitCode = 1; });
