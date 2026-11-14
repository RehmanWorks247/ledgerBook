import { test, expect, type BrowserContext } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { authenticateFixture } from './session-fixture';

const origin = 'http://127.0.0.1:4312';
const headers = { Origin: origin, 'X-CSRF-Protection': '1' };
let seed: { orgId: string; customerId: string };
test.beforeAll(async () => { seed = JSON.parse(await readFile('.local/e2e/seed.json', 'utf8')); });

async function authenticate(context: BrowserContext, email = 'admin@example.test') {
  await authenticateFixture(context, email);
  await context.addInitScript(value => localStorage.setItem('e2e-email', value), email);
  await context.route('**/api/auth/config', route => route.fulfill({ json: { provider: 'clerk', publishableKey: 'isolated-test-only' } }));
}

async function createBooking(context: BrowserContext, paid = false, customerId = seed.customerId) {
  const path = `/api/organizations/${seed.orgId}/customers/${customerId}/bookings`;
  const response = await context.request.post(path, {
    headers,
    data: {
      reference: `HISTORY-${randomUUID().slice(0, 8)}`, departure_at: '2099-12-20T10:30:00Z',
      amount: '100.00', instalment_total: '100.00', effective_date: '2020-01-01', required_services: [], idempotency_key: randomUUID(),
      instalments: [
        { due_date: '2020-01-01', amount: '40.00', ...(paid ? { paid: true, paid_date: '2020-01-01' } : {}) },
        { due_date: '2099-01-01', amount: '60.00' },
      ],
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const booking = await response.json() as { id: string; reference: string };
  return { ...booking, apiPath: `${path}/${booking.id}`, pagePath: `/o/${seed.orgId}/users/${customerId}/bookings/${booking.id}` };
}

test('admin corrects an advance, trashes, restores and permanently deletes payment history without duplicate credit', async ({ page, context }) => {
  await authenticate(context);
  const customerResponse = await context.request.post(`/api/organizations/${seed.orgId}/customers`, {
    headers, data: { name: 'Payment history fixture', email: `history-${randomUUID()}@example.test`, idempotency_key: randomUUID() },
  });
  expect(customerResponse.status(), await customerResponse.text()).toBe(201);
  const booking = await createBooking(context, true, (await customerResponse.json()).id);
  async function expectPaid(paid: string, remaining: string) {
    await expect.poll(async () => {
      const response = await context.request.get(booking.apiPath);
      const result = await response.json();
      return [result.paid_minor, result.remaining_minor];
    }).toEqual([paid, remaining]);
  }
  await page.goto(booking.pagePath);
  const history = page.getByRole('region', { name: 'Payment history', exact: true });
  await history.getByRole('button', { name: /^View details for payment / }).click();
  let dialog = page.getByRole('dialog', { name: 'Payment details', exact: true });
  await dialog.getByRole('button', { name: 'Edit payment', exact: true }).click();
  await expect(dialog).toContainText('reverses the original ledger payment');
  await dialog.getByLabel('Payment amount (GBP)', { exact: true }).fill('45.00');
  await dialog.getByLabel('Payment date', { exact: true }).fill('2020-01-02');
  await dialog.getByLabel('Payment note', { exact: true }).fill('Corrected advance transfer');
  await dialog.getByLabel('Reason for change', { exact: true }).fill('Actual transfer was forty-five pounds');
  // Simulate another admin editing the record after this dialog opened.
  const listed = await context.request.get(`${booking.apiPath}/payments`);
  const currentPayment = (await listed.json()).items[0];
  const concurrent = await context.request.patch(`${booking.apiPath}/payments/${currentPayment.id}`, {
    headers, data: { version: currentPayment.version, amount: '40.00', payment_date: '2020-01-01', note: 'Checked by another administrator', reason: 'Second administrator review' },
  });
  expect(concurrent.ok(), await concurrent.text()).toBe(true);
  await dialog.getByRole('button', { name: 'Save payment changes', exact: true }).click();
  await expect(dialog).toContainText('Close and refresh the history');
  await dialog.getByRole('button', { name: 'Close and refresh history', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expectPaid('4000', '6000');
  await expect(history).toContainText('Checked by another administrator');
  await history.getByRole('button', { name: /^View details for payment / }).click();
  dialog = page.getByRole('dialog', { name: 'Payment details', exact: true });
  await dialog.getByRole('button', { name: 'Edit payment', exact: true }).click();
  await dialog.getByLabel('Payment amount (GBP)', { exact: true }).fill('45.00');
  await dialog.getByLabel('Payment date', { exact: true }).fill('2020-01-02');
  await dialog.getByLabel('Payment note', { exact: true }).fill('Corrected advance transfer');
  await dialog.getByLabel('Reason for change', { exact: true }).fill('Actual transfer was forty-five pounds');
  await dialog.getByRole('button', { name: 'Save payment changes', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(history).toContainText('Payment updated.');
  await expectPaid('4500', '5500');
  await expect(history).toContainText('GBP 45.00');

  await history.getByRole('button', { name: /^View details for payment / }).click();
  dialog = page.getByRole('dialog', { name: 'Payment details', exact: true });
  await dialog.getByRole('button', { name: 'Move to trash', exact: true }).click();
  await dialog.getByLabel('Reason for deletion', { exact: true }).fill('Temporarily remove duplicate record');
  await dialog.getByRole('button', { name: 'Move payment to trash', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(history).toContainText('No payments yet');
  await expectPaid('0', '10000');
  await history.getByRole('button', { name: 'Trash', exact: true }).click();
  await expect(history).toContainText('In trash');
  await history.getByRole('button', { name: /^View details for payment / }).click();
  dialog = page.getByRole('dialog', { name: 'Payment details', exact: true });
  await expect(dialog.getByRole('button', { name: 'Edit payment', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Restore payment', exact: true }).click();
  await dialog.getByLabel('Reason for restoration', { exact: true }).fill('Confirmed this transfer is valid');
  await dialog.getByRole('button', { name: 'Restore payment', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(history).toContainText('Payment trash is empty');
  await expectPaid('4500', '5500');

  await history.getByRole('button', { name: 'Payment history', exact: true }).click();
  await history.getByRole('button', { name: /^View details for payment / }).click();
  dialog = page.getByRole('dialog', { name: 'Payment details', exact: true });
  await dialog.getByRole('button', { name: 'Move to trash', exact: true }).click();
  await dialog.getByLabel('Reason for deletion', { exact: true }).fill('Remove test record permanently');
  await dialog.getByRole('button', { name: 'Move payment to trash', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expectPaid('0', '10000');
  // Trash is also available centrally, so admins can find and manage deleted records.
  await page.goto(`/o/${seed.orgId}/payment-reviews?deleted=deleted&status=all&q=${booking.reference}`);
  await expect(page.getByRole('button', { name: 'Trash', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /^View details for payment / }).click();
  dialog = page.getByRole('dialog', { name: 'Payment details', exact: true });
  await dialog.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toContainText('ledger entries and audit history remain');
  await dialog.getByLabel('Reason for deletion', { exact: true }).fill('Approved permanent removal');
  await expect(dialog.getByRole('button', { name: 'Delete payment permanently', exact: true })).toBeDisabled();
  await dialog.getByLabel('Type DELETE to confirm', { exact: true }).fill('DELETE');
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: '.local/e2e/payment-history-trash-mobile.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Delete payment permanently', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^View details for payment / })).toHaveCount(0);
  await expectPaid('0', '10000');
  const payments = await context.request.get(`${booking.apiPath}/payments?deleted=deleted`);
  expect((await payments.json()).items).toHaveLength(0);
});

test('a customer selects one of two invoices from My Account and approval credits that booking and account exactly once', async ({ page, context, browser }) => {
  await authenticate(context);
  const customerPath = `/api/organizations/${seed.orgId}/customers/${seed.customerId}`;
  const baseline = await (await context.request.get(`${customerPath}/statement`)).json();
  const bookings = [await createBooking(context), await createBooking(context)];
  const selectedBooking = bookings[0];
  const bookingPayments = `${selectedBooking.apiPath}/payments`;
  const note = `Account transfer ${randomUUID()}`;
  const customerContext = await browser.newContext({ baseURL: origin });
  let paymentEntryId: string | null = null;
  const format = (minor: string) => `GBP ${(Number(minor) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  try {
    await authenticate(customerContext, 'customer@example.test');
    const customer = await customerContext.newPage();
    await customer.setViewportSize({ width: 390, height: 844 });
    await customer.goto(`/o/${seed.orgId}`);
    const totals = customer.getByLabel('Account totals', { exact: true });
    const outstanding = totals.locator('article').filter({ hasText: 'Outstanding balance' }).locator('strong');
    const beforePayment = (BigInt(baseline.current_balance_minor) + 20000n).toString();
    const afterPayment = (BigInt(beforePayment) - 10000n).toString();
    await expect(outstanding).toHaveText(format(beforePayment));
    const pay = customer.getByRole('button', { name: 'Make a payment', exact: true });
    const accountDetails = customer.getByRole('region', { name: 'Account details', exact: true });
    const payBox = await pay.boundingBox();
    const detailsBox = await accountDetails.boundingBox();
    expect(payBox!.y).toBeLessThan(detailsBox!.y);
    await expect(customer.getByRole('form', { name: 'Submit account payment', exact: true })).toHaveCount(0);
    await pay.click();
    await expect(customer.getByLabel('Amount paid (GBP)', { exact: true })).toBeFocused();
    const form = customer.getByRole('form', { name: 'Submit account payment', exact: true });
    await expect(form).toContainText('Receipt files are optional');
    const invoices = await (await customerContext.request.get(`${customerPath}/invoices/outstanding`)).json();
    const invoice = invoices.invoices.find((item: { booking_id: string }) => item.booking_id === selectedBooking.id);
    expect(invoice).toBeDefined();
    await form.getByRole('combobox', { name: 'Invoice to pay' }).selectOption(invoice.id);
    expect(await customer.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await form.getByLabel('Amount paid (GBP)', { exact: true }).fill('100.00');
    await form.getByLabel('Payment date', { exact: true }).fill('2020-01-01');
    await form.getByLabel('Payment note').fill(note);
    const submissionResponse = customer.waitForResponse(response => response.url() === `${origin}${bookingPayments}` && response.request().method() === 'POST');
    await form.getByRole('button', { name: 'Submit payment for review', exact: true }).click();
    const submission = await submissionResponse;
    expect(submission.status(), await submission.text()).toBe(201);
    const payment = await submission.json();
    expect(payment.booking_id).toBe(selectedBooking.id);
    expect(payment.invoice_id).toBe(invoice.id);
    expect(payment.status).toBe('pending');
    await expect(customer.getByText('Payment submitted for review.', { exact: false })).toBeVisible();
    await expect(form).toHaveCount(0);
    await expect(outstanding).toHaveText(format(beforePayment));
    const history = customer.getByRole('region', { name: 'Payment history', exact: true });
    const paymentCard = history.getByRole('article').filter({ hasText: note });
    await expect(paymentCard).toContainText(/pending/i);
    await paymentCard.getByRole('button', { name: 'View payment', exact: true }).click();
    await expect(customer.getByRole('button', { name: 'Edit payment', exact: true })).toHaveCount(0);
    await expect(customer.getByRole('button', { name: 'Move to trash', exact: true })).toHaveCount(0);
    await expect(customer.getByRole('button', { name: 'Trash', exact: true })).toHaveCount(0);
    await customer.keyboard.press('Escape');

    await page.goto(`/o/${seed.orgId}/payment-reviews?q=${encodeURIComponent(note)}`);
    await expect(page.getByRole('region', { name: 'Payment review queue', exact: true })).toContainText(selectedBooking.reference);
    await page.getByRole('button', { name: /^Review payment / }).click();
    const dialog = page.getByRole('dialog', { name: 'Review payment', exact: true });
    await dialog.getByRole('button', { name: 'Approve payment', exact: true }).click();
    await dialog.getByLabel('I have verified independently that the money was received.', { exact: true }).check();
    const approvalResponse = page.waitForResponse(response => response.url() === `${origin}${bookingPayments}/${payment.id}/approve` && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Confirm approval', exact: true }).click();
    const approval = await approvalResponse;
    expect(approval.status(), await approval.text()).toBe(201);
    paymentEntryId = (await approval.json()).ledger_entry_id;
    await expect(dialog).toHaveCount(0);
    const repeated = await context.request.post(`${bookingPayments}/${payment.id}/approve`, { headers });
    expect(repeated.ok(), await repeated.text()).toBe(true);
    expect((await repeated.json()).ledger_entry_id).toBe(paymentEntryId);

    await customer.reload();
    await expect(outstanding).toHaveText(format(afterPayment));
    await expect(paymentCard).toContainText(/approved/i);
    const statement = await (await customerContext.request.get(`${customerPath}/statement`)).json();
    expect(statement.current_balance_minor).toBe(afterPayment);
    expect(statement.total_paid_minor).toBe((BigInt(baseline.total_paid_minor) + 10000n).toString());
    for (const booking of bookings) {
      const result = await (await customerContext.request.get(booking.apiPath)).json();
      expect(result.paid_minor).toBe(booking.id === selectedBooking.id ? '10000' : '0');
      expect(result.remaining_minor).toBe(booking.id === selectedBooking.id ? '0' : '10000');
    }
    await customer.screenshot({ path: '.local/e2e/account-payment-mobile.png', fullPage: true });
  } finally {
    for (const booking of bookings) {
      const current = await context.request.get(booking.apiPath);
      if (current.ok()) {
        const response = await context.request.delete(booking.apiPath, {
          headers, data: { confirmation: booking.reference, reason: 'Clean up account payment browser fixture',
            effective_date: '2020-01-01', expected_version: (await current.json()).version, idempotency_key: randomUUID() },
        });
        expect(response.status(), await response.text()).toBe(200);
      }
    }
    if (paymentEntryId) {
      const reversal = await context.request.post(`${customerPath}/entries`, {
        headers, data: { kind: 'reversal', reversal_of: paymentEntryId, effective_date: '2020-01-01',
          description: 'Restore account payment browser fixture balance', idempotency_key: randomUUID() },
      });
      expect(reversal.status(), await reversal.text()).toBe(201);
    }
    await customerContext.close();
  }
});
