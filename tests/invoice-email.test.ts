import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import sharp from 'sharp';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { config } from '../apps/api/src/config';
import { businessDate } from '../apps/api/src/dashboard/time';
import { NotificationsService, type EmailMessage } from '../apps/api/src/notifications/notifications.service';
import { PaymentEmailOutbox } from '../apps/api/src/payments/email-outbox.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

it('publishes complete MIME invoices atomically with safe filenames and unchanged local replay',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'ledger-invoice-email-'));
  const prior={mode:config.emailMode,directory:config.mailDirectory};
  config.emailMode='file';config.mailDirectory=directory;
  const pdf=Buffer.concat([Buffer.from('%PDF-1.7\n'),Buffer.from(Array.from({length:256},(_,index)=>index))]);
  try {
    const mail=new NotificationsService();
    const message={to:'customer@example.test',subject:'Invoice — Récapitulatif',text:'Booking: INVOICE-123\nYour invoice is attached.',
      attachments:[{filename:'invoice.pdf\r\nX-Evil: true/"',content:pdf,contentType:'application/pdf'}]};
    await mail.send(message,{idempotencyKey:'invoice-local-retry'});
    const names=await readdir(directory);assert.equal(names.length,1);
    const file=join(directory,names[0]),first=await readFile(file,'utf8');
    assert.equal((await stat(file)).mode&0o777,0o600);
    assert.match(first,/MIME-Version: 1.0\r\nContent-Type: multipart\/mixed/);
    assert.doesNotMatch(first,/(?<!\r)\n/);
    assert.doesNotMatch(first,/\r\nX-Evil:/);
    assert.match(first,/Subject: =\?UTF-8\?B\?/);
    assert.match(first,/Booking: INVOICE-123\r\nYour invoice is attached\./);
    const encoded=first.match(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)\r\n--ledger-/)?.[1];
    assert.ok(encoded);assert.deepEqual(Buffer.from(encoded,'base64'),pdf);
    for(const line of encoded.split('\r\n'))assert.ok(line.length<=76);
    await mail.send(message,{idempotencyKey:'invoice-local-retry'});
    assert.deepEqual(await readdir(directory),names);assert.equal(await readFile(file,'utf8'),first);
  } finally {config.emailMode=prior.mode;config.mailDirectory=prior.directory;await rm(directory,{recursive:true,force:true});}
});

