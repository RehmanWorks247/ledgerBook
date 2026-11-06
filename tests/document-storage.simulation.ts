// Run with the committed local Postman simulation; never calls AWS.
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
    console.log('PASS: real AWS SDK PUT/GET/DELETE with exact ASCII-PDF bytes; checksum/SSE headers; two transient 503s retried; persistent outage sanitized after three attempts. Binary coverage uses document-storage.test.ts because Postman 1.75 decodes bodies as UTF-8.');
  } finally {
    storage.onApplicationShutdown();
    for (const [key,value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key]=value; }
  }
}
void main().catch(error => { console.error('Document storage simulation failed:',error.message); process.exitCode=1; });
