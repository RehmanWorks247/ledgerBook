import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { verifyPassword } from '../apps/api/src/auth/crypto';
import { demoCustomers, DEMO_AS_OF, DEMO_CUSTOMER_COUNT, DEMO_ORGANIZATION_ID, DEMO_ORGANIZATION_NAME, DEMO_START_DATE } from '../scripts/demo-data';
import { seedDemoWorkspace, verifyDemoWorkspace } from '../scripts/demo-seed';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

const legacyOrganizationId='52b9bde8-5e4f-5868-9194-d7a6da0ee47f';
const legacyCustomerId='00dfd4d4-c664-53c3-a90e-c088bc60dd8b';
const legacyUserId='fd9b8562-5c06-58c5-8281-88454496182a';
const historicalMonths=['2026-08','2026-09','2026-10','2026-11'];

describe('isolated, deterministic three-month demonstration workspace', () => {
  let database:TestDatabase;
  let seed:TestSeed;
  let originalRows:Record<string,unknown>;
  let originalMode:string|undefined;

  before(async () => {
    originalMode=process.env.NODE_ENV;
    process.env.NODE_ENV='test';
    database=await setupTestDatabase();
    seed=await database.seed();
    // Preserve identities from the original 50-customer demo as well as the
    // unrelated business workspaces supplied by the shared test helper.
    await database.db.query(`INSERT INTO organizations(id,name,currency,currency_exponent)
      VALUES($1,'LedgerBook Demo — Autumn 2026','GBP',2)`,[legacyOrganizationId]);
    await database.db.query(`INSERT INTO users(id,email,password_hash)
      VALUES($1,'demo.amina.farooq.001@example.test','disabled:demo-fixture')`,[legacyUserId]);
    await database.db.query(`INSERT INTO memberships(id,organization_id,user_id,role)
      VALUES('c768b80c-cf2e-5261-b491-ce4632b3ff3f',$1,$2,'admin')`,[legacyOrganizationId,seed.adminId]);
    await database.db.query(`INSERT INTO customers(id,organization_id,name,email,notes,created_by,idempotency_key,request_hash)
      VALUES($1,$2,'Amina Farooq','demo.amina.farooq.001@example.test','Existing demo with user edits',$3,
        '886eeeff-0ba1-52ce-96c8-f4223f2fce7a',$4)`,[legacyCustomerId,legacyOrganizationId,seed.adminId,'a'.repeat(64)]);
    await database.db.query(`INSERT INTO memberships(id,organization_id,user_id,role,customer_id)
      VALUES('235d4c73-0a02-5b2a-bf79-4f8597bedbd3',$1,$2,'customer',$3)`,[legacyOrganizationId,legacyUserId,legacyCustomerId]);
    await database.db.query(`INSERT INTO ledger_entries(organization_id,customer_id,kind,amount_minor,currency,
      effective_date,description,created_by,idempotency_key,request_hash)
      VALUES($1,$2,'charge',250000,'GBP','2026-09-01','Previously imported package',$3,$4,$5)`,
    [legacyOrganizationId,legacyCustomerId,seed.adminId,randomUUID(),'b'.repeat(64)]);
    originalRows=await existingRows();
  });
  after(async () => {
    if(database) await database.close();
    if(originalMode===undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV=originalMode;
  });

  async function existingRows() {
    const snapshot:Record<string,unknown>={};
    for(const table of ['customers','memberships','ledger_entries','invitations','audit_events','bookings','booking_instalments','booking_nodes','booking_payments','booking_payment_receipts','payment_email_outbox']) {
      snapshot[table]=(await database.db.query(`SELECT * FROM ${table} WHERE organization_id<>$1 ORDER BY id`,[DEMO_ORGANIZATION_ID])).rows;
    }
    snapshot.organizations=(await database.db.query('SELECT * FROM organizations WHERE id<>$1 ORDER BY id',[DEMO_ORGANIZATION_ID])).rows;
    snapshot.users=(await database.db.query('SELECT * FROM users WHERE id<>ALL($1::uuid[]) ORDER BY id',[demoCustomers.map(customer=>customer.userId)])).rows;
    return snapshot;
  }
  async function counts() {
    const result:Record<string,number>={};
    for(const table of ['organizations','users','customers','memberships','ledger_entries','invitations','audit_events','bookings','booking_instalments','booking_nodes','booking_payments','booking_payment_receipts','payment_email_outbox']) {
      result[table]=(await database.db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
    }
    return result;
  }

  it('defines 200 unique fictional customers throughout the last three months with coherent histories', () => {
    assert.equal(DEMO_AS_OF,'2026-11-06');
    assert.equal(DEMO_START_DATE,'2026-08-07');
    assert.equal(DEMO_CUSTOMER_COUNT,200);
    assert.equal(demoCustomers.length,DEMO_CUSTOMER_COUNT);
    assert.notEqual(DEMO_ORGANIZATION_ID,legacyOrganizationId);
    assert.ok(demoCustomers.every(customer=>customer.id!==legacyCustomerId && customer.userId!==legacyUserId));
    for(const key of ['id','userId','membershipId','name','email','phone'] as const) {
      assert.equal(new Set(demoCustomers.map(customer=>customer[key])).size,DEMO_CUSTOMER_COUNT,`${key} must be unique.`);
    }
    const scenarios:Record<string,number>={};
    const months:Record<string,number>={};
    const createdDays=new Set<string>();
    const paymentMonths=new Set<string>();
    for(const customer of demoCustomers) {
      scenarios[customer.scenario]=(scenarios[customer.scenario]??0)+1;
      const month=customer.createdAt.slice(0,7);
      months[month]=(months[month]??0)+1;
      createdDays.add(customer.createdAt.slice(0,10));
      assert.ok(customer.createdAt.slice(0,10)>=DEMO_START_DATE && customer.createdAt.slice(0,10)<=DEMO_AS_OF);
      assert.match(customer.email,/@[^@]*\.(?:test|invalid)$/);
      const trip=customer.booking;
      assert.ok(customer.createdAt<=trip.createdAt && trip.createdAt.slice(0,10)===trip.bookedOn);
      assert.ok(trip.bookedOn<=DEMO_AS_OF && trip.bookedOn<trip.departureAt.slice(0,10));
      assert.ok(trip.departureAt<trip.arrivalAt && trip.arrivalAt<trip.returnAt && trip.returnAt<trip.returnArrivalAt);
      assert.ok(trip.makkahCheckOut===trip.madinahCheckIn || trip.madinahCheckOut===trip.makkahCheckIn);
      for(const city of ['makkah','madinah'] as const) {
        assert.equal((Date.parse(trip[`${city}CheckOut`])-Date.parse(trip[`${city}CheckIn`]))/86_400_000,trip[`${city}Nights`]);
      }
      assert.equal([trip.makkahCheckIn,trip.madinahCheckIn].sort()[0],trip.arrivalAt.slice(0,10));
      assert.equal([trip.makkahCheckOut,trip.madinahCheckOut].sort()[1],trip.returnAt.slice(0,10));
      const total=BigInt(trip.totalMinor);
      assert.ok(total>0n);
      assert.equal(trip.instalments.reduce((sum,item)=>sum+BigInt(item.amountMinor),0n),total);
      assert.ok(trip.instalments.every(item=>BigInt(item.amountMinor)>0n && item.dueDate>=trip.bookedOn && item.dueDate<trip.departureAt.slice(0,10)));
      const approved=trip.payments.filter(payment=>payment.status==='approved').reduce((sum,payment)=>sum+BigInt(payment.amountMinor),0n);
      const pending=trip.payments.filter(payment=>payment.status==='pending').reduce((sum,payment)=>sum+BigInt(payment.amountMinor),0n);
      assert.ok(approved+pending<=total,'The scenarios must not overpay a booking if pending evidence is approved.');
      if(customer.scenario==='fully_paid') assert.equal(approved,total);
      if(customer.scenario==='partial') assert.ok(approved>0n && approved<total);
      if(customer.scenario==='deposit_pending') {assert.ok(approved<total);assert.ok(pending>0n);}
      if(customer.scenario==='unpaid') assert.equal(approved,0n);
      for(const payment of trip.payments) {
        paymentMonths.add(payment.paymentDate.slice(0,7));
        assert.ok(BigInt(payment.amountMinor)>0n);
        assert.ok(payment.paymentDate>=trip.bookedOn && payment.paymentDate<=DEMO_AS_OF);
        assert.ok(payment.submittedAt>=trip.createdAt);
        assert.ok(payment.submittedAt.slice(0,10)>=payment.paymentDate && payment.submittedAt.slice(0,10)<=DEMO_AS_OF);
        assert.ok(payment.receiptCount>=1 && payment.receiptCount<=5);
        if(payment.status==='pending') assert.equal(payment.reviewedAt,null);
        else {assert.ok(payment.reviewedAt);assert.ok(payment.reviewedAt!>=payment.submittedAt && payment.reviewedAt!.slice(0,10)<=DEMO_AS_OF);}
      }
    }
    assert.deepEqual(scenarios,{fully_paid:90,partial:60,deposit_pending:30,unpaid:20});
    assert.deepEqual(Object.keys(months).sort(),historicalMonths);
    assert.deepEqual([...paymentMonths].sort(),historicalMonths);
    assert.ok(months['2026-08']>=35 && months['2026-09']>=45 && months['2026-10']>=45 && months['2026-11']>=8,'Customers must be distributed through the full period.');
    assert.ok(createdDays.size>=75,'Historical activity should cover most days, rather than a few bulk import dates.');
    assert.equal([...createdDays].sort()[0],DEMO_START_DATE);
    assert.equal([...createdDays].sort().at(-1),DEMO_AS_OF);
    assert.ok(demoCustomers.some(customer=>customer.booking.returnAt.slice(0,10)<DEMO_AS_OF),'Include completed trips.');
    assert.ok(demoCustomers.some(customer=>customer.booking.departureAt.slice(0,10)>DEMO_AS_OF),'Include upcoming trips.');
  });

  it('requires a current administrator and rejects production before writing any fixture data', async () => {
    const before=await counts();
    await assert.rejects(seedDemoWorkspace(database.db,randomUUID()));
    await assert.rejects(seedDemoWorkspace(database.db,seed.customerUserId));
    await database.db.query('UPDATE memberships SET is_active=false WHERE user_id=$1',[seed.adminId]);
    try {await assert.rejects(seedDemoWorkspace(database.db,seed.adminId));}
    finally {await database.db.query('UPDATE memberships SET is_active=true WHERE user_id=$1',[seed.adminId]);}
    const originalMode=process.env.NODE_ENV;
    process.env.NODE_ENV='production';
    try {await assert.rejects(seedDemoWorkspace(database.db,seed.adminId));}
    finally {if(originalMode===undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV=originalMode;}
    assert.deepEqual(await counts(),before);
    assert.deepEqual(await existingRows(),originalRows);
  });

  it('rolls the entire import back if a generated document cannot be persisted', async () => {
    const before=await counts();
    await database.db.query(`CREATE FUNCTION demo_test_fail_document() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.kind='file' THEN RAISE EXCEPTION 'simulated demonstration document failure'; END IF; RETURN NEW; END; $$;`);
    await database.db.query('CREATE TRIGGER demo_test_fail_document BEFORE INSERT ON booking_nodes FOR EACH ROW EXECUTE FUNCTION demo_test_fail_document()');
    try {
      await assert.rejects(seedDemoWorkspace(database.db,seed.adminId),/simulated demonstration document failure/);
      assert.deepEqual(await counts(),before);
      assert.deepEqual(await existingRows(),originalRows);
    } finally {
      await database.db.query('DROP TRIGGER demo_test_fail_document ON booking_nodes');
      await database.db.query('DROP FUNCTION demo_test_fail_document()');
    }
  });

  it('refuses to replace an existing workspace that happens to have the fixture identity', async () => {
    await database.db.query("INSERT INTO organizations(id,name,currency,currency_exponent) VALUES($1,'Existing unrelated workspace','USD',2)",[DEMO_ORGANIZATION_ID]);
    const before=await counts();
    try {
      await assert.rejects(seedDemoWorkspace(database.db,seed.adminId),/already in use|fixture marker/);
      assert.deepEqual(await counts(),before);
      assert.equal((await database.db.query('SELECT name FROM organizations WHERE id=$1',[DEMO_ORGANIZATION_ID])).rows[0].name,'Existing unrelated workspace');
    } finally {await database.db.query('DELETE FROM organizations WHERE id=$1',[DEMO_ORGANIZATION_ID]);}
  });

  it('creates a separate GBP workspace with 200 bookings and preserves existing businesses and the older demo', async () => {
    const report=await seedDemoWorkspace(database.db,seed.adminId);
    assert.equal(report.organizationId,DEMO_ORGANIZATION_ID);
    assert.equal(report.organizationName,DEMO_ORGANIZATION_NAME);
    assert.equal(report.asOf,DEMO_AS_OF);
    assert.equal(report.periodStart,DEMO_START_DATE);
    assert.equal(report.alreadyPresent,false);
    assert.equal(report.customers,DEMO_CUSTOMER_COUNT);
    assert.equal(report.bookings,DEMO_CUSTOMER_COUNT);
    const expectedTotal=demoCustomers.reduce((sum,customer)=>sum+BigInt(customer.booking.totalMinor),0n);
    const expectedPaid=demoCustomers.flatMap(customer=>customer.booking.payments).filter(payment=>payment.status==='approved')
      .reduce((sum,payment)=>sum+BigInt(payment.amountMinor),0n);
    assert.equal(report.totalMinor,expectedTotal.toString());
    assert.equal(report.paidMinor,expectedPaid.toString());
    assert.equal(report.balanceMinor,(expectedTotal-expectedPaid).toString());
    assert.equal(report.customerMonths.reduce((sum,month)=>sum+month.count,0),DEMO_CUSTOMER_COUNT);
    assert.deepEqual(report.customerMonths.map(month=>month.month).sort(),historicalMonths);
    const organization=(await database.db.query('SELECT * FROM organizations WHERE id=$1',[DEMO_ORGANIZATION_ID])).rows[0];
    assert.equal(organization.currency,'GBP');
    assert.equal(organization.currency_exponent,2);
    assert.equal(new Date(organization.created_at).toISOString().slice(0,10),DEMO_START_DATE);
    const admin=(await database.db.query('SELECT role,is_active FROM memberships WHERE organization_id=$1 AND user_id=$2',[DEMO_ORGANIZATION_ID,seed.adminId])).rows[0];
    assert.deepEqual(admin,{role:'admin',is_active:true});
    const earliest=(await database.db.query('SELECT min(created_at) AS created_at FROM customers WHERE organization_id=$1',[DEMO_ORGANIZATION_ID])).rows[0].created_at;
    assert.equal(new Date(earliest).toISOString().slice(0,10),DEMO_START_DATE);
    const invalidHistory=(await database.db.query(`SELECT count(*)::int AS n FROM bookings b
      JOIN customers c ON c.id=b.customer_id WHERE b.organization_id=$1
      AND (b.created_at<c.created_at OR c.created_at<$2::date OR b.created_at>=$3::date+interval '1 day')`,
    [DEMO_ORGANIZATION_ID,DEMO_START_DATE,DEMO_AS_OF])).rows[0].n;
    assert.equal(invalidHistory,0);
    assert.deepEqual(await existingRows(),originalRows);
  });

  it('reconciles each booking total, instalment plan, approved payment and customer balance exactly', async () => {
    const rows=(await database.db.query(`SELECT c.id,b.id AS booking_id,b.total_minor::text AS total,
      (SELECT coalesce(sum(amount_minor),0)::text FROM booking_instalments i WHERE i.booking_id=b.id) AS instalments,
      (SELECT coalesce(sum(amount_minor),0)::text FROM ledger_entries l WHERE l.customer_id=c.id) AS balance,
      (SELECT coalesce(sum(amount_minor),0)::text FROM ledger_entries l WHERE l.customer_id=c.id AND kind='charge') AS charged,
      (SELECT coalesce(-sum(amount_minor),0)::text FROM ledger_entries l WHERE l.customer_id=c.id AND kind='payment') AS paid
      FROM customers c JOIN bookings b ON b.customer_id=c.id WHERE c.organization_id=$1`,[DEMO_ORGANIZATION_ID])).rows;
    assert.equal(rows.length,DEMO_CUSTOMER_COUNT);
    assert.equal(new Set(rows.map(row=>row.id)).size,DEMO_CUSTOMER_COUNT);
    for(const customer of demoCustomers) {
      const row=rows.find(item=>item.id===customer.id)!;
      assert.ok(row);
      assert.equal(row.total,customer.booking.totalMinor);
      assert.equal(row.instalments,row.total);
      assert.equal(row.charged,row.total);
      const expectedPaid=customer.booking.payments.filter(payment=>payment.status==='approved').reduce((sum,payment)=>sum+BigInt(payment.amountMinor),0n);
      assert.equal(row.paid,expectedPaid.toString());
      assert.equal(row.balance,(BigInt(row.total)-expectedPaid).toString());
    }
    assert.equal(rows.filter(row=>row.balance==='0').length,90);
    const foreignLinks=(await database.db.query(`SELECT count(*)::int AS n FROM booking_payments p JOIN ledger_entries l ON l.id=p.ledger_entry_id
      WHERE p.organization_id=$1 AND (p.customer_id<>l.customer_id OR p.organization_id<>l.organization_id OR l.kind<>'payment'
        OR l.amount_minor<>-p.amount_minor OR l.currency<>p.currency OR l.effective_date<>p.payment_date)`,[DEMO_ORGANIZATION_ID])).rows[0].n;
    assert.equal(foreignLinks,0);
  });

  it('preserves pending and rejected review histories without crediting them or sending fixture emails', async () => {
    const expected=demoCustomers.flatMap(customer=>customer.booking.payments);
    const payments=(await database.db.query('SELECT id,status,ledger_entry_id,reviewed_at,rejection_reason FROM booking_payments WHERE organization_id=$1',[DEMO_ORGANIZATION_ID])).rows;
    assert.equal(payments.length,expected.length);
    for(const payment of expected) {
      const stored=payments.find(item=>item.id===payment.id)!;
      assert.ok(stored);
      assert.equal(stored.status,payment.status);
      if(payment.status==='approved') assert.ok(stored.ledger_entry_id);
      else assert.equal(stored.ledger_entry_id,null);
      if(payment.status==='pending') assert.equal(stored.reviewed_at,null);
      if(payment.status==='rejected') assert.equal(stored.rejection_reason,payment.rejectionReason);
    }
    for(const table of ['invitations','payment_email_outbox']) {
      assert.equal((await database.db.query(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id=$1`,[DEMO_ORGANIZATION_ID])).rows[0].n,0);
    }
    const identities=(await database.db.query(`SELECT u.email,u.password_hash FROM users u JOIN memberships m ON m.user_id=u.id
      WHERE m.organization_id=$1 AND m.role='customer'`,[DEMO_ORGANIZATION_ID])).rows;
    assert.equal(identities.length,DEMO_CUSTOMER_COUNT);
    for(const identity of identities) {
      assert.match(identity.email,/@[^@]*\.(?:test|invalid)$/);
      assert.equal(identity.password_hash,'disabled:demo-fixture');
      assert.equal(await verifyPassword('disabled:demo-fixture',identity.password_hash),false);
    }
  });

  it('persists real PDF documents and decodable receipt images in every required booking scope', async () => {
    const report=await verifyDemoWorkspace(database.db);
    const folders=(await database.db.query(`SELECT booking_id,count(*)::int AS n FROM booking_nodes
      WHERE organization_id=$1 AND default_folder GROUP BY booking_id`,[DEMO_ORGANIZATION_ID])).rows;
    assert.equal(folders.length,DEMO_CUSTOMER_COUNT);
    assert.ok(folders.every(folder=>folder.n===6));
    const documents=(await database.db.query(`SELECT id,booking_id,customer_id,parent_id,service_key,name,size,content FROM booking_nodes
      WHERE organization_id=$1 AND kind='file'`,[DEMO_ORGANIZATION_ID])).rows;
    assert.equal(documents.length,report.documents);
    assert.ok(documents.length>=DEMO_CUSTOMER_COUNT*5);
    assert.equal(new Set(documents.map(document=>document.booking_id)).size,DEMO_CUSTOMER_COUNT);
    for(const customer of demoCustomers) {
      const actual=documents.filter(document=>document.booking_id===customer.booking.id);
      assert.deepEqual(actual.map(document=>document.service_key).sort(),[...new Set(['flight',...customer.booking.requiredServices])].sort());
    }
    for(const document of documents) {
      const content=Buffer.from(document.content);
      assert.equal(content.length,document.size);
      assert.match(document.name,/^SAMPLE-.*\.pdf$/i);
      assert.ok(content.subarray(0,8).toString('ascii').startsWith('%PDF-'));
      assert.ok(content.subarray(-1024).includes(Buffer.from('%%EOF')));
      const text=content.toString('latin1');
      assert.match(text,/SAMPLE/);
      const customer=demoCustomers.find(item=>item.booking.id===document.booking_id)!;
      assert.equal(document.customer_id,customer.id);
      assert.ok(text.includes(customer.booking.reference),'Each document identifies its own booking.');
      assert.ok(text.includes(customer.name),'Each document identifies its own lead traveller.');
      const fontSizes=Array.from(text.matchAll(/\/F\d+ ([\d.]+) Tf/g),match=>Number(match[1]));
      assert.ok(fontSizes.length>0 && fontSizes.every(size=>size>=7),'PDF text must remain large enough to read.');
    }
    const misplacedDocuments=(await database.db.query(`SELECT count(*)::int AS n FROM booking_nodes d
      JOIN booking_nodes f ON f.id=d.parent_id WHERE d.organization_id=$1 AND d.kind='file'
      AND (f.kind<>'folder' OR f.booking_id<>d.booking_id OR f.customer_id<>d.customer_id
        OR f.organization_id<>d.organization_id OR f.service_key<>d.service_key)`,[DEMO_ORGANIZATION_ID])).rows[0].n;
    assert.equal(misplacedDocuments,0);
    const receipts=(await database.db.query('SELECT payment_id,booking_id,customer_id,mime_type,size,content FROM booking_payment_receipts WHERE organization_id=$1',[DEMO_ORGANIZATION_ID])).rows;
    assert.equal(receipts.length,report.receipts);
    const expectedReceipts=demoCustomers.flatMap(customer=>customer.booking.payments).reduce((sum,payment)=>sum+payment.receiptCount,0);
    assert.equal(receipts.length,expectedReceipts);
    const hashes=new Set<string>();
    for(const receipt of receipts) {
      const content=Buffer.from(receipt.content);
      assert.equal(content.length,receipt.size);
      assert.equal(receipt.mime_type,'image/webp');
      const metadata=await sharp(content).metadata();
      assert.equal(metadata.format,'webp');
      assert.ok(metadata.width && metadata.width>=700 && metadata.height && metadata.height>=1000,'Screenshots must be legible at normal phone resolution.');
      const pixels=await sharp(content).resize(32,32).stats();
      assert.ok(pixels.channels.some(channel=>channel.stdev>5),'Stored screenshots must contain rendered content.');
      hashes.add(createHash('sha256').update(content).digest('hex'));
      const owner=demoCustomers.find(customer=>customer.booking.payments.some(payment=>payment.id===receipt.payment_id))!;
      assert.ok(owner);
      assert.equal(receipt.customer_id,owner.id);
      assert.equal(receipt.booking_id,owner.booking.id);
    }
    assert.equal(hashes.size,receipts.length,'Each attachment should show the corresponding payment or supporting detail.');
  });

  it('matches transfer PDF routes to the actual hotel order for both Jeddah and Madinah arrivals', async () => {
    const cases=(['JED','MED'] as const).map(airport=>demoCustomers.find(customer=>customer.booking.route.arrivalCode===airport)!);
    assert.ok(cases.every(Boolean),'The dataset must exercise both city orders.');
    const dateLabel=(value:string)=>new Intl.DateTimeFormat('en-GB',{
      day:'2-digit',month:'short',year:'numeric',timeZone:'UTC',
    }).format(new Date(`${value.slice(0,10)}T12:00:00Z`));
    for(const customer of cases) {
      const booking=customer.booking;
      const document=(await database.db.query(`SELECT content FROM booking_nodes
        WHERE organization_id=$1 AND booking_id=$2 AND service_key='transfers' AND kind='file'`,
      [DEMO_ORGANIZATION_ID,booking.id])).rows[0];
      assert.ok(document);
      // The generated PDF's appended content stream uses escaped literal Tj strings.
      // Joining text operators makes assertions independent of PDF line wrapping.
      const content=Buffer.from(document.content).toString('latin1');
      const text=Array.from(content.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g),match=>match[1].replace(/\\([\\()])/g,'$1'))
        .join(' ').replace(/\s+/g,' ');
      const row=(label:string,nextLabel:string)=>{
        const start=text.indexOf(label),end=text.indexOf(nextLabel,start+label.length);
        assert.ok(start>=0 && end>start,`The transfer PDF must contain the ${label} row.`);
        return text.slice(start+label.length,end).trim();
      };
      // Infer hotel order from check-in dates, independently of the PDF's airport rule.
      const makkahFirst=booking.makkahCheckIn<booking.madinahCheckIn;
      const firstHotel=makkahFirst?booking.makkahHotel:booking.madinahHotel;
      const lastHotel=makkahFirst?booking.madinahHotel:booking.makkahHotel;
      const transferOn=makkahFirst?booking.makkahCheckOut:booking.madinahCheckOut;
      const arrival=row('Airport arrival','Arrival collection');
      assert.ok(arrival.includes(`${booking.route.arrivalName} (${booking.route.arrivalCode}) to ${firstHotel}`),arrival);
      const intercity=row('Intercity transfer','Return airport');
      assert.ok(intercity.includes(dateLabel(transferOn)),intercity);
      assert.ok(intercity.includes(`${firstHotel} to ${lastHotel}`),intercity);
      const returning=row('Return airport','Vehicle allocation');
      assert.ok(returning.includes(dateLabel(booking.returnAt)),returning);
      assert.ok(returning.includes(`${lastHotel} to ${booking.route.returnOriginName}`),returning);
    }
  });

  it('reruns safely without duplicate records or overwriting changes to already imported customers', async () => {
    const customer=demoCustomers[0];
    const retainedNote='A user edited this demonstration customer after importing.';
    await database.db.query('UPDATE customers SET notes=$1 WHERE id=$2',[retainedNote,customer.id]);
    const before=await counts();
    const [first,second]=await Promise.all([seedDemoWorkspace(database.db,seed.adminId),seedDemoWorkspace(database.db,seed.adminId)]);
    assert.equal(first.alreadyPresent,true);
    assert.equal(second.alreadyPresent,true);
    assert.deepEqual(await counts(),before);
    assert.equal((await database.db.query('SELECT notes FROM customers WHERE id=$1',[customer.id])).rows[0].notes,retainedNote);
    assert.deepEqual(await existingRows(),originalRows);
  });
});
