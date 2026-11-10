import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it, type TestContext } from 'node:test';
import type { PoolClient } from 'pg';
import { DocumentCleanupWorker } from '../apps/api/src/bookings/document-cleanup.worker';
import type { DocumentStorage, StoredDocument } from '../apps/api/src/bookings/document-storage';
import type { DatabaseService } from '../apps/api/src/database/database.service';

const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const object=():StoredDocument=>({id:randomUUID(),bucket:'cleanup-development',object_key:`documents/${randomUUID()}`,checksum:'0'.repeat(64),size:1});

function harness(t:TestContext,count=0,cloud=true) {
  t.mock.timers.enable({apis:['setTimeout']});
  const previous=process.env.NODE_ENV;
  process.env.NODE_ENV='development';
  const state={pending:Array.from({length:count},object),sweeps:0,purgeQueries:0,limits:[] as number[],deletes:[] as string[],failDatabase:false};
  let remove:((entry:StoredDocument,signal?:AbortSignal)=>Promise<void>)|undefined;
  const database={
    async transaction<T>(work:(client:PoolClient)=>Promise<T>) {
      state.sweeps++;
      if(state.failDatabase) throw new Error('Private database connection details must not be logged');
      return work({query:async(sql:string,params:unknown[])=>{
        if(sql.includes('SELECT o.id')) {
          state.limits.push(Number(params[0]));
          return {rows:state.pending.slice(0,Number(params[0]))};
        }
        return {rows:[]};
      }} as unknown as PoolClient);
    },
    async query(sql:string,params:unknown[]) {
      if(sql.includes('SELECT id,bucket')) {state.purgeQueries++;return {rows:[]};}
      if(sql.startsWith('DELETE FROM document_objects')) state.pending=state.pending.filter(entry=>entry.id!==params[0]);
      return {rows:[]};
    },
  } as unknown as DatabaseService;
  const storage={cloud,remove:async(entry:StoredDocument,signal?:AbortSignal)=>{
    state.deletes.push(entry.id);
    await remove?.(entry,signal);
  }} as unknown as DocumentStorage;
  const worker=new DocumentCleanupWorker(database,storage);
  t.after(async()=>{
    await worker.beforeApplicationShutdown();
    if(previous===undefined) delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;
  });
  return {worker,state,onRemove:(handler:typeof remove)=>{remove=handler;}};
}

describe('automatic document cleanup scheduling and shutdown',()=>{
  it('does not start for database storage or the test environment',async t=>{
    const {worker,state}=harness(t,1,false);
    worker.onModuleInit();
    t.mock.timers.tick(24*3600000);
    await flush();
    assert.equal(state.sweeps,0);
    const other=new DocumentCleanupWorker({transaction:async()=>{throw new Error('No test cleanup allowed');}} as unknown as DatabaseService,{cloud:true} as DocumentStorage);
    process.env.NODE_ENV='test';
    other.onModuleInit();
    t.mock.timers.tick(24*3600000);
    await flush();
    await other.beforeApplicationShutdown();
  });

  it('waits one minute at startup, drains a full batch promptly and then returns to hourly checks',async t=>{
    const {worker,state}=harness(t,11);
    worker.onModuleInit();
    t.mock.timers.tick(59999);
    await flush();
    assert.equal(state.sweeps,0);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(state.sweeps,1);
    assert.equal(state.deletes.length,10);
    assert.equal(state.pending.length,1);
    t.mock.timers.tick(59999);
    await flush();
    assert.equal(state.sweeps,1);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(state.sweeps,2);
    assert.equal(state.deletes.length,11);
    assert.deepEqual(state.limits,[10,10]);
    t.mock.timers.tick(3599999);
    await flush();
    assert.equal(state.sweeps,2);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(state.sweeps,3);
  });

  it('never overlaps a slow sweep even when multiple intervals elapse',async t=>{
    const {worker,state,onRemove}=harness(t,1);
    let release!:()=>void;
    onRemove((_entry,signal)=>new Promise<void>((resolve,reject)=>{
      release=resolve;
      signal?.addEventListener('abort',()=>reject(new DOMException('Stopped','AbortError')),{once:true});
    }));
    worker.onModuleInit();
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(state.deletes.length,1);
    t.mock.timers.tick(5*3600000);
    await flush();
    assert.equal(state.sweeps,1);
    release();
    await flush();
    assert.equal(state.pending.length,0);
    t.mock.timers.tick(3600000);
    await flush();
    assert.equal(state.sweeps,2);
  });

  it('retains failed deletions and retries after five minutes without logging provider details',async t=>{
    const {worker,state,onRemove}=harness(t,1);
    const errors=t.mock.method(console,'error',()=>undefined);
    onRemove(async()=>{throw new Error('private storage credential must not be logged');});
    worker.onModuleInit();
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(state.pending.length,1);
    assert.equal(errors.mock.calls.length,1);
    assert.doesNotMatch(String(errors.mock.calls[0].arguments),/private storage credential/);
    onRemove(undefined);
    t.mock.timers.tick(299999);
    await flush();
    assert.equal(state.sweeps,1);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(state.sweeps,2);
    assert.equal(state.pending.length,0);
    assert.equal(state.deletes.length,2);
  });

  it('recovers from database failure on the next bounded retry',async t=>{
    const {worker,state}=harness(t,1);
    const errors=t.mock.method(console,'error',()=>undefined);
    state.failDatabase=true;
    worker.onModuleInit();
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(state.deletes.length,0);
    assert.equal(errors.mock.calls.length,1);
    assert.doesNotMatch(String(errors.mock.calls[0].arguments),/Private database/);
    state.failDatabase=false;
    t.mock.timers.tick(300000);
    await flush();
    assert.equal(state.sweeps,2);
    assert.equal(state.pending.length,0);
  });

  it('cancels its startup timer on shutdown and never starts a sweep afterward',async t=>{
    const {worker,state}=harness(t,1);
    worker.onModuleInit();
    await worker.beforeApplicationShutdown();
    t.mock.timers.tick(24*3600000);
    await flush();
    assert.equal(state.sweeps,0);
  });

  it('aborts an in-flight delete, waits for it to settle and leaves remaining work recoverable without false error logs',async t=>{
    const {worker,state,onRemove}=harness(t,2);
    const errors=t.mock.method(console,'error',()=>undefined);
    let aborted=false,settled=false;
    onRemove(async(_entry,signal)=>{
      assert.ok(signal,'Shutdown must be propagated to the provider operation.');
      try {
        await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>{
          aborted=true;reject(new DOMException('Stopped','AbortError'));
        },{once:true}));
      } finally {settled=true;}
    });
    worker.onModuleInit();
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(state.deletes.length,1);
    await worker.beforeApplicationShutdown();
    assert.equal(aborted,true);
    assert.equal(settled,true);
    assert.equal(state.pending.length,2);
    assert.equal(state.purgeQueries,0);
    t.mock.timers.tick(24*3600000);
    await flush();
    assert.equal(state.sweeps,1);
    assert.equal(state.deletes.length,1);
    assert.equal(errors.mock.calls.length,0,'An intentional shutdown is not a storage failure.');
  });
});
