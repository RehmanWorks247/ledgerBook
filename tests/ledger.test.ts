import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { AccessService } from '../apps/api/src/access/access.service';
import { LedgerService, csvCell, type PostEntryInput } from '../apps/api/src/ledger/ledger.service';
import { formatMoney, parseMoney, validDate } from '../apps/api/src/ledger/money';
import { integrationBackend, setupTestDatabase } from './helpers';

describe('exact money parsing', () => {
  it('uses integer arithmetic including values beyond floating point precision', () => {
    assert.equal(parseMoney('999999999999.99', 2), 99_999_999_999_999n);
    assert.equal(parseMoney('-12.345', 3, true), -12345n);
    assert.equal(parseMoney('52', 0), 52n);
    assert.equal(formatMoney('-12345', 3), '-12.345');
    assert.equal(formatMoney('99', 2), '0.99');
  });
  it('rejects malformed, zero, out-of-range, negative charge, and excessive precision amounts', () => {
    for (const value of ['0', '0.00', '1e3', '1,000', 'NaN', '0.001', '-1', '1000000000000.01', '2.']) {
      assert.throws(() => parseMoney(value, 2));
    }
    assert.throws(() => parseMoney('2.0', 0));
    assert.throws(() => parseMoney('2.0001', 3));
    assert.equal(validDate('2026-02-30'), false);
    assert.equal(validDate('2024-02-29'), true);
  });
});

