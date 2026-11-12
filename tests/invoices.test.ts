import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { AccessService } from '../apps/api/src/access/access.service';
import { invoiceText, renderInvoicePdf } from '../apps/api/src/invoices/invoice-pdf';
import { ensureBookingInvoice, InvoicesService, issueBookingInvoice, type InvoiceSnapshot } from '../apps/api/src/invoices/invoices.service';
import { LedgerService } from '../apps/api/src/ledger/ledger.service';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';
import { renumberExistingInvoices } from '../apps/api/src/database/invoice-number-migration';
import { nextInvoiceNumber } from '../apps/api/src/invoices/invoice-number';

describe('immutable invoice snapshots, legacy bookings and scoped history', () => {
  let database: TestDatabase;
  let seed: TestSeed;
  let access: AccessService;
  let invoices: InvoicesService;
  let ledger: LedgerService;
  before(async () => {
    database = await setupTestDatabase();
    seed = await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP'");
    access = new AccessService(database.db);
    seed.admin = await access.membership(seed.adminId, seed.orgId);
    seed.otherAdmin = await access.membership(seed.otherAdminId, seed.otherOrgId);
    seed.customerMember = await access.membership(seed.customerUserId, seed.orgId);
    invoices = new InvoicesService(database.db, access);
    ledger = new LedgerService(database.db, access);
  });
  after(async () => { if (database) await database.close(); });

  // Model bookings from a deployment before invoice history existed, without
  // bypassing immutable-history triggers or relying on an application hook.
  async function legacyBooking(customerId = seed.customerId, other = false) {
    const member = other ? seed.otherAdmin : seed.admin;
    const id = randomUUID();
    const reference = `LEGACY-${id}`;
    const charge = await ledger.post(member, customerId, {
      kind: 'charge', amount: '100.00', effective_date: '2026-11-01', description: `Booking ${reference}`,
      reference, idempotency_key: randomUUID(),
    });
    await database.db.query(`INSERT INTO bookings(id,organization_id,customer_id,reference,departure_at,total_minor,charge_entry_id,created_by,idempotency_key,request_hash)
      VALUES($1,$2,$3,$4,'2030-01-01T12:00:00Z',10000,$5,$6,$7,$8)`,
      [id, member.organization_id, customerId, reference, charge.id, member.user_id, randomUUID(), '0'.repeat(64)]);
    return id;
  }
  const context = (bookingId: string) => ({ organizationId: seed.orgId, customerId: seed.customerId, bookingId, actorId: seed.adminId });
  const issue = (bookingId: string, eventKey: string) => database.db.transaction(async client => {
    await access.customer(seed.admin, seed.customerId, client, true);
    return issueBookingInvoice(client, { ...context(bookingId), reason: 'booking_updated', eventKey });
  });

  it('creates one honest legacy snapshot on concurrent first reads and never queues a historical email', async () => {
    const booking = await legacyBooking();
    const beforeEmails = (await database.db.query('SELECT count(*)::int AS count FROM payment_email_outbox')).rows[0].count;
    const [first, second] = await Promise.all([
      invoices.list(seed.customerMember, seed.customerId, booking), invoices.list(seed.admin, seed.customerId, booking),
    ]);
    assert.equal(first.invoices.length, 1);
    assert.deepEqual(first, second);
    const initial = first.invoices[0];
    assert.equal(initial.reason, 'legacy_snapshot');
    assert.equal(initial.version, 1);
    assert.equal(initial.total_minor, '10000');
    assert.equal(initial.paid_minor, '0');
    assert.equal(initial.balance_minor, '10000');
    assert.equal(initial.status, 'unpaid');
    assert.equal(first.has_more, false);
    assert.equal(first.next_before_version, null);
    const pdf = await invoices.pdf(seed.customerMember, seed.customerId, booking, initial.id);
    assert.equal(pdf.content.subarray(0, 5).toString(), '%PDF-');
    assert.match(pdf.content.toString('latin1'), /%%EOF\s*$/);
    assert.match(pdf.content.toString('latin1'), /\/FontFile2\b/);
    assert.equal(initial.invoice_number, 'Inv-up001');
    assert.equal(pdf.filename, 'Inv-up001.pdf');
    assert.equal((await database.db.query('SELECT count(*)::int AS count FROM payment_email_outbox')).rows[0].count, beforeEmails);
  });

  it('replays exact bytes per event, freezes identity snapshots and paginates newest revisions first', async () => {
    const booking = await legacyBooking();
    await invoices.list(seed.admin, seed.customerId, booking);
    const first = await issue(booking, 'stable-operation');
    await database.db.query('UPDATE customers SET name=$1,phone=$2 WHERE id=$3', ['Åster Studio – العربية', '+44 7700 900123', seed.customerId]);
    const second = await issue(booking, 'next-operation');
    const repeated = await issue(booking, 'stable-operation');
    assert.deepEqual(repeated, first);
    assert.equal(second.version, 3);
    const old = await database.db.query('SELECT snapshot FROM booking_invoices WHERE id=$1', [first.id]);
    const latest = await database.db.query('SELECT snapshot FROM booking_invoices WHERE id=$1', [second.id]);
    assert.equal(old.rows[0].snapshot.customer.name, 'Aster Studio');
    assert.equal(old.rows[0].snapshot.template_version, 3);
    assert.equal(old.rows[0].snapshot.customer.phone, '');
    assert.equal(latest.rows[0].snapshot.customer.name, 'Åster Studio – العربية');
    assert.equal(latest.rows[0].snapshot.customer.phone, '+44 7700 900123');
    const page = await invoices.list(seed.customerMember, seed.customerId, booking, { limit: '2' });
    assert.deepEqual(page.invoices.map(item => item.version), [3, 2]);
    assert.equal(page.has_more, true);
    assert.equal(page.next_before_version, 2);
    const tail = await invoices.list(seed.customerMember, seed.customerId, booking, { limit: '2', before_version: '2' });
    assert.deepEqual(tail.invoices.map(item => item.version), [1]);
    assert.equal(tail.has_more, false);
    assert.equal(tail.next_before_version, null);
    assert.deepEqual((await invoices.pdf(seed.customerMember, seed.customerId, booking, first.id)).content, first.content);
    await database.db.query('UPDATE customers SET name=$1,phone=$2 WHERE id=$3', ['Aster Studio', '', seed.customerId]);
  });

  it('keeps metadata and bytes immutable and rolls failed issuance back without consuming a revision', async () => {
    const booking = await legacyBooking();
    const initial = await issue(booking, 'initial');
    await assert.rejects(database.db.query('UPDATE booking_invoices SET filename=filename WHERE id=$1', [initial.id]), /cannot be edited or deleted/);
    await assert.rejects(database.db.query('DELETE FROM booking_invoices WHERE id=$1', [initial.id]), /cannot be edited or deleted/);
    await database.db.query(`CREATE FUNCTION invoice_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='invoice.issued' THEN RAISE EXCEPTION 'Invoice persistence failure'; END IF; RETURN NEW; END; $$;`);
    await database.db.query('CREATE TRIGGER invoice_test_reject_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION invoice_test_reject_audit()');
    await assert.rejects(issue(booking, 'retryable'), /Invoice persistence failure/);
    await database.db.query('DROP TRIGGER invoice_test_reject_audit ON audit_events');
    await database.db.query('DROP FUNCTION invoice_test_reject_audit()');
    assert.equal((await invoices.list(seed.admin, seed.customerId, booking)).invoices.length, 1);
    assert.equal((await issue(booking, 'retryable')).version, 2);
    const current = await database.db.transaction(async client => {
      await access.customer(seed.admin, seed.customerId, client, true);
      return ensureBookingInvoice(client, context(booking));
    });
    assert.equal(current.version, 2);
  });

  it('rejects cross-customer, cross-booking, cross-tenant, inactive and invalid history access', async () => {
    const booking = await legacyBooking();
    const initial = await issue(booking, 'initial');
    const another = await legacyBooking();
    await assert.rejects(invoices.pdf(seed.customerMember, seed.secondCustomerId, booking, initial.id), /not found/);
    await assert.rejects(invoices.pdf(seed.customerMember, seed.customerId, another, initial.id), /not found/);
    await assert.rejects(invoices.pdf(seed.otherAdmin, seed.customerId, booking, initial.id), /not found/);
    await assert.rejects(invoices.list(seed.admin, seed.secondCustomerId, booking), /Booking was not found/);
    for (const raw of [{ limit: '0' }, { limit: '101' }, { before_version: '0' }, { before_version: '1e3' }, { limit: ['2'] }, { unknown: '1' }]) {
      await assert.rejects(invoices.list(seed.admin, seed.customerId, booking, raw), /limit 1–100/);
    }
    await database.db.query('UPDATE memberships SET is_active=false WHERE organization_id=$1 AND user_id=$2', [seed.orgId, seed.customerUserId]);
    await assert.rejects(invoices.pdf(seed.customerMember, seed.customerId, booking, initial.id), /access is unavailable/);
    await database.db.query('UPDATE memberships SET is_active=true WHERE organization_id=$1 AND user_id=$2', [seed.orgId, seed.customerUserId]);
  });

  it('purges invoices with only their authorized customer or workspace and preserves the other scope', async () => {
    const removedBooking = await legacyBooking(seed.secondCustomerId);
    const retainedBooking = await legacyBooking();
    const removed = (await invoices.list(seed.admin, seed.secondCustomerId, removedBooking)).invoices[0];
    const retained = (await invoices.list(seed.admin, seed.customerId, retainedBooking)).invoices[0];
    await database.db.query('SELECT permanently_delete_customer($1,$2,$3,$4)', [seed.adminId, seed.orgId, seed.secondCustomerId, 'beacon@example.test']);
    assert.equal((await database.db.query('SELECT id FROM booking_invoices WHERE id=$1', [removed.id])).rowCount, 0);
    assert.ok((await invoices.pdf(seed.customerMember, seed.customerId, retainedBooking, retained.id)).content.length);
    const otherBooking = await legacyBooking(seed.otherCustomerId, true);
    const other = (await invoices.list(seed.otherAdmin, seed.otherCustomerId, otherBooking)).invoices[0];
    const workspace = (await database.db.query('SELECT name,version FROM organizations WHERE id=$1', [seed.otherOrgId])).rows[0];
    await database.db.query('SELECT permanently_delete_workspace($1,$2,$3,$4,$5)', [seed.otherAdminId, seed.otherOrgId, workspace.name, workspace.version, 'a'.repeat(64)]);
    assert.equal((await database.db.query('SELECT id FROM booking_invoices WHERE id=$1', [other.id])).rowCount, 0);
    assert.ok((await invoices.pdf(seed.customerMember, seed.customerId, retainedBooking, retained.id)).content.length);
  });
});

