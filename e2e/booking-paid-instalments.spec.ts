import { test, expect, type BrowserContext, type Page } from '@playwright/test';
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
    headers, data: { name: 'Payment reminders fixture', email: `reminder-payments-${randomUUID()}@example.test`, idempotency_key: randomUUID() },
  });
  expect(response.status(), await response.text()).toBe(201);
  customerId = (await response.json()).id;
});
const customerEndpoint = () => `/api/organizations/${seed.orgId}/customers/${customerId}`;
async function statement(context: BrowserContext) {
  const response = await context.request.get(`${customerEndpoint()}/statement`);
  expect(response.ok()).toBe(true);
  return await response.json() as { entries: { id: string; kind: string; amount_minor: string }[]; total_paid_minor: string };
}
async function recordPayment(page: Page, amount: string) {
  await page.getByRole('button', { name: 'Record payment', exact: true }).click();
  const form = page.getByRole('form', { name: 'Record booking payment', exact: true });
  await form.getByLabel('Amount received (GBP)', { exact: true }).fill(amount);
  await form.getByLabel(/^Date received/).fill('2020-01-05');
  await form.getByRole('button', { name: 'Record payment', exact: true }).click();
  await expect(form).toHaveCount(0);
}

test('past payments survive conversion; a current payment reduces reminders once and full payment stops them', async ({ page, context }) => {
  // Existing saved data from the old installment interface must remain usable.
  const createdResponse = await context.request.post(`${customerEndpoint()}/bookings`, { headers, data: {
    reference: 'PAST-AND-CURRENT-PAYMENTS', departure_at: '2099-12-20T10:30:00+00:00', required_services: [],
    amount: '1000.00', effective_date: '2020-01-01', idempotency_key: randomUUID(),
    instalments: [
      { due_date: '2020-01-01', amount: '300.00', paid: true, paid_date: '2020-01-01' },
      { due_date: '2020-01-02', amount: '350.00' }, { due_date: '2099-02-01', amount: '350.00' },
    ],
  } });
  expect(createdResponse.status(), await createdResponse.text()).toBe(201);
  const created = await createdResponse.json();
  const endpoint = `${customerEndpoint()}/bookings/${created.id}`;
  const originalEntries = (await statement(context)).entries;
  await page.goto(`/o/${seed.orgId}/users/${customerId}/bookings/${created.id}`);
  await page.getByRole('button', { name: 'Edit booking', exact: true }).click();
  const edit = page.getByRole('form', { name: 'Edit booking', exact: true });
  await expect(edit.getByLabel('Amount (GBP)', { exact: true })).toHaveCount(2);
  await expect(edit.getByLabel('Amount (GBP)', { exact: true }).nth(0)).toHaveValue('350.00');
  await expect(edit.getByRole('checkbox', { name: /Paid instalment/ })).toHaveCount(0);
  await edit.getByLabel('Reason for change').fill('Use simple payment reminders');
  await edit.getByRole('button', { name: 'Save booking', exact: true }).click();
  await expect(edit).toHaveCount(0);
  expect((await statement(context)).entries).toEqual(originalEntries);
  await recordPayment(page, '200.00');
  await expect.poll(async () => (await (await context.request.get(endpoint)).json()).paid_minor).toBe('50000');
  await page.reload();
  let booking = await (await context.request.get(endpoint)).json();
  expect(booking.remaining_minor).toBe('50000');
  expect(booking.instalments.filter((row: { paid: boolean }) => !row.paid).map((row: { remaining_minor: string }) => row.remaining_minor)).toEqual(['15000', '35000']);
  const reminderSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Payment reminders', exact: true }) });
  await expect(reminderSection).toContainText('GBP 150.00');
  await expect(reminderSection).toContainText('GBP 350.00');
  expect((await statement(context)).entries.filter(entry => entry.kind === 'payment')).toHaveLength(2);

  // Saving outstanding reminders again must not deduct the £500 a second time.
  await page.getByRole('button', { name: 'Edit booking', exact: true }).click();
  await expect(edit.getByLabel('Amount (GBP)', { exact: true }).nth(0)).toHaveValue('150.00');
  await edit.getByLabel('Reason for change').fill('Keep the remaining reminder amounts');
  await edit.getByRole('button', { name: 'Save booking', exact: true }).click();
  await expect(edit).toHaveCount(0);
  booking = await (await context.request.get(endpoint)).json();
  expect(booking.instalments.filter((row: { paid: boolean }) => !row.paid).map((row: { remaining_minor: string }) => row.remaining_minor)).toEqual(['15000', '35000']);
  await recordPayment(page, '500.00');
  await expect.poll(async () => (await (await context.request.get(endpoint)).json()).remaining_minor).toBe('0');
  await page.reload();
  booking = await (await context.request.get(endpoint)).json();
  expect(booking.paid_minor).toBe('100000');
  expect(booking.instalments.filter((row: { paid: boolean }) => !row.paid).every((row: { remaining_minor: string }) => row.remaining_minor === '0')).toBe(true);
  await expect(page.getByRole('heading', { name: 'Payment history', exact: true })).toBeVisible();
  expect((await statement(context)).entries.filter(entry => entry.kind === 'payment')).toHaveLength(3);
});

