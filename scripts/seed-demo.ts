import 'reflect-metadata';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Demo fixtures cannot run in production.');
  const { values } = parseArgs({ options: { 'admin-email': { type: 'string' }, verify: { type: 'boolean' } } });
  process.env.NODE_ENV = 'development';
  // This command never loads .env, Resend credentials, or application workers.
  process.env.EMAIL_MODE = 'file';
  const [{ openLocalDatabase }, { seedDemoWorkspace, verifyDemoWorkspace }] = await Promise.all([import('./local-database'), import('./demo-seed')]);
  const local = await openLocalDatabase();
  try {
    const credentials = values['admin-email'] ? undefined : JSON.parse(await readFile(resolve('.local/admin-login.json'), 'utf8')) as { email: string };
    const email = z.email().parse(values['admin-email'] ?? credentials?.email).toLowerCase();
    const admin = await local.db.query<{ id: string }>('SELECT id FROM users WHERE email=$1', [email]);
    if (!admin.rows.length) throw new Error('Start LedgerBook and provision its administrator before importing fixtures.');
    const report = values.verify ? await verifyDemoWorkspace(local.db) : await seedDemoWorkspace(local.db, admin.rows[0].id);
    const output = { ...report, workspaceUrl: `http://localhost:3000/o/${report.organizationId}`, notifications: 'No fixture notifications enqueued', customerLogins: 'Disabled; use the existing administrator' };
    await mkdir(resolve('.local/demo-preview'), { recursive: true });
    await writeFile(resolve('.local/demo-seed-report.json'), JSON.stringify(output, null, 2) + '\n');
    console.log(JSON.stringify(output, null, 2));
  } finally { await local.close(); }
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Demo import failed.'); process.exitCode = 1; });
