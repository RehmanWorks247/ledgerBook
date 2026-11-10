// Actual backup/restore and SDK against the existing local Postman storage member.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DocumentStorage } from '../apps/api/src/bookings/document-storage';
import { backupDocuments,restoreDocuments } from '../scripts/document-backup';

const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function main(){
  if(process.env.NODE_ENV==='production')throw Error('Simulation is disabled in production.');
  const endpoint='http://127.0.0.1:4018/s3',bucket='ledgerbook-simulation';
  for(const mode of ['s3','r2'] as const){
    assert.equal((await fetch(`${endpoint}/_control/${mode==='s3'?'reset':'r2'}`,{method:'POST'})).status,200);
    const directory=await mkdtemp(join(tmpdir(),'ledger-snapshot-sim-')),archive=join(directory,'database.dump');
    const storage=new DocumentStorage({mode,bucket,region:'auto',endpoint,forcePathStyle:true,credentials:{accessKeyId:'simulation-only',secretAccessKey:'simulation-only'}});
    const bytes=[Buffer.from('Current document bytes'),Buffer.from('Historical document bytes')];
    const objects=bytes.map(content=>({id:randomUUID(),bucket,object_key:`documents/${randomUUID()}`,size:content.length,checksum:hash(content)}));
    try{
      const dump=Buffer.from('Synthetic exported database snapshot');await writeFile(archive,dump,{mode:0o600});
      await writeFile(`${archive}.json`,JSON.stringify({format:1,sha256:hash(dump),bytes:dump.length,referenced_objects:objects}),{mode:0o600});
      for(const [index,object]of objects.entries())await storage.put(object,bytes[index],'text/plain');
      const backup=join(directory,'documents');assert.equal((await backupDocuments(archive,backup,storage)).objects,2);
      for(const object of objects)await storage.remove(object);
      assert.deepEqual(await restoreDocuments(archive,backup,bucket,storage),{status:'verified',objects:2,created:2,existing:0});
      assert.deepEqual(await restoreDocuments(archive,backup,bucket,storage),{status:'verified',objects:2,created:0,existing:2});
      const corrupt=Buffer.alloc(bytes[0].length,33),conflict={...objects[0],checksum:hash(corrupt)};
      await storage.put(conflict,corrupt,'text/plain');
      await assert.rejects(restoreDocuments(archive,backup,bucket,storage),/does not match/);
      assert.deepEqual(await storage.get(conflict),corrupt,'Conflicting destination must never be overwritten.');
      for(const object of objects)await storage.remove(object);
      const state=await(await fetch(`${endpoint}/_control/state`)).json();assert.deepEqual(state,{puts:8,gets:8,deletes:4,objects:0});
      console.log(`PASS: ${mode} snapshot-bound document backup and create-only restore; exact current/history bytes, identical-existing replay, conflicting destination preserved. Observed 8 PUTs, 8 GETs, 4 DELETEs; zero synthetic objects remain.`);
    }finally{storage.onApplicationShutdown();await rm(directory,{recursive:true,force:true});}
  }
}
void main().catch(error=>{console.error('Document backup simulation failed:',error.message);process.exitCode=1;});
