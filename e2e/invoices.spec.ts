import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

const origin = 'http://127.0.0.1:4312';
const writeHeaders = { Origin: origin, 'X-CSRF-Protection': '1' };
type Seed = { orgId: string; customerId: string };
type Invoice = { id: string; invoice_number: string; version: number; filename: string; total_minor: string; paid_minor: string; balance_minor: string; reason: string };
let seed: Seed;
test.beforeAll(async () => { seed = JSON.parse(await readFile('.local/e2e/seed.json', 'utf8')); });

async function authenticate(context: BrowserContext, email: string) {
  const response = await context.request.post(`${origin}/api/auth/login`, {
    headers: writeHeaders, data: { email, password: 'Test-only password 47!' },
  });
  expect(response.status(), await response.text()).toBe(200);
  await context.addInitScript(value => localStorage.setItem('e2e-email', value), email);
  await context.route('**/api/auth/config', route => route.fulfill({ json: { provider: 'clerk', publishableKey: 'isolated-test-only' } }));
}

async function downloadInvoice(page: Page, history: Locator, invoice: Invoice) {
  const event = page.waitForEvent('download');
  await history.getByRole('button', { name: `Download ${invoice.invoice_number} version ${invoice.version} as PDF`, exact: true }).click();
  const download = await event;
  expect(download.suggestedFilename()).toBe(invoice.filename);
  const bytes = await readFile((await download.path())!);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(bytes.length).toBeGreaterThan(1000);
  expect(bytes.subarray(-30).toString()).toContain('%%EOF');
  return bytes;
}