test('a previously recorded payment links from payment history without posting it again', async ({ page, context }) => {
  const paymentResponse = await context.request.post(`${customerEndpoint()}/entries`, { headers, data: {
    kind: 'payment', amount: '300.00', effective_date: '2020-01-01', description: 'Old bank transfer', idempotency_key: randomUUID(),
  } });
  expect(paymentResponse.status(), await paymentResponse.text()).toBe(201);
  const payment = await paymentResponse.json();
  const response = await context.request.post(`${customerEndpoint()}/bookings`, { headers, data: {
    reference: 'LINK-PAST-PAYMENT', departure_at: '2099-12-20T10:30:00+00:00', required_services: [],
    amount: '1000.00', effective_date: '2020-01-01', schedule_basis: 'reminders',
    instalments: [{ due_date: '2099-01-01', amount: '1000.00' }], idempotency_key: randomUUID(),
  } });
  expect(response.status(), await response.text()).toBe(201);
  const created = await response.json();
  await page.goto(`/o/${seed.orgId}/users/${customerId}/bookings/${created.id}`);
  await page.getByRole('button', { name: 'Use existing payment', exact: true }).click();
  const form = page.getByRole('form', { name: 'Use existing booking payment', exact: true });
  await form.getByRole('combobox', { name: 'Existing payment', exact: true }).selectOption(String(payment.id));
  await form.getByRole('button', { name: 'Use payment', exact: true }).click();
  await expect(form).toHaveCount(0);
  const endpoint = `${customerEndpoint()}/bookings/${created.id}`;
  await expect.poll(async () => (await (await context.request.get(endpoint)).json()).paid_minor).toBe('30000');
  const booking = await (await context.request.get(endpoint)).json();
  expect(booking.remaining_minor).toBe('70000');
  expect(booking.instalments[0].remaining_minor).toBe('70000');
  expect((await statement(context)).entries.filter(entry => entry.kind === 'payment').map(entry => String(entry.id))).toEqual([String(payment.id)]);
  await page.getByRole('button', { name: 'Edit booking', exact: true }).click();
  await page.getByRole('button', { name: 'Remove reminder 1', exact: true }).click();
  await page.getByLabel('Reason for change').fill('Stop reminders while retaining the balance');
  await page.getByRole('button', { name: 'Save booking', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Edit booking', exact: true })).toHaveCount(0);
  const updated = await (await context.request.get(endpoint)).json();
  expect(updated.paid_minor).toBe('30000');
  expect(updated.remaining_minor).toBe('70000');
  expect((await statement(context)).entries.filter(entry => entry.kind === 'payment')).toHaveLength(1);
});

test('a payment received while editing preserves the draft and rejects its stale payment snapshot', async ({ page, context }) => {
  const response = await context.request.post(`${customerEndpoint()}/bookings`, { headers, data: {
    reference: 'PAYMENT-WHILE-EDITING', departure_at: '2099-12-20T10:30:00+00:00', required_services: [],
    amount: '1000.00', effective_date: '2020-01-01', schedule_basis: 'reminders',
    instalments: [{ due_date: '2099-01-01', amount: '1000.00' }], idempotency_key: randomUUID(),
  } });
  expect(response.status(), await response.text()).toBe(201);
  const booking = await response.json();
  const endpoint = `${customerEndpoint()}/bookings/${booking.id}`;
  await page.goto(`/o/${seed.orgId}/users/${customerId}/bookings/${booking.id}`);
  await page.getByRole('button', { name: 'Edit booking', exact: true }).click();
  const edit = page.getByRole('form', { name: 'Edit booking', exact: true });
  await edit.getByLabel('Amount (GBP)', { exact: true }).fill('800.00');
  await edit.getByLabel('Reason for change').fill('Reduce the reminder');
  await recordPayment(page, '100.00');
  await expect(edit.getByLabel('Amount (GBP)', { exact: true })).toHaveValue('800.00');
  await edit.getByRole('button', { name: 'Save booking', exact: true }).click();
  await expect(edit.getByRole('alert')).toContainText(/changed/i);
  await expect(edit.getByLabel('Amount (GBP)', { exact: true })).toHaveValue('800.00');
  const updated = await (await context.request.get(endpoint)).json();
  expect(updated.paid_minor).toBe('10000');
  expect(updated.instalments[0].amount_minor).toBe('100000');
  expect(updated.instalments[0].remaining_minor).toBe('90000');
});
