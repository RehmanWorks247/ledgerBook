import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

function run(binary:string,args:string[],input?:string) {
  return new Promise<string>((resolve,reject)=>{
    const child=spawn(binary,args,{stdio:['pipe','pipe','pipe']});let output='',diagnostic='';
    child.stdout.on('data',chunk=>{output+=String(chunk);});child.stderr.on('data',chunk=>{diagnostic=(diagnostic+String(chunk)).slice(-3000);});
    child.on('error',reject);child.on('close',code=>code===0?resolve(output):reject(new Error(`${binary} ${args[0]} failed: ${diagnostic}`)));
    child.stdin.end(input);
  });
}
async function waitFor(check:()=>Promise<unknown>) {
  for(let attempt=0;attempt<60;attempt++) {try {await check();return;} catch {await new Promise(resolve=>setTimeout(resolve,500));}}
  throw new Error('Release fixture did not become ready.');
}
async function smoke() {
  const image=process.env.RELEASE_TEST_IMAGE || 'ledgerbook:release-audit';
  const suffix=randomUUID().slice(0,8),network=`ledger-release-${suffix}`,db=`ledger-db-${suffix}`,app=`ledger-app-${suffix}`,proxy=`ledger-proxy-${suffix}`;
  await mkdir(resolve('.local'),{recursive:true});const directory=await mkdtemp(resolve('.local/release-smoke-'));
  const password=randomUUID().replaceAll('-',''),runtimePassword=randomUUID().replaceAll('-','');
  const env=join(directory,'runtime.env'),ownerEnv=join(directory,'owner.env'),ca=join(directory,'ca.crt');
  try {
    await writeFile(join(directory,'ca.cnf'),'[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=LedgerBook release fixture CA\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
    await run('openssl',['req','-new','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',join(directory,'ca.cnf'),'-keyout',join(directory,'ca.key'),'-out',ca]);
    await run('openssl',['req','-new','-newkey','rsa:2048','-nodes','-subj','/CN=ledger-release.test','-keyout',join(directory,'server.key'),'-out',join(directory,'server.csr')]);
    await writeFile(join(directory,'server.cnf'),'[v3]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:ledger-release-db,DNS:ledger-release.test\n');
    await run('openssl',['x509','-req','-in',join(directory,'server.csr'),'-CA',ca,'-CAkey',join(directory,'ca.key'),'-CAserial',join(directory,'ca.srl'),'-CAcreateserial','-out',join(directory,'server.crt'),'-days','1','-extfile',join(directory,'server.cnf'),'-extensions','v3']);
    await chmod(ca,0o644);
    const settings={NODE_ENV:'production',PUBLIC_APP_URL:'https://ledger-release.test',PUBLIC_HOST:'ledger-release.test',AUTH_PROVIDER:'clerk',
      CLERK_PUBLISHABLE_KEY:`pk_live_${Buffer.from('clerk.release.invalid$').toString('base64')}`,CLERK_SECRET_KEY:'sk_live_fixture_only_no_provider_access',
      DATABASE_URL:`postgresql://ledger_runtime:${runtimePassword}@ledger-release-db/ledger_release`,DATABASE_SSL:'true',DATABASE_SSL_CA_FILE:'/run/tls/ca.crt',NODE_EXTRA_CA_CERTS:'/run/tls/ca.crt',
      EMAIL_MODE:'resend',EMAIL_FROM:'fixture@release.invalid',RESEND_API_KEY:'re_fixture_only_no_provider_access',RESEND_WEBHOOK_SECRET:`whsec_${Buffer.from('fixture-only-secret').toString('base64')}`,
      DOCUMENT_STORAGE:'r2',STORAGE_ENVIRONMENT:'production',R2_ACCOUNT_ID:'0'.repeat(32),R2_DOCUMENT_BUCKET:'fixture-production',R2_ACCESS_KEY_ID:'fixture-only',R2_SECRET_ACCESS_KEY:'fixture-only',TRUST_PROXY_HOPS:'1'};
    await writeFile(env,Object.entries(settings).map(([key,value])=>`${key}=${value}`).join('\n'),{mode:0o600});
    await writeFile(ownerEnv,Object.entries({...settings,DATABASE_URL:`postgresql://ledger_owner:${password}@ledger-release-db/ledger_release`}).map(([key,value])=>`${key}=${value}`).join('\n'),{mode:0o600});
    await run('docker',['pull','postgres:17-alpine']);await run('docker',['pull','caddy:2-alpine']);
    await run('docker',['network','create','--internal',network]);
    // The internal network has no Internet route: these fake provider keys cannot make external calls.
    await run('docker',['run','-d','--name',db,'--network',network,'--network-alias','ledger-release-db','-e','POSTGRES_USER=ledger_owner','-e',`POSTGRES_PASSWORD=${password}`,'-e','POSTGRES_DB=ledger_release','-v',`${directory}:/tls:ro`,'postgres:17-alpine','sh','-c',
      'cp /tls/server.key /tmp/ledger-server.key && chown postgres:postgres /tmp/ledger-server.key && chmod 600 /tmp/ledger-server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tls/server.crt -c ssl_key_file=/tmp/ledger-server.key']);
    await waitFor(()=>run('docker',['exec',db,'pg_isready','-U','ledger_owner','-d','ledger_release']));
    await assert.rejects(run('docker',['run','--rm','--network',network,'--env-file',ownerEnv,'-v',`${ca}:/run/tls/ca.crt:ro`,image]),/Release preflight failed/);
    const operation=['run','--rm','--network',network,'--env-file',ownerEnv,'-v',`${ca}:/run/tls/ca.crt:ro`,image,'node','dist/operations/scripts/migrate.js'];
    await run('docker',operation);await run('docker',operation);
    await run('docker',['exec','-i',db,'psql','-U','ledger_owner','-d','ledger_release','-v','ON_ERROR_STOP=1'],`CREATE ROLE ledger_runtime LOGIN PASSWORD '${runtimePassword}';`);
    await run('docker',['exec','-i',db,'psql','-U','ledger_owner','-d','ledger_release','-v','app_schema=public','-v','app_role=ledger_runtime'],await readFile(resolve('deploy/runtime-grants.sql'),'utf8'));
    const runtime=['run','--rm','--network',network,'--env-file',env,'-v',`${ca}:/run/tls/ca.crt:ro`,image];
    await assert.rejects(run('docker',[...runtime.slice(0,-1),'--env','RESEND_WEBHOOK_SECRET=',image]),/Configure RESEND_WEBHOOK_SECRET/);
    assert.equal((await run('docker',[...runtime,'node','-p','process.getuid()'])).trim(),'1000');
    await run('docker',[...runtime,'node','-e',"const {DatabaseService}=require('./dist/api/database/database.service');const db=new DatabaseService();db.query(\"SELECT has_table_privilege(current_user,'public.account_purge_context','INSERT') AS private_write,has_schema_privilege(current_user,'public','CREATE') AS schema_write,has_function_privilege(current_user,'public.account_purge_allows(text,text,jsonb,jsonb)','EXECUTE') AS private_helper\").then(r=>{if(Object.values(r.rows[0]).some(Boolean))process.exitCode=1}).catch(()=>process.exitCode=1).finally(()=>db.close())"]);
    const preflight=JSON.parse((await run('docker',[...runtime,'node','dist/operations/scripts/release-preflight.js'])).trim());assert.equal(preflight.status,'ready');
    await run('docker',['run','-d','--name',app,'--network',network,'--network-alias','app','--env-file',env,'--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--tmpfs','/tmp:rw,noexec,nosuid,size=64m','-v',`${ca}:/run/tls/ca.crt:ro`,image]);
    await waitFor(()=>run('docker',['exec',app,'node','-e',"fetch('http://127.0.0.1:3000/api/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]));
    const caddy=(await readFile(resolve('deploy/Caddyfile'),'utf8')).replace('{$PUBLIC_HOST} {','{$PUBLIC_HOST} {\n  tls /tls/server.crt /tls/server.key');
    await writeFile(join(directory,'Caddyfile'),caddy);
    await run('docker',['run','-d','--name',proxy,'--network',network,'--network-alias','ledger-release.test','--read-only','--cap-drop=ALL','--cap-add=NET_BIND_SERVICE','--security-opt=no-new-privileges',
      '--tmpfs','/tmp:rw,size=16m','--tmpfs','/data:rw,size=16m','--tmpfs','/config:rw,size=1m','-e','PUBLIC_HOST=ledger-release.test','-e','ACME_EMAIL=fixture@release.invalid','-v',`${directory}:/tls:ro`,'-v',`${join(directory,'Caddyfile')}:/etc/caddy/Caddyfile:ro`,'caddy:2-alpine']);
    await waitFor(()=>run('docker',['exec',app,'node','dist/operations/scripts/release-preflight.js','--origin']));
    const monitor=JSON.parse((await run('docker',['exec',app,'node','dist/operations/scripts/release-monitor.js'])).trim());assert.equal(monitor.status,'ok');
    await run('docker',['exec',app,'node','-e',"fetch('https://ledger-release.test/').then(async r=>{if(!r.ok||!(await r.text()).includes('id=\"root\"'))process.exit(1)}).catch(()=>process.exit(1))"]);
    console.log(JSON.stringify({status:'passed',nonroot_uid:1000,production_mode:true,startup_guards:true,database_tls_verified:true,migration_replay:true,least_privilege_runtime:true,https_ready:true,anonymous_rejected:true,frontend_served:true,monitor:monitor.status,migrations:preflight.migrations,external_provider_access:false}));
  } finally {
    await Promise.allSettled([proxy,app,db].map(name=>run('docker',['rm','-fv',name])));
    await run('docker',['network','rm',network]).catch(()=>undefined);await rm(directory,{recursive:true,force:true});
  }
}
void smoke().catch(error=>{console.error(error instanceof Error?error.message:'Release fixture failed.');process.exitCode=1;});