describe('durable booking invoice attachments',()=>{
  let database:TestDatabase,seed:TestSeed,bookings:BookingsService,payments:PaymentsService,mail:NotificationsService,worker:PaymentEmailOutbox;
  let sent:{message:EmailMessage;key?:string}[];
  beforeEach(async()=>{
    database=await setupTestDatabase();seed=await database.seed();const access=new AccessService(database.db);
    await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1",[seed.orgId]);
    bookings=new BookingsService(database.db,access);payments=new PaymentsService(database.db,access);
    sent=[];mail=new NotificationsService();mail.send=async(message,options)=>{sent.push({message,key:options?.idempotencyKey});return {providerMessageId:randomUUID()};};
    worker=new PaymentEmailOutbox(database.db,mail,access,false);
  });
  afterEach(async()=>{await worker?.beforeApplicationShutdown();await database?.close();});
  const create=(customerId:string)=>bookings.create(seed.admin,customerId,{reference:`INVOICE-${randomUUID()}`,
    departure_at:'2030-01-01T12:00:00Z',required_services:[],amount:'100.00',effective_date:businessDate(),idempotency_key:randomUUID()});
  const queued=async(bookingId:string)=>(await database.db.query('SELECT * FROM payment_email_outbox WHERE dedupe_key=$1',[`booking-created:${bookingId}`])).rows[0];
  async function approve(bookingId:string) {
    const buffer=await sharp({create:{width:8,height:8,channels:3,background:'#249a67'}}).png().toBuffer();
    const payment=await payments.submit(seed.customerMember,seed.customerId,bookingId,{amount:'25.00',payment_date:businessDate(),idempotency_key:randomUUID()},
      [{originalname:'receipt.png',mimetype:'image/png',buffer,size:buffer.length}]);
    await payments.approve(seed.admin,seed.customerId,bookingId,payment.id);return payment;
  }
  async function isolate(id:string) {
    await database.db.query("UPDATE payment_email_outbox SET next_attempt_at=now()+interval '1 day' WHERE id<>$1",[id]);
  }

  it('delivers the initial stored invoice to an active customer without a login',async()=>{
    const booking=await create(seed.secondCustomerId),email=await queued(booking.id);
    assert.ok(email.invoice_id);assert.equal(await worker.flush(),1);
    assert.equal(sent.length,1);assert.equal(sent[0].message.to,'beacon@example.test');
    const invoice=(await database.db.query('SELECT * FROM booking_invoices WHERE id=$1',[email.invoice_id])).rows[0];
    assert.deepEqual(sent[0].message.attachments,[{filename:invoice.filename,content:Buffer.from(invoice.pdf),contentType:'application/pdf'}]);
    assert.equal(sent[0].key,`payment-email/${email.id}`);assert.equal(await worker.flush(),0);
  });

  it('retries the same invoice bytes and key after a later payment produces a newer invoice',async()=>{
    const booking=await create(seed.customerId),email=await queued(booking.id);await isolate(email.id);
    let fail=true;mail.send=async(message,options)=>{
      sent.push({message,key:options?.idempotencyKey});if(fail)throw new Error('Acknowledgement lost after acceptance.');
      return {providerMessageId:randomUUID()};
    };
    assert.equal(await worker.flush(),0);await approve(booking.id);await isolate(email.id);
    fail=false;await database.db.query('UPDATE payment_email_outbox SET next_attempt_at=now() WHERE id=$1',[email.id]);
    assert.equal(await worker.flush(),1);assert.equal(sent.length,2);assert.deepEqual(sent[1],sent[0]);
    const invoices=(await database.db.query('SELECT * FROM booking_invoices WHERE booking_id=$1 ORDER BY version',[booking.id])).rows;
    assert.equal(invoices.length,2);assert.notDeepEqual(Buffer.from(invoices[1].pdf),sent[0].message.attachments?.[0].content);
    assert.deepEqual(Buffer.from(invoices[0].pdf),sent[0].message.attachments?.[0].content);
  });

  for(const change of ['recipient','archived account','unrelated invoice'] as const)
    it(`cancels a queued booking attachment after ${change} changes`,async()=>{
      const booking=await create(seed.customerId),email=await queued(booking.id);
      if(change==='recipient')await database.db.query("UPDATE payment_email_outbox SET recipient='someone-else@example.test' WHERE id=$1",[email.id]);
      if(change==='archived account')await database.db.query("UPDATE customers SET status='archived' WHERE id=$1",[seed.customerId]);
      if(change==='unrelated invoice') {
        const other=await create(seed.secondCustomerId),otherEmail=await queued(other.id);
        await database.db.query('UPDATE payment_email_outbox SET invoice_id=$2 WHERE id=$1',[email.id,otherEmail.invoice_id]);
      }
      await isolate(email.id);assert.equal(await worker.flush(),0);assert.equal(sent.length,0);
      const saved=(await database.db.query('SELECT * FROM payment_email_outbox WHERE id=$1',[email.id])).rows[0];
      assert.equal(saved.state,'cancelled');assert.equal(saved.delivery_status,'cancelled');
    });

  it('attaches the approval event invoice and cancels it when customer access is removed',async()=>{
    const booking=await create(seed.customerId),payment=await approve(booking.id);
    const email=(await database.db.query('SELECT * FROM payment_email_outbox WHERE dedupe_key=$1',[`payment-approved:${payment.id}`])).rows[0];
    await isolate(email.id);assert.ok(email.invoice_id);
    await database.db.query('UPDATE memberships SET is_active=false WHERE id=$1',[seed.customerMember.id]);
    assert.equal(await worker.flush(),0);assert.equal(sent.length,0);
    assert.equal((await database.db.query('SELECT state FROM payment_email_outbox WHERE id=$1',[email.id])).rows[0].state,'cancelled');
  });
});
