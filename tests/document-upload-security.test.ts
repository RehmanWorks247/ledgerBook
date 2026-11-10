import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { AccessService, type Membership } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { DocumentStorage, type StoredDocument } from '../apps/api/src/bookings/document-storage';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

// These are service authorization/race checks, not provider contract checks.
// The raw HTTP R2 suite and Postman simulation exercise transport separately.
class VerificationStorage extends DocumentStorage {
  objects = new Map<string,Buffer>();
  reads = 0;
  afterRead: (()=>Promise<void>) | undefined;
  constructor() {
    super({mode:'r2',bucket:'security-development',region:'auto',endpoint:'https://storage.invalid',
      credentials:{accessKeyId:'test-only',secretAccessKey:'test-only'}});
  }
  override async signUpload(object:StoredDocument,mimeType:string) {
    return {url:`https://storage.invalid/${object.object_key}`,headers:{'Content-Type':mimeType,'If-None-Match':'*'}};
  }
  override async get(object:StoredDocument) {
    this.reads++;
    const bytes=this.objects.get(object.id);
    assert.ok(bytes,'Test fixture must have uploaded the object.');
    await this.afterRead?.();
    return bytes;
  }
}

describe('direct booking upload authorization and lifecycle races',()=>{
  let database:TestDatabase,seed:TestSeed,access:AccessService,bookings:BookingsService;
  let bookingId:string,folderId:string,otherFolderId:string,secondBookingId:string,secondFolderId:string;
  let sameOrganizationAdmin:Membership;
  const storage=new VerificationStorage();
  const bytes=Buffer.from('Booking document security fixture');
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const request=(name:string)=>({name,size:bytes.length,sha256,idempotency_key:randomUUID()});
  const begin=async (name:string)=>{
    const input=request(name);
    const ticket=await bookings.beginUpload(seed.admin,seed.customerId,bookingId,folderId,input);
    assert.equal(ticket.transport,'direct');
    if(ticket.transport!=='direct') throw new Error('Expected a direct upload.');
    storage.objects.set(ticket.uploadId,bytes);
    return {input,ticket};
  };
  const visibleCount=async (key:string)=>(await database.db.query('SELECT id FROM booking_nodes WHERE idempotency_key=$1',[key])).rows.length;

  before(async()=>{
    database=await setupTestDatabase();
    seed=await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1",[seed.orgId]);
    access=new AccessService(database.db);
    bookings=new BookingsService(database.db,access,storage);
    const create=async(customerId:string,reference:string)=>{
      const booking=await bookings.create(seed.admin,customerId,{reference,departure_at:'2026-11-12T10:30:00Z',
        amount:'100.00',effective_date:'2026-11-09',required_services:['makkah'],idempotency_key:randomUUID()});
      return booking.id as string;
    };
    bookingId=await create(seed.customerId,'UPLOAD-SECURITY');
    const folders=(await bookings.files(seed.admin,seed.customerId,bookingId)).items;
    folderId=folders.find(node=>node.serviceKey==='makkah')!.id;
    otherFolderId=folders.find(node=>node.serviceKey==='madinah')!.id;
    secondBookingId=await create(seed.secondCustomerId,'OTHER-CUSTOMER');
    secondFolderId=(await bookings.files(seed.admin,seed.secondCustomerId,secondBookingId)).items.find(node=>node.serviceKey==='makkah')!.id;
    await database.db.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'admin')",[randomUUID(),seed.orgId,seed.otherAdminId]);
    sameOrganizationAdmin=await access.membership(seed.otherAdminId,seed.orgId);
  });
  after(async()=>{storage.onApplicationShutdown();if(database) await database.close();});

  it('rejects customers and foreign tenants before creating upload reservations',async()=>{
    const before=(await database.db.query('SELECT id FROM document_uploads')).rows.length;
    await assert.rejects(bookings.beginUpload(seed.customerMember,seed.customerId,bookingId,folderId,request('customer.txt')),/administrator/);
    await assert.rejects(bookings.beginUpload(seed.otherAdmin,seed.customerId,bookingId,folderId,request('foreign.txt')),/not found/);
    assert.equal((await database.db.query('SELECT id FROM document_uploads')).rows.length,before);
  });

  it('binds completion to its original uploader, customer, booking and folder before reading storage',async()=>{
    const {ticket}=await begin('bound.txt');
    const reads=storage.reads;
    await assert.rejects(bookings.completeUpload(sameOrganizationAdmin,seed.customerId,bookingId,folderId,ticket.uploadId),/not found/);
    await assert.rejects(bookings.completeUpload(seed.admin,seed.customerId,bookingId,otherFolderId,ticket.uploadId),/not found/);
    await assert.rejects(bookings.completeUpload(seed.admin,seed.secondCustomerId,secondBookingId,secondFolderId,ticket.uploadId),/not found/);
    await assert.rejects(bookings.completeUpload(seed.customerMember,seed.customerId,bookingId,folderId,ticket.uploadId),/administrator/);
    assert.equal(storage.reads,reads);
    const saved=await bookings.completeUpload(seed.admin,seed.customerId,bookingId,folderId,ticket.uploadId);
    assert.deepEqual((await bookings.document(seed.customerMember,seed.customerId,bookingId,saved.id)).content,bytes);
  });

  it('rechecks admin membership after verification and leaves no visible document when access is revoked',async()=>{
    const {input,ticket}=await begin('revoked.txt');
    storage.afterRead=async()=>{await database.db.query('UPDATE memberships SET is_active=false WHERE id=$1',[seed.admin.id]);};
    try {
      await assert.rejects(bookings.completeUpload(seed.admin,seed.customerId,bookingId,folderId,ticket.uploadId),/Organization access is unavailable/);
    } finally {
      storage.afterRead=undefined;
      await database.db.query('UPDATE memberships SET is_active=true WHERE id=$1',[seed.admin.id]);
    }
    assert.equal(await visibleCount(input.idempotency_key),0);
    assert.equal((await database.db.query('SELECT state FROM document_objects WHERE id=$1',[ticket.uploadId])).rows[0].state,'pending');
    const saved=await bookings.completeUpload(seed.admin,seed.customerId,bookingId,folderId,ticket.uploadId);
    assert.ok(saved.id);
    assert.equal(await visibleCount(input.idempotency_key),1);
  });

  it('rechecks customer archival after verification without publishing the pending object',async()=>{
    const {input,ticket}=await begin('archived.txt');
    storage.afterRead=async()=>{await database.db.query("UPDATE customers SET status='archived' WHERE id=$1",[seed.customerId]);};
    try {
      await assert.rejects(bookings.completeUpload(seed.admin,seed.customerId,bookingId,folderId,ticket.uploadId),/Restore this customer/);
    } finally {
      storage.afterRead=undefined;
      await database.db.query("UPDATE customers SET status='active' WHERE id=$1",[seed.customerId]);
    }
    assert.equal(await visibleCount(input.idempotency_key),0);
  });

  it('denies another customer in the same organization access to a completed document',async()=>{
    const input=request('other-customer.txt');
    const ticket=await bookings.beginUpload(seed.admin,seed.secondCustomerId,secondBookingId,secondFolderId,input);
    assert.equal(ticket.transport,'direct');
    if(ticket.transport!=='direct') throw new Error('Expected a direct upload.');
    storage.objects.set(ticket.uploadId,bytes);
    const saved=await bookings.completeUpload(seed.admin,seed.secondCustomerId,secondBookingId,secondFolderId,ticket.uploadId);
    const reads=storage.reads;
    await assert.rejects(bookings.document(seed.customerMember,seed.secondCustomerId,secondBookingId,saved.id),/not found/);
    await assert.rejects(bookings.document(seed.customerMember,seed.customerId,bookingId,saved.id),/not found/);
    assert.equal(storage.reads,reads);
  });

  it('deletes metadata immediately, preserves cleanup coordinates and prevents an old completion resurrecting the file',async()=>{
    const {input,ticket}=await begin('deleted.txt');
    const saved=await bookings.completeUpload(seed.admin,seed.customerId,bookingId,folderId,ticket.uploadId);
    await assert.rejects(bookings.remove(seed.customerMember,seed.customerId,bookingId,saved.id),/administrator/);
    await bookings.remove(seed.admin,seed.customerId,bookingId,saved.id);
    const reads=storage.reads;
    await assert.rejects(bookings.document(seed.customerMember,seed.customerId,bookingId,saved.id),/not found/);
    await assert.rejects(bookings.completeUpload(seed.admin,seed.customerId,bookingId,folderId,ticket.uploadId),/not found/);
    assert.equal(storage.reads,reads);
    assert.equal(await visibleCount(input.idempotency_key),0);
    assert.equal((await database.db.query('SELECT id FROM document_uploads WHERE id=$1',[ticket.uploadId])).rows.length,0);
    assert.equal((await database.db.query('SELECT id FROM document_purge_outbox WHERE id=$1',[ticket.uploadId])).rows.length,1);
  });
});
