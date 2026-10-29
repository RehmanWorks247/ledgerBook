/* global require, module, process, console, __dirname, setTimeout, URL */
/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require('node:child_process');
const { openSync, closeSync } = require('node:fs');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { resolve } = require('node:path');

const root=resolve(__dirname,'..');
const local=resolve(root,'.local');
const statusPath=resolve(local,'local-status.json');
const sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
function validStatus(value){
  if(!value||!Number.isSafeInteger(value.pid)||value.pid<1||value.pid>2147483647) return false;
  if(typeof value.owner!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.owner)) return false;
  if(!['starting','running','stopped','failed'].includes(value.state)) return false;
  try{
    const url=new URL(value.url);
    return url.protocol==='http:'&&url.hostname==='localhost'&&Number(url.port)>=1024&&Number(url.port)<=65535&&value.url===url.origin;
  }catch{return false;}
}
async function readStatus(){
  try{const value=JSON.parse(await readFile(statusPath,'utf8'));return validStatus(value)?value:undefined;}
  catch{return undefined;}
}
function processState(pid,probe=(value)=>process.kill(value,0)){
  if(!Number.isSafeInteger(pid)||pid<1||pid>2147483647) return 'stopped';
  try{probe(pid);return 'running';}
  catch(error){return error.code==='ESRCH'?'stopped':'unknown';}
}
async function main(){
  const action=process.argv[2];
  await mkdir(local,{recursive:true,mode:0o700});
  const status=await readStatus();
  const state=status?processState(status.pid):'stopped';
  if(action==='status'){
    if(status?.state==='running'&&state==='running') console.log(`LedgerBook is running at ${status.url}`);
    else if(status&&['running','starting'].includes(status.state)&&state==='unknown') console.log('LedgerBook process status could not be verified. Check the terminal that started it.');
    else if(status?.state==='starting'&&state==='running') console.log(`LedgerBook is starting at ${status.url}`);
    else console.log('LedgerBook is not running. Start it with npm run local:start.');
    return;
  }
  if(action==='stop'){
    if(!status||!['running','starting'].includes(status.state)||state==='stopped'){console.log('LedgerBook is already stopped.');return;}
    if(state==='unknown') throw new Error('The local process could not be verified. Stop it from the terminal that started it.');
    await writeFile(resolve(local,`stop-${status.owner}.json`),JSON.stringify({owner:status.owner}),{mode:0o600});
    for(let i=0;i<100;i++){
      const current=await readStatus();
      if(current?.owner!==status.owner||current.state==='stopped'||processState(status.pid)==='stopped'){console.log('LedgerBook stopped; data is preserved.');return;}
      await sleep(100);
    }
    throw new Error('The app has not stopped yet. Check .local/local.log; no process was force-killed.');
  }
  if(action!=='start') throw new Error('Use start, stop, or status.');
  if(status&&['running','starting'].includes(status.state)&&state==='unknown') throw new Error('The previous local process could not be verified. Check its terminal before starting another.');
  if(status&&['running','starting'].includes(status.state)&&state==='running'){
    console.log(`LedgerBook is already ${status.state} at ${status.url}`);return;
  }
  const log=openSync(resolve(local,'local.log'),'a',0o600);
  let child;
  try{child=spawn(process.execPath,['--import','tsx','scripts/local.ts',...process.argv.slice(3)],{
    cwd:root,detached:true,windowsHide:true,stdio:['ignore',log,log],
  });}finally{closeSync(log);}
  let spawnError;
  child.once('error',error=>{spawnError=error;});
  child.unref();
  for(let i=0;i<300;i++){
    if(spawnError) throw new Error('Unable to start the local Node.js process.');
    const current=await readStatus();
    if(current?.pid===child.pid&&current.state==='running'){
      console.log(`LedgerBook is running at ${current.url}`);
      console.log('Administrator login details: .local/admin-login.txt');
      return;
    }
    if(current?.pid===child.pid&&current.state==='failed') throw new Error('Startup failed. Check .local/local.log.');
    if(child.exitCode!==null) throw new Error('Local process exited. Check .local/local.log.');
    await sleep(100);
  }
  throw new Error('Startup did not finish within 30 seconds. Check .local/local.log.');
}
module.exports={validStatus,processState};
if(require.main===module) void main().catch(error=>{console.error(error.message);process.exitCode=1;});
