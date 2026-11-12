import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { authenticateFixture } from './session-fixture';

const headers = { Origin: 'http://127.0.0.1:4312', 'X-CSRF-Protection': '1' };
let seed: { orgId: string };
let customerId: string;
test.beforeAll(async () => { seed = JSON.parse(await readFile('.local/e2e/seed.json', 'utf8')); });
test.beforeEach(async ({ context }) => {
  await authenticateFixture(context);
  await context.addInitScript(() => localStorage.setItem('e2e-email', 'admin@example.test'));
  await context.route('**/api/auth/config', route => route.fulfill({ json: { provider: 'clerk', publishableKey: 'isolated-test-only' } }));
  const response = await context.request.post(`/api/organizations/${seed.orgId}/customers`, {
    headers, data: { name: 'Reminder browser fixture', email: `reminders-${randomUUID()}@example.test`, idempotency_key: randomUUID() },
  });
  expect(response.status(), await response.text()).toBe(201);
  customerId = (await response.json()).id;
});
const customerEndpoint = () => `/api/organizations/${seed.orgId}/customers/${customerId}`;
async function startBooking(page: Page, reference: string) {
  await page.goto(`/o/${seed.orgId}/customers/${customerId}/bookings/new`);
  await page.getByLabel('Booking reference', { exact: true }).fill(reference);
  await page.getByLabel(/^Departure \(/).fill('2099-12-20T10:30');
  await page.getByLabel('Booking total (GBP)', { exact: true }).fill('1000.00');
  await page.getByLabel('Charge effective date', { exact: true }).fill('2020-01-01');
  await expect(page.getByLabel('Amount (GBP)', { exact: true })).toHaveValue('1000.00');
}

test('simple reminders allow a partial plan and deleting them leaves payments and the booking charge unchanged', async ({ page, context }) => {
  await startBooking(page, 'SIMPLE-REMINDERS');
  const reminders = page.getByRole('group', { name: 'Payment reminders', exact: true });
  await expect(reminders.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByLabel('Amount assistance', { exact: true })).toHaveCount(0);
  await page.getByLabel('Amount (GBP)', { exact: true }).fill('300.00');
  await page.getByLabel('Due date 1', { exact: true }).fill('2099-01-01');
  await page.getByRole('button', { name: 'Add reminder', exact: true }).click();
  await page.getByLabel('Amount (GBP)', { exact: true }).nth(1).fill('200.00');
  await page.getByLabel('Due date 2', { exact: true }).fill('2099-02-01');
  await expect(reminders).toContainText('GBP 500.00 has no reminder yet.');
  const submitted = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === `${customerEndpoint()}/bookings`);
  await page.getByRole('button', { name: 'Create booking', exact: true }).click();
  const payload = (await submitted).postDataJSON();
  expect(payload.schedule_basis).toBe('reminders');
  expect(payload.existing_payment_entry_ids).toBeUndefined();
  expect(payload.instalments).toEqual([{ due_date: '2099-01-01', amount: '300.00' }, { due_date: '2099-02-01', amount: '200.00' }]);
  await expect(page.getByRole('heading', { name: 'SIMPLE-REMINDERS', exact: true })).toBeVisible();
  const endpoint = `${customerEndpoint()}/bookings/${new URL(page.url()).pathname.split('/').at(-1)}`;
  const created = await (await context.request.get(endpoint)).json();
  expect(created.paid_minor).toBe('0');
  expect(created.remaining_minor).toBe('100000');
  const statementBefore = await (await context.request.get(`${customerEndpoint()}/statement`)).json();
  await page.getByRole('button', { name: 'Edit booking', exact: true }).click();
  await page.getByRole('button', { name: 'Remove reminder 2', exact: true }).click();
  await page.getByRole('button', { name: 'Remove reminder 1', exact: true }).click();
  await page.getByLabel('Reason for change').fill('Use no reminders for now');
  await page.getByRole('button', { name: 'Save booking', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Edit booking', exact: true })).toHaveCount(0);
  await page.reload();
  const updated = await (await context.request.get(endpoint)).json();
  expect(updated.instalments).toEqual([]);
  expect(updated.charge_entry_id).toBe(created.charge_entry_id);
  expect(updated.remaining_minor).toBe('100000');
  const statementAfter = await (await context.request.get(`${customerEndpoint()}/statement`)).json();
  expect(statementAfter.entries).toEqual(statementBefore.entries);
});

test('over-budget and zero reminders cannot save; exact pennies and an empty reminder list can', async ({ page, context }) => {
  await startBooking(page, 'REMINDER-VALIDATION');
  let writes = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === `${customerEndpoint()}/bookings`) writes++; });
  const amount = page.getByLabel('Amount (GBP)', { exact: true });
  await amount.fill('1000.01');
  await page.getByRole('button', { name: 'Create booking', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Create booking', exact: true })).toBeVisible();
  await expect(page.getByText(/Reminders exceed the remaining balance/)).toBeVisible();
  expect(writes).toBe(0);
  await amount.fill('0.00');
  await page.getByRole('button', { name: 'Create booking', exact: true }).click();
  expect(writes).toBe(0);
  await amount.fill('123.45');
  await page.getByRole('button', { name: 'Create booking', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'REMINDER-VALIDATION', exact: true })).toBeVisible();
  const endpoint = `${customerEndpoint()}/bookings/${new URL(page.url()).pathname.split('/').at(-1)}`;
  expect((await (await context.request.get(endpoint)).json()).instalments[0].amount_minor).toBe('12345');
  await startBooking(page, 'NO-REMINDERS');
  await page.getByRole('button', { name: 'Remove reminder 1', exact: true }).click();
  await page.getByRole('button', { name: 'Create booking', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'NO-REMINDERS', exact: true })).toBeVisible();
  const saved = await (await context.request.get(`${customerEndpoint()}/bookings/${new URL(page.url()).pathname.split('/').at(-1)}`)).json();
  expect(saved.instalments).toEqual([]);
});

test('the reminder list restores its draft and fits a narrow screen without extra planner controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await startBooking(page, 'MOBILE-REMINDERS');
  await page.getByLabel('Amount (GBP)', { exact: true }).fill('350.00');
  await page.getByLabel('Due date 1', { exact: true }).fill('2099-01-01');
  await page.getByRole('button', { name: 'Add reminder', exact: true }).click();
  await page.getByLabel('Amount (GBP)', { exact: true }).nth(1).fill('350.00');
  await page.getByLabel('Due date 2', { exact: true }).fill('2099-02-01');
  await page.reload();
  await expect(page.getByLabel('Amount (GBP)', { exact: true })).toHaveCount(2);
  await expect(page.getByLabel('Amount (GBP)', { exact: true }).nth(0)).toHaveValue('350.00');
  await expect(page.getByLabel('Amount (GBP)', { exact: true }).nth(1)).toHaveValue('350.00');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.getByRole('group', { name: 'Payment reminders', exact: true }).screenshot({ path: '.local/e2e/simple-reminders-mobile.png' });
});