test('booking invoices download, update after approval, and remain accessible after cancellation', async ({ page, context, browser }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await authenticate(context, 'admin@example.test');
  const reference = `INVOICE-E2E-${randomUUID().slice(0, 8)}`;
  const customerBase = `${origin}/api/organizations/${seed.orgId}/customers/${seed.customerId}`;
  const customerContext = await browser.newContext({ baseURL: origin });
  let bookingId = '';
  let paymentEntryId: string | null = null;
  try {
    await page.goto(`/o/${seed.orgId}/customers/${seed.customerId}/bookings/new`);
    await page.getByLabel('Booking reference', { exact: true }).fill(reference);
    await page.getByLabel(/^Departure \(/).fill('2026-12-20T10:30');
    await page.getByLabel('Booking total (GBP)', { exact: true }).fill('500.00');
    await page.getByLabel('Charge effective date').fill('2026-11-09');
    await page.getByRole('button', { name: 'Create booking', exact: true }).click();
    await expect(page.getByRole('heading', { name: reference, exact: true })).toBeVisible();
    const bookingPath = new URL(page.url()).pathname;
    bookingId = bookingPath.split('/').at(-1)!;
    const bookingBase = `${customerBase}/bookings/${bookingId}`;
    const invoiceHistory = page.getByRole('region', { name: 'Invoice history', exact: true });
    const rows = invoiceHistory.locator('tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Version 1 · Latest');
    await expect(rows.first()).toContainText('Booking created');
    await expect(rows.first().getByRole('cell').nth(3)).toHaveText('GBP 0.00');
    await expect(rows.first().getByRole('cell').nth(4)).toHaveText('GBP 500.00');
    const originalHistory = await context.request.get(`${bookingBase}/invoices`);
    expect(originalHistory.status(), await originalHistory.text()).toBe(200);
    const initial = (await originalHistory.json()).invoices[0] as Invoice;
    const originalPdf = await downloadInvoice(page, invoiceHistory, initial);

    await authenticate(customerContext, 'customer@example.test');
    const receipt = await sharp({ create: { width: 30, height: 30, channels: 3, background: '#118833' } }).png().toBuffer();
    const submission = await customerContext.request.post(`${bookingBase}/payments`, {
      headers: writeHeaders,
      multipart: { amount: '125.00', payment_date: '2026-11-09', note: 'Invoice browser test transfer', idempotency_key: randomUUID(),
        receipts: { name: 'invoice-receipt.png', mimeType: 'image/png', buffer: receipt } },
    });
    expect(submission.status(), await submission.text()).toBe(201);
    const payment = await submission.json();
    await page.getByRole('button', { name: 'Refresh payment submissions', exact: true }).click();
    await page.getByRole('button', { name: /^Review payment / }).click();
    await expect(rows).toHaveCount(1, { timeout: 1000 });
    await page.getByRole('button', { name: 'Approve payment', exact: true }).click();
    await page.getByLabel('I have checked the receipts and verified that the money was received.').check();
    const approvalResponse = page.waitForResponse(response => response.url() === `${bookingBase}/payments/${payment.id}/approve` && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Confirm approval', exact: true }).click();
    const approval = await approvalResponse;
    expect(approval.status(), await approval.text()).toBe(201);
    paymentEntryId = (await approval.json()).ledger_entry_id;
    await expect(page.getByText('Payment approved and recorded.', { exact: false })).toBeVisible();
    // No page reload: the approval callback must refresh invoice history itself.
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('Version 2 · Latest');
    await expect(rows.first()).toContainText('Payment approved');
    await expect(rows.first().getByRole('cell').nth(3)).toHaveText('GBP 125.00');
    await expect(rows.first().getByRole('cell').nth(4)).toHaveText('GBP 375.00');
    await expect(rows.nth(1).getByRole('cell').nth(4)).toHaveText('GBP 500.00');
    const approvedHistory = (await (await context.request.get(`${bookingBase}/invoices`)).json()).invoices as Invoice[];
    expect(approvedHistory.map(item => item.version)).toEqual([2, 1]);
    expect(await downloadInvoice(page, invoiceHistory, approvedHistory[1])).toEqual(originalPdf);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await invoiceHistory.screenshot({ path: '.local/invoice-history.png' });

    const customer = await customerContext.newPage();
    customer.on('pageerror', error => errors.push(error.message));
    await customer.goto(bookingPath);
    const customerHistory = customer.getByRole('region', { name: 'Invoice history', exact: true });
    await expect(customerHistory.locator('tbody tr')).toHaveCount(2);
    await expect(customer.getByRole('button', { name: 'Edit booking', exact: true })).toHaveCount(0);
    const approvedPdf = await downloadInvoice(customer, customerHistory, approvedHistory[0]);
    expect(approvedPdf.equals(originalPdf)).toBe(false);
    await customer.setViewportSize({ width: 390, height: 844 });
    const viewport = await customer.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(viewport.scrollWidth, JSON.stringify(viewport)).toBeLessThanOrEqual(viewport.width + 1);

    await page.getByRole('button', { name: 'Cancel booking', exact: true }).click();
    const cancellation = page.getByRole('form', { name: 'Cancel booking', exact: true });
    await cancellation.getByLabel('Cancellation reason').fill('Invoice history should remain available after cancellation.');
    await cancellation.getByLabel(`Type ${reference} to confirm`).fill(reference);
    await cancellation.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
    await expect(page).toHaveURL(`/o/${seed.orgId}/users/${seed.customerId}`);
    const bookings = page.getByRole('region', { name: 'Customer bookings', exact: true });
    await expect(bookings.getByRole('row').filter({ hasText: reference })).toHaveCount(0);
    await bookings.getByRole('combobox', { name: 'Booking status', exact: true }).selectOption('all');
    const cancelledBooking = bookings.getByRole('row').filter({ hasText: reference });
    await expect(cancelledBooking).toContainText('cancelled');
    await cancelledBooking.getByRole('link', { name: 'Invoice history', exact: true }).click();
    await expect(page).toHaveURL(`${bookingPath}/invoices`);
    await expect(page.getByRole('heading', { name: 'Booking invoices', exact: true })).toBeVisible();
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText('Booking cancelled');
    await expect(rows.first().getByRole('cell').nth(2)).toHaveText('GBP 0.00');
    await expect(rows.first().getByRole('cell').nth(4)).toContainText('−GBP 125.00');
    const cancelledHistory = (await (await context.request.get(`${bookingBase}/invoices`)).json()).invoices as Invoice[];
    expect(cancelledHistory.map(item => item.version)).toEqual([3, 2, 1]);
    await downloadInvoice(page, invoiceHistory, cancelledHistory[0]);
    expect(await downloadInvoice(page, invoiceHistory, cancelledHistory[2])).toEqual(originalPdf);

    await customer.goto(`${bookingPath}/invoices`);
    await expect(customerHistory.locator('tbody tr')).toHaveCount(3);
    expect(await downloadInvoice(customer, customerHistory, cancelledHistory[1])).toEqual(approvedPdf);
    await expect(page.getByRole('button', { name: 'Cancel booking', exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    // The full browser suite shares its seeded customer. Restore its balance via
    // real audited operations so this scenario does not affect later workflows.
    if (bookingId) {
      const current = await context.request.get(`${customerBase}/bookings/${bookingId}`);
      if (current.ok()) {
        const booking = await current.json();
        const cleanup = await context.request.delete(`${customerBase}/bookings/${bookingId}`, {
          headers: writeHeaders, data: { confirmation: reference, reason: 'Clean up invoice browser fixture',
            effective_date: '2026-11-09', expected_version: booking.version, idempotency_key: randomUUID() },
        });
        expect(cleanup.status(), await cleanup.text()).toBe(200);
      }
      if (paymentEntryId) {
        const reversal = await context.request.post(`${customerBase}/entries`, {
          headers: writeHeaders, data: { kind: 'reversal', reversal_of: paymentEntryId, effective_date: '2026-11-09',
            description: 'Restore invoice browser fixture balance', idempotency_key: randomUUID() },
        });
        expect(reversal.status(), await reversal.text()).toBe(201);
      }
    }
    await customerContext.close();
  }
});