function invoiceFixture(): InvoiceSnapshot {
  return {
    id: randomUUID(), invoice_number: 'INV-TEST-V1', version: 1, reason: 'booking_created', issued_at: '2026-11-10T00:00:00Z',
    total_minor: '495000', paid_minor: '300000', balance_minor: '195000',
    currency: 'GBP', status: 'partially_paid', filename: 'invoice.pdf', template_version: 3,
    organization: { id: randomUUID(), name: 'North Trading' },
    customer: { id: randomUUID(), name: 'Åster العربية', email: 'customer@example.test', phone: '+44 7700 900123', customer_code: 'C-1001' },
    booking: { id: randomUUID(), reference: 'UMR-2026-1042', departure_at: '2030-01-01T12:00:00Z', required_services: ['flight', 'makkah', 'visas'],
      original_total_minor: '495000', cancelled_at: null, charge_reversed: false },
    currency_exponent: 2, time_zone: 'Europe/London', approved_payment_count: 1, latest_payment_date: '2026-11-09',
    instalments: Array.from({ length: 100 }, () => ({ due_date: '2027-01-01', amount_minor: '4950' })),
  };
}

async function readPdf(content: Buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(content), useSystemFonts: false });
  try {
    const pdf = await task.promise;
    const pages = [];
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const viewport = page.getViewport({ scale: 1 });
      const items = (await page.getTextContent()).items.filter(item => 'str' in item);
      pages.push({ text: items.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim(), items, width: viewport.width, height: viewport.height });
    }
    return pages;
  } finally { await task.destroy(); }
}

