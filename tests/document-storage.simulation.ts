// Run with the committed local Postman simulation; never calls AWS or R2.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DocumentStorage, type StoredDocument } from '../apps/api/src/bookings/document-storage';

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Simulation is disabled in production.');
  const base = 'http://127.0.0.1:4018/s3';
  const control = async (action:string) => assert.equal((await fetch(`${base}/_control/${action}`,{method:'POST'})).status,200);
  const previous = {AWS_ACCESS_KEY_ID:process.env.AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY:process.env.AWS_SECRET_ACCESS_KEY,AWS_SESSION_TOKEN:process.env.AWS_SESSION_TOKEN};
  process.env.AWS_ACCESS_KEY_ID = 'simulation-only';
  process.env.AWS_SECRET_ACCESS_KEY = 'simulation-only';
  delete process.env.AWS_SESSION_TOKEN;
  const storage = new DocumentStorage({mode:'s3',bucket:'ledgerbook-simulation',region:'eu-west-2',endpoint:base,forcePathStyle:true});
  const r2 = new DocumentStorage({mode:'r2',bucket:'ledgerbook-simulation',region:'auto',endpoint:base,forcePathStyle:true,
    credentials:{accessKeyId:'simulation-only',secretAccessKey:'simulation-only'}});
  // Postman 1.75 decodes intercepted bodies as UTF-8. A separate raw HTTP S3
  // integration suite verifies binary PDFs; this fixture is deliberately ASCII.
  const bytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Title (Simulation) >>\nendobj\n%%EOF\n');
  const object:StoredDocument = {id:randomUUID(),bucket:'ledgerbook-simulation',object_key:`documents/${randomUUID()}.pdf`,size:bytes.length,checksum:createHash('sha256').update(bytes).digest('hex')};
  try {
    await control('reset');
    await storage.put(object,bytes);
    assert.deepEqual(await storage.get(object),bytes);
    await storage.remove(object);
    await assert.rejects(storage.get(object),/temporarily unavailable/);
    await control('fail-two');
    await storage.put(object,bytes);
    assert.deepEqual(await storage.get(object),bytes);
    let state = await (await fetch(`${base}/_control/state`)).json() as {puts:number;gets:number;deletes:number;objects:number};
    assert.deepEqual(state,{puts:4,gets:3,deletes:1,objects:1});
    await control('outage');
    await assert.rejects(storage.put({...object,id:randomUUID(),object_key:`documents/${randomUUID()}.pdf`},bytes),(error:unknown) => {
      assert.equal((error as {getStatus():number}).getStatus(),503);
      assert.equal((error as Error).message,'Document storage is temporarily unavailable. Retry this upload.');
      return true;
    });
    state = await (await fetch(`${base}/_control/state`)).json() as typeof state;
    assert.deepEqual(state,{puts:7,gets:3,deletes:1,objects:1});
    await control('reset');
    const textBytes=Buffer.from('a');
    const textObject={...object,id:randomUUID(),object_key:`documents/${randomUUID()}`,size:textBytes.length,checksum:createHash('sha256').update(textBytes).digest('hex')};
    await storage.put(textObject,textBytes,'text/plain');
    assert.deepEqual(await storage.get(textObject),textBytes);
    const response=await fetch(`${base}/${textObject.bucket}/${textObject.object_key}`,{headers:{Authorization:'AWS4-HMAC-SHA256 simulation-only'}});
    assert.equal(response.headers.get('content-type'),'text/plain');
    assert.equal(await response.text(),'a');
    await storage.remove(textObject);
    console.log('PASS: one-byte text file with an extensionless object key preserves bytes and Content-Type.');
    console.log('PASS: real AWS SDK PUT/GET/DELETE with exact ASCII-PDF bytes; checksum/SSE headers; two transient 503s retried; persistent outage sanitized after three attempts. Binary coverage uses document-storage.test.ts because Postman 1.75 decodes bodies as UTF-8.');

    await control('r2');
    await r2.put(object,bytes);
    assert.deepEqual(await r2.get(object),bytes);
    await control('fail-two');
    await r2.put(object,bytes);
    assert.deepEqual(await r2.get(object),bytes);
    await control('corrupt-gets');
    await assert.rejects(r2.get(object),(error:unknown) => {
      assert.equal((error as {getStatus():number}).getStatus(),503);
      assert.match((error as Error).message,/temporarily unavailable/);
      return true;
    });
    await control('recover');
    await control('fail-deletes');
    await assert.rejects(r2.remove(object));
    state = await (await fetch(`${base}/_control/state`)).json() as typeof state;
    assert.deepEqual(state,{puts:4,gets:3,deletes:3,objects:1},'Failed deletion must leave the object for reconciliation.');
    await control('recover');
    await r2.remove(object);
    await assert.rejects(r2.get(object),/temporarily unavailable/);
    await control('outage');
    await assert.rejects(r2.put(object,bytes),(error:unknown) => {
      assert.equal((error as {getStatus():number}).getStatus(),503);
      assert.equal((error as Error).message,'Document storage is temporarily unavailable. Retry this upload.');
      return true;
    });
    state = await (await fetch(`${base}/_control/state`)).json() as typeof state;
    assert.deepEqual(state,{puts:7,gets:4,deletes:4,objects:0});
    console.log('PASS: R2 adapter sends Content-MD5 without unsupported SSE, preserves ASCII-PDF bytes, retries transient failures, rejects corrupted downloads, retains objects after failed deletion, recovers deletion, and sanitizes persistent upload outage. Local contract stand-in only; live permissions and browser CORS remain separate checks.');
  } finally {
    storage.onApplicationShutdown();
    r2.onApplicationShutdown();
    for (const [key,value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key]=value; }
  }
}
void main().catch(error => { console.error('Document storage simulation failed:',error.message); process.exitCode=1; });
