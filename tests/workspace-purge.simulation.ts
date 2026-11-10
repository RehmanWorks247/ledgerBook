// Real workspace, document-version and cleanup services against the existing
// local Postman R2 HTTP stand-in. ASCII fixtures avoid CLI binary-body conversion.
// Start: postman simulation run postman/simulations/document-storage.sim.yaml --port 4029 --no-history --output ndjson
// Run: node --require ./tests/test-environment.cjs --import tsx tests/workspace-purge.simulation.ts
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { AccessService, type Membership } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { DocumentVersionsService } from '../apps/api/src/bookings/document-versions.service';
import { cleanupDocumentObjects, DocumentStorage, type StoredDocument } from '../apps/api/src/bookings/document-storage';
import { OrganizationsService } from '../apps/api/src/organizations/organizations.service';
import { setupTestDatabase } from './helpers';

async function main() {
  if (process.env.NODE_ENV !== 'test') throw new Error('Run with tests/test-environment.cjs; this simulation requires the test environment.');
  if (process.env.TEST_DATABASE_URL) {
    const database = new URL(process.env.TEST_DATABASE_URL);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)
      || !/(?:^|[_-])(?:test|audit)(?:[_-]|$)/i.test(database.pathname.slice(1))) {
      throw new Error('Use a disposable loopback PostgreSQL database named with test or audit.');
    }
  }
  const port = Number(process.env.WORKSPACE_STORAGE_SIMULATION_PORT ?? 4029);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a valid local simulation port from 1024 to 65535.');
  const endpoint = `http://127.0.0.1:${port}/s3`;
  const control = async (action: string) => assert.equal((await fetch(`${endpoint}/_control/${action}`, { method: 'POST' })).status, 200);
  const state = async () => await (await fetch(`${endpoint}/_control/state`)).json() as { puts: number; gets: number; deletes: number; objects: number };
  await control('r2');
  const database = await setupTestDatabase();
  const storage = new DocumentStorage({ mode: 'r2', bucket: 'ledgerbook-simulation', region: 'auto', endpoint, forcePathStyle: true,
    credentials: { accessKeyId: 'simulation-only', secretAccessKey: 'simulation-only' } });
  try {
    const seed = await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP'");
    const access = new AccessService(database.db);
    const admin = await access.membership(seed.adminId, seed.orgId, true);
    const otherAdmin = await access.membership(seed.otherAdminId, seed.otherOrgId, true);
    const bookings = new BookingsService(database.db, access, storage);
    const versions = new DocumentVersionsService(database.db, access, storage);
    const workspaces = new OrganizationsService(database.db, access);
    const prepareBooking = async (member: Membership, customer: string, reference: string) => {
      const booking = await bookings.create(member, customer, { reference, departure_at: '2030-01-01T12:00:00Z',
        amount: '100', effective_date: '2026-11-10', required_services: ['makkah'], idempotency_key: randomUUID() });
      const folder = (await bookings.files(member, customer, booking.id)).items.find(node => node.serviceKey === 'makkah')!.id;
      return { booking, folder };
    };
    const own = await prepareBooking(admin, seed.customerId, 'WORKSPACE-PURGE-SIMULATION');
    const other = await prepareBooking(otherAdmin, seed.otherCustomerId, 'UNRELATED-WORKSPACE-SIMULATION');
    const document = await bookings.upload(admin, seed.customerId, own.booking.id, own.folder, 'private.txt', randomUUID(), Buffer.from('historical workspace bytes'));
    const replacementBytes = Buffer.from('current workspace bytes');
    const replacement = await versions.begin(admin, seed.customerId, own.booking.id, document.id, own.folder, {
      name: 'private.txt', size: replacementBytes.length, sha256: createHash('sha256').update(replacementBytes).digest('hex'),
      expected_version: 1, idempotency_key: randomUUID(),
    });
    assert.equal(replacement.transport, 'direct');
    if (replacement.transport !== 'direct') throw new Error('The R2 adapter did not prepare the document replacement.');
    const replacementObject = (await database.db.query<StoredDocument>(`SELECT o.id,o.bucket,o.object_key,o.checksum,o.size
      FROM document_objects o JOIN document_version_uploads u ON u.storage_object_id=o.id WHERE u.id=$1`, [replacement.uploadId])).rows[0];
    await storage.put(replacementObject, replacementBytes, 'text/plain');
    assert.equal((await versions.complete(admin, seed.customerId, own.booking.id, document.id, own.folder, replacement.uploadId)).version, 2);
    const retained = await bookings.upload(otherAdmin, seed.otherCustomerId, other.booking.id, other.folder, 'retained.txt', randomUUID(), Buffer.from('another workspace stays accessible'));
    assert.equal((await versions.download(admin, seed.customerId, own.booking.id, document.id, 1)).content.toString(), 'historical workspace bytes');
    assert.equal((await versions.download(admin, seed.customerId, own.booking.id, document.id, 2)).content.toString(), 'current workspace bytes');

    const pendingBytes = Buffer.from('in-flight pending upload');
    const pending = await bookings.beginUpload(admin, seed.customerId, own.booking.id, own.folder, {
      name: 'pending.txt', size: pendingBytes.length, sha256: createHash('sha256').update(pendingBytes).digest('hex'), idempotency_key: randomUUID(),
    });
    assert.equal(pending.transport, 'direct');
    if (pending.transport !== 'direct') throw new Error('The R2 adapter did not create a pending direct-upload journal.');
    const pendingObject = (await database.db.query<StoredDocument>('SELECT id,bucket,object_key,checksum,size FROM document_objects WHERE id=$1', [pending.uploadId])).rows[0];
    // Complete the modeled provider write through the actual SDK, deliberately
    // leaving its application upload receipt uncommitted.
    await storage.put(pendingObject, pendingBytes, 'text/plain');
    const objects = (await database.db.query<StoredDocument & { state: string }>('SELECT id,bucket,object_key,checksum,size,state FROM document_objects WHERE organization_id=$1 ORDER BY id', [seed.orgId])).rows;
    assert.equal(objects.length, 3);
    assert.deepEqual(objects.map(object => object.state).sort(), ['pending', 'ready', 'ready']);
    assert.deepEqual(await state(), { puts: 4, gets: 3, deletes: 0, objects: 4 });

    const deletion = await workspaces.remove(seed.adminId, seed.orgId, { confirmation_name: 'North Trading', expected_version: 1 });
    assert.deepEqual(deletion, { id: seed.orgId, deleted: true, files_pending: 3 });
    const journal = (await database.db.query<StoredDocument>('SELECT id,bucket,object_key,checksum,size FROM document_purge_outbox ORDER BY id')).rows;
    assert.deepEqual(journal, objects.map(({ state: _state, ...object }) => object));
    for (const table of ['organizations', 'document_objects', 'document_uploads', 'booking_nodes', 'document_versions']) {
      const column = table === 'organizations' ? 'id' : table === 'document_versions' ? 'document_id' : 'organization_id';
      const id = table === 'document_versions' ? document.id : seed.orgId;
      assert.equal((await database.db.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`, [id])).rowCount, 0, table);
    }
    await assert.rejects(versions.download(admin, seed.customerId, own.booking.id, document.id, 1), /access is unavailable/);
    await assert.rejects(bookings.completeUpload(admin, seed.customerId, own.booking.id, own.folder, pending.uploadId), /access is unavailable/);
    assert.equal((await versions.download(otherAdmin, seed.otherCustomerId, other.booking.id, retained.id, 1)).content.toString(), 'another workspace stays accessible');
    assert.deepEqual(await cleanupDocumentObjects(database.db, storage), { removed: 0, failed: 0 });
    await database.db.query("UPDATE document_purge_outbox SET created_at=now()-interval '23 hours 59 minutes'");
    assert.deepEqual(await cleanupDocumentObjects(database.db, storage), { removed: 0, failed: 0 });
    assert.equal((await state()).deletes, 0, 'The 24-hour grace period must prevent early provider deletion.');

    // An upload that was already in flight can finish after the workspace is
    // removed; the durable journal must still remove its bytes after the grace.
    await storage.put(pendingObject, pendingBytes, 'text/plain');
    await database.db.query("UPDATE document_purge_outbox SET created_at=now()-interval '25 hours'");
    await control('fail-deletes');
    assert.deepEqual(await cleanupDocumentObjects(database.db, storage), { removed: 0, failed: 3 });
    assert.deepEqual((await database.db.query('SELECT id FROM document_purge_outbox ORDER BY id')).rows.map(row => row.id), objects.map(object => object.id));
    assert.deepEqual(await state(), { puts: 5, gets: 4, deletes: 9, objects: 4 });
    for (const object of objects) assert.equal((await storage.get(object)).length, object.size);

    await control('recover');
    assert.deepEqual(await cleanupDocumentObjects(database.db, storage), { removed: 3, failed: 0 });
    assert.equal((await database.db.query('SELECT 1 FROM document_purge_outbox')).rowCount, 0);
    for (const object of objects) await assert.rejects(storage.get(object), /temporarily unavailable/);
    assert.equal((await versions.download(otherAdmin, seed.otherCustomerId, other.booking.id, retained.id, 1)).content.toString(), 'another workspace stays accessible');
    assert.deepEqual(await cleanupDocumentObjects(database.db, storage), { removed: 0, failed: 0 });
    assert.deepEqual(await state(), { puts: 5, gets: 11, deletes: 12, objects: 1 });

    // Remove the remaining unrelated synthetic fixture through normal services.
    await bookings.remove(otherAdmin, seed.otherCustomerId, other.booking.id, retained.id);
    await database.db.query("UPDATE document_purge_outbox SET created_at=now()-interval '25 hours'");
    assert.deepEqual(await cleanupDocumentObjects(database.db, storage), { removed: 1, failed: 0 });
    assert.deepEqual(await state(), { puts: 5, gets: 11, deletes: 13, objects: 0 });
    console.log('PASS: permanent workspace deletion journals current, historical and pending cloud objects; immediate access denial and 24-hour grace hold; nine DELETE503 retries retain all journals and bytes; recovery removes all three target objects while another workspace remains accessible. Final fixture cleanup leaves zero objects. Observed totals: 5 PUTs, 11 GETs, 13 DELETEs.');
  } finally { storage.onApplicationShutdown(); await database.close(); }
}
void main().catch(error => { console.error('Workspace purge simulation failed:', error.message); process.exitCode = 1; });
