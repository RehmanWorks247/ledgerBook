import { test, expect, type BrowserContext } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const origin = 'http://127.0.0.1:4312';
let orgId: string;
test.beforeAll(async () => { ({ orgId } = JSON.parse(await readFile('.local/e2e/seed.json', 'utf8'))); });

async function authenticate(context: BrowserContext, email = 'admin@example.test') {
  const response = await context.request.post(`${origin}/api/auth/login`, {
    headers: { Origin: origin, 'X-CSRF-Protection': '1' },
    data: { email, password: 'Test-only password 47!' },
  });
  expect(response.status(), await response.text()).toBe(200);
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
  const name = `Browser company ${randomUUID().slice(0, 8)}`;
  await page.getByRole('button', { name: 'Add company', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add company', exact: true });
  for (const [label, value] of [
    ['Company name', name], ['Hotel name', 'Pullman Zamzam Madinah'], ['Customer name', 'Syed Ahsan Yousuf'],
    ['Check-in', '2026-06-16'], ['Check-out', '2026-06-21'], ['Room type', '01 Dbl 01 Triple With BB'],
    ['Booking date', '2026-05-21'], ['Voucher number', '002825'], ['Voucher price', '6625.10'],
    ['Paid', '2500.00'], ['Un-Paid', '123.45'], ['Balance', '-22.05'], ['Remarks', 'Amounts entered from the company sheet.'],
  ]) await dialog.getByLabel(label, { exact: true }).fill(value);
  await dialog.getByRole('button', { name: 'Add company', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  let row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toContainText('002825');
  await expect(row).toContainText('6,625.10');
  await expect(row).toContainText('123.45');
  await expect(row).toContainText('22.05');
  await page.reload();
  row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toContainText('Amounts entered from the company sheet.');
  await page.screenshot({ path: '.local/e2e/companies-desktop.png', fullPage: true });

  await page.getByLabel('Search companies', { exact: true }).fill('No such company exists here');
  await expect(row).toHaveCount(0);
  await page.getByLabel('Search companies', { exact: true }).fill(name);
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
  const edit = page.getByRole('dialog', { name: 'Edit company', exact: true });
  await expect(edit.getByLabel('Voucher number', { exact: true })).toHaveValue('002825');
  await expect(edit.getByLabel('Balance', { exact: true })).toHaveValue('-22.05');
  await edit.getByLabel('Paid', { exact: true }).fill('0');
  await edit.getByRole('textbox', { name: 'Remarks', exact: true }).fill('Company details updated');
  await edit.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(edit).toHaveCount(0);
  await expect(row).toContainText('Company details updated');
  await expect(row).toContainText('123.45');
  await row.getByRole('button', { name: `Delete ${name}`, exact: true }).click();
  const deletion = page.getByRole('dialog', { name: 'Delete company?', exact: true });
  await deletion.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: `Delete ${name}`, exact: true }).click();
  await deletion.getByRole('button', { name: 'Delete company', exact: true }).click();
  await expect(row).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('mobile companies table scrolls within the page and its manual form fits the viewport', async ({ page, context }) => {
  await authenticate(context);
  const name = `Mobile company ${randomUUID().slice(0, 8)}`;
  const response = await context.request.post(`${origin}/api/organizations/${orgId}/companies`, {
    headers: { Origin: origin, 'X-CSRF-Protection': '1' },
    data: { company_name: name, hotel_name: 'Aqeeq Al Madinah', customer_name: 'Mr. Munaf Patel', voucher_price: '3400', idempotency_key: randomUUID() },
  });
  expect(response.status(), await response.text()).toBe(201);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/o/${orgId}/companies`);
  await expect(page.getByRole('heading', { name: 'Companies', exact: true })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/e2e/companies-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Add company', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add company', exact: true });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await dialog.getByLabel('Company name', { exact: true }).fill('Mobile manual company');
  await dialog.getByLabel('Remarks', { exact: true }).fill('Mobile input works');
  await dialog.getByRole('button', { name: 'Add company', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: 'Mobile manual company' })).toBeVisible();
});

test('customer accounts cannot see Companies or open its route', async ({ page, context }) => {
  await authenticate(context, 'customer@example.test');
  await page.goto(`/o/${orgId}/companies`);
  await expect(page).toHaveURL(`/o/${orgId}`);
  await expect(page.getByRole('link', { name: 'Companies', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add company', exact: true })).toHaveCount(0);
});
