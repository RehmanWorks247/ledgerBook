import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { authenticateFixture } from './session-fixture';

let seed: { orgId: string; customerId: string; secondCustomerId: string };
test.beforeAll(async () => { seed = JSON.parse(await readFile('.local/e2e/seed.json', 'utf8')); });
test.beforeEach(async ({ context }) => {
  await authenticateFixture(context);
  await context.addInitScript(() => localStorage.setItem('e2e-email', 'admin@example.test'));
  await context.route('**/api/auth/config', route => route.fulfill({ json: { provider: 'clerk', publishableKey: 'isolated-test-only' } }));
});
const createPath = (customerId: string) => `/o/${seed.orgId}/customers/${customerId}/bookings/new`;
async function fillBooking(page: Page, reference: string) {
  await page.getByLabel('Booking reference', { exact: true }).fill(reference);
  await page.getByLabel(/^Departure \(/).fill('2026-12-20T10:30');
  await page.getByLabel('Booking total (GBP)', { exact: true }).fill('500.00');
  await page.getByLabel('Charge effective date').fill('2026-11-09');
}

test('booking drafts survive refresh and navigation, keep the customer, and clear on discard or successful creation', async ({ page, context }) => {
  const account = await (await context.request.get(`/api/organizations/${seed.orgId}/customers/${seed.customerId}`)).json();
  await page.goto(`/o/${seed.orgId}/bookings/new`);
  await page.getByRole('combobox', { name: 'Customer name or ID' }).fill(account.customer_code);
  await page.getByRole('option').filter({ hasText: account.customer_code }).click();
  await expect(page).toHaveURL(createPath(seed.customerId));
  await fillBooking(page, 'REFRESH-DRAFT');
  await page.getByRole('checkbox', { name: 'Flight Tickets', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Makkah Hotel', exact: true }).check();
  await page.getByRole('button', { name: 'Add instalment', exact: true }).click();
  await page.getByLabel('Due date 1', { exact: true }).fill('2026-12-01');
  await page.getByLabel('Amount (GBP)', { exact: true }).fill('250.00');
  await page.getByRole('button', { name: 'Add instalment', exact: true }).click();
  await page.getByLabel('Due date 2', { exact: true }).fill('2026-12-15');
  await page.getByLabel('Amount (GBP)', { exact: true }).nth(1).fill('245.00');
  await page.reload();
  await expect(page.getByText('Draft restored. Changes are saved automatically on this device.')).toBeVisible();
  await expect(page.getByLabel('Booking reference', { exact: true })).toHaveValue('REFRESH-DRAFT');
  await expect(page.getByLabel(/^Departure \(/)).toHaveValue('2026-12-20T10:30');
  await expect(page.getByLabel('Booking total (GBP)', { exact: true })).toHaveValue('500.00');
  await expect(page.getByLabel('Charge effective date')).toHaveValue('2026-11-09');
  await expect(page.getByRole('checkbox', { name: 'Flight Tickets', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Makkah Hotel', exact: true })).toBeChecked();
  await expect(page.getByLabel('Due date 1', { exact: true })).toHaveValue('2026-12-01');
  await expect(page.getByLabel('Due date 2', { exact: true })).toHaveValue('2026-12-15');
  await expect(page.getByLabel('Amount (GBP)', { exact: true }).nth(0)).toHaveValue('250.00');
  await expect(page.getByLabel('Amount (GBP)', { exact: true }).nth(1)).toHaveValue('245.00');
  await page.goto(createPath(seed.secondCustomerId));
  await expect(page.getByLabel('Booking reference', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Amount (GBP)', { exact: true })).toHaveCount(0);
  await page.goto(createPath(seed.customerId));
  await expect(page.getByLabel('Booking reference', { exact: true })).toHaveValue('REFRESH-DRAFT');
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await page.reload();
  await expect(page.getByLabel('Booking reference', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Amount (GBP)', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Makkah Hotel', exact: true })).not.toBeChecked();
  await fillBooking(page, 'SAVED-DRAFT');
  await page.getByRole('button', { name: 'Create booking', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'SAVED-DRAFT', exact: true })).toBeVisible();
  await page.goto(createPath(seed.customerId));
  await expect(page.getByLabel('Booking reference', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Booking total (GBP)', { exact: true })).toHaveValue('');
});

test('a refreshed draft retries a lost successful response without creating a duplicate booking', async ({ page, context }) => {
  await page.goto(createPath(seed.customerId));
  await fillBooking(page, 'LOST-RESPONSE-DRAFT');
  const endpoint = `/api/organizations/${seed.orgId}/customers/${seed.customerId}/bookings`;
  let committedId = '';
  await page.route(`**${endpoint}`, async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    committedId = (await response.json()).id;
    await route.abort('failed');
  }, { times: 1 });
  await page.getByRole('button', { name: 'Create booking', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(committedId).not.toBe('');
  await page.reload();
  await expect(page.getByLabel('Booking reference', { exact: true })).toHaveValue('LOST-RESPONSE-DRAFT');
  await page.getByRole('button', { name: 'Create booking', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'LOST-RESPONSE-DRAFT', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname.endsWith(`/${committedId}`)).toBe(true);
  const listing = await (await context.request.get(endpoint)).json();
  expect(listing.items.filter((item: { reference: string }) => item.reference === 'LOST-RESPONSE-DRAFT')).toHaveLength(1);
});
