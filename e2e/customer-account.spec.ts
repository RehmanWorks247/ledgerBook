import { authenticateFixture } from './session-fixture';
import { test, expect, type BrowserContext } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

const origin = 'http://127.0.0.1:4312';
const headers = { Origin: origin, 'X-CSRF-Protection': '1' };
let seed: { orgId: string; customerId: string };
test.beforeAll(async () => { seed = JSON.parse(await readFile('.local/e2e/seed.json', 'utf8')); });

async function authenticate(context: BrowserContext, email: string) {
  await authenticateFixture(context, email);
  await context.addInitScript(value => localStorage.setItem('e2e-email', value), email);
  await context.route('**/api/auth/config', route => route.fulfill({ json: { provider: 'clerk', publishableKey: 'isolated-test-only' } }));
}

test('customers land on My bookings and can open My Account for totals and payments', async ({ page, context, browser }) => {
  const admin = await browser.newContext({ baseURL: origin });
  const customerBase = `${origin}/api/organizations/${seed.orgId}/customers/${seed.customerId}`;
  const root = `/o/${seed.orgId}`;
  const bookings: { id: string; reference: string; cancelled?: boolean }[] = [];
  const paymentEntries: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  async function cancel(booking: typeof bookings[number]) {
    const response = await admin.request.delete(`${customerBase}/bookings/${booking.id}`, {
      headers, data: { confirmation: booking.reference, effective_date: '2026-11-10', expected_version: 1,
        reason: 'Account overview browser test', idempotency_key: randomUUID() },
    });
    expect(response.status(), await response.text()).toBe(200);
    booking.cancelled = true;
  }
  try {
    await authenticate(admin, 'admin@example.test');
    await authenticate(context, 'customer@example.test');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await expect(page).toHaveURL(`${root}/users/${seed.customerId}`);
    const main = page.getByRole('main');
    const navigation = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(main.getByRole('heading', { name: 'My bookings', exact: true })).toBeVisible();
    await expect(navigation.getByRole('link').first()).toHaveText('My bookings');
    await expect(navigation.getByRole('link', { name: 'My bookings', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.goto('/login');
    await expect(page).toHaveURL(`${root}/users/${seed.customerId}`);
    await navigation.getByRole('link', { name: 'My account', exact: true }).click();
    await expect(page).toHaveURL(root);
    await expect(navigation.getByRole('link', { name: 'My account', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(navigation.getByRole('link', { name: 'My bookings', exact: true })).toBeVisible();
    await expect(page.getByText('My files', { exact: true })).toHaveCount(0);
    await expect(main.getByRole('heading', { name: 'Aster Studio', exact: true })).toBeVisible();
    await expect(main.getByRole('region', { name: 'Account details', exact: true })).toContainText('customer@example.test');
    const totals = main.getByLabel('Account totals', { exact: true });
    const total = totals.locator('article').filter({ hasText: 'Total amount' }).locator('strong');
    const paid = totals.locator('article').filter({ hasText: 'Amount paid' }).locator('strong');
    const outstanding = totals.locator('article').filter({ hasText: 'Outstanding balance' }).locator('strong');
    await expect(totals.locator('article')).toHaveCount(3);
    await expect(total).toHaveText('GBP 0.00');
    await expect(paid).toHaveText('GBP 0.00');
    await expect(outstanding).toHaveText('GBP 0.00');
    await expect(totals).toContainText('Nothing left to pay');

    for (const amount of ['500', '750']) {
      const response = await admin.request.post(`${customerBase}/bookings`, {
        headers, data: { reference: `ACCOUNT-${randomUUID().slice(0, 8)}`, amount, effective_date: '2026-11-10',
          departure_at: '2030-01-01T12:00:00Z', required_services: [], idempotency_key: randomUUID() },
      });
      expect(response.status(), await response.text()).toBe(201);
      bookings.push(await response.json());
    }
    for (const [index, amount] of ['125', '75', '50'].entries()) {
      const booking = bookings[index % 2];
      const buffer = await sharp({ create: { width: 16, height: 16, channels: 3, background: ['#118833', '#221188', '#882211'][index] } }).png().toBuffer();
      const submitted = await context.request.post(`${customerBase}/bookings/${booking.id}/payments`, {
        headers, multipart: { amount, payment_date: '2026-11-10', idempotency_key: randomUUID(),
          receipts: { name: 'receipt.png', mimeType: 'image/png', buffer } },
      });
      expect(submitted.status(), await submitted.text()).toBe(201);
      if (index < 2) {
        const payment = await submitted.json();
        const approved = await admin.request.post(`${customerBase}/bookings/${booking.id}/payments/${payment.id}/approve`, { headers });
        expect(approved.status(), await approved.text()).toBe(201);
        paymentEntries.push((await approved.json()).ledger_entry_id);
      }
    }
    await main.getByRole('button', { name: 'Refresh balance', exact: true }).click();
    await expect(total).toHaveText('GBP 1,250.00');
    await expect(paid).toHaveText('GBP 200.00');
    await expect(outstanding).toHaveText('GBP 1,050.00');
    const color = await outstanding.evaluate(element => ({ actual: getComputedStyle(element).color, expected: getComputedStyle(document.documentElement).getPropertyValue('--danger').trim() }));
    await expect(outstanding).toHaveCSS('color', await page.evaluate(value => {
      const element = document.createElement('span'); element.style.color = value; document.body.append(element);
      const result = getComputedStyle(element).color; element.remove(); return result;
    }, color.expected));
    const positions = await totals.locator('article').evaluateAll(elements => elements.map(element => ({ top: element.getBoundingClientRect().top, left: element.getBoundingClientRect().left })));
    expect(new Set(positions.map(position => position.top)).size).toBe(1);
    expect(positions[0].left).toBeLessThan(positions[1].left);
    expect(positions[1].left).toBeLessThan(positions[2].left);
    const nameBox = await main.getByRole('heading', { name: 'Aster Studio', exact: true }).boundingBox();
    const detailsBox = await main.getByRole('region', { name: 'Account details', exact: true }).boundingBox();
    expect(detailsBox!.y).toBeGreaterThan(nameBox!.y + nameBox!.height);
    expect(positions[0].top).toBeGreaterThan(detailsBox!.y + detailsBox!.height);
    await page.screenshot({ path: '.local/customer-account-desktop.png', fullPage: true, animations: 'disabled' });

    await expect(main.getByRole('link', { name: 'My bookings', exact: true })).toHaveCount(0);
    await navigation.getByRole('link', { name: 'My bookings', exact: true }).click();
    await expect(main.getByRole('heading', { name: 'My bookings', exact: true })).toBeVisible();
    const bookingList = main.getByRole('region', { name: 'Customer bookings', exact: true });
    const firstBooking = bookingList.getByRole('article', { name: bookings[0].reference, exact: true });
    await expect(firstBooking).toBeVisible();
    await expect(bookingList.getByRole('table')).toHaveCount(0);
    await expect(bookingList.getByRole('search')).toHaveCount(0);
    await expect(bookingList.getByRole('searchbox')).toHaveCount(0);
    await expect(bookingList.getByRole('combobox')).toHaveCount(0);
    await expect(bookingList).not.toContainText('Booking total');
    await expect(bookingList).not.toContainText('GBP');
    await firstBooking.getByRole('link', { name: 'View booking', exact: true }).click();
    await expect(main.getByRole('heading', { name: bookings[0].reference, exact: true })).toBeVisible();
    await expect(main.getByRole('button', { name: 'Open Flight Tickets folder', exact: true })).toBeVisible();
    await expect(main.getByRole('region', { name: 'Booking details', exact: true })).toHaveCount(0);
    await expect(main.getByRole('region', { name: 'Invoice history', exact: true })).toHaveCount(0);
    await expect(main.getByRole('region', { name: 'Payment history', exact: true })).toHaveCount(0);
    await expect(main.getByRole('region', { name: 'Service availability', exact: true })).toHaveCount(0);
    await expect(main.getByRole('heading', { name: 'Payment reminders', exact: true })).toHaveCount(0);
    await expect(main.getByRole('form')).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'New folder', exact: true })).toHaveCount(0);
    await main.getByRole('link', { name: 'My bookings', exact: true }).click();
    await main.getByRole('link', { name: 'My account', exact: true }).click();
    await expect(page).toHaveURL(root);
    await main.getByRole('link', { name: 'View account statement', exact: true }).click();
    await expect(main.getByRole('heading', { name: 'Account statement', exact: true })).toBeVisible();
    await main.getByRole('link', { name: 'My account', exact: true }).click();
    await expect(total).toHaveText('GBP 1,250.00');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.topbar-brand').click();
    await expect(page).toHaveURL(`${root}/users/${seed.customerId}`);
    await expect(main.getByRole('heading', { name: 'My bookings', exact: true })).toBeVisible();
    await main.getByRole('link', { name: 'My account', exact: true }).click();
    const viewport = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width + 1);
    await page.screenshot({ path: '.local/customer-account-mobile.png', fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await expect(navigation.getByRole('link').first()).toHaveText('My bookings');
    await navigation.getByRole('link', { name: 'My bookings', exact: true }).click();
    await expect(main.getByRole('heading', { name: 'My bookings', exact: true })).toBeVisible();
    await expect(firstBooking).toBeVisible();
    const bookingsViewport = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(bookingsViewport.scrollWidth).toBeLessThanOrEqual(bookingsViewport.width + 1);
    await page.screenshot({ path: '.local/customer-bookings-mobile.png', fullPage: true, animations: 'disabled' });
    await main.getByRole('link', { name: 'My account', exact: true }).click();

    await page.route(`**/customers/${seed.customerId}/statement?*`, route => route.fulfill({ status: 503, json: { message: 'Unable to load account totals.' } }), { times: 1 });
    await main.getByRole('button', { name: 'Refresh balance', exact: true }).click();
    await expect(main.getByRole('alert')).toContainText('Unable to load account totals.');
    await main.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(total).toHaveText('GBP 1,250.00');

    await cancel(bookings[1]);
    await main.getByRole('button', { name: 'Refresh balance', exact: true }).click();
    await expect(total).toHaveText('GBP 500.00');
    await expect(paid).toHaveText('GBP 125.00');
    await expect(outstanding).toHaveText('GBP 375.00');
    await cancel(bookings[0]);
    await main.getByRole('button', { name: 'Refresh balance', exact: true }).click();
    await expect(total).toHaveText('GBP 0.00');
    await expect(paid).toHaveText('GBP 0.00');
    await expect(outstanding).toHaveText('GBP 0.00');
    await expect(totals).toContainText('Nothing left to pay');
    await page.goto(`${root}/users/${seed.customerId}`);
    await expect(bookingList.getByRole('article')).toHaveCount(0);
    await expect(bookingList).not.toContainText('Cancelled bookings');
    expect(errors).toEqual([]);
  } finally {
    for (const booking of bookings) if (!booking.cancelled) await cancel(booking);
    for (const reversal_of of paymentEntries) {
      const response = await admin.request.post(`${customerBase}/entries`, {
        headers, data: { kind: 'reversal', reversal_of, effective_date: '2026-11-10', description: 'Restore account browser fixture', idempotency_key: randomUUID() },
      });
      expect(response.status(), await response.text()).toBe(201);
    }
    await admin.close();
  }
});
