import { authenticateFixture } from './session-fixture';
import { test, expect, type BrowserContext } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';

const origin = 'http://127.0.0.1:4312';
let orgId: string;
test.beforeAll(async () => { ({ orgId } = JSON.parse(await readFile('.local/e2e/seed.json', 'utf8'))); });

async function authenticate(context: BrowserContext, email = 'admin@example.test') {
  await authenticateFixture(context, email);
  await context.addInitScript(value => localStorage.setItem('e2e-email', value), email);
  await context.route('**/api/auth/config', route => route.fulfill({ json: { provider: 'clerk', publishableKey: 'isolated-test-only' } }));
}

test('companies support manual fields, reload, search, all date filters, editing and deletion', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await authenticate(context);
  await page.goto(`/o/${orgId}`);
  await page.getByRole('link', { name: 'Companies', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Companies', exact: true })).toBeVisible();
  const links = await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link').allTextContents();
  expect(links.at(-2)?.trim()).toBe('Companies');
  await expect(page.locator('.company-card-grid').getByRole('link')).toHaveCount(3);
  await expect(page.getByRole('table')).toHaveCount(0);
  for (const company of ['Muhabiya Hotels', 'Aden Golden', 'Al Subaee']) {
    await expect(page.getByRole('link', { name: company, exact: true })).toBeVisible();
  }
  const cards = await page.locator('.company-card').all();
  const boxes = await Promise.all(cards.map(card => card.boundingBox()));
  expect(boxes.every(box => box && Math.abs(box.y - boxes[0]!.y) < 1)).toBe(true);
  await page.screenshot({ path: '.local/e2e/companies-grid-desktop.png', fullPage: true });
  await page.getByRole('link', { name: 'Muhabiya Hotels', exact: true }).click();
  await expect(page).toHaveURL(`/o/${orgId}/companies/muhabiya-hotels`);
  await expect(page.getByRole('heading', { name: 'Muhabiya Hotels', exact: true })).toBeVisible();
  const name = `Browser customer ${randomUUID().slice(0, 8)}`;
  await page.getByRole('button', { name: 'Add Voucher', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Voucher', exact: true });
  await expect(dialog.getByLabel('Company name', { exact: true })).toHaveValue('Muhabiya Hotels');
  await expect(dialog.getByLabel('Company name', { exact: true })).toHaveAttribute('readonly', '');
  for (const [label, value] of [
    ['Hotel name', 'Pullman Zamzam Madinah'], ['Customer name', name],
    ['Check-in', '2026-06-16'], ['Check-out', '2026-06-21'], ['Quantity', '3'], ['Room type', 'Dbl / Triple With BB'],
    ['Booking date', '2026-05-21'], ['Voucher number', '002825'], ['Voucher total', '6625.10'],
    ['Remarks', 'Amounts entered from the company sheet.'],
  ]) await dialog.getByLabel(label, { exact: true }).fill(value);
  await expect(dialog.getByLabel('Paid', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Add Voucher', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  let row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toContainText('002825');
  await expect(row).toContainText('6,625.10');
  await expect(row).toContainText('6,625.10');
  const headers = await page.getByRole('columnheader').allTextContents();
  expect(headers.indexOf('Quantity') + 1).toBe(headers.indexOf('Room type'));
  await expect(row.getByRole('cell').nth(3)).toHaveText('3');
  const totals = page.getByRole('region', { name: 'Company totals', exact: true });
  await expect(totals).toContainText('6,625.10');
  const summaryBox = await totals.boundingBox();
  const filtersBox = await page.getByRole('search', { name: 'Filter records', exact: true }).boundingBox();
  expect(summaryBox!.y).toBeLessThan(filtersBox!.y);
  await totals.getByRole('button', { name: 'Edit paid', exact: true }).click();
  const paidDialog = page.getByRole('dialog', { name: 'Edit company paid', exact: true });
  await paidDialog.getByLabel('Paid', { exact: true }).fill('2600.45');
  await paidDialog.getByRole('button', { name: 'Save paid', exact: true }).click();
  await expect(paidDialog).toHaveCount(0);
  await expect(totals).toContainText('2,600.45');
  await expect(totals).toContainText('4,024.65');
  await page.reload();
  row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toContainText('Amounts entered from the company sheet.');
  await page.screenshot({ path: '.local/e2e/companies-desktop.png', fullPage: true });

  await page.getByLabel('Search records', { exact: true }).fill('No such company exists here');
  await expect(row).toHaveCount(0);
  await expect(totals).toContainText('6,625.10');
  await expect(totals).toContainText('2,600.45');
  await expect(totals).toContainText('4,024.65');
  await page.getByRole('button', { name: 'Preview Excel', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Excel preview', exact: true });
  await expect(preview.getByRole('region', { name: 'Records spreadsheet preview', exact: true })).toContainText(name);
  await expect(preview).toContainText('002825');
  await expect(preview).toContainText('Voucher total (SAR)');
  const downloadEvent = page.waitForEvent('download');
  await preview.getByRole('button', { name: 'Download Excel', exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('muhabiya-hotels-records.xlsx');
  const workbook = unzipSync(await readFile((await download.path())!));
  expect(strFromU8(workbook['xl/worksheets/sheet1.xml'])).toContain(name);
  expect(strFromU8(workbook['xl/worksheets/sheet1.xml'])).toContain('002825');
  expect(strFromU8(workbook['xl/worksheets/sheet2.xml'])).toContain('2600.45');
  await download.saveAs('.local/e2e/company-export.xlsx');
  await preview.getByRole('button', { name: 'Summary', exact: true }).click();
  await expect(preview.getByRole('region', { name: 'Summary spreadsheet preview', exact: true })).toContainText('4024.65');
  await preview.getByRole('button', { name: 'Records', exact: true }).click();
  await page.screenshot({ path: '.local/e2e/company-excel-desktop.png', fullPage: true });
  await preview.getByRole('button', { name: 'Close record dialog', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Preview Excel', exact: true })).toBeFocused();
  await page.getByLabel('Search records', { exact: true }).fill(name);
  await expect(row).toBeVisible();
  for (const [field, date, excluded] of [
    ['booking_date', '2026-05-21', '2026-05-22'],
    ['check_in', '2026-06-16', '2026-06-17'],
    ['check_out', '2026-06-21', '2026-06-22'],
  ]) {
    await page.getByLabel('From date', { exact: true }).fill('');
    await page.getByLabel('To date', { exact: true }).fill('');
    await page.getByRole('combobox', { name: 'Date field', exact: true }).selectOption(field);
    await page.getByLabel('From date', { exact: true }).fill(date);
    await page.getByLabel('To date', { exact: true }).fill(date);
    await expect(row).toBeVisible();
    await page.getByLabel('To date', { exact: true }).fill(excluded);
    await page.getByLabel('From date', { exact: true }).fill(excluded);
    await expect(row).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Clear filters', exact: true }).first().click();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: `Edit ${name}`, exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Voucher', exact: true });
  await expect(edit.getByLabel('Voucher number', { exact: true })).toHaveValue('002825');
  await expect(edit.getByLabel('Quantity', { exact: true })).toHaveValue('3');
  await edit.getByLabel('Quantity', { exact: true }).fill('5');
  await expect(edit.getByLabel('Paid', { exact: true })).toHaveCount(0);
  await edit.getByRole('textbox', { name: 'Remarks', exact: true }).fill('Company details updated');
  await edit.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(edit).toHaveCount(0);
  await expect(row).toContainText('Company details updated');
  await expect(totals).toContainText('4,024.65');
  await expect(row).toContainText('6,625.10');
  await row.getByRole('button', { name: `Delete ${name}`, exact: true }).click();
  const deletion = page.getByRole('dialog', { name: 'Delete record?', exact: true });
  await deletion.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: `Delete ${name}`, exact: true }).click();
  await deletion.getByRole('button', { name: 'Delete record', exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(totals).toContainText('2,600.45');
  await expect(totals).toContainText('−SAR 2,600.45');
  expect(errors).toEqual([]);
});

test('each company keeps its own records through navigation, search and reload', async ({ page, context }) => {
  await authenticate(context);
  const customer = `Shared customer ${randomUUID().slice(0, 8)}`;
  const companies = [
    ['Muhabiya Hotels', 'muhabiya-hotels'], ['Aden Golden', 'aden-golden'], ['Al Subaee', 'al-subaee'],
  ];
  await page.goto(`/o/${orgId}/companies`);
  for (const [name, slug] of companies) {
    await page.getByRole('link', { name, exact: true }).click();
    await expect(page).toHaveURL(`/o/${orgId}/companies/${slug}`);
    await page.getByRole('button', { name: 'Add Voucher', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add Voucher', exact: true });
    await expect(dialog.getByLabel('Company name', { exact: true })).toHaveValue(name);
    await dialog.getByLabel('Customer name', { exact: true }).fill(customer);
    await dialog.getByLabel('Voucher number', { exact: true }).fill(slug);
    await dialog.getByRole('button', { name: 'Add Voucher', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('row').filter({ hasText: customer })).toHaveCount(1);
    await page.getByRole('link', { name: 'All companies', exact: true }).click();
  }
  for (const [name, slug] of companies) {
    await page.getByRole('link', { name, exact: true }).click();
    await page.reload();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await page.getByLabel('Search records', { exact: true }).fill(customer);
    const rows = page.getByRole('row').filter({ hasText: customer });
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText(slug);
    await expect(page.getByText('1 record · Amounts in SAR', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await expect(rows).toHaveCount(1);
    await page.getByRole('link', { name: 'All companies', exact: true }).click();
  }
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Al Subaee', exact: true })).toBeVisible();
  await page.goto(`/o/${orgId}/companies/not-a-company`);
  await expect(page).toHaveURL(`/o/${orgId}/companies`);
  await expect(page.locator('.company-card')).toHaveCount(3);
});

test('mobile companies table scrolls within the page and its manual form fits the viewport', async ({ page, context }) => {
  await authenticate(context);
  const name = `Mobile company ${randomUUID().slice(0, 8)}`;
  const response = await context.request.post(`${origin}/api/organizations/${orgId}/companies`, {
    headers: { Origin: origin, 'X-CSRF-Protection': '1' },
    data: { company_name: 'Aden Golden', hotel_name: 'Aqeeq Al Madinah', customer_name: name, voucher_price: '3400', idempotency_key: randomUUID() },
  });
  expect(response.status(), await response.text()).toBe(201);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/o/${orgId}/companies`);
  await expect(page.getByRole('heading', { name: 'Companies', exact: true })).toBeVisible();
  const cards = await page.locator('.company-card').all();
  const boxes = await Promise.all(cards.map(card => card.boundingBox()));
  expect(boxes).toHaveLength(3);
  expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y + boxes[0]!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/e2e/companies-grid-mobile.png', fullPage: true });
  await page.getByRole('link', { name: 'Aden Golden', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/e2e/companies-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Add Voucher', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Voucher', exact: true });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await expect(dialog.getByLabel('Company name', { exact: true })).toHaveValue('Aden Golden');
  await dialog.getByLabel('Customer name', { exact: true }).fill('Mobile manual customer');
  await dialog.getByLabel('Quantity', { exact: true }).fill('2');
  await dialog.getByLabel('Voucher total', { exact: true }).fill('100');
  await dialog.getByLabel('Remarks', { exact: true }).fill('Mobile input works');
  await dialog.getByRole('button', { name: 'Add Voucher', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: 'Mobile manual customer' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit paid', exact: true }).click();
  const paidDialog = page.getByRole('dialog', { name: 'Edit company paid', exact: true });
  await paidDialog.getByLabel('Paid', { exact: true }).fill('25');
  await paidDialog.getByRole('button', { name: 'Save paid', exact: true }).click();
  await expect(paidDialog).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Company totals', exact: true })).toContainText('SAR 25.00');
  await page.getByRole('button', { name: 'Preview Excel', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Excel preview', exact: true });
  await expect(preview.getByRole('region', { name: 'Records spreadsheet preview', exact: true })).toContainText(name);
  const previewBox = await preview.boundingBox();
  expect(previewBox!.x).toBeGreaterThanOrEqual(0);
  expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(390);
  const previewScroll = preview.getByRole('region', { name: 'Records spreadsheet preview', exact: true });
  expect(await previewScroll.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await page.screenshot({ path: '.local/e2e/company-excel-mobile.png', fullPage: true });
  await preview.getByRole('button', { name: 'Close record dialog', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('customer accounts cannot see Companies or open its route', async ({ page, context }) => {
  await authenticate(context, 'customer@example.test');
  await page.goto(`/o/${orgId}/companies`);
  await expect(page).toHaveURL(`/o/${orgId}`);
  await expect(page.getByRole('link', { name: 'Companies', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add Voucher', exact: true })).toHaveCount(0);
  await page.goto(`/o/${orgId}/companies/al-subaee`);
  await expect(page).toHaveURL(`/o/${orgId}`);
  await expect(page.getByRole('button', { name: 'Add Voucher', exact: true })).toHaveCount(0);
});