it('renumbers existing invoices and their saved PDFs atomically in issue order, preserving financial snapshots', async () => {
  const database = await setupTestDatabase({ throughMigration: 29 });
  try {
    const seed = await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP'");
    const access = new AccessService(database.db);
    const admin = await access.membership(seed.adminId, seed.orgId);
    const ledger = new LedgerService(database.db, access);
    const charge = await ledger.post(admin, seed.customerId, { kind: 'charge', amount: '4950', effective_date: '2020-01-01',
      description: 'Existing booking', idempotency_key: randomUUID() });
    const bookingId = randomUUID();
    await database.db.query(`INSERT INTO bookings(id,organization_id,customer_id,reference,departure_at,total_minor,charge_entry_id,created_by,idempotency_key,request_hash)
      VALUES($1,$2,$3,'EXISTING','2030-01-01',495000,$4,$5,$6,$7)`,
      [bookingId, seed.orgId, seed.customerId, charge.id, seed.adminId, randomUUID(), '0'.repeat(64)]);
    for (const version of [2, 1]) {
      const snapshot = invoiceFixture();
      snapshot.organization.id = seed.orgId; snapshot.customer.id = seed.customerId; snapshot.booking.id = bookingId;
      snapshot.version = version; snapshot.issued_at = `2020-01-0${version}T00:00:00Z`;
      snapshot.invoice_number = `INV-${bookingId.replaceAll('-', '').toUpperCase()}-V${version}`;
      snapshot.filename = `${snapshot.invoice_number.toLowerCase()}.pdf`;
      await database.db.query(`INSERT INTO booking_invoices(id,organization_id,customer_id,booking_id,invoice_number,version,reason,event_key,
        issued_at,total_minor,paid_minor,balance_minor,currency,status,filename,snapshot,pdf)
        VALUES($1,$2,$3,$4,$5,$6,'booking_created',$7,$8,495000,300000,195000,'GBP','partially_paid',$9,$10::jsonb,$11)`,
        [snapshot.id, seed.orgId, seed.customerId, bookingId, snapshot.invoice_number, version, `existing:${version}`,
          snapshot.issued_at, snapshot.filename, JSON.stringify(snapshot), await renderInvoicePdf(snapshot)]);
    }
    const read = async () => (await database.db.query('SELECT * FROM booking_invoices ORDER BY issued_at,id')).rows;
    const before = await read();
    const sql = await readFile('apps/api/src/database/migrations/030_sequential_invoice_numbers.sql', 'utf8');
    const migrate = () => database.db.transaction(async client => {
      // PGlite's prepared-query adapter accepts one SQL statement at a time.
      for (const statement of sql.split(';').filter(value => value.trim())) await client.query(statement);
      await renumberExistingInvoices(client);
    });
    await database.applyMigration(`CREATE FUNCTION fail_invoice_renumber() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='invoice.renumbered' THEN RAISE EXCEPTION 'Simulated renumber failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER fail_invoice_renumber BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_invoice_renumber();`);
    await assert.rejects(migrate(), /Simulated renumber failure/);
    assert.deepEqual(await read(), before);
    await assert.rejects(database.db.query('UPDATE booking_invoices SET filename=filename'), /cannot be edited or deleted/);
    await database.applyMigration('DROP TRIGGER fail_invoice_renumber ON audit_events; DROP FUNCTION fail_invoice_renumber();');
    await migrate();
    const after = await read();
    for (let index = 0; index < after.length; index++) {
      const row = after[index], old = before[index], number = `Inv-up00${index + 1}`;
      assert.equal(row.invoice_number, number);
      assert.equal(row.filename, `${number}.pdf`);
      assert.deepEqual(row.snapshot, { ...old.snapshot, invoice_number: number, filename: `${number}.pdf` });
      const { invoice_number: _number, filename: _filename, snapshot: _snapshot, pdf: _pdf, ...unchanged } = row;
      const { invoice_number: _oldNumber, filename: _oldFilename, snapshot: _oldSnapshot, pdf: _oldPdf, ...original } = old;
      assert.deepEqual(unchanged, original);
      const text = (await readPdf(Buffer.from(row.pdf))).map(page => page.text).join(' ');
      assert.ok(text.includes(number)); assert.ok(!text.includes(old.invoice_number));
    }
    assert.equal((await database.db.query("SELECT count(*)::int AS count FROM audit_events WHERE action='invoice.renumbered'")).rows[0].count, 2);
    assert.equal((await database.db.query('SELECT count(*)::int AS count FROM ledger_entries')).rows[0].count, 1);
    await assert.rejects(database.db.query('UPDATE booking_invoices SET filename=filename'), /cannot be edited or deleted/);
    assert.equal(await database.db.transaction(client => nextInvoiceNumber(client)), 'Inv-up003');
    await database.db.query("SELECT setval('invoice_number_sequence',999)");
    assert.equal(await database.db.transaction(client => nextInvoiceNumber(client)), 'Inv-up1000');
  } finally { await database.close(); }
});

