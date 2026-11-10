// Real booking/version services + SDK against the committed local Postman mock.
// ASCII fixture only: binary and direct-presigned writes use the raw HTTP suite.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { DocumentVersionsService } from '../apps/api/src/bookings/document-versions.service';
import { cleanupDocumentObjects, DocumentStorage } from '../apps/api/src/bookings/document-storage';
import { setupTestDatabase } from './helpers';

async function main() {
  if(process.env.NODE_ENV==='production')throw Error('Simulation is disabled in production.');
  const endpoint='http://127.0.0.1:4018/s3';
  const control=async(action:string)=>assert.equal((await fetch(`${endpoint}/_control/${action}`,{method:'POST'})).status,200);
  await control('reset');
  const database=await setupTestDatabase();
  const storage=new DocumentStorage({mode:'s3',bucket:'ledgerbook-simulation',region:'eu-west-2',endpoint,forcePathStyle:true,credentials:{accessKeyId:'simulation-only',secretAccessKey:'simulation-only'}});
  try {
    const seed=await database.seed();await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1",[seed.orgId]);
    const access=new AccessService(database.db),member=await access.membership(seed.adminId,seed.orgId);
    const bookings=new BookingsService(database.db,access,storage),versions=new DocumentVersionsService(database.db,access,storage);
    const booking=(await bookings.create(member,seed.customerId,{reference:'VERSIONS-SIMULATION',departure_at:'2026-11-12T10:30:00Z',amount:'100.00',effective_date:'2026-11-09',required_services:['makkah'],idempotency_key:randomUUID()})).id as string;
    const folder=(await bookings.files(member,seed.customerId,booking)).items.find(node=>node.serviceKey==='makkah')!.id;
    const file=await bookings.upload(member,seed.customerId,booking,folder,'instructions.txt',randomUUID(),Buffer.from('version one'));
    await control('outage');
    const key=randomUUID();
    const replace=()=>versions.proxy(member,seed.customerId,booking,file.id,folder,'instructions.txt',key,1,Buffer.from('version two'));
    await assert.rejects(replace(),/temporarily unavailable/);
    assert.equal((await versions.history(member,seed.customerId,booking,file.id)).items.length,1);
    assert.equal((await versions.text(member,seed.customerId,booking,file.id)).text,'version one');
    await control('recover');await control('fail-two');
    assert.equal((await replace()).version,2);assert.equal((await replace()).version,2);
    assert.equal((await versions.text(member,seed.customerId,booking,file.id)).text,'version two');
    assert.equal((await versions.download(member,seed.customerId,booking,file.id,1)).content.toString(),'version one');
    await versions.restore(member,seed.customerId,booking,file.id,1,{expected_version:2});
    assert.equal((await versions.text(member,seed.customerId,booking,file.id)).text,'version one');
    await assert.rejects(versions.restore(member,seed.customerId,booking,file.id,1,{expected_version:2}),/newer version/);
    await bookings.remove(member,seed.customerId,booking,file.id);
    await database.db.query("UPDATE document_purge_outbox SET created_at=now()-interval '25 hours'");
    await control('fail-deletes');assert.deepEqual(await cleanupDocumentObjects(database.db,storage),{removed:0,failed:2});
    await control('recover');assert.deepEqual(await cleanupDocumentObjects(database.db,storage),{removed:2,failed:0});
    const state=await(await fetch(`${endpoint}/_control/state`)).json() as {objects:number;puts:number;gets:number;deletes:number};
    assert.equal(state.objects,0);assert.equal(state.puts,7);assert.equal(state.gets,4);assert.equal(state.deletes,8);
    console.log('PASS: actual booking + version services preserve the old document after storage outage, retry transient failures, commit one replacement, download/restore historical bytes, reject stale restore, retain failed cleanup and remove every version after recovery. Postman observed 7 PUTs, 4 GETs, 8 DELETEs; zero objects remain.');
  } finally {storage.onApplicationShutdown();await database.close();}
}
void main().catch(error=>{console.error('Version simulation failed:',error.message);process.exitCode=1;});
