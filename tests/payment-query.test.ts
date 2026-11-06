import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { HttpException } from '@nestjs/common';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

describe('searchable and paginated payment reviews', () => {
  let database:TestDatabase;
  let seed:TestSeed;
  let payments:PaymentsService;
  let firstBooking:string;
  let secondBooking:string;
  const ids=Array.from({length:105},()=>randomUUID());
  const receiptIds=Array.from({length:105},()=>randomUUID());

  before(async () => {
    database=await setupTestDatabase();
    seed=await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP'");
    const access=new AccessService(database.db);
    seed.admin=await access.membership(seed.adminId,seed.orgId);
    payments=new PaymentsService(database.db,access);
    const bookings=new BookingsService(database.db,access);
    const create=async (reference:string)=>(await bookings.create(seed.admin,seed.customerId,{
      reference,departure_at:'2030-01-01T12:00:00Z',required_services:[],amount:'10000.00',
      effective_date:'2026-01-01',idempotency_key:randomUUID(),
    })).id as string;
    firstBooking=await create('SEARCH-ALPHA');
    secondBooking=await create('SEARCH-BETA');
    // Seed immutable evidence in one transaction; each booking remains below its 100-item limit.
    await database.db.transaction(async client=>{
      for(let index=0;index<ids.length;index++) {
        const bookingId=index<55?firstBooking:secondBooking;
        await client.query(`INSERT INTO booking_payments(id,organization_id,customer_id,booking_id,
          amount_minor,currency,payment_date,note,submitted_by,submitted_at,idempotency_key,request_hash)
          VALUES($1,$2,$3,$4,$5,'GBP',$6,$7,$8,$9,$10,$11)`,
        [ids[index],seed.orgId,seed.customerId,bookingId,String((index+1)*100),
          index<60?'2026-01-02':'2026-01-03',index===104?'Final transfer 100% literal_under':'Search batch',
          seed.customerUserId,index===104?new Date('2026-09-25T12:00:00Z'):new Date(Date.UTC(2026,0,3,12,index)),randomUUID(),'0'.repeat(64)]);
        await client.query(`INSERT INTO booking_payment_receipts(id,organization_id,customer_id,booking_id,
          payment_id,name,size,content,original_sha256) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8)`,
        [receiptIds[index],seed.orgId,seed.customerId,bookingId,ids[index],`query-proof-${index}.webp`,Buffer.from('x'),index.toString(16).padStart(64,'0')]);
      }
    });
    await payments.approve(seed.admin,seed.customerId,firstBooking,ids[0],{});
    await payments.reject(seed.admin,seed.customerId,firstBooking,ids[1],{reason:'Missing bank reference'});
  });
  after(async ()=>{if(database) await database.close();});

  it('pages every result beyond the former first-100 limit and returns scoped status counts', async () => {
    const first=await payments.reviewQueue(seed.admin,{status:'all',page_size:'100'});
    const second=await payments.reviewQueue(seed.admin,{status:'all',page_size:'100',page:'2'});
    assert.equal(first.total,105);
    assert.equal(first.items.length,100);
    assert.equal(second.items.length,5);
    assert.equal(second.page,2);
    assert.equal(second.total_pages,2);
    assert.equal(new Set([...first.items,...second.items].map(item=>item.id)).size,105);
    assert.deepEqual(first.counts,{pending:103,approved:1,rejected:1,all:105});
    const pending=await payments.reviewQueue(seed.admin);
    assert.equal(pending.items.length,25);
    assert.equal(pending.total,103);
    assert.equal(pending.total_pages,5);
    const clamped=await payments.reviewQueue(seed.admin,{page:'999'});
    assert.equal(clamped.page,5);
    assert.equal(clamped.items.length,3);
  });

  it('searches identifiers, people, dates, amounts, notes and receipt names across every page', async () => {
    for(const q of [ids[104],ids[104].slice(0,8),receiptIds[104],'query-proof-104','100%','literal_under','£105.00','25 Sept 2026']) {
      const found=await payments.reviewQueue(seed.admin,{status:'all',q});
      assert.deepEqual(found.items.map(item=>item.id),[ids[104]],q);
    }
    for(const q of [seed.customerId,'ASTER studio','customer@example.test','Search batch']) {
      const found=await payments.reviewQueue(seed.admin,{status:'all',q});
      assert.equal(found.total,q==='Search batch'?104:105,q);
    }
    const code=(await payments.reviewQueue(seed.admin)).items[0].customer_code;
    assert.equal((await payments.reviewQueue(seed.admin,{status:'all',q:code})).total,105);
    assert.equal((await payments.reviewQueue(seed.admin,{status:'all',q:'SEARCH-ALPHA'})).total,55);
    assert.equal((await payments.reviewQueue(seed.admin,{status:'all',q:secondBooking})).total,50);
    for(const q of ['2026-01-02','02 Jan 2026','2 Jan 2026','02/01/2026'])
      assert.equal((await payments.reviewQueue(seed.admin,{status:'all',q})).total,60,q);
    assert.equal((await payments.reviewQueue(seed.admin,{status:'all',q:'missing bank reference'})).items[0].id,ids[1]);
    assert.equal((await payments.reviewQueue(seed.admin,{status:'all',q:'_'})).total,1,'underscore is a literal character');
    assert.equal((await payments.reviewQueue(seed.admin,{status:'all',q:'%'})).total,1,'percent is a literal character');
    assert.equal((await payments.reviewQueue(seed.admin,{status:'all',q:"' OR true --"})).total,0);
  });

  it('combines inclusive date ranges, status and search while keeping counts independent of the selected status', async () => {
    const found=await payments.reviewQueue(seed.admin,{status:'approved',q:'Aster',from:'2026-01-02',to:'2026-01-02'});
    assert.deepEqual(found.items.map(item=>item.id),[ids[0]]);
    assert.deepEqual(found.counts,{pending:58,approved:1,rejected:1,all:60});
    assert.equal(found.total,1);
    const empty=await payments.reviewQueue(seed.admin,{status:'all',from:'2026-01-04'});
    assert.equal(empty.total,0);
    assert.equal(empty.total_pages,1);
    assert.equal(empty.page,1);
    assert.deepEqual(empty.items,[]);
    assert.equal((await payments.reviewQueue(seed.otherAdmin,{status:'all',q:'Aster'})).total,0);
  });

  it('sorts amounts numerically and keeps pagination deterministic', async () => {
    for(const sort of ['newest','amount_desc']) {
      const found=await payments.reviewQueue(seed.admin,{status:'all',sort,page_size:2});
      assert.deepEqual(found.items.map(item=>item.id),[ids[104],ids[103]]);
    }
    for(const sort of ['oldest','amount_asc']) {
      const found=await payments.reviewQueue(seed.admin,{status:'all',sort,page_size:2});
      assert.deepEqual(found.items.map(item=>item.id),[ids[0],ids[1]]);
    }
  });

  it('rejects malformed or ambiguous filters before running a query', async () => {
    for(const query of [
      {status:'unknown'},{status:['pending','approved']},{page:'0'},{page:'-1'},{page:'1.5'},
      {page:'1000001'},{page:[]},{page_size:'101'},{page_size:''},{q:['Aster']},{q:'x'.repeat(201)},
      {from:'2026-02-30'},{to:'yesterday'},{from:'2026-02-01',to:'2026-01-01'},{sort:'unsafe'},
      {unexpected:'ignored'},
    ]) await assert.rejects(payments.reviewQueue(seed.admin,query),
      (error:unknown)=>error instanceof HttpException && error.getStatus()===400,JSON.stringify(query));
    await assert.rejects(payments.reviewQueue(seed.customerMember,{status:'all'}),
      (error:unknown)=>error instanceof HttpException && error.getStatus()===403);
  });
});