describe('reference payment invoice PDF template', () => {
  it('keeps the company branding and essential booking/payment facts on one page', async () => {
    const pdf = await renderInvoicePdf(invoiceFixture());
    const content = pdf.toString('latin1');
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.match(content, /%%EOF\s*$/);
    assert.match(content, /\/FontFile2\b/);
    assert.match(content, /\/ToUnicode\b/);
    assert.match(content, /\/Subtype \/Image\b/);
    assert.ok(pdf.length < 2 * 1024 * 1024);
    const pages = await readPdf(pdf);
    assert.equal(pages.length, 1, 'A full instalment schedule must not add pages to the simplified invoice.');
    for (const expected of ['Payment Invoice', 'Date:10-November-2026', 'UMRAH PACAKGES UK LTD', '110 Hucknall Road',
      'info@umrahpackagseuk.com', 'Guest Name:', '+44 7700 900123', 'customer@example.test', 'UMR-2026-1042',
      '01-January-2030', 'Included services', 'Flight Tickets', 'Makkah Hotel', 'Visas', 'Total Amount £4950.00', 'Received Amount £3000.00',
      'Balance Amount £1950.00', 'INV-TEST-V1']) assert.ok(pages[0].text.includes(expected), expected);
    assert.doesNotMatch(pages[0].text, /Payment schedule|Invoice record|Only approved|Version 1|Booking created|C-1001|n\/a|Qty|Munaf|Qatar|Hilton/);
    const withoutPhone = invoiceFixture();
    delete withoutPhone.customer.phone;
    assert.doesNotMatch((await readPdf(await renderInvoicePdf(withoutPhone)))[0].text, /Contact number:/);
    assert.equal(invoiceText('Åster العربية (test) \\ line\nnew\u202E'), 'Åster العربية (test) \\ line new');
    assert.equal(invoiceText('旅'), '[U+65C5]');
  });

  it('prints only checked services once, in form order, and omits an empty checklist', async () => {
    const snapshot = invoiceFixture();
    snapshot.booking.required_services = ['extras', 'makkah', 'flight', 'flight'];
    const selected = (await readPdf(await renderInvoicePdf(snapshot)))[0].text;
    assert.match(selected, /Included services Flight Tickets Makkah Hotel Extras/);
    assert.equal(selected.match(/Flight Tickets/g)?.length, 1);
    assert.doesNotMatch(selected, /Madinah Hotel|Transfers|Visas|Travel package/);
    snapshot.booking.required_services = ['madinah'];
    const single = (await readPdf(await renderInvoicePdf(snapshot)))[0].text;
    assert.match(single, /Included services Madinah Hotel/);
    assert.doesNotMatch(single, /Flight Tickets|Makkah Hotel|Transfers|Visas|Extras/);
    snapshot.booking.required_services = [];
    const empty = (await readPdf(await renderInvoicePdf(snapshot)))[0].text;
    assert.doesNotMatch(empty, /Included services|Flight Tickets|Makkah Hotel|Madinah Hotel|Transfers|Visas|Extras|Travel package/);
    assert.match(empty, /Total Amount £4950\.00/);
  });

  it('fits all six checked services and payment totals on one page, including cancellation', async () => {
    const snapshot = invoiceFixture();
    snapshot.booking.required_services = ['extras', 'flight', 'madinah', 'makkah', 'transfers', 'visas'];
    for (const cancelled of [false, true]) {
      if (cancelled) {
        snapshot.status = 'cancelled';
        snapshot.booking.cancelled_at = snapshot.issued_at;
        snapshot.total_minor = '0';
        snapshot.balance_minor = '-300000';
      }
      const pages = await readPdf(await renderInvoicePdf(snapshot));
      assert.equal(pages.length, 1);
      assert.match(pages[0].text, /Included services Flight Tickets Makkah Hotel Madinah Hotel Transfers Visas Extras/);
      assert.match(pages[0].text, /Received Amount £3000\.00/);
      for (const item of pages[0].items.filter(item => item.str.includes('Amount') || item.str.includes('£'))) {
        assert.ok(pages[0].height - item.transform[5] < pages[0].height - 74, item.str);
      }
    }
  });

  it('prints exact payment balances, credits and cancellation/reversal states', async () => {
    const cases: [Partial<InvoiceSnapshot>, string[]][] = [
      [{ paid_minor: '0', balance_minor: '495000', status: 'unpaid' }, ['Received Amount £0.00', 'Balance Amount £4950.00']],
      [{ paid_minor: '495000', balance_minor: '0', status: 'paid' }, ['Received Amount £4950.00', 'Balance Amount £0.00']],
      [{ total_minor: '100000000000000', paid_minor: '9007199254740993', balance_minor: '-8907199254740993', status: 'overpaid' },
        ['Total Amount £1000000000000.00', 'Received Amount £90071992547409.93', 'Credit Amount £89071992547409.93']],
      [{ total_minor: '0', balance_minor: '-300000', status: 'cancelled', booking: { ...invoiceFixture().booking, cancelled_at: '2026-11-10T00:00:00Z' } },
        ['Booking status Cancelled', 'Total Amount £0.00', 'Received Amount £3000.00', 'Credit Amount £3000.00']],
      [{ total_minor: '0', balance_minor: '-300000', status: 'cancelled', booking: { ...invoiceFixture().booking, charge_reversed: true } },
        ['Booking status Charge reversed', 'Credit Amount £3000.00']],
    ];
    for (const [changes, expected] of cases) {
      const pages = await readPdf(await renderInvoicePdf({ ...invoiceFixture(), ...changes }));
      assert.equal(pages.length, 1);
      for (const text of expected) assert.ok(pages[0].text.includes(text), text);
    }
  });

  it('paginates long fields without dropping characters or printing into the stationery', async () => {
    const snapshot = invoiceFixture();
    snapshot.customer.name = '旅'.repeat(160);
    snapshot.customer.email = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(60)}`;
    snapshot.booking.reference = '旅'.repeat(160);
    const pages = await readPdf(await renderInvoicePdf(snapshot));
    assert.ok(pages.length > 1);
    const text = pages.map(page => page.text).join(' ');
    assert.equal((text.replaceAll(' ', '').match(/\[U\+65C5\]/g) ?? []).length, 320);
    assert.ok(text.includes('Balance Amount £1950.00'));
    for (const page of pages) {
      assert.ok(page.text.includes('Payment Invoice'));
      assert.ok(page.text.includes(snapshot.invoice_number));
      for (const item of page.items.filter(item => item.str.trim())) {
        assert.ok(item.transform[4] >= 49 && item.transform[4] + item.width <= page.width + 0.5, item.str);
        if (item.str === snapshot.invoice_number || /^\d+ \/ \d+$/.test(item.str)) continue;
        // Top header is above 50 pt; all body baselines stay clear of both bands.
        const top = page.height - item.transform[5];
        assert.ok(top < 51 || (top >= 78 && top <= page.height - 70), `${item.str}: ${top}`);
      }
    }
    snapshot.customer.name = 'अनिल العربية';
    snapshot.booking.reference = 'MIXED';
    const mixed = (await readPdf(await renderInvoicePdf(snapshot))).map(page => page.text).join(' ');
    assert.ok(!mixed.includes('\u0000'));
    assert.ok(mixed.includes('[U+905]'), 'Unsupported mixed-script characters must remain explicit.');
  });
});
