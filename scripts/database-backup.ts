import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, link, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Pool, type PoolClient } from 'pg';
import { databasePoolConfig } from '../apps/api/src/database/pool-config';

export type BackupObject={id:string;bucket:string;object_key:string;checksum:string;size:number};
export type BackupManifest={format:1;schema:string;created_at:string;sha256:string;bytes:number;tables:Record<string,string>;ledger_total_minor:string;cloud_objects:string;referenced_objects:BackupObject[]};
const identifier=(name:string)=>`"${name.replaceAll('"','""')}"`;
function schemaName(env:NodeJS.ProcessEnv) {
  const schema=env.DATABASE_SCHEMA || 'public';
  if(!/^[a-z_][a-z0-9_]{0,62}$/.test(schema) || schema.startsWith('pg_') || schema==='information_schema') throw new Error('Use a valid application DATABASE_SCHEMA.');
  return schema;
}
function connection(value:string|undefined) {
  if(!value) throw new Error('Provide an explicit database connection URL.');
  const url=new URL(value);
  if(!['postgres:','postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1) || url.hash) throw new Error('Use a PostgreSQL URL with an explicit database name.');
  return url;
}
function pool(url:URL,env:NodeJS.ProcessEnv) {
  return new Pool(databasePoolConfig({connectionString:url.toString(),poolSize:1,production:env.NODE_ENV==='production',ssl:env.DATABASE_SSL==='true',caFile:env.DATABASE_SSL_CA_FILE}));
}
/** No connection URL, password or archive content is passed in process arguments. */
export function postgresToolEnvironment(url:URL,env:NodeJS.ProcessEnv) {
  const output:NodeJS.ProcessEnv={...env,PGHOST:url.hostname,PGPORT:url.port || '5432',PGDATABASE:decodeURIComponent(url.pathname.slice(1)),PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGCONNECT_TIMEOUT:'10'};
  for(const name of ['PGSERVICE','PGSERVICEFILE','PGOPTIONS','PGSSLKEY','PGSSLCERT','PGSSLROOTCERT']) delete output[name];
  const requestedTls=['prefer','require','verify-ca','verify-full'].includes(url.searchParams.get('sslmode') || '') || ['true','1'].includes(url.searchParams.get('ssl') || '')
    || Boolean(env.DATABASE_SSL_CA_FILE || url.searchParams.get('sslrootcert') || url.searchParams.get('sslcert') || url.searchParams.get('sslkey'));
  output.PGSSLMODE=env.NODE_ENV==='production' || env.DATABASE_SSL==='true' || requestedTls ? 'verify-full' : 'disable';
  if(env.DATABASE_SSL_CA_FILE) output.PGSSLROOTCERT=resolve(env.DATABASE_SSL_CA_FILE);
  for(const [parameter,key] of [['sslrootcert','PGSSLROOTCERT'],['sslcert','PGSSLCERT'],['sslkey','PGSSLKEY']] as const) if(url.searchParams.get(parameter) && !output[key]) output[key]=url.searchParams.get(parameter)!;
  if(output.PGSSLMODE==='verify-full' && !output.PGSSLROOTCERT) output.PGSSLROOTCERT='system';
  return output;
}
async function tool(name:'pg_dump'|'pg_restore',args:string[],url:URL,env:NodeJS.ProcessEnv,input?:string,output?:string) {
  const childEnv=postgresToolEnvironment(url,env);
  let binary:string=name,command=args;
  if(env.PG_TOOLS_MODE==='docker') {
    binary='docker';
    if(['127.0.0.1','localhost','[::1]'].includes(childEnv.PGHOST!)) childEnv.PGHOST='host.docker.internal';
    command=['run','--rm','-i','--add-host=host.docker.internal:host-gateway'];
    for(const key of Object.keys(childEnv).filter(key=>key.startsWith('PG') && !['PG_TOOLS_MODE','PG_TOOLS_IMAGE'].includes(key))) command.push('--env',key);
    for(const key of ['PGSSLROOTCERT','PGSSLCERT','PGSSLKEY']) if(childEnv[key] && childEnv[key]!=='system') command.push('--mount',`type=bind,src=${resolve(childEnv[key]!)},dst=${resolve(childEnv[key]!)},readonly`);
    command.push(env.PG_TOOLS_IMAGE || 'postgres:17-alpine',name,...args);
  }
  const child=spawn(binary,command,{env:childEnv,stdio:['pipe','pipe','pipe']});
  // Consume diagnostics but do not expose credentials that provider errors might echo.
  child.stderr.resume();
  const done=new Promise<void>((resolve,reject)=>{child.once('error',()=>reject(new Error('PostgreSQL command could not start. Install matching pg_dump/pg_restore or set PG_TOOLS_MODE=docker.')));
    child.once('close',code=>code===0?resolve():reject(new Error('PostgreSQL command failed. Check tool/server versions, network, database permissions and TLS.')));});
  const transfers:Promise<unknown>[]=[done];
  if(input) transfers.push(pipeline(createReadStream(input),child.stdin)); else child.stdin.end();
  if(output) transfers.push(pipeline(child.stdout,createWriteStream(output,{flags:'wx',mode:0o600}))); else child.stdout.resume();
  try {await Promise.all(transfers);} catch(error) {child.kill('SIGTERM');await Promise.allSettled(transfers);throw error;}
}
async function checksum(path:string) {
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function syncPath(path:string) {
  const handle=await open(path,'r');
  try {await handle.sync();} finally {await handle.close();}
}
async function inventory(client:PoolClient,schema:string) {
  const rows=await client.query<{tablename:string}>('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename',[schema]);
  const tables:Record<string,string>={};
  for(const {tablename} of rows.rows) tables[tablename]=(await client.query<{n:string}>(`SELECT count(*)::text AS n FROM ${identifier(schema)}.${identifier(tablename)}`)).rows[0].n;
  const ledger_total_minor=tables.ledger_entries ? (await client.query<{total:string}>(`SELECT coalesce(sum(amount_minor),0)::text AS total FROM ${identifier(schema)}.ledger_entries`)).rows[0].total : '0';
  const referenced_objects=tables.document_objects && tables.booking_nodes && tables.document_versions ? (await client.query<BackupObject>(`SELECT o.id,o.bucket,o.object_key,o.checksum,o.size FROM ${identifier(schema)}.document_objects o
    WHERE EXISTS(SELECT 1 FROM ${identifier(schema)}.booking_nodes n WHERE n.storage_object_id=o.id)
      OR EXISTS(SELECT 1 FROM ${identifier(schema)}.document_versions v WHERE v.storage_object_id=o.id) ORDER BY o.id`)).rows : [];
  return {tables,ledger_total_minor,cloud_objects:tables.document_objects || '0',referenced_objects};
}

export async function backupDatabase(destination:string,env:NodeJS.ProcessEnv=process.env) {
  const url=connection(env.DATABASE_MIGRATION_URL || env.DATABASE_URL),schema=schemaName(env),path=resolve(destination),temporary=`${path}.partial-${randomUUID()}`;
  try {await stat(path);throw new Error('Backup destination already exists. Use a new filename.');} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
  const db=pool(url,env);let client:PoolClient|undefined;
  try {
    client=await db.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='30min'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='30min'");
    const snapshot=(await client.query<{id:string}>('SELECT pg_export_snapshot() AS id')).rows[0].id;
    const expected=await inventory(client,schema);
    await tool('pg_dump',['--format=custom','--no-owner','--no-privileges',`--schema=${schema}`,`--snapshot=${snapshot}`],url,env,undefined,temporary);
    await syncPath(temporary);
    const manifest:BackupManifest={format:1,schema,created_at:new Date().toISOString(),sha256:await checksum(temporary),bytes:(await stat(temporary)).size,...expected};
    await link(temporary,path); // atomic, refuses to overwrite an existing backup
    await chmod(path,0o600);
    await writeFile(`${path}.json`,`${JSON.stringify(manifest,null,2)}\n`,{flag:'wx',mode:0o600});
    await syncPath(`${path}.json`);
    await syncPath(dirname(path));
    await client.query('COMMIT');
    return manifest;
  } catch(error) {await client?.query('ROLLBACK').catch(()=>undefined);throw error;}
  finally {client?.release();await db.end();await rm(temporary,{force:true});}
}

export async function restoreDatabase(source:string,confirmation:string,env:NodeJS.ProcessEnv=process.env) {
  const target=connection(env.RESTORE_DATABASE_URL),path=resolve(source);
  if(confirmation!==decodeURIComponent(target.pathname.slice(1))) throw new Error('Confirm the exact empty target database name with --confirm-empty-database.');
  for(const current of [env.DATABASE_URL,env.DATABASE_MIGRATION_URL].filter(Boolean)) {
    const live=connection(current);
    if(live.hostname===target.hostname && (live.port || '5432')===(target.port || '5432') && live.pathname===target.pathname) throw new Error('Restore target must differ from the configured source database.');
  }
  const manifest=JSON.parse(await readFile(`${path}.json`,'utf8')) as BackupManifest;
  if(manifest.format!==1 || schemaName({DATABASE_SCHEMA:manifest.schema})!==manifest.schema || !/^[a-f0-9]{64}$/.test(manifest.sha256) || manifest.sha256!==await checksum(path) || manifest.bytes!==(await stat(path)).size) throw new Error('Backup manifest or archive checksum is invalid.');
  const db=pool(target,env);let client:PoolClient|undefined;
  try {
    client=await db.connect();
    const existing=await client.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f') LIMIT 1`);
    if(existing.rows.length) throw new Error('Restore requires an empty database. Existing application data is never overwritten.');
    await tool('pg_restore',['--dbname',decodeURIComponent(target.pathname.slice(1)),'--exit-on-error','--single-transaction','--no-owner','--no-privileges'],target,env,path);
    const actual=await inventory(client,manifest.schema);
    if(JSON.stringify(actual.tables)!==JSON.stringify(manifest.tables) || actual.ledger_total_minor!==manifest.ledger_total_minor || JSON.stringify(actual.referenced_objects)!==JSON.stringify(manifest.referenced_objects)) throw new Error('Restored row counts, ledger totals or document references do not match the backup manifest.');
    return {status:'verified',tables:Object.keys(actual.tables).length,ledger_total_minor:actual.ledger_total_minor,cloud_objects:actual.cloud_objects};
  } finally {client?.release();await db.end();}
}

if(require.main===module) {
  const [action,path,flag,confirmation]=process.argv.slice(2);
  const operation=action==='backup' && path && !flag ? backupDatabase(path) : action==='restore' && path && flag==='--confirm-empty-database' && confirmation ? restoreDatabase(path,confirmation) : Promise.reject(new Error('Usage: database-backup backup FILE | restore FILE --confirm-empty-database NAME'));
  void operation.then(result=>{
    const summary='sha256' in result ? {status:'backed_up',bytes:result.bytes,sha256:result.sha256,tables:Object.keys(result.tables).length,referenced_objects:result.referenced_objects.length} : result;
    console.log(JSON.stringify(summary));
  }).catch(()=>{console.error('Database backup/restore failed. Check private connection settings, target confirmation, archive integrity, tool version and database permissions.');process.exitCode=1;});
}
