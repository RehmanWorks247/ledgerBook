import assert from 'node:assert/strict';
import { it } from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { companyFields, type Company, type CompanyExport } from '../src/companies/model';
import { companyExportFilename, companySheets } from '../src/companies/spreadsheet';
import { companyWorkbook } from '../src/companies/workbook';

const row: Company = {
  ...companyFields(undefined, 2), id: 'test', organization_id: 'workspace', company_name: 'Aden Golden',
  quantity: 7, check_in: '2026-06-16', check_out: null, booking_date: null,
  customer_name: '=1+1', voucher_number: '002825', voucher_price_minor: '662510', remarks: 'A&B <hotel>\nSecond line',
  created_at: '', updated_at: '', version: 1,
};
const data: CompanyExport = {
  company_name: 'Aden Golden', items: [row], total: 1, currency: 'SAR', currency_exponent: 2,
  totals: { total_minor: '662510', paid_minor: '260045', balance_minor: '402465', unpaid_minor: '402465', unpriced_count: 0, voucher_count: 1, paid_version: 1 },
};

it('creates matching records and summary sheets, with informational quantity and separate company paid', () => {
  const [records, summary] = companySheets(data);
  assert.equal(records.headers.indexOf('Quantity') + 1, records.headers.indexOf('Room type'));
  assert.equal(records.rows[0][5], 7);
  assert.deepEqual(records.rows[0][9], { amount: '6625.10' });
  assert.deepEqual(summary.rows.find(row => row[0] === 'Total paid (SAR)'), ['Total paid (SAR)', { amount: '2600.45' }]);
  assert.equal(companyExportFilename('Aden Golden'), 'aden-golden-records.xlsx');
});

it('writes an XLSX archive with numeric amounts, literal formula-like text, leading zero IDs and frozen headers', () => {
  const files = unzipSync(companyWorkbook(data));
  const records = strFromU8(files['xl/worksheets/sheet1.xml']);
  const summary = strFromU8(files['xl/worksheets/sheet2.xml']);
  assert.match(strFromU8(files['xl/workbook.xml']), /name="Records".*name="Summary"/s);
  assert.match(records, /<c r="B2"[^>]*t="inlineStr"><is><t[^>]*>=1\+1<\/t>/);
  assert.match(records, /<c r="I2"[^>]*t="inlineStr"><is><t[^>]*>002825<\/t>/);
  assert.match(records, /<c r="F2"[^>]*t="n"><v>7<\/v>/);
  assert.match(records, /<c r="J2"[^>]*t="n"><v>6625.10<\/v>/);
  assert.match(records, /A&amp;B &lt;hotel&gt;\nSecond line/);
  assert.match(records, /state="frozen"/);
  assert.match(records, /<autoFilter ref="A1:K2"/);
  assert.match(summary, /<v>2600.45<\/v>/);
  assert.match(summary, /<v>4024.65<\/v>/);
  assert.doesNotMatch(records + summary, /<f[ >]/);
  assert.match(strFromU8(files['xl/styles.xml']), /SAR/);
});

it('leaves unknown amounts blank and preserves very large paid amounts as exact text', () => {
  const largePaid = '10000000000000000000000000001';
  const files = unzipSync(companyWorkbook({ ...data, items: [{ ...row, voucher_price_minor: null }],
    totals: { ...data.totals, total_minor: null, balance_minor: null, unpaid_minor: null, paid_minor: largePaid, unpriced_count: 1 } }));
  assert.match(strFromU8(files['xl/worksheets/sheet1.xml']), /<c r="J2"[^>]*t="inlineStr"><is><t[^>]*><\/t>/);
  assert.match(strFromU8(files['xl/worksheets/sheet2.xml']), /<c r="B6"[^>]*t="inlineStr"><is><t[^>]*>100000000000000000000000000.01<\/t>/);
  assert.doesNotThrow(() => companyWorkbook({ ...data, total: 0, items: [] }));
});
