import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../apps/api/src/database/database.service';
import { DEMO_AS_OF, DEMO_ORGANIZATION_ID, DEMO_ORGANIZATION_NAME, demoCustomers, seedUUID } from './demo-data';
import { buildDemoDocuments, receiptImage } from './demo-documents';

const VERSION = 'autumn-2026-v1';
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const folderNames = { flight: 'Flight Tickets', makkah: 'Makkah Hotel', madinah: 'Madinah Hotel', transfers: 'Transfers', visas: 'Visas', extras: 'Extras' };

export interface DemoSeedReport {
  organizationId: string;
  organizationName: string;
  asOf: string;
  alreadyPresent: boolean;
  customers: number;
  bookings: number;
  documents: number;
  receipts: number;
  payments: { approved: number; pending: number; rejected: number };
  totalMinor: string;
  paidMinor: string;
  balanceMinor: string;
  customerMonths: Array<{ month: string; count: number }>;
}

function developmentOnly() {
  if (!['development', 'test'].includes(process.env.NODE_ENV ?? '')) {
    throw new Error('Demo fixtures are available only in development or test.');
  }
}

async function audit(client: PoolClient, adminId: string, action: string, objectId: string, at: string, metadata: Record<string, unknown> = {}) {
  await client.query(`INSERT INTO audit_events(organization_id,actor_id,action,object_id,metadata,created_at)
    VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [DEMO_ORGANIZATION_ID, adminId, action, objectId, JSON.stringify({ fixture: VERSION, ...metadata }), at]);
}

/**
 * Local-only historical fixtures. SQL preserves the original event dates while
 * leaving every database constraint and trigger enabled. No notification service
 * or outbox is invoked: importing fictional history must never send email.
 * All rows commit together; re-running preserves any later edits to this workspace.
 */
export async function seedDemoWorkspace(db: DatabaseService, adminUserId: string): Promise<DemoSeedReport> {
  developmentOnly();
  const alreadyPresent = await db.transaction(async (client) => {
    const admin = await client.query(`SELECT user_id FROM memberships WHERE user_id=$1 AND role='admin' AND is_active LIMIT 1`, [adminUserId]);
    if (!admin.rows.length) throw new Error('An existing active administrator is required.');
    const present = await client.query('SELECT name FROM organizations WHERE id=$1 FOR UPDATE', [DEMO_ORGANIZATION_ID]);
    if (present.rows.length) {
      const marker = await client.query(`SELECT id FROM audit_events WHERE organization_id=$1 AND action='demo.seed.completed' AND metadata->>'fixture'=$2`, [DEMO_ORGANIZATION_ID, VERSION]);
      const access = await client.query(`SELECT id FROM memberships WHERE organization_id=$1 AND user_id=$2 AND role='admin' AND is_active`, [DEMO_ORGANIZATION_ID, adminUserId]);
      if (!marker.rows.length || !access.rows.length) throw new Error('Demo workspace identity is already in use without the expected fixture marker/access. Nothing was changed.');
      return true;
    }
    await client.query(`INSERT INTO organizations(id,name,currency,currency_exponent,created_at) VALUES($1,$2,'GBP',2,'2026-09-01T08:00:00Z')`, [DEMO_ORGANIZATION_ID, DEMO_ORGANIZATION_NAME]);
    await client.query(`INSERT INTO memberships(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'admin','2026-09-01T08:00:00Z')`, [seedUUID('admin-membership'), DEMO_ORGANIZATION_ID, adminUserId]);

    for (const customer of demoCustomers) {
      const booking = customer.booking;
      // These synthetic identities cannot authenticate. No shared demo password
      // is introduced and existing global identities are never reused/changed.
      await client.query(`INSERT INTO users(id,email,password_hash,created_at) VALUES($1,$2,'disabled:demo-fixture',$3)`, [customer.userId, customer.email, customer.createdAt]);
      await client.query(`INSERT INTO customers(id,organization_id,name,email,phone,notes,created_by,created_at,updated_at,idempotency_key,request_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10)`, [customer.id, DEMO_ORGANIZATION_ID, customer.name, customer.email, customer.phone, customer.notes, adminUserId, customer.createdAt, customer.idempotencyKey, digest(JSON.stringify(customer))]);
      await client.query(`INSERT INTO memberships(id,organization_id,user_id,role,customer_id,created_at) VALUES($1,$2,$3,'customer',$4,$5)`, [customer.membershipId, DEMO_ORGANIZATION_ID, customer.userId, customer.id, customer.createdAt]);
      const charge = await client.query(`INSERT INTO ledger_entries(organization_id,customer_id,kind,amount_minor,currency,effective_date,description,reference,created_by,created_at,idempotency_key,request_hash)
        VALUES($1,$2,'charge',$3,'GBP',$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [DEMO_ORGANIZATION_ID, customer.id, booking.totalMinor, booking.bookedOn, `Sample Umrah package · ${booking.passengers.length} traveller(s)`, booking.reference, adminUserId, booking.createdAt, seedUUID(`charge:${booking.id}`), digest(`charge:${booking.id}`)]);
      await client.query(`INSERT INTO bookings(id,organization_id,customer_id,reference,departure_at,required_services,total_minor,currency,charge_entry_id,created_by,created_at,idempotency_key,request_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,'GBP',$8,$9,$10,$11,$12)`, [booking.id, DEMO_ORGANIZATION_ID, customer.id, booking.reference, booking.departureAt, booking.requiredServices, booking.totalMinor, charge.rows[0].id, adminUserId, booking.createdAt, booking.idempotencyKey, digest(JSON.stringify(booking))]);
      await audit(client, adminUserId, 'customer.created', customer.id, customer.createdAt);
      await audit(client, adminUserId, 'booking.created', booking.id, booking.createdAt, { customer_id: customer.id, booking_id: booking.id });
      await audit(client, adminUserId, 'ledger.posted', String(charge.rows[0].id), booking.createdAt, { customer_id: customer.id, booking_id: booking.id, kind: 'charge' });
      for (const instalment of booking.instalments) {
        await client.query(`INSERT INTO booking_instalments(id,organization_id,customer_id,booking_id,due_date,amount_minor,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`, [instalment.id, DEMO_ORGANIZATION_ID, customer.id, booking.id, instalment.dueDate, instalment.amountMinor, booking.createdAt]);
      }
      for (const [serviceKey, name] of Object.entries(folderNames)) {
        const key = seedUUID(`folder:${booking.id}:${serviceKey}`);
        await client.query(`INSERT INTO booking_nodes(id,organization_id,customer_id,booking_id,kind,name,service_key,default_folder,issued_at,created_by,created_at,updated_at,idempotency_key,request_hash)
          VALUES($1,$2,$3,$4,'folder',$5,$6,true,$7,$8,$9,$9,$1,$10)`, [key, DEMO_ORGANIZATION_ID, customer.id, booking.id, name, serviceKey, booking.issuedServices.includes(serviceKey as typeof booking.issuedServices[number]) ? booking.createdAt : null, adminUserId, booking.createdAt, digest(key)]);
      }
      for (const document of buildDemoDocuments(customer)) {
        const key = seedUUID(`document:${booking.id}:${document.serviceKey}:${document.name}`);
        await client.query(`INSERT INTO booking_nodes(id,organization_id,customer_id,booking_id,parent_id,kind,name,service_key,content,size,created_by,created_at,updated_at,idempotency_key,request_hash)
          VALUES($1,$2,$3,$4,$5,'file',$6,$7,$8,$9,$10,$11,$11,$1,$12)`, [key, DEMO_ORGANIZATION_ID, customer.id, booking.id, seedUUID(`folder:${booking.id}:${document.serviceKey}`), document.name, document.serviceKey, document.content, document.content.length, adminUserId, booking.createdAt, digest(document.content)]);
        await audit(client, adminUserId, 'document.uploaded', key, booking.createdAt, { customer_id: customer.id, booking_id: booking.id, name: document.name, service_key: document.serviceKey });
      }
      for (const payment of booking.payments) {
        await client.query(`INSERT INTO booking_payments(id,organization_id,customer_id,booking_id,amount_minor,currency,payment_date,note,submitted_by,submitted_at,idempotency_key,request_hash)
          VALUES($1,$2,$3,$4,$5,'GBP',$6,$7,$8,$9,$10,$11)`, [payment.id, DEMO_ORGANIZATION_ID, customer.id, booking.id, payment.amountMinor, payment.paymentDate, payment.note, customer.userId, payment.submittedAt, payment.idempotencyKey, digest(JSON.stringify(payment))]);
        await audit(client, customer.userId, 'payment.submitted', payment.id, payment.submittedAt, { customer_id: customer.id, booking_id: booking.id, receipt_count: payment.receiptCount, notification: 'suppressed-fixture-import' });
        for (let index = 0; index < payment.receiptCount; index++) {
          const content = await receiptImage(customer, payment, index);
          await client.query(`INSERT INTO booking_payment_receipts(id,organization_id,customer_id,booking_id,payment_id,name,size,content,original_sha256,created_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [seedUUID(`receipt:${payment.id}:${index}`), DEMO_ORGANIZATION_ID, customer.id, booking.id, payment.id, `SAMPLE-${payment.reference}-${index + 1}.webp`, content.length, content, digest(content), payment.submittedAt]);
        }
        let ledgerId: string | null = null;
        if (payment.status === 'approved') {
          const posted = await client.query(`INSERT INTO ledger_entries(organization_id,customer_id,kind,amount_minor,currency,effective_date,description,reference,created_by,created_at,idempotency_key,request_hash)
            VALUES($1,$2,'payment',$3,'GBP',$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [DEMO_ORGANIZATION_ID, customer.id, `-${payment.amountMinor}`, payment.paymentDate, 'Sample bank transfer reviewed and approved', payment.reference, adminUserId, payment.reviewedAt, seedUUID(`credit:${payment.id}`), digest(`credit:${payment.id}`)]);
          ledgerId = posted.rows[0].id;
          await audit(client, adminUserId, 'ledger.posted', String(ledgerId), payment.reviewedAt!, { customer_id: customer.id, booking_id: booking.id, payment_id: payment.id, kind: 'payment' });
        }
        if (payment.status !== 'pending') {
          await client.query(`UPDATE booking_payments SET status=$2,reviewed_by=$3,reviewed_at=$4,rejection_reason=$5,ledger_entry_id=$6 WHERE id=$1`, [payment.id, payment.status, adminUserId, payment.reviewedAt, payment.rejectionReason, ledgerId]);
          await audit(client, adminUserId, `payment.${payment.status}`, payment.id, payment.reviewedAt!, { customer_id: customer.id, booking_id: booking.id, notification: 'suppressed-fixture-import' });
        }
      }
    }
    await audit(client, adminUserId, 'demo.seed.completed', DEMO_ORGANIZATION_ID, new Date().toISOString(), { customers: demoCustomers.length, emails: 'not-enqueued', asOf: DEMO_AS_OF });
    return false;
  });
  return { ...await verifyDemoWorkspace(db), alreadyPresent };
}

