import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { verifyPassword } from '../apps/api/src/auth/crypto';
import { demoCustomers, DEMO_AS_OF, DEMO_ORGANIZATION_ID, DEMO_ORGANIZATION_NAME } from '../scripts/demo-data';
import { seedDemoWorkspace, verifyDemoWorkspace } from '../scripts/demo-seed';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

describe('isolated, deterministic autumn demonstration workspace', () => {
  let database:TestDatabase;
  let seed:TestSeed;
  let originalRows:Record<string,unknown>;
  let originalMode:string|undefined;

  before(async () => {
    originalMode=process.env.NODE_ENV;
    process.env.NODE_ENV='test';
    database=await setupTestDatabase();
    seed=await database.seed();
    originalRows=await existingRows();
  });
  after(async () => {
    if(database) await database.close();
    if(originalMode===undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV=originalMode;
  });

  async function existingRows() {
    const snapshot:Record<string,unknown>={};
    for(const table of ['customers','memberships','ledger_entries','invitations','audit_events','bookings','booking_nodes','booking_payments','booking_payment_receipts','payment_email_outbox']) {
      snapshot[table]=(await database.db.query(`SELECT * FROM ${table} WHERE organization_id=ANY($1::uuid[]) ORDER BY id`,[[seed.orgId,seed.otherOrgId]])).rows;
    }
    snapshot.organizations=(await database.db.query('SELECT * FROM organizations WHERE id=ANY($1::uuid[]) ORDER BY id',[[seed.orgId,seed.otherOrgId]])).rows;
    snapshot.users=(await database.db.query('SELECT * FROM users WHERE id=ANY($1::uuid[]) ORDER BY id',[[seed.adminId,seed.otherAdminId,seed.customerUserId]])).rows;
    return snapshot;
  }
  async function counts() {
    const result:Record<string,number>={};
    for(const table of ['organizations','users','customers','memberships','ledger_entries','invitations','audit_events','bookings','booking_instalments','booking_nodes','booking_payments','booking_payment_receipts','payment_email_outbox']) {
      result[table]=(await database.db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
    }
    return result;
  }

  it('defines fifty unique fictional customers across all three months with exact, coherent scenario amounts', () => {
    assert.equal(DEMO_AS_OF,'2026-11-06');
    assert.equal(demoCustomers.length,50);
    for(const key of ['id','userId','membershipId','email'] as const) {
      assert.equal(new Set(demoCustomers.map(customer=>customer[key])).size,50,`${key} must be unique.`);
    }
    const scenarios:Record<string,number>={};
    const months=new Set<string>();
    for(const customer of demoCustomers) {
      scenarios[customer.scenario]=(scenarios[customer.scenario]??0)+1;
      months.add(customer.createdAt.slice(0,7));
      assert.ok(customer.createdAt.slice(0,10)>='2026-09-01' && customer.createdAt.slice(0,10)<=DEMO_AS_OF);
      assert.match(customer.email,/@[^@]*\.(?:test|invalid)$/);
      const trip=customer.booking;
      const total=BigInt(trip.totalMinor);
      assert.ok(total>0n);
      assert.equal(trip.instalments.reduce((sum,item)=>sum+BigInt(item.amountMinor),0n),total);
      const approved=trip.payments.filter(payment=>payment.status==='approved').reduce((sum,payment)=>sum+BigInt(payment.amountMinor),0n);
      const pending=trip.payments.filter(payment=>payment.status==='pending').reduce((sum,payment)=>sum+BigInt(payment.amountMinor),0n);
      assert.ok(approved+pending<=total,'The scenarios must not overpay a booking if pending evidence is approved.');
      if(customer.scenario==='fully_paid') assert.equal(approved,total);
      if(customer.scenario==='partial') assert.ok(approved>0n && approved<total);
      if(customer.scenario==='deposit_pending') {assert.ok(approved<total);assert.ok(pending>0n);}
      if(customer.scenario==='unpaid') assert.equal(approved,0n);
      for(const payment of trip.payments) {
        assert.ok(BigInt(payment.amountMinor)>0n);
        assert.ok(payment.paymentDate>=trip.bookedOn && payment.paymentDate<=DEMO_AS_OF);
        assert.ok(payment.submittedAt.slice(0,10)>=payment.paymentDate && payment.submittedAt.slice(0,10)<=DEMO_AS_OF);
        assert.ok(payment.receiptCount>=1 && payment.receiptCount<=5);
        if(payment.status==='pending') assert.equal(payment.reviewedAt,null);
        else {assert.ok(payment.reviewedAt);assert.ok(payment.reviewedAt!>=payment.submittedAt);}
      }
    }
    assert.deepEqual(scenarios,{fully_paid:20,partial:15,deposit_pending:10,unpaid:5});
    assert.deepEqual([...months].sort(),['2026-09','2026-10','2026-11']);
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

  it('creates a separate GBP workspace with fifty bookings and preserves every existing business row', async () => {
    const report=await seedDemoWorkspace(database.db,seed.adminId);
    assert.equal(report.organizationId,DEMO_ORGANIZATION_ID);
    assert.equal(report.organizationName,DEMO_ORGANIZATION_NAME);
    assert.equal(report.asOf,DEMO_AS_OF);
    assert.equal(report.alreadyPresent,false);
    assert.equal(report.customers,50);
    assert.equal(report.bookings,50);
    const expectedTotal=demoCustomers.reduce((sum,customer)=>sum+BigInt(customer.booking.totalMinor),0n);
    const expectedPaid=demoCustomers.flatMap(customer=>customer.booking.payments).filter(payment=>payment.status==='approved')
      .reduce((sum,payment)=>sum+BigInt(payment.amountMinor),0n);
    assert.equal(report.totalMinor,expectedTotal.toString());
    assert.equal(report.paidMinor,expectedPaid.toString());
    assert.equal(report.balanceMinor,(expectedTotal-expectedPaid).toString());
    assert.equal(report.customerMonths.reduce((sum,month)=>sum+month.count,0),50);
    assert.deepEqual(report.customerMonths.map(month=>month.month).sort(),['2026-09','2026-10','2026-11']);
    const organization=(await database.db.query('SELECT * FROM organizations WHERE id=$1',[DEMO_ORGANIZATION_ID])).rows[0];
    assert.equal(organization.currency,'GBP');
    assert.equal(organization.currency_exponent,2);
    const admin=(await database.db.query('SELECT role,is_active FROM memberships WHERE organization_id=$1 AND user_id=$2',[DEMO_ORGANIZATION_ID,seed.adminId])).rows[0];
    assert.deepEqual(admin,{role:'admin',is_active:true});
    assert.deepEqual(await existingRows(),originalRows);
  });

  it('reconciles each booking total, instalment plan, approved payment and customer balance exactly', async () => {
    const rows=(await database.db.query(`SELECT c.id,b.id AS booking_id,b.total_minor::text AS total,
      (SELECT coalesce(sum(amount_minor),0)::text FROM booking_instalments i WHERE i.booking_id=b.id) AS instalments,
      (SELECT coalesce(sum(amount_minor),0)::text FROM ledger_entries l WHERE l.customer_id=c.id) AS balance,
      (SELECT coalesce(sum(amount_minor),0)::text FROM ledger_entries l WHERE l.customer_id=c.id AND kind='charge') AS charged,
      (SELECT coalesce(-sum(amount_minor),0)::text FROM ledger_entries l WHERE l.customer_id=c.id AND kind='payment') AS paid
      FROM customers c JOIN bookings b ON b.customer_id=c.id WHERE c.organization_id=$1`,[DEMO_ORGANIZATION_ID])).rows;
    assert.equal(rows.length,50);
    assert.equal(new Set(rows.map(row=>row.id)).size,50);
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
    assert.equal(rows.filter(row=>row.balance==='0').length,20);
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
    assert.equal(identities.length,50);
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
    assert.equal(folders.length,50);
    assert.ok(folders.every(folder=>folder.n===6));
    const documents=(await database.db.query(`SELECT id,booking_id,name,size,content FROM booking_nodes
      WHERE organization_id=$1 AND kind='file'`,[DEMO_ORGANIZATION_ID])).rows;
    assert.equal(documents.length,report.documents);
    assert.ok(documents.length>=50);
    assert.equal(new Set(documents.map(document=>document.booking_id)).size,50);
    for(const document of documents) {
      const content=Buffer.from(document.content);
      assert.equal(content.length,document.size);
      assert.match(document.name,/^SAMPLE-.*\.pdf$/i);
      assert.ok(content.subarray(0,8).toString('ascii').startsWith('%PDF-'));
      assert.ok(content.subarray(-1024).includes(Buffer.from('%%EOF')));
      const text=content.toString('latin1');
      assert.match(text,/SAMPLE/);
      const customer=demoCustomers.find(item=>item.booking.id===document.booking_id)!;
      assert.ok(text.includes(customer.booking.reference),'Each document identifies its own booking.');
    }
    const receipts=(await database.db.query('SELECT payment_id,mime_type,size,content FROM booking_payment_receipts WHERE organization_id=$1',[DEMO_ORGANIZATION_ID])).rows;
    assert.equal(receipts.length,report.receipts);
    const expectedReceipts=demoCustomers.flatMap(customer=>customer.booking.payments).reduce((sum,payment)=>sum+payment.receiptCount,0);
    assert.equal(receipts.length,expectedReceipts);
    for(const receipt of receipts) {
      const content=Buffer.from(receipt.content);
      assert.equal(content.length,receipt.size);
      assert.equal(receipt.mime_type,'image/webp');
      const metadata=await sharp(content).metadata();
      assert.equal(metadata.format,'webp');
      assert.ok(metadata.width && metadata.width>0 && metadata.height && metadata.height>0);
    }
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
