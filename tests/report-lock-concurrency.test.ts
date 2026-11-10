// Forces the customer/booking lock overlap using disposable PostgreSQL only.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import type { PoolClient } from 'pg';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import type { DatabaseService } from '../apps/api/src/database/database.service';
import { setupTestDatabase } from './helpers';

it('legacy service-folder repair serializes with document writers before acquiring the booking lock', {skip:!process.env.TEST_DATABASE_URL,timeout:30_000},async()=>{
  const database=await setupTestDatabase();let release!:()=>void,arrived!:()=>void;
  const checkpoint=new Promise<void>(resolve=>{arrived=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const active:Promise<unknown>[]=[];
  try {
    const seed=await database.seed();await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1",[seed.orgId]);
    const access=new AccessService(database.db),member=await access.membership(seed.adminId,seed.orgId),bookings=new BookingsService(database.db,access);
    const booking=(await bookings.create(member,seed.customerId,{reference:'FOLDER-LOCKS',departure_at:'2030-01-01T12:00:00Z',amount:'100.00',effective_date:'2026-11-09',required_services:[],idempotency_key:randomUUID()})).id as string;
    await database.db.query("DELETE FROM booking_nodes WHERE booking_id=$1 AND service_key='extras'",[booking]);
    const writerDb=Object.create(database.db) as DatabaseService;
    writerDb.transaction=work=>database.db.transaction(client=>work(new Proxy(client,{get(target,property){
      if(property!=='query')return Reflect.get(target,property);
      return async(sql:string,params:unknown[])=>{
        const result=await target.query(sql,params);
        if(sql.includes('SELECT * FROM customers WHERE')&&sql.endsWith('FOR UPDATE')){arrived();await gate;}
        return result;
      };
    }}) as PoolClient));
    const writer=new BookingsService(writerDb,new AccessService(writerDb)).createFolder(member,seed.customerId,booking,{name:'Concurrent folder',parent_id:null,idempotency_key:randomUUID()});
    active.push(writer);void writer.catch(()=>undefined);await Promise.race([checkpoint,writer.then(()=>{throw Error('Writer missed the customer lock checkpoint.');})]);
    let repairPid=0;const repairDb=Object.create(database.db) as DatabaseService;
    repairDb.transaction=work=>database.db.transaction(async client=>{repairPid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return work(client);});
    const repair=new BookingsService(repairDb,new AccessService(repairDb)).files(member,seed.customerId,booking);active.push(repair);void repair.catch(()=>undefined);
    let blocked=false;
    for(let attempt=0;attempt<200;attempt++){
      if(repairPid&&(await database.db.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[repairPid])).rows[0]?.wait_event_type==='Lock'){blocked=true;break;}
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    release();const results=await Promise.allSettled([writer,repair]);assert.equal(blocked,true,'Repair must overlap a customer-locked writer.');
    for(const result of results)assert.equal(result.status,'fulfilled',result.status==='rejected'?String(result.reason):'');
    const files=await bookings.files(member,seed.customerId,booking);assert.equal(files.items.filter(node=>node.defaultFolder).length,6);assert.ok(files.items.some(node=>node.name==='Concurrent folder'));
  }finally{release();await Promise.allSettled(active);await database.close();}
});
