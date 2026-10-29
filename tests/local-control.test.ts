import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';

const requireLocal=createRequire(resolve('tests/local-control.test.ts'));
const {validStatus,processState}=requireLocal('../scripts/local-control.cjs') as {
  validStatus(value:unknown):boolean;
  processState(pid:unknown,probe?:(pid:number)=>void):'running'|'stopped'|'unknown';
};

test('local control rejects malformed status and process IDs without probing other processes',()=>{
  const status={pid:process.pid,owner:randomUUID(),state:'running',url:'http://localhost:3000'};
  assert.equal(validStatus(status),true);
  for(const pid of [undefined,null,'123',0,-1,1.5,NaN,2147483648]){
    assert.equal(validStatus({...status,pid}),false);
    assert.equal(processState(pid,()=>assert.fail('An invalid PID must never reach the process probe.')),'stopped');
  }
  for(const patch of [
    {owner:'../../somewhere'}, {owner:undefined}, {state:'unknown'}, {url:'https://example.com:3000'},
    {url:'http://localhost:3000/path'}, {url:'http://localhost:3000@evil.example:3000'},
    {url:'http://localhost:80'}, {url:'http://localhost:3000\n'},
  ]) assert.equal(validStatus({...status,...patch}),false);
  assert.equal(validStatus(null),false);
  assert.equal(validStatus({}),false);
});

test('local control distinguishes a dead process from an unverifiable process',()=>{
  assert.equal(processState(123,()=>undefined),'running');
  assert.equal(processState(123,()=>{throw Object.assign(new Error('missing'),{code:'ESRCH'});}),'stopped');
  assert.equal(processState(123,()=>{throw Object.assign(new Error('denied'),{code:'EPERM'});}),'unknown');
  assert.equal(processState(123,()=>{throw new Error('unexpected failure');}),'unknown');
});
