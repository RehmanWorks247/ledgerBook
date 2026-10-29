import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { NestExpressApplication } from '@nestjs/platform-express';

async function main() {
  if(process.env.NODE_ENV==='production') throw new Error('Local mode cannot run with NODE_ENV=production.');
  const {values}=parseArgs({options:{port:{type:'string'},name:{type:'string'},email:{type:'string'},currency:{type:'string'},verify:{type:'boolean'}}});
  const port=Number(values.port??3000);
  if(!Number.isSafeInteger(port)||port<1024||port>65535) throw new Error('Choose a local port from 1024 to 65535.');
  const origin=`http://localhost:${port}`;
  const local=resolve('.local');
  const statusPath=resolve(local,'local-status.json');
  const owner=randomUUID();
  const stopPath=resolve(local,`stop-${owner}.json`);
  // Set before importing application modules: local mode is separate from .env/production.
  process.env.NODE_ENV='development';
  process.env.PUBLIC_APP_URL=origin;
  process.env.PORT=String(port);
  process.env.EMAIL_MODE='file';
  process.env.MAIL_DIRECTORY=resolve(local,'mail');
  process.env.TRUST_PROXY_HOPS='0';
  if(!existsSync(resolve('apps/web/dist/index.html'))) throw new Error('Build the frontend first with npm run build:web.');
  await mkdir(local,{recursive:true,mode:0o700});
  const [{openLocalDatabase},{ensureLocalAccount},{createApp},{verifyLocalApp}]=await Promise.all([
    import('./local-database'),import('./local-account'),import('../apps/api/src/app'),import('./local-smoke'),
  ]);
  const database=await openLocalDatabase();
  let app:NestExpressApplication|undefined;
  let stopping=false;
  let timer:NodeJS.Timeout|undefined;
  let stage='administrator provisioning';
  const startedAt=new Date().toISOString();
  const status={pid:process.pid,owner,url:origin,startedAt,database:'persistent-local-postgresql',dataDirectory:database.dataDirectory,email:'local-files'};
  async function saveStatus(extra:Record<string,unknown>) {
    const temporary=resolve(local,`status-${owner}.tmp`);
    await writeFile(temporary,JSON.stringify({...status,...extra},null,2)+'\n',{mode:0o600});
    await rename(temporary,statusPath);
  }
  async function shutdown() {
    if(stopping) return;
    stopping=true;
    if(timer) clearInterval(timer);
    try {
      if(app) await app.close();
      else await database.close();
      await saveStatus({state:'stopped',stoppedAt:new Date().toISOString()});
      await unlink(stopPath).catch(()=>undefined);
      console.log('LedgerBook stopped. Your local data is preserved.');
    } catch {console.error('Local shutdown failed. Check the local database lock before restarting.');process.exitCode=1;}
  }
  try {
    await saveStatus({state:'starting'});
    const account=await ensureLocalAccount(database.db,{name:values.name,email:values.email,currency:values.currency});
    stage='application initialization';
    app=await createApp({database:database.db,logger:false});
    stage='local port binding';
    await app.listen(port,'127.0.0.1');
    stage='startup verification';
    const verification=(account.created||values.verify)&&account.email&&account.password&&account.organizationId
      ?await verifyLocalApp(app,{email:account.email,password:account.password,organizationId:account.organizationId,origin})
      :{checks:['Database migrations and application startup'],transport:'not-tested'};
    await saveStatus({state:'running',organizationId:account.organizationId,adminEmail:account.email,credentialsFile:account.credentialsPath,
      verification:{...verification,checkedAt:new Date().toISOString()}});
    console.log(`LedgerBook is running at ${origin}`);
    console.log(`Local database: ${database.dataDirectory}`);
    console.log(account.credentialsPath?`Administrator login details: ${account.credentialsPath}`:'Use your existing administrator login.');
    console.log(`Invitation and reset emails: ${process.env.MAIL_DIRECTORY}`);
    console.log(`Startup verification: ${verification.checks.length} checks (${verification.transport}).`);
    console.log('Stop with npm run local:stop. Data and accounts are preserved between starts.');
    process.once('SIGINT',()=>{void shutdown();});
    process.once('SIGTERM',()=>{void shutdown();});
    timer=setInterval(()=>{void readFile(stopPath,'utf8').then(value=>{
      try {if(JSON.parse(value).owner===owner) void shutdown();} catch { /* Ignore malformed stop requests. */ }
    }).catch(()=>undefined);},500);
    timer.unref();
  } catch(error) {
    if(app) await app.close();else await database.close();
    await saveStatus({state:'failed',failedAt:new Date().toISOString(),stage,errorCode:(error as NodeJS.ErrnoException)?.code??'APPLICATION_ERROR'});
    throw error;
  }
}
void main().catch(error=>{
  const code=(error as NodeJS.ErrnoException)?.code;
  if(code==='EADDRINUSE') console.error('Port is already in use. Stop the other app or run npm run local -- --port 3001.');
  else console.error('Local startup failed. Check for an existing local process, database lock, or invalid local configuration.');
  process.exitCode=1;
});
