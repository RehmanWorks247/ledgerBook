import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { cleanupDocumentObjects, DocumentStorage, type StoredDocument } from '../apps/api/src/bookings/document-storage';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

const pdf = (label:string) => Buffer.concat([
  Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Title (${label}) >>\nendobj\n%binary:`),
  Buffer.from([0,255,128,13,10]),Buffer.from('\n%%EOF\n'),
]);

/** A real HTTP boundary: requests are serialized/signed by the production AWS SDK. */
class S3StandIn {
  readonly objects = new Map<string,Buffer>();
  readonly requests:Array<{method:string;path:string;headers:IncomingHttpHeaders}> = [];
  readonly failDeletes = new Set<string>();
  failPuts = false;
  afterPut?:()=>Promise<void>;
  private server?:Server;

  async start() {
    this.server = createServer((request,response) => {
      void (async () => {
        const path = decodeURIComponent(new URL(request.url!,'http://localhost').pathname);
        this.requests.push({method:request.method!,path,headers:request.headers});
        if (!request.headers.authorization?.startsWith('AWS4-HMAC-SHA256 ')) {
          response.writeHead(403,{'Content-Type':'application/xml'}).end('<Error><Code>AccessDenied</Code></Error>');
          return;
        }
        if (request.method === 'PUT') {
          const chunks:Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const bytes = Buffer.concat(chunks);
          if (this.failPuts) {
            response.writeHead(500,{'Content-Type':'application/xml'}).end('<Error><Code>InternalError</Code><Message>provider secret must not escape</Message></Error>');
            return;
          }
          const checksum = createHash('sha256').update(bytes).digest('base64');
          if (request.headers['x-amz-checksum-sha256'] !== checksum) {
            response.writeHead(400,{'Content-Type':'application/xml'}).end('<Error><Code>BadDigest</Code></Error>');
            return;
          }
          this.objects.set(path,bytes);
          await this.afterPut?.();
          response.writeHead(200,{'ETag':'"stand-in"','x-amz-checksum-sha256':checksum}).end();
        } else if (request.method === 'GET') {
          const bytes = this.objects.get(path);
          if (!bytes) response.writeHead(404,{'Content-Type':'application/xml'}).end('<Error><Code>NoSuchKey</Code></Error>');
          else response.writeHead(200,{'Content-Type':'application/pdf','Content-Length':bytes.length}).end(bytes);
        } else if (request.method === 'DELETE') {
          if (this.failDeletes.has(path)) {
            response.writeHead(500,{'Content-Type':'application/xml'}).end('<Error><Code>InternalError</Code></Error>');
          } else { this.objects.delete(path); response.writeHead(204).end(); }
        } else response.writeHead(405).end();
      })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
    });
    await new Promise<void>((resolve,reject) => {
      this.server!.once('error',reject);
      this.server!.listen(0,'127.0.0.1',resolve);
    });
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async close() {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve,reject) => this.server ? this.server.close(error => error ? reject(error) : resolve()) : resolve());
  }
}

describe('private S3 documents and durable upload reconciliation',() => {
  let database:TestDatabase;
  let seed:TestSeed;
  let storage:DocumentStorage;
  let bookings:BookingsService;
  let bookingId:string;
  let folderId:string;
  let savedId:string;
  let readyObject:StoredDocument;
  let orphanObject:StoredDocument;
  const provider = new S3StandIn();
  const previousEnvironment = {AWS_ACCESS_KEY_ID:process.env.AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY:process.env.AWS_SECRET_ACCESS_KEY,AWS_SESSION_TOKEN:process.env.AWS_SESSION_TOKEN};
  const objectPath = (object:StoredDocument) => `/${object.bucket}/${object.object_key}`;
  const upload = (name:string,key=randomUUID(),bytes=pdf(name)) => bookings.upload(seed.admin,seed.customerId,bookingId,folderId,name,key,bytes);
  const journal = async (id:string) => (await database.db.query<StoredDocument>('SELECT id,bucket,object_key,checksum,size FROM document_objects WHERE id=$1',[id])).rows[0];

  before(async () => {
    process.env.AWS_ACCESS_KEY_ID = 'test-only-access-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-only-secret-key';
    delete process.env.AWS_SESSION_TOKEN;
    const endpoint = await provider.start();
    storage = new DocumentStorage({mode:'s3',bucket:'ledgerbook-test',region:'eu-west-2',endpoint,forcePathStyle:true});
    database = await setupTestDatabase();
    seed = await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1",[seed.orgId]);
    const access = new AccessService(database.db);
    seed.admin = await access.membership(seed.adminId,seed.orgId);
    bookings = new BookingsService(database.db,access,storage);
    bookingId = (await bookings.create(seed.admin,seed.customerId,{reference:'STORAGE-TEST',departure_at:'2026-11-12T10:30:00Z',
      amount:'100.00',effective_date:'2026-11-06',required_services:['makkah'],idempotency_key:randomUUID()})).id as string;
    folderId = (await bookings.files(seed.admin,seed.customerId,bookingId)).items.find(node => node.serviceKey === 'makkah')!.id;
  });
  after(async () => {
    storage?.onApplicationShutdown();
    await provider.close();
    if (database) await database.close();
    for (const [key,value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it('writes signed, encrypted, checksummed objects while committing only private metadata and one audit event',async () => {
    const bytes = pdf('cloud-voucher.pdf');
    const saved = await upload('cloud-voucher.pdf',randomUUID(),bytes);
    savedId = saved.id;
    const row = (await database.db.query('SELECT content,size,storage_object_id FROM booking_nodes WHERE id=$1',[saved.id])).rows[0];
    assert.equal(row.content,null);
    assert.equal(row.size,bytes.length);
    readyObject = await journal(row.storage_object_id);
    assert.deepEqual(provider.objects.get(objectPath(readyObject)),bytes);
    assert.equal(readyObject.checksum,createHash('sha256').update(bytes).digest('hex'));
    const put = provider.requests.find(request => request.method === 'PUT' && request.path === objectPath(readyObject))!;
    assert.equal(put.headers['x-amz-server-side-encryption'],'AES256');
    assert.equal(put.headers['content-type'],'application/pdf');
    assert.equal(put.headers['cache-control'],'private, no-store');
    assert.equal((await database.db.query("SELECT state FROM document_objects WHERE id=$1",[readyObject.id])).rows[0].state,'ready');
    assert.equal((await database.db.query("SELECT count(*)::int AS n FROM audit_events WHERE action='document.uploaded' AND object_id=$1",[saved.id])).rows[0].n,1);
    assert.deepEqual((await bookings.document(seed.customerMember,seed.customerId,bookingId,saved.id)).content,bytes);
    assert.ok(saved.openUrl?.startsWith('/api/organizations/'));
    assert.equal(JSON.stringify(saved).includes('object_key'),false);
  });

  it('continues reading bytea documents after switching the configured writer to S3',async () => {
    const local = new BookingsService(database.db,new AccessService(database.db),new DocumentStorage({mode:'database'}));
    const bytes = pdf('legacy');
    const saved = await local.upload(seed.admin,seed.customerId,bookingId,folderId,'legacy.pdf',randomUUID(),bytes);
    const requestsBefore = provider.requests.length;
    assert.deepEqual((await bookings.document(seed.admin,seed.customerId,bookingId,saved.id)).content,bytes);
    assert.equal(provider.requests.length,requestsBefore);
    assert.equal((await database.db.query('SELECT storage_object_id FROM booking_nodes WHERE id=$1',[saved.id])).rows[0].storage_object_id,null);
  });

  it('returns one document and audit event for simultaneous identical submissions without overwriting either attempt', {timeout:15_000},async () => {
    let arrived = 0;
    let release!:()=>void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    provider.afterPut = async () => { if (++arrived === 2) release(); await gate; };
    const key = randomUUID();
    let results;
    try { results = await Promise.all([upload('concurrent.pdf',key),upload('concurrent.pdf',key)]); }
    finally { release(); provider.afterPut = undefined; }
    assert.equal(results[0].id,results[1].id);
    assert.equal(arrived,2);
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM booking_nodes WHERE idempotency_key=$1',[key])).rows[0].n,1);
    assert.equal((await database.db.query("SELECT count(*)::int AS n FROM audit_events WHERE action='document.uploaded' AND object_id=$1",[results[0].id])).rows[0].n,1);
    const count = provider.requests.length;
    await assert.rejects(upload('concurrent.pdf',key,pdf('different')),/different upload/);
    assert.equal(provider.requests.length,count,'Conflicting retry is rejected before reaching S3.');
    assert.deepEqual((await bookings.document(seed.admin,seed.customerId,bookingId,results[0].id)).content,pdf('concurrent.pdf'));
  });

  it('leaves no visible document on provider failure, hides provider details, and allows retry',async () => {
    const key = randomUUID();
    provider.failPuts = true;
    try {
      await assert.rejects(upload('provider-failure.pdf',key),(error:unknown) => {
        assert.equal((error as {getStatus():number}).getStatus(),503);
        assert.match((error as Error).message,/temporarily unavailable/);
        assert.doesNotMatch((error as Error).message,/provider secret/);
        return true;
      });
    } finally { provider.failPuts = false; }
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM booking_nodes WHERE idempotency_key=$1',[key])).rows[0].n,0);
    const saved = await upload('provider-failure.pdf',key);
    assert.deepEqual((await bookings.document(seed.admin,seed.customerId,bookingId,saved.id)).content,pdf('provider-failure.pdf'));
  });

  it('retains a recoverable pending object when metadata or audit persistence rolls back',async () => {
    const key = randomUUID();
    const priorKeys = new Set(provider.objects.keys());
    await database.db.query(`CREATE FUNCTION storage_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='document.uploaded' AND NEW.metadata->>'name'='audit-failure.pdf' THEN RAISE EXCEPTION 'simulated audit failure'; END IF;
      RETURN NEW; END; $$`);
    await database.db.query('CREATE TRIGGER storage_test_reject_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION storage_test_reject_audit()');
    try { await assert.rejects(upload('audit-failure.pdf',key),/simulated audit failure/); }
    finally {
      await database.db.query('DROP TRIGGER storage_test_reject_audit ON audit_events');
      await database.db.query('DROP FUNCTION storage_test_reject_audit()');
    }
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM booking_nodes WHERE idempotency_key=$1',[key])).rows[0].n,0);
    const path = [...provider.objects.keys()].find(value => !priorKeys.has(value))!;
    const row = (await database.db.query("SELECT id,state FROM document_objects WHERE object_key=$1",[path.slice('/ledgerbook-test/'.length)])).rows[0];
    assert.equal(row.state,'pending');
    orphanObject = await journal(row.id);
    assert.ok(provider.objects.has(objectPath(orphanObject)));
    const saved = await upload('audit-failure.pdf',key);
    assert.notEqual((await database.db.query('SELECT storage_object_id FROM booking_nodes WHERE id=$1',[saved.id])).rows[0].storage_object_id,orphanObject.id);
  });

  it('reconciles only old unreferenced objects and retries failed deletion without touching ready documents',async () => {
    assert.deepEqual(await cleanupDocumentObjects(database.db,storage),{removed:0,failed:0});
    await database.db.query("UPDATE document_objects SET created_at=now()-interval '25 hours' WHERE id=ANY($1::uuid[])",[[orphanObject.id,readyObject.id]]);
    provider.failDeletes.add(objectPath(orphanObject));
    try { assert.deepEqual(await cleanupDocumentObjects(database.db,storage),{removed:0,failed:1}); }
    finally { provider.failDeletes.clear(); }
    assert.equal((await database.db.query('SELECT state FROM document_objects WHERE id=$1',[orphanObject.id])).rows[0].state,'deleting');
    assert.ok(provider.objects.has(objectPath(readyObject)));
    assert.deepEqual(await cleanupDocumentObjects(database.db,storage),{removed:1,failed:0});
    assert.equal((await database.db.query('SELECT id FROM document_objects WHERE id=$1',[orphanObject.id])).rows.length,0);
    assert.equal(provider.objects.has(objectPath(orphanObject)),false);
    assert.equal(provider.requests.some(request => request.method === 'DELETE' && request.path === objectPath(readyObject)),false);
    assert.deepEqual((await bookings.document(seed.admin,seed.customerId,bookingId,savedId)).content,pdf('cloud-voucher.pdf'));
    assert.ok((await database.db.query("SELECT id FROM document_objects WHERE state='pending'")).rows.length > 0,'Young pending attempts remain available for reconciliation later.');
  });

  it('rechecks membership after upload and cannot finalize when access was revoked during the provider call',async () => {
    const key = randomUUID();
    const beforeObjects = provider.objects.size;
    provider.afterPut = async () => { await database.db.query('UPDATE memberships SET is_active=false WHERE organization_id=$1 AND user_id=$2',[seed.orgId,seed.adminId]); };
    try { await assert.rejects(upload('revoked.pdf',key),/Organization access is unavailable/); }
    finally {
      provider.afterPut = undefined;
      await database.db.query('UPDATE memberships SET is_active=true WHERE organization_id=$1 AND user_id=$2',[seed.orgId,seed.adminId]);
    }
    assert.equal(provider.objects.size,beforeObjects+1);
    assert.equal((await database.db.query('SELECT id FROM booking_nodes WHERE idempotency_key=$1',[key])).rows.length,0);
  });

  it('rejects cross-tenant reads and writes before issuing storage requests',async () => {
    const count = provider.requests.length;
    await assert.rejects(bookings.document(seed.otherAdmin,seed.customerId,bookingId,savedId),/not found/);
    await assert.rejects(bookings.upload(seed.otherAdmin,seed.customerId,bookingId,folderId,'wrong-tenant.pdf',randomUUID(),pdf('wrong tenant')),/not found/);
    await assert.rejects(bookings.upload(seed.customerMember,seed.customerId,bookingId,folderId,'customer.pdf',randomUUID(),pdf('customer')),/administrator/);
    assert.equal(provider.requests.length,count);
  });

  it('rejects provider content with the wrong checksum or size instead of returning corrupted documents',async () => {
    const path = objectPath(readyObject);
    const original = provider.objects.get(path)!;
    try {
      const corrupted = Buffer.from(original);
      corrupted[0] ^= 1;
      provider.objects.set(path,corrupted);
      await assert.rejects(bookings.document(seed.admin,seed.customerId,bookingId,savedId),/temporarily unavailable/);
      provider.objects.set(path,original.subarray(0,-1));
      await assert.rejects(bookings.document(seed.admin,seed.customerId,bookingId,savedId),/temporarily unavailable/);
    } finally { provider.objects.set(path,original); }
    assert.deepEqual((await bookings.document(seed.admin,seed.customerId,bookingId,savedId)).content,original);
  });

  it('preserves finalized journal identity and state against direct database updates',async () => {
    const before = await journal(readyObject.id);
    const invalidUpdates:Array<[string,unknown]> = [
      ['id',randomUUID()], ['organization_id',seed.otherOrgId], ['customer_id',seed.secondCustomerId],
      ['booking_id',randomUUID()], ['bucket','changed-private-bucket'], ['object_key',`changed/${randomUUID()}.pdf`],
      ['checksum','f'.repeat(64)], ['size',readyObject.size+1], ['state','pending'], ['state','deleting'],
    ];
    for (const [column,value] of invalidUpdates) {
      // Column identifiers are fixed literals above; values remain parameterized.
      await assert.rejects(database.db.query(`UPDATE document_objects SET ${column}=$1 WHERE id=$2`,[value,readyObject.id]),error => {
        assert.equal((error as {code?:string}).code,'23514');
        assert.match((error as Error).message,/identity and finalized state are immutable/);
        return true;
      });
    }
    assert.deepEqual(await journal(readyObject.id),before);
    assert.equal((await database.db.query('SELECT state FROM document_objects WHERE id=$1',[readyObject.id])).rows[0].state,'ready');
    await assert.rejects(database.db.query('DELETE FROM document_objects WHERE id=$1',[readyObject.id]),error => (error as {code?:string}).code==='23503');
    assert.deepEqual((await bookings.document(seed.admin,seed.customerId,bookingId,savedId)).content,pdf('cloud-voucher.pdf'));
  });

  it('rejects attachment of pending or deleting journal rows and cannot resurrect a cleanup claim',async () => {
    const id=randomUUID();
    await database.db.query(`INSERT INTO document_objects(id,organization_id,customer_id,booking_id,bucket,object_key,checksum,size)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,seed.orgId,seed.customerId,bookingId,readyObject.bucket,`schema-test/${id}.pdf`,readyObject.checksum,readyObject.size]);
    const attach=()=>database.db.query('UPDATE booking_nodes SET storage_object_id=$1 WHERE id=$2',[id,savedId]);
    await assert.rejects(attach(),/Document storage must be ready/);
    await database.db.query("UPDATE document_objects SET state='deleting' WHERE id=$1",[id]);
    await assert.rejects(attach(),/Document storage must be ready/);
    await assert.rejects(database.db.query("UPDATE document_objects SET state='ready' WHERE id=$1",[id]),/identity and finalized state are immutable/);
    await assert.rejects(database.db.query("UPDATE document_objects SET state='pending' WHERE id=$1",[id]),/identity and finalized state are immutable/);
    assert.equal((await database.db.query('SELECT storage_object_id FROM booking_nodes WHERE id=$1',[savedId])).rows[0].storage_object_id,readyObject.id);
    await database.db.query('DELETE FROM document_objects WHERE id=$1',[id]);
    assert.deepEqual((await bookings.document(seed.admin,seed.customerId,bookingId,savedId)).content,pdf('cloud-voucher.pdf'));
  });
});
