import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DocumentStorage, type StoredDocument } from '../apps/api/src/bookings/document-storage';

// Explicit live smoke check. Creates only a unique synthetic object and removes
// that exact object in finally; never reads or modifies booking/customer files.
async function main() {
  const storage = new DocumentStorage();
  if (!storage.direct || !storage.options.bucket) throw new Error('Configure an R2 environment before running this check.');
  const bytes = Buffer.from('LedgerBook private R2 verification fixture. No customer data.\n');
  const object: StoredDocument = {
    id: randomUUID(), bucket: storage.options.bucket,
    object_key: `verification/${randomUUID()}.txt`, size: bytes.length,
    checksum: createHash('sha256').update(bytes).digest('hex'),
  };
  const signed = await storage.signUpload(object, 'text/plain', 60);
  const started = performance.now();
  try {
    if (process.env.PUBLIC_APP_URL) {
      const preflight = await fetch(signed.url, { method: 'OPTIONS', headers: {
        Origin: process.env.PUBLIC_APP_URL, 'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type,if-none-match',
      }, signal: AbortSignal.timeout(15000) });
      assert.equal(preflight.headers.get('access-control-allow-origin'), process.env.PUBLIC_APP_URL, 'R2 CORS must allow the application origin.');
      assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /PUT/);
      console.log('PASS: browser upload CORS for the configured application origin.');
    }
    const uploaded = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: bytes, signal: AbortSignal.timeout(30000) });
    assert.equal(uploaded.status, 200, 'Signed R2 upload failed.');
    assert.deepEqual(await storage.get(object, true), bytes);
    console.log(`PASS: private signed upload and SHA-256 verified download (${Math.round(performance.now() - started)} ms for a small synthetic file).`);
    const replay = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: bytes, signal: AbortSignal.timeout(15000) });
    assert.equal(replay.status, 412, 'A signed URL must not overwrite an existing verified object.');
    console.log('PASS: replayed upload cannot overwrite an existing object.');
    const unsigned = new URL(signed.url); unsigned.search = '';
    const anonymous = await fetch(unsigned, { signal: AbortSignal.timeout(15000) });
    assert.ok([400, 401, 403, 404].includes(anonymous.status), 'Anonymous access must be denied.');
    console.log('PASS: anonymous access is denied.');
  } finally {
    try {
      await storage.remove(object);
      console.log('PASS: the synthetic verification object was removed.');
    } finally { storage.onApplicationShutdown(); }
  }
}

void main().catch(error => {
  // Never print provider errors/URLs, which can contain signed credentials.
  console.error(error instanceof assert.AssertionError ? error.message : 'R2 verification failed. Check bucket permissions, environment and CORS.');
  process.exitCode = 1;
});
