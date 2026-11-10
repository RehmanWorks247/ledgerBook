import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import type { PoolClient } from 'pg';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { DocumentVersionsService } from '../apps/api/src/bookings/document-versions.service';
import type { DatabaseService } from '../apps/api/src/database/database.service';
import { setupTestDatabase } from './helpers';

for(const operation of ['download','history'] as const)it(`document ${operation} reads a consistent requested version while another editor commits`,{skip:!process.env.TEST_DATABASE_URL,timeout:30_000},async()=>{
  const database=await setupTestDatabase();let release!:()=>void,arrived!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),checkpoint=new Promise<void>(resolve=>{arrived=resolve;});let reading:Promise<unknown>|undefined;
  try{
    const seed=await database.seed();await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1",[seed.orgId]);
    const access=new AccessService(database.db),member=await access.membership(seed.adminId,seed.orgId),bookings=new BookingsService(database.db,access),versions=new DocumentVersionsService(database.db,access);
    const booking=(await bookings.create(member,seed.customerId,{reference:'VERSION-RACE',departure_at:'2030-01-01T12:00:00Z',amount:'1.00',effective_date:'2026-11-09',required_services:[],idempotency_key:randomUUID()})).id as string;
    const folder=(await bookings.files(member,seed.customerId,booking)).items[0].id;
    const file=await bookings.upload(member,seed.customerId,booking,folder,'version.txt',randomUUID(),Buffer.from('version one'));
    const readerDb=Object.create(database.db) as DatabaseService;
    readerDb.transaction=work=>database.db.transaction(client=>work(new Proxy(client,{get(target,property){
      if(property!=='query')return Reflect.get(target,property);
      return async(sql:string,params:unknown[])=>{const result=await target.query(sql,params);if(sql.includes('FROM booking_nodes WHERE organization_id=')){arrived();await gate;}return result;};
    }}) as PoolClient));
    const reader=new DocumentVersionsService(readerDb,new AccessService(readerDb));
    const request=operation==='download'?reader.download(member,seed.customerId,booking,file.id,1):reader.history(member,seed.customerId,booking,file.id);
    reading=request;void request.catch(()=>undefined);await checkpoint;
    assert.equal((await versions.proxy(member,seed.customerId,booking,file.id,folder,'version.txt',randomUUID(),1,Buffer.from('version two'))).version,2);
    release();const result=await request;
    if('content' in result)assert.equal(result.content.toString(),'version one');
    else{assert.equal(result.version,2);assert.deepEqual(result.items.map(item=>[item.version,item.current]),[[2,true],[1,false]]);}
  }finally{release();await reading?.catch(()=>undefined);await database.close();}
});
