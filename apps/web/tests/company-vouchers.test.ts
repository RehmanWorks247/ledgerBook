import assert from 'node:assert/strict';
import { it } from 'node:test';
import { companyDecimal, companyFields, companyPaidPayload, companyPayload } from '../src/companies/model';

it('submits informational quantity and the full voucher price without record-level paid inputs', () => {
  const fields = { ...companyFields(undefined, 2), company_name: 'Aden Golden', quantity: '7', voucher_price: '10.30' };
  const payload = companyPayload(fields, 2);
  assert.equal(payload.quantity, 7);
  assert.equal(payload.voucher_price, '10.30');
  for (const name of ['paid', 'unpaid', 'balance', 'payments']) assert.equal(name in payload, false);
});

it('validates the separate company paid field without losing precision', () => {
  assert.equal(companyPaidPayload(' 100.30 ', 2), '100.30');
  assert.equal(companyPaidPayload('0', 2), '0');
  assert.equal(companyPaidPayload('100000000000000000000000000.01', 2), '100000000000000000000000000.01');
  assert.equal(companyDecimal('10000000000000000000000000001', 2), '100000000000000000000000000.01');
  assert.equal(companyPaidPayload('5', 0), '5');
  assert.equal(companyPaidPayload('5.001', 3), '5.001');
  for (const value of ['', ' ', '-1', '1e2', '1,000', '1.001']) assert.throws(() => companyPaidPayload(value, 2));
  assert.throws(() => companyPaidPayload('1.1', 0));
});

it('rejects invalid quantity and voucher prices', () => {
  const fields = { ...companyFields(undefined, 2), company_name: 'Aden Golden' };
  for (const quantity of ['', '0', '-1', '1.5', '1e2', '1000001']) assert.throws(() => companyPayload({ ...fields, quantity }, 2), /Quantity/);
  for (const voucher_price of ['-1', '1e2', '1.001']) assert.throws(() => companyPayload({ ...fields, voucher_price }, 2));
});
