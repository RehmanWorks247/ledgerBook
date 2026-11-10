import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { createServer,type Server } from 'node:http';
import { mkdtemp,readFile,writeFile,stat,rm,symlink } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,beforeEach,describe,it } from 'node:test';
import { DocumentStorage,type StoredDocument } from '../apps/api/src/bookings/document-storage';
import { backupDocuments,restoreDocuments } from '../scripts/document-backup';

const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
for(const mode of ['s3','r2'] as const)describe(`${mode} document snapshot backup and create-only restore via real SDK`,()=>{
  let directory:string,archive:string,output:string,server:Server,storage:DocumentStorage,objects:StoredDocument[];
  const provider=new Map<string,Buffer>(),requests:Array<{method:string;path:string;condition:string|undefined}>=[];
  const bucket='ledgerbook-simulation',original=[Buffer.from([0,255,128,9,10,13,0,20]),Buffer.from('Historical UTF-8 instructions · café')];
  const path=(object:StoredDocument)=>`/${object.bucket}/${object.object_key}`;
  beforeEach(async()=>{
    directory=await mkdtemp(join(tmpdir(),'ledger-document-backup-'));archive=join(directory,'database.dump');output=join(directory,'documents');provider.clear();requests.length=0;
    objects=original.map(bytes=>{const id=randomUUID();return{id,bucket,object_key:`documents/${randomUUID()}/${randomUUID()}/${randomUUID()}/${id}`,size:bytes.length,checksum:hash(bytes)};});
    objects.forEach((object,index)=>provider.set(path(object),Buffer.from(original[index])));
    const bytes=Buffer.from('Synthetic immutable database snapshot archive fixture');await writeFile(archive,bytes,{mode:0o600});
    await writeFile(`${archive}.json`,JSON.stringify({format:1,schema:'public',sha256:hash(bytes),bytes:bytes.length,referenced_objects:objects}),{mode:0o600});
    server=createServer((request,response)=>{void(async()=>{
      const key=decodeURIComponent(new URL(request.url!,'http://localhost').pathname);requests.push({method:request.method!,path:key,condition:request.headers['if-none-match'] as string|undefined});
      if(!request.headers.authorization?.startsWith('AWS4-HMAC-SHA256 ')){response.writeHead(403).end();return;}
      if(request.method==='GET'){
        const bytes=provider.get(key);if(!bytes)response.writeHead(404,{'Content-Type':'application/xml'}).end('<Error><Code>NoSuchKey</Code></Error>');else response.writeHead(200,{'Content-Length':bytes.length}).end(bytes);
      }else if(request.method==='PUT'){
        const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks);
        assert.equal(request.headers['if-none-match'],'*');assert.equal(request.headers['cache-control'],'private, no-store');
        if(mode==='r2'){assert.equal(request.headers['content-md5'],createHash('md5').update(bytes).digest('base64'));assert.equal(request.headers['x-amz-server-side-encryption'],undefined);}
        else{assert.equal(request.headers['x-amz-checksum-sha256'],Buffer.from(hash(bytes),'hex').toString('base64'));assert.equal(request.headers['x-amz-server-side-encryption'],'AES256');}
        if(provider.has(key)){response.writeHead(412,{'Content-Type':'application/xml'}).end('<Error><Code>PreconditionFailed</Code></Error>');return;}
        provider.set(key,bytes);response.writeHead(200,{ETag:'"fixture"'}).end();
      }else response.writeHead(501).end();
    })().catch(()=>response.writeHead(500).end());});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    storage=new DocumentStorage({mode,bucket,region:'auto',endpoint:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,forcePathStyle:true,credentials:{accessKeyId:'synthetic',secretAccessKey:'synthetic'}});
  });
  afterEach(async()=>{storage?.onApplicationShutdown();server?.closeAllConnections();await new Promise<void>(resolve=>server?.close(()=>resolve()));await rm(directory,{recursive:true,force:true});});
  it('copies only snapshot references into private verified files and resumes without downloading twice',async()=>{
    provider.set('/ledgerbook-simulation/documents/unreferenced',Buffer.from('excluded'));
    const result=await backupDocuments(archive,output,storage);assert.equal(result.objects,2);assert.equal(result.downloaded,2);assert.equal(requests.length,2);
    assert.equal((await stat(output)).mode&0o777,0o700);assert.equal((await stat(join(output,'backup.json'))).mode&0o777,0o600);
    for(const [index,object] of objects.entries()){
      const saved=join(output,'objects',`${object.id}.bin`);assert.deepEqual(await readFile(saved),original[index]);assert.equal((await stat(saved)).mode&0o777,0o600);
    }
    assert.equal((await backupDocuments(archive,output,storage)).reused,2);assert.equal(requests.length,2);
    assert.ok(JSON.parse(await readFile(join(output,'backup.json'),'utf8')).completed_at);
  });
  it('retains a resumable incomplete backup after corrupt or unavailable provider bytes',async()=>{
    provider.set(path(objects[1]),Buffer.alloc(objects[1].size,0));
    await assert.rejects(backupDocuments(archive,output,storage),/temporarily unavailable/);
    assert.equal(JSON.parse(await readFile(join(output,'backup.json'),'utf8')).completed_at,null);
    await assert.rejects(restoreDocuments(archive,output,bucket,storage),/incomplete/);assert.equal(requests.filter(item=>item.method==='PUT').length,0);
    provider.set(path(objects[1]),original[1]);assert.equal((await backupDocuments(archive,output,storage)).reused,1);
  });
  it('restores byte-exact binary and historical files, accepts identical existing keys, refuses conflicting keys',async()=>{
    await backupDocuments(archive,output,storage);provider.clear();
    await assert.rejects(restoreDocuments(archive,output,'wrong-bucket',storage),/exact configured/);
    assert.deepEqual(await restoreDocuments(archive,output,bucket,storage),{status:'verified',objects:2,created:2,existing:0});
    objects.forEach((object,index)=>assert.deepEqual(provider.get(path(object)),original[index]));
    assert.deepEqual(await restoreDocuments(archive,output,bucket,storage),{status:'verified',objects:2,created:0,existing:2});
    const conflict=Buffer.alloc(objects[0].size,42);provider.set(path(objects[0]),conflict);
    await assert.rejects(restoreDocuments(archive,output,bucket,storage),/does not match/);assert.deepEqual(provider.get(path(objects[0])),conflict);
    assert.ok(requests.filter(item=>item.method==='PUT').every(item=>item.condition==='*'));assert.ok(!requests.some(item=>item.method==='DELETE'));
  });
  it('validates every local object and the source snapshot before any restore write',async()=>{
    await backupDocuments(archive,output,storage);provider.clear();requests.length=0;
    const file=join(output,'objects',`${objects[1].id}.bin`);await writeFile(file,Buffer.alloc(objects[1].size,55));
    await assert.rejects(restoreDocuments(archive,output,bucket,storage),/checksum/);assert.equal(requests.length,0);
    await rm(file);await symlink(archive,file);await assert.rejects(restoreDocuments(archive,output,bucket,storage),/symbolic links/);assert.equal(requests.length,0);
    await writeFile(archive,'corrupt');await assert.rejects(backupDocuments(archive,join(directory,'other'),storage),/snapshot manifest/);assert.equal(requests.length,0);
  });
  it('rejects unsafe reference metadata and bucket redirection before contacting storage',async()=>{
    const manifest=JSON.parse(await readFile(`${archive}.json`,'utf8'));requests.length=0;
    for(const invalid of [{...objects[0],object_key:'documents/../../secret'},{...objects[0],id:'../bad'}]){
      await writeFile(`${archive}.json`,JSON.stringify({...manifest,referenced_objects:[invalid]}));await assert.rejects(backupDocuments(archive,output,storage),/valid referenced_objects/);
    }
    await writeFile(`${archive}.json`,JSON.stringify({...manifest,referenced_objects:[{...objects[0],bucket:'other-bucket'}]}));
    await assert.rejects(backupDocuments(archive,output,storage),/same private cloud bucket/);assert.equal(requests.length,0);
    await writeFile(`${archive}.json`,JSON.stringify({...manifest,referenced_objects:[objects[0],objects[0]]}));
    await assert.rejects(backupDocuments(archive,output,storage),/duplicate object/);assert.equal(requests.length,0);
  });
});
