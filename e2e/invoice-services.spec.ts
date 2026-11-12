import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { authenticateFixture } from './session-fixture';

async function latestInvoice(page: Page, version: number) {
  const history = page.getByRole('region', { name: 'Invoice history', exact: true });
  await expect(history.locator('tbody tr')).toHaveCount(version);
  const downloadEvent = page.waitForEvent('download');
  await history.locator('tbody tr').first().getByRole('button', { name: /Download .* as PDF/ }).click();
  const download = await downloadEvent;
  const content = await readFile((await download.path())!);
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(content), useSystemFonts: false });
  try {
    const pdf = await task.promise;
    expect(pdf.numPages).toBe(1);
    const text = (await (await pdf.getPage(1)).getTextContent()).items
      .filter(item => 'str' in item).map(item => item.str).join(' ').replace(/\s+/g, ' ');
    return { content, text };
  } finally { await task.destroy(); }
}

test('create and edit booking checkboxes control only the services included in each invoice', async ({ page, context }) => {
  const seed = JSON.parse(await readFile('.local/e2e/seed.json', 'utf8')) as { orgId: string };
  await authenticateFixture(context);
  await context.addInitScript(() => localStorage.setItem('e2e-email', 'admin@example.test'));
  await context.route('**/api/auth/config', route => route.fulfill({ json: { provider: 'clerk', publishableKey: 'isolated-test-only' } }));
  const customer = await context.request.post(`/api/organizations/${seed.orgId}/customers`, {
    headers: { Origin: 'http://127.0.0.1:4312', 'X-CSRF-Protection': '1' },
    data: { name: 'Invoice services browser fixture', email: `services-${randomUUID()}@example.test`, idempotency_key: randomUUID() },
  });
  expect(customer.status(), await customer.text()).toBe(201);
  const customerId = (await customer.json()).id as string;
  const reference = `SERVICES-${randomUUID().slice(0, 8)}`;
  await page.goto(`/o/${seed.orgId}/customers/${customerId}/bookings/new`);
  await page.getByLabel('Booking reference', { exact: true }).fill(reference);
  await page.getByLabel(/^Departure \(/).fill('2026-12-20T10:30');
  await page.getByLabel('Booking total (GBP)', { exact: true }).fill('500.00');
  await page.getByLabel('Charge effective date').fill('2026-11-09');
  await page.getByRole('checkbox', { name: 'Flight Tickets', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Makkah Hotel', exact: true }).check();
  await page.getByRole('button', { name: 'Create booking', exact: true }).click();
  await expect(page.getByRole('heading', { name: reference, exact: true })).toBeVisible();
  const initial = await latestInvoice(page, 1);
  expect(initial.text).toContain('Included services Flight Tickets Makkah Hotel');
  expect(initial.text).not.toMatch(/Madinah Hotel|Transfers|Visas|Extras/);

  await page.getByRole('button', { name: 'Edit booking', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Flight Tickets', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Makkah Hotel', exact: true })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Flight Tickets', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Madinah Hotel', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Transfers', exact: true }).check();
  await page.getByLabel('Reason for change').fill('Update the services included in this booking.');
  await page.getByRole('button', { name: 'Save booking', exact: true }).click();
  const updated = await latestInvoice(page, 2);
  expect(updated.text).toContain('Included services Makkah Hotel Madinah Hotel Transfers');
  expect(updated.text).not.toMatch(/Flight Tickets|Visas|Extras/);

  await page.getByRole('button', { name: 'Edit booking', exact: true }).click();
  for (const service of ['Makkah Hotel', 'Madinah Hotel', 'Transfers']) {
    await page.getByRole('checkbox', { name: service, exact: true }).uncheck();
  }
  await page.getByLabel('Reason for change').fill('Remove all selected services.');
  await page.getByRole('button', { name: 'Save booking', exact: true }).click();
  const empty = await latestInvoice(page, 3);
  expect(empty.text).not.toMatch(/Included services|Flight Tickets|Makkah Hotel|Madinah Hotel|Transfers|Visas|Extras|Travel package/);
  expect(empty.text).toContain('Total Amount £500.00');

  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('region', { name: 'Invoice history', exact: true }).locator('tbody tr').last()
    .getByRole('button', { name: /Download .* as PDF/ }).click();
  expect(await readFile((await (await downloadEvent).path())!)).toEqual(initial.content);
});