export async function verifyDemoWorkspace(db: DatabaseService): Promise<DemoSeedReport> {
  developmentOnly();
  const counts = await db.query(`SELECT
    (SELECT count(*)::int FROM customers WHERE organization_id=$1) customers,
    (SELECT count(*)::int FROM bookings WHERE organization_id=$1) bookings,
    (SELECT count(*)::int FROM booking_nodes WHERE organization_id=$1 AND kind='file') documents,
    (SELECT count(*)::int FROM booking_payment_receipts WHERE organization_id=$1) receipts,
    (SELECT count(*)::int FROM booking_payments WHERE organization_id=$1 AND status='approved') approved,
    (SELECT count(*)::int FROM booking_payments WHERE organization_id=$1 AND status='pending') pending,
    (SELECT count(*)::int FROM booking_payments WHERE organization_id=$1 AND status='rejected') rejected,
    (SELECT coalesce(sum(amount_minor),0)::text FROM ledger_entries WHERE organization_id=$1 AND kind='charge') total,
    (SELECT coalesce(-sum(amount_minor),0)::text FROM ledger_entries WHERE organization_id=$1 AND kind='payment') paid,
    (SELECT coalesce(sum(amount_minor),0)::text FROM ledger_entries WHERE organization_id=$1) balance`, [DEMO_ORGANIZATION_ID]);
  const months = await db.query<{ month: string; count: number }>(`SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM') AS month,count(*)::int AS count FROM customers WHERE organization_id=$1 GROUP BY 1 ORDER BY 1`, [DEMO_ORGANIZATION_ID]);
  const c = counts.rows[0];
  return { organizationId: DEMO_ORGANIZATION_ID, organizationName: DEMO_ORGANIZATION_NAME, asOf: DEMO_AS_OF, alreadyPresent: true,
    customers: c.customers, bookings: c.bookings, documents: c.documents, receipts: c.receipts,
    payments: { approved: c.approved, pending: c.pending, rejected: c.rejected }, totalMinor: c.total, paidMinor: c.paid, balanceMinor: c.balance, customerMonths: months.rows };
}
