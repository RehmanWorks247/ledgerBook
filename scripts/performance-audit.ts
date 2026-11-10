import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setupTestDatabase } from '../tests/helpers';
import { AccessService } from '../apps/api/src/access/access.service';
import { DashboardService } from '../apps/api/src/dashboard/dashboard.service';
import { CustomersService } from '../apps/api/src/customers/customers.service';
import { LedgerService } from '../apps/api/src/ledger/ledger.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { BookingManagementService } from '../apps/api/src/bookings/booking-management.service';

// Opt-in SQL/service benchmark. Never load the app's .env or use its database.
// TEST_DATABASE_URL=postgresql://.../ledger_audit node --require ./tests/test-environment.cjs --import tsx scripts/performance-audit.ts
async function main() {
  let target:URL;
  try { target=new URL(process.env.TEST_DATABASE_URL ?? 'postgresql://invalid/'); }
  catch { throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL.'); }
  if (process.env.NODE_ENV!=='test' || !['localhost','127.0.0.1','[::1]'].includes(target.hostname)
    || !['postgres:','postgresql:'].includes(target.protocol)
    || !/(?:^|[_-])(?:test|audit)(?:[_-]|$)/i.test(target.pathname.slice(1))) {
    throw new Error('Use the test environment and a disposable local PostgreSQL database named with test or audit.');
  }
  const count=Number(process.env.AUDIT_CUSTOMERS ?? 1000);
  if (!Number.isInteger(count) || count<1 || count>10000) throw new Error('AUDIT_CUSTOMERS must be an integer from 1 to 10000.');
  const report=process.env.AUDIT_REPORT ?? '.local/launch-audit/performance.json';
  await mkdir(dirname(report),{recursive:true});
  const fixture = await setupTestDatabase();
  try {
    const seed = await fixture.seed();
    await fixture.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1", [seed.orgId]);
    const access = new AccessService(fixture.db);
    const member = await access.membership(seed.adminId,seed.orgId);
    const started=performance.now();
    await fixture.db.transaction(async client => {
      // Bulk fixture construction is not an application request. The normal
      // 15-second query limit is automatically restored when this commits.
      await client.query("SET LOCAL statement_timeout = '2min'");
      await client.query(`INSERT INTO customers(id,organization_id,name,email,created_by,idempotency_key,request_hash)
        SELECT gen_random_uuid(),$1,'Performance customer '||lpad(n::text,6,'0'),'audit-'||n||'@example.test',$2,gen_random_uuid(),repeat('0',64)
        FROM generate_series(1,$3::int) n`, [seed.orgId,seed.adminId,count]);
      await client.query(`INSERT INTO ledger_entries(organization_id,customer_id,kind,amount_minor,currency,effective_date,description,reference,created_by,idempotency_key,request_hash)
        SELECT $1,c.id,'charge',100000,'GBP',CURRENT_DATE-10,'Performance booking',c.customer_code||'-'||n,$2,gen_random_uuid(),repeat('0',64)
        FROM customers c CROSS JOIN generate_series(1,5) n WHERE c.organization_id=$1 AND c.email LIKE 'audit-%'`,[seed.orgId,seed.adminId]);
      await client.query(`INSERT INTO bookings(id,organization_id,customer_id,reference,departure_at,required_services,total_minor,currency,charge_entry_id,created_by,idempotency_key,request_hash)
        SELECT gen_random_uuid(),organization_id,customer_id,reference,now()+interval '2 days',ARRAY['flight'],amount_minor,currency,id,created_by,gen_random_uuid(),repeat('0',64)
        FROM ledger_entries WHERE organization_id=$1 AND description='Performance booking'`,[seed.orgId]);
      await client.query(`INSERT INTO booking_instalments(id,organization_id,customer_id,booking_id,due_date,amount_minor)
        SELECT gen_random_uuid(),organization_id,customer_id,id,CURRENT_DATE + n,50000 FROM bookings CROSS JOIN (VALUES(-10),(2)) AS dates(n) WHERE organization_id=$1`,[seed.orgId]);
      await client.query(`INSERT INTO ledger_entries(organization_id,customer_id,kind,amount_minor,currency,effective_date,description,created_by,idempotency_key,request_hash)
        SELECT $1,c.id,'payment',-10000,'GBP',CURRENT_DATE-5,'Performance payment',$2,gen_random_uuid(),repeat('0',64)
        FROM customers c CROSS JOIN generate_series(1,20) n WHERE c.organization_id=$1 AND c.email LIKE 'audit-%'`,[seed.orgId,seed.adminId]);
      await client.query(`INSERT INTO audit_events(organization_id,actor_id,action,object_id,metadata)
        SELECT $1,$2,CASE WHEN n%10=0 THEN 'reminder.sent' ELSE 'document.uploaded' END,c.id::text,jsonb_build_object('customer_id',c.id::text)
        FROM customers c CROSS JOIN generate_series(1,50) n WHERE c.organization_id=$1 AND c.email LIKE 'audit-%'`,[seed.orgId,seed.adminId]);
    });
    for (const table of ['customers','bookings','booking_instalments','ledger_entries','audit_events']) {
      await fixture.db.query(`ANALYZE ${table}`);
    }
    const dashboard = new DashboardService(fixture.db,access);
    const customers = new CustomersService(fixture.db,access,undefined!);
    const ledger = new LedgerService(fixture.db,access);
    const customer = (await fixture.db.query("SELECT id FROM customers WHERE organization_id=$1 AND email='audit-1@example.test'",[seed.orgId])).rows[0].id;
    const cases:Record<string,()=>Promise<unknown>>={
      customers_page:()=>customers.list(member,{page_size:25}),
      customers_search:()=>customers.list(member,{search:'Performance customer 000999'}),
      customer_statement:()=>ledger.statement(member,customer),
      combined_ledger:()=>dashboard.combinedLedger(member,{page_size:50}),
      combined_ledger_search:()=>dashboard.combinedLedger(member,{search:'Performance customer 000999'}),
      dashboard_overview:()=>dashboard.overview(member),
    };
    const output:any={environment:'Disposable local PostgreSQL 17 container; service + SQL timing; excludes HTTP, Clerk, external storage/email, WAN latency',counts:{customers:count+2,bookings:count*5,instalments:count*10,ledger_entries:count*25,audit_events:count*50},seed_ms:Math.round(performance.now()-started),measurements:{}};
    for (const [name,run] of Object.entries(cases)) {
      const durations:number[]=[];
      for(let n=0;n<6;n++) {const start=performance.now();await run();durations.push(performance.now()-start);}
      const sorted=durations.slice(1).sort((a,b)=>a-b);
      output.measurements[name]={warm_samples:5,cold_ms:Math.round(durations[0]),warm_median_ms:Math.round(sorted[2]),warm_max_ms:Math.round(sorted[4])};
      console.log(name,output.measurements[name]);
      await writeFile(report,JSON.stringify(output,null,2)+'\n');
    }
    const concurrentStart=performance.now();
    const results=await Promise.allSettled(Array.from({length:10},async()=>{const start=performance.now();await dashboard.overview(member);return performance.now()-start;}));
    const durations=results.filter(r=>r.status==='fulfilled').map(r=>(r as PromiseFulfilledResult<number>).value).sort((a,b)=>a-b);
    const failures=results.filter(result=>result.status==='rejected');
    output.concurrent_dashboard={requests:10,concurrency:10,failures:failures.length,
      failure_reasons:failures.map(result=>({code:result.reason?.code,message:result.reason?.message})),
      total_ms:Math.round(performance.now()-concurrentStart),median_ms:Math.round(durations[Math.floor(durations.length/2)]),max_ms:Math.round(durations.at(-1)!)};
    console.log('concurrent_dashboard',output.concurrent_dashboard);
    if(process.env.AUDIT_WRITES==='1') {
      const bookings=new BookingsService(fixture.db,access),management=new BookingManagementService(fixture.db,access);
      const today=new Date().toISOString().slice(0,10);
      const create=()=>bookings.create(member,seed.secondCustomerId,{reference:`AUDIT-${randomUUID()}`,amount:'100.00',
        departure_at:new Date(Date.now()+7*86400_000).toISOString(),effective_date:today,required_services:['flight'],idempotency_key:randomUUID()});
      const samples:Record<string,number[]>={create:[],edit:[],cancel:[]};
      for(let n=0;n<6;n++) {
        let start=performance.now();const booking=await create();samples.create.push(performance.now()-start);
        start=performance.now();
        await management.update(member,seed.secondCustomerId,booking.id,{reference:booking.reference,amount:'125.00',departure_at:new Date(booking.departure_at).toISOString(),
          effective_date:today,required_services:['flight'],instalments:[{due_date:today,amount:'125.00'}],reason:'Performance correction',expected_version:1,idempotency_key:randomUUID()});
        samples.edit.push(performance.now()-start);start=performance.now();
        await management.cancel(member,seed.secondCustomerId,booking.id,{confirmation:booking.reference,reason:'Performance cancellation',effective_date:today,expected_version:2,idempotency_key:randomUUID()});
        samples.cancel.push(performance.now()-start);
      }
      output.booking_writes=Object.fromEntries(Object.entries(samples).map(([name,values])=>{
        const warm=values.slice(1).sort((a,b)=>a-b);
        return [name,{samples:6,cold_ms:Math.round(values[0]),warm_median_ms:Math.round(warm[2]),warm_max_ms:Math.round(warm[4])}];
      }));
      const writes=await Promise.allSettled(Array.from({length:10},async()=>{const start=performance.now();await create();return performance.now()-start;}));
      const times=writes.filter(r=>r.status==='fulfilled').map(r=>(r as PromiseFulfilledResult<number>).value).sort((a,b)=>a-b);
      output.concurrent_booking_creates={requests:10,same_customer:true,failures:writes.filter(r=>r.status==='rejected').length,
        median_ms:Math.round(times[Math.floor(times.length/2)]),max_ms:Math.round(times.at(-1)!)};
      console.log('booking_writes',output.booking_writes);console.log('concurrent_booking_creates',output.concurrent_booking_creates);
      if(output.concurrent_booking_creates.failures) process.exitCode=1;
    }
    await writeFile(report,JSON.stringify(output,null,2)+'\n');
    if (failures.length) process.exitCode=1;
  } finally {await fixture.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
