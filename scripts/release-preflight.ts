import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from '../apps/api/src/config';
import { DatabaseService } from '../apps/api/src/database/database.service';
import { documentStorageOptions } from '../apps/api/src/bookings/document-storage';

/** Read-only release check. Does not migrate, create accounts or send messages. */
export async function releasePreflight(checkOrigin=false) {
  if(!config.production) throw new Error('Preflight requires NODE_ENV=production.');
  if(!config.clerkPublishableKey?.startsWith('pk_live_') || !config.clerkSecretKey?.startsWith('sk_live_')) throw new Error('Use a Clerk production instance for release.');
  if(!config.resendWebhookSecret) throw new Error('Configure RESEND_WEBHOOK_SECRET and the delivery webhook before release.');
  if(process.env.PUBLIC_HOST && new URL(config.appUrl).hostname!==process.env.PUBLIC_HOST) throw new Error('PUBLIC_HOST must match PUBLIC_APP_URL.');
  const storage=documentStorageOptions();
  if(storage.mode==='database') throw new Error('Production documents require private R2 or S3 storage.');
  const db=new DatabaseService();
  try {
    const health=await db.query<{version:number;read_only:string}>('SELECT current_setting(\'server_version_num\')::integer AS version,current_setting(\'transaction_read_only\') AS read_only');
    if(health.rows[0].version<150000 || health.rows[0].read_only!=='off') throw new Error('Production needs a writable PostgreSQL 15 or newer.');
    const files=(await readdir(resolve('apps/api/src/database/migrations'))).filter(name=>/^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
    const applied=await db.query<{name:string;checksum:string}>('SELECT name,checksum FROM schema_migrations');
    for(const name of files) {
      const checksum=createHash('sha256').update(await readFile(resolve('apps/api/src/database/migrations',name))).digest('hex');
      if(applied.rows.find(row=>row.name===name)?.checksum!==checksum) throw new Error(`Migration ${name} is missing or has a different checksum. Apply the reviewed release migrations first.`);
    }
    if(applied.rows.some(row=>!files.includes(row.name))) throw new Error('Database has newer migrations than this application image.');
    // Authorization and private storage metadata must be accessible to the runtime role.
    await db.query('SELECT 1 FROM memberships m JOIN bookings b ON b.organization_id=m.organization_id LEFT JOIN booking_operations o ON o.booking_id=b.id LEFT JOIN document_versions v ON false LIMIT 0');
    await db.query('SELECT o.description,o.color,o.version,u.workspace_creator FROM organizations o JOIN memberships m ON m.organization_id=o.id JOIN users u ON u.id=m.user_id LEFT JOIN workspace_create_requests c ON false LEFT JOIN workspace_delete_receipts d ON false LIMIT 0');
    const workspacePrivileges=await db.query<{allowed:boolean}>(`SELECT has_function_privilege(current_user,
      'permanently_delete_workspace(uuid,uuid,text,integer,text)','EXECUTE') AS allowed`);
    if(!workspacePrivileges.rows[0]?.allowed) throw new Error('Deployment runtime grants are missing workspace deletion access. Apply deploy/runtime-grants.sql after migration.');
    if(checkOrigin) {
      const ready=await fetch(`${config.appUrl}/api/ready`,{signal:AbortSignal.timeout(10000),redirect:'error'});
      if(!ready.ok || (await ready.json() as {status?:string}).status!=='ready') throw new Error('Deployment readiness check failed.');
      const protectedRoute=await fetch(`${config.appUrl}/api/auth/session`,{signal:AbortSignal.timeout(10000),redirect:'error'});
      if(protectedRoute.status!==401) throw new Error('Deployment did not reject an anonymous request to its protected session route.');
    }
    return {status:'ready',migrations:files.length,database_major:Math.floor(health.rows[0].version/10000),storage:storage.mode,origin_checked:checkOrigin};
  } finally {await db.close();}
}
if(require.main===module) void releasePreflight(process.argv.includes('--origin')).then(result=>console.log(JSON.stringify(result))).catch(error=>{
  // Database/provider diagnostics can contain credentials. Only our fixed messages are printed.
  const message=error instanceof Error ? error.message : '';
  const safe=/^(Preflight|Use a Clerk|Configure RESEND|PUBLIC_HOST|Production documents|Production needs|Migration |Database has|Deployment )/.test(message);
  console.error(safe ? message : 'Release preflight failed. Verify private configuration, database access and applied migrations.');process.exitCode=1;
});