describe(`ledger integrity (${integrationBackend})`, () => {
  let fixture: Awaited<ReturnType<typeof setupTestDatabase>>;
  let seed: Awaited<ReturnType<Awaited<ReturnType<typeof setupTestDatabase>>['seed']>>;
  let ledger: LedgerService;
  let access: AccessService;

  before(async () => {
    fixture = await setupTestDatabase();
    seed = await fixture.seed();
    access = new AccessService(fixture.db);
    ledger = new LedgerService(fixture.db, access);
  });
  after(async () => fixture?.close());

  async function account(): Promise<string> {
    const id = randomUUID();
    await fixture.db.query(
      `INSERT INTO customers (id,organization_id,name,email,created_by,idempotency_key,request_hash)
       VALUES ($1,$2,'Test customer',$3,$4,$5,$6)`,
      [id, seed.orgId, `${id}@example.test`, seed.adminId, randomUUID(), '0'.repeat(64)],
    );
    return id;
  }
  function entry(overrides: Partial<PostEntryInput> = {}): PostEntryInput {
    return { kind: 'charge', amount: '10.00', effective_date: '2026-01-02', description: 'Goods', idempotency_key: randomUUID(), ...overrides };
  }

  it('calculates opening, charges, payments, and exact linked reversal without changing originals', async () => {
    const id = await account();
    const opening = await ledger.post(seed.admin, id, entry({ kind: 'opening', amount: '100.00', effective_date: '2026-01-01' }));
    const charge = await ledger.post(seed.admin, id, entry({ amount: '25.50' }));
    const payment = await ledger.post(seed.admin, id, entry({ kind: 'payment', amount: '50.00', effective_date: '2026-01-03' }));
    const reversalInput = entry({ kind: 'reversal', reversal_of: charge.id, effective_date: '2026-01-04', amount: undefined });
    const reversal = await ledger.post(seed.admin, id, reversalInput);
    assert.equal(reversal.amount_minor, '-2550');
    assert.equal(reversal.reversal_of, charge.id);
    assert.equal((await ledger.post(seed.admin, id, reversalInput)).id, reversal.id);
    const statement = await ledger.statement(seed.admin, id);
    assert.equal(statement.current_balance_minor, '5000');
    assert.equal(statement.total_amount_minor, '10000');
    assert.equal(statement.total_paid_minor, '5000');
    assert.deepEqual(statement.entries.map((row) => row.running_balance_minor), ['10000', '12550', '7550', '5000']);
    assert.deepEqual(statement.entries.map((row) => row.id), [opening.id, charge.id, payment.id, reversal.id]);
    assert.equal(statement.entries.find((row) => row.id === charge.id)?.reversed_by, reversal.id);
    await assert.rejects(ledger.post(seed.admin, id, { ...reversalInput, idempotency_key: randomUUID() }), /already been reversed/);
    await assert.rejects(ledger.post(seed.admin, id, entry({ kind: 'reversal', reversal_of: reversal.id, effective_date: '2026-01-05' })), /Only an original/);
    await assert.rejects(ledger.post(seed.admin, id, entry({ kind: 'opening', amount: '1.00' })), /first entry/);
  });

  it('keeps date-filtered and searched running balances independent from displayed rows and pagination', async () => {
    const id = await account();
    await ledger.post(seed.admin, id, entry({ kind: 'opening', amount: '100.00', effective_date: '2026-01-01' }));
    const last = await ledger.post(seed.admin, id, entry({ amount: '20.00', effective_date: '2026-01-03', description: 'Visible search' }));
    const backdated = await ledger.post(seed.admin, id, entry({ kind: 'payment', amount: '30.00', effective_date: '2026-01-02', description: 'Other payment' }));
    await ledger.post(seed.admin, id, entry({ amount: '5.00', effective_date: '2026-01-03', description: 'Other same day' }));
    const filtered = await ledger.statement(seed.admin, id, { start: '2026-01-03', end: '2026-01-03', search: 'visible', page_size: 1 });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.entries[0].id, last.id);
    assert.equal(filtered.entries[0].running_balance_minor, '9000');
    assert.equal(filtered.opening_balance_minor, '7000');
    assert.equal(filtered.closing_balance_minor, '9500');
    assert.equal(filtered.current_balance_minor, '9500');
    assert.equal(filtered.total_amount_minor, '12500');
    assert.equal(filtered.total_paid_minor, '3000');
    const secondPage = await ledger.statement(seed.admin, id, { page: 2, page_size: 1 });
    assert.equal(secondPage.entries[0].id, backdated.id);
    assert.equal(secondPage.entries[0].running_balance_minor, '7000');
    assert.equal(secondPage.total_amount_minor, '12500');
    assert.equal(secondPage.total_paid_minor, '3000');
  });

  it('isolates tenants and limits customers even when a caller supplies a forged role', async () => {
    await assert.rejects(ledger.statement(seed.admin, seed.otherCustomerId), /not found/);
    await assert.rejects(ledger.statement(seed.customerMember, seed.secondCustomerId), /not found/);
    await assert.rejects(ledger.post({ ...seed.customerMember, role: 'admin' }, seed.customerId, entry()), /administrator/);
    await assert.rejects(access.membership(seed.customerUserId, seed.otherOrgId), /unavailable/);
    const own = await ledger.statement(seed.customerMember, seed.customerId);
    assert.equal(own.customer.id, seed.customerId);
  });

  it('finds statement entries by ID and displayed date without discarding preceding balance movements', async () => {
    const id = await account();
    await ledger.post(seed.admin, id, entry({ amount: '80.00', effective_date: '2025-08-01' }));
    const payment = await ledger.post(seed.admin, id, entry({ kind: 'payment', amount: '25.00', effective_date: '2025-08-06', reference: 'BANK-SEARCH' }));
    for (const search of [`#${payment.id}`, '2025-08-06', '06 Aug 2025', 'BANK-SEARCH', 'payment']) {
      const found = await ledger.statement(seed.admin, id, { search, page_size: 1 });
      assert.equal(found.total, 1, search);
      assert.equal(found.entries[0].id, payment.id, search);
      assert.equal(found.entries[0].running_balance_minor, '5500');
      assert.equal(found.current_balance_minor, '5500');
    }
    assert.equal((await ledger.statement(seed.admin, id, { search: 'Test customer' })).total, 2);
    assert.equal((await ledger.statement(seed.admin, id, { search: id })).total, 2);
    assert.equal((await ledger.statement(seed.admin, id, { search: '%' })).total, 0);
    const csv = await ledger.csv(seed.admin, id, { search: `#${payment.id}` });
    assert.equal(csv.trim().split('\r\n').length, 2);
    assert.match(csv, /BANK-SEARCH/);
  });

  it('rejects malformed transaction bodies and unsupported fields with client errors', async () => {
    for (const body of [null, undefined, [], 'charge', { ...entry(), balance_minor: '500' }]) {
      await assert.rejects(ledger.post(seed.admin, seed.customerId, body as PostEntryInput), (error: unknown) =>
        typeof error === 'object' && error !== null && 'getStatus' in error && (error as { getStatus(): number }).getStatus() === 400,
      );
    }
    await assert.rejects(ledger.post(seed.admin, seed.customerId, entry({ kind: 'reversal', reversal_of: '9999999999999999999' })), /original transaction/);
  });

  it('does not expose administrator notes or submission metadata to a customer', async () => {
    await fixture.db.query('UPDATE customers SET notes=$1 WHERE id=$2', ['Internal collection instructions', seed.customerId]);
    const customerStatement = await ledger.statement(seed.customerMember, seed.customerId);
    for (const key of ['notes', 'created_by', 'request_hash', 'idempotency_key']) {
      assert.equal(key in customerStatement.customer, false);
    }
    const adminStatement = await ledger.statement(seed.admin, seed.customerId);
    assert.ok('notes' in adminStatement.customer);
    assert.equal(adminStatement.customer.notes, 'Internal collection instructions');
  });

  it('rechecks revocation and preserves ledger history on archived accounts', async () => {
    const id = await account();
    await ledger.post(seed.admin, id, entry());
    await fixture.db.query("UPDATE customers SET status='archived' WHERE id=$1", [id]);
    await assert.rejects(ledger.post(seed.admin, id, entry()), /Archived/);
    assert.equal((await ledger.statement(seed.admin, id)).current_balance_minor, '1000');
    await fixture.db.query('UPDATE memberships SET is_active=false WHERE id=$1', [seed.customerMember.id]);
    await assert.rejects(ledger.statement(seed.customerMember, seed.customerId), /unavailable/);
    await fixture.db.query('UPDATE memberships SET is_active=true WHERE id=$1', [seed.customerMember.id]);
  });

  it('returns one entry for duplicate submissions and rejects changed payloads', async () => {
    const id = await account();
    const input = entry();
    const results = await Promise.all(Array.from({ length: 12 }, () => ledger.post(seed.admin, id, input)));
    assert.equal(new Set(results.map((row) => row.id)).size, 1);
    assert.equal((await ledger.statement(seed.admin, id)).current_balance_minor, '1000');
    await assert.rejects(ledger.post(seed.admin, id, { ...input, amount: '11.00' }), /different transaction/);
    const differentCustomer = await account();
    await assert.rejects(ledger.post(seed.admin, differentCustomer, input), /different transaction/);
  });

  it('preserves all distinct concurrently submitted writes and prevents double reversal', async () => {
    const id = await account();
    await Promise.all(Array.from({ length: 20 }, () => ledger.post(seed.admin, id, entry({ amount: '0.01' }))));
    const statement = await ledger.statement(seed.admin, id);
    assert.equal(statement.total, 20);
    assert.equal(statement.current_balance_minor, '20');
    const original = statement.entries[0];
    const reversals = await Promise.allSettled(Array.from({ length: 2 }, () => ledger.post(seed.admin, id, entry({ kind: 'reversal', reversal_of: original.id }))));
    assert.equal(reversals.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal((await ledger.statement(seed.admin, id)).current_balance_minor, '19');
  });

  it('enforces append-only and cross-tenant integrity at the database boundary', async () => {
    const id = await account();
    const posted = await ledger.post(seed.admin, id, entry());
    await assert.rejects(fixture.db.query('UPDATE ledger_entries SET amount_minor=99 WHERE id=$1', [posted.id]), /cannot be edited/);
    await assert.rejects(fixture.db.query('DELETE FROM ledger_entries WHERE id=$1', [posted.id]), /cannot be edited/);
    await assert.rejects(fixture.db.query('DELETE FROM audit_events WHERE object_id=$1', [posted.id]), /cannot be edited/);
    await assert.rejects(fixture.db.query(
      `INSERT INTO ledger_entries (organization_id,customer_id,kind,amount_minor,currency,effective_date,description,created_by,idempotency_key,request_hash)
       VALUES ($1,$2,'charge',100,'USD','2026-01-01','Invalid tenant',$3,$4,$5)`,
      [seed.otherOrgId, id, seed.otherAdminId, randomUUID(), '0'.repeat(64)],
    ));
    await assert.rejects(fixture.db.query('UPDATE organizations SET currency_exponent=3 WHERE id=$1', [seed.orgId]), /currency cannot change/);
  });

  it('keeps debt and credit separate and includes archived balances', async () => {
    const id = await account();
    await ledger.post(seed.admin, id, entry({ kind: 'opening', amount: '-200.00' }));
    await fixture.db.query("UPDATE customers SET status='archived' WHERE id=$1", [id]);
    const dashboard = await ledger.dashboard(seed.admin);
    assert.ok(BigInt(dashboard.total_debt_minor) > 0n);
    assert.ok(BigInt(dashboard.total_credit_minor) >= 20_000n);
    await assert.rejects(ledger.dashboard(seed.customerMember), /administrator/);
  });

  it('exports exact decimal amounts and protects CSV from formula injection', async () => {
    const id = await account();
    await ledger.post(seed.admin, id, entry({ amount: '12.34', description: '=HYPERLINK("evil")', reference: '+SUM(1,2)' }));
    const csv = await ledger.csv(seed.admin, id);
    assert.ok(csv.includes('"12.34"'));
    assert.ok(csv.includes('"\'=HYPERLINK(""evil"")"'));
    assert.ok(csv.includes('"\'+SUM(1,2)"'));
    assert.equal(csvCell('\t@formula', true), '"\'\t@formula"');
    assert.ok(csv.endsWith('\r\n'));
  });
});
