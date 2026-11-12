import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';
import { AccessService } from '../apps/api/src/access/access.service';
import { CompaniesService } from '../apps/api/src/companies/companies.service';
import { setupTestDatabase } from './helpers';

it('preserves voucher fields and combines previous paid amounts into independent company totals', async () => {
  const database = await setupTestDatabase({ throughMigration: 30 });
  try {
    const seed = await database.seed();
    const first = randomUUID(), second = randomUUID(), third = randomUUID(), foreign = randomUUID();
    await database.db.query(`INSERT INTO companies(id,organization_id,company_name,voucher_price_minor,paid_minor,unpaid_minor,balance_minor)
      VALUES($1,$5,'Muhabiya Hotels',10000,2500,123,-77),($2,$5,'muhabiya hotels',20000,3000,NULL,NULL),
      ($3,$5,'Aden Golden',0,0,0,0),($4,$6,'Muhabiya Hotels',10000,9000,1000,1000)`, [first, second, third, foreign, seed.orgId, seed.otherOrgId]);
    const before = (await database.db.query('SELECT to_jsonb(c) AS row FROM companies c ORDER BY id')).rows;
    await database.applyMigration(await readFile('apps/api/src/database/migrations/031_company_voucher_amounts.sql', 'utf8'));
    assert.deepEqual((await database.db.query("SELECT to_jsonb(c)-'quantity' AS row FROM companies c ORDER BY id")).rows, before);
    const service = new CompaniesService(database.db, new AccessService(database.db));
    const page = await service.list(seed.adminId, seed.orgId, { company_name: 'Muhabiya Hotels' });
    assert.equal(page.items[0].quantity, 1);
    assert.deepEqual(page.totals, { total_minor: '30000', paid_minor: '5500', balance_minor: '24500', unpaid_minor: '24500', unpriced_count: 0, voucher_count: 2, paid_version: 1 });
    await service.update(seed.adminId, seed.orgId, first, { quantity: 9, expected_version: 1 });
    assert.deepEqual((await service.list(seed.adminId, seed.orgId, { company_name: 'Muhabiya Hotels' })).totals, page.totals);
    await service.remove(seed.adminId, seed.orgId, first, { expected_version: 2 });
    const after = await service.list(seed.adminId, seed.orgId, { company_name: 'Muhabiya Hotels' });
    assert.equal(after.totals.total_minor, '20000');
    assert.equal(after.totals.paid_minor, '5500', 'Paid remains independent after voucher deletion.');
    assert.equal((await service.list(seed.otherAdminId, seed.otherOrgId, { company_name: 'Muhabiya Hotels' })).totals.paid_minor, '9000');
  } finally { await database.close(); }
});
