import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { authenticateFixture } from './session-fixture';

let seed: { orgId: string; customerId: string; secondCustomerId: string };
let draftCustomerId: string;
test.beforeAll(async () => { seed = JSON.parse(await readFile('.local/e2e/seed.json', 'utf8')); });
test.beforeEach(async ({ context }) => {
  await authenticateFixture(context);
  await context.addInitScript(() => localStorage.setItem('e2e-email', 'admin@example.test'));
  await context.route('**/api/auth/config', route => route.fulfill({ json: { provider: 'clerk', publishableKey: 'isolated-test-only' } }));
  // Draft submissions must not change balances used by the shared customer workflows.
  const customer = await context.request.post(`/api/organizations/${seed.orgId}/customers`, {
    headers: { Origin: 'http://127.0.0.1:4312', 'X-CSRF-Protection': '1' },
    data: { name: 'Booking draft browser fixture', email: `draft-${randomUUID()}@example.test`, idempotency_key: randomUUID() },
  });
  expect(customer.status(), await customer.text()).toBe(201);
  draftCustomerId = (await customer.json()).id;
});
const createPath = (customerId: string) => `/o/${seed.orgId}/customers/${customerId}/bookings/new`;
async function fillBooking(page: Page, reference: string) {
  await page.getByLabel('Booking reference', { exact: true }).fill(reference);
  await page.getByLabel(/^Departure \(/).fill('2026-12-20T10:30');
  await page.getByLabel('Booking total (GBP)', { exact: true }).fill('500.00');
  await page.getByLabel('Charge effective date').fill('2026-11-09');
}

test('booking drafts survive refresh and navigation, keep the customer, and clear on discard or successful creation', async ({ page, context }) => {
  const account = await (await context.request.get(`/api/organizations/${seed.orgId}/customers/${draftCustomerId}`)).json();
  await page.goto(`/o/${seed.orgId}/bookings/new`);
  await page.getByRole('combobox', { name: 'Customer name or ID' }).fill(account.customer_code);
  await page.getByRole('option').filter({ hasText: account.customer_code }).click();
  await expect(page).toHaveURL(createPath(draftCustomerId));
  await fillBooking(page, 'REFRESH-DRAFT');
  await page.getByRole('checkbox', { name: 'Flight Tickets', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Makkah Hotel', exact: true }).check();
  await page.getByLabel('Due date 1', { exact: true }).fill('2026-12-01');
  await page.getByLabel('Amount (GBP)', { exact: true }).fill('250.00');
  await page.getByRole('button', { name: 'Add reminder', exact: true }).click();
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
  await expect(page.getByLabel('Amount (GBP)', { exact: true })).toHaveValue('');
  await page.goto(createPath(draftCustomerId));
  await expect(page.getByLabel('Booking reference', { exact: true })).toHaveValue('REFRESH-DRAFT');
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await page.reload();
  await expect(page.getByLabel('Booking reference', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Amount (GBP)', { exact: true })).toHaveValue('');
  await expect(page.getByRole('checkbox', { name: 'Makkah Hotel', exact: true })).not.toBeChecked();
  await fillBooking(page, 'SAVED-DRAFT');
  await page.getByRole('button', { name: 'Create booking', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'SAVED-DRAFT', exact: true })).toBeVisible();
  await page.goto(createPath(draftCustomerId));
  await expect(page.getByLabel('Booking reference', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Booking total (GBP)', { exact: true })).toHaveValue('');
});

test('a refreshed draft retries a lost successful response without creating a duplicate booking', async ({ page, context }) => {
  await page.goto(createPath(draftCustomerId));
  await fillBooking(page, 'LOST-RESPONSE-DRAFT');
  const endpoint = `/api/organizations/${seed.orgId}/customers/${draftCustomerId}/bookings`;
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

test('an attempted legacy draft asks to check the existing booking without replaying old financial actions', async ({ page, context }) => {
  const reference = 'LEGACY-LOST-RESPONSE-DRAFT';
  await page.goto(createPath(draftCustomerId));
  await fillBooking(page, reference);
  const endpoint = `/api/organizations/${seed.orgId}/customers/${draftCustomerId}/bookings`;
  // This is the previous release's exact request shape, before remaining-balance plans.
  const payload = {
    reference, departure_at: '2026-12-20T05:30:00.000Z', amount: '500.00', effective_date: '2026-11-09', required_services: [],
    instalment_total: '600.00', instalments: [{ due_date: '2026-12-01', amount: '300.00' }, { due_date: '2026-12-15', amount: '300.00' }],
  };
  const idempotencyKey = randomUUID();
  const response = await context.request.post(endpoint, {
    headers: { Origin: 'http://127.0.0.1:4312', 'X-CSRF-Protection': '1' }, data: { ...payload, idempotency_key: idempotencyKey },
  });
  expect(response.status(), await response.text()).toBe(201);
  const created = await response.json();
  await page.evaluate(({ customerId, payload, idempotencyKey }) => {
    const key = Object.keys(localStorage).find(key => key.startsWith('ledgerbook:booking-draft:v1:') && key.includes(customerId));
    if (!key) throw new Error('Expected the synthetic customer booking draft');
    const draft = JSON.parse(localStorage.getItem(key)!);
    draft.fields.instalmentTotal = payload.instalment_total;
    draft.fields.instalmentMode = 'manual';
    draft.fields.instalments = payload.instalments.map(row => ({ ...row, key: crypto.randomUUID() }));
    delete draft.fields.existingPaymentEntryIds;
    draft.submission = { payload: JSON.stringify(payload), key: idempotencyKey };
    localStorage.setItem(key, JSON.stringify(draft));
  }, { customerId: draftCustomerId, payload, idempotencyKey });
  await page.reload();
  await expect(page.getByText('Draft restored. Changes are saved automatically on this device.')).toBeVisible();
  await expect(page.getByLabel('Instalment calculation total (GBP)', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('previous submission');
  await expect(page.getByRole('button', { name: 'Create booking', exact: true })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Check the customer’s bookings', exact: true })).toBeVisible();
  const listing = await (await context.request.get(endpoint)).json();
  expect(listing.items.filter((item: { reference: string }) => item.reference === reference)).toHaveLength(1);
  const restored = await (await context.request.get(`${endpoint}/${created.id}`)).json();
  expect(restored.total_minor).toBe('50000');
  expect(restored.instalment_total_minor).toBe('60000');
});
