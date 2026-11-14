import { authenticateFixture } from './session-fixture';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { receiptPdf } from '../tests/pdf-fixture';

const origin = 'http://127.0.0.1:4312';
type Seed = { orgId: string; customerId: string; secondCustomerId: string };
let seed: Seed;
test.beforeAll(async () => { seed = JSON.parse(await readFile('.local/e2e/seed.json', 'utf8')); });

async function authenticate(context: BrowserContext, email = 'admin@example.test') {
  await authenticateFixture(context, email);
  await context.addInitScript(value => localStorage.setItem('e2e-email', value), email);
  await context.route('**/api/auth/config', route => route.fulfill({ json: { provider: 'clerk', publishableKey: 'isolated-test-only' } }));
}

async function createBooking(page: Page, customerId: string, reference: string) {
  await page.goto(`/o/${seed.orgId}/customers/${customerId}/bookings/new`);
  await page.getByLabel('Booking reference', { exact: true }).fill(reference);
  await page.getByLabel(/^Departure \(/).fill('2026-12-20T10:30');
  await page.getByLabel('Booking total (GBP)', { exact: true }).fill('500.00');
  await page.getByLabel('Charge effective date').fill('2026-11-09');
  await page.getByRole('button', { name: 'Create booking', exact: true }).click();
  await expect(page.getByRole('heading', { name: reference, exact: true })).toBeVisible();
  return new URL(page.url()).pathname;
}

test('customer creation, invitation, edit, archive, booking, file CRUD and permanent deletion', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await authenticate(context);
  await page.goto(`/o/${seed.orgId}/customers/new`);
  await page.getByLabel('Full name or business name').fill('Browser Launch Customer');
  await page.getByLabel('Email address').fill('browser-launch@example.test');
  await page.getByLabel('Phone number').fill('+44 7700 900123');
  await page.getByLabel('Internal notes').fill('Isolated test account.');
  await page.getByRole('button', { name: 'Create & invite customer' }).click();
  await expect(page.getByRole('heading', { name: 'Browser Launch Customer', exact: true })).toBeVisible();
  const customerId = new URL(page.url()).pathname.split('/').at(-1)!;
  const customerPath = `/o/${seed.orgId}/customers/${customerId}`;
  await page.getByRole('link', { name: 'Manage account' }).click();
  await page.getByLabel('Full name or business name').fill('Browser Customer Edited');
  await page.getByLabel('Internal notes').fill('Edited notes persisted');
  await page.getByLabel(/^Account status/).selectOption('archived');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('heading', { name: 'Browser Customer Edited', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record transaction', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Manage account' }).click();
  await expect(page.getByLabel('Internal notes')).toHaveValue('Edited notes persisted');
  await page.getByLabel(/^Account status/).selectOption('active');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('button', { name: 'Record transaction', exact: true })).toBeVisible();

  const bookingPath = await createBooking(page, customerId, 'BROWSER-E2E-001');
  await page.getByRole('button', { name: 'Open Flight Tickets folder' }).click();
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Folder name').fill('Travel paperwork');
  await page.getByRole('button', { name: 'Create folder', exact: true }).click();
  await page.getByRole('button', { name: 'Rename Travel paperwork', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Previous paperwork');
  await page.getByRole('button', { name: 'Save name' }).click();
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Folder name').fill('Travel paperwork');
  await page.getByRole('button', { name: 'Create folder', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Travel paperwork folder' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Previous paperwork folder' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete Previous paperwork', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete permanently' }).click();
  await page.getByRole('button', { name: 'Open Travel paperwork folder' }).click();
  const document = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
  await page.getByLabel('Choose files', { exact: true }).setInputFiles({ name: 'ticket.pdf', mimeType: 'application/pdf', buffer: document });
  await expect(page.getByRole('button', { name: 'ticket.pdf', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Rename ticket.pdf', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('renamed.txt');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('confirmed-ticket.pdf');
  await page.getByRole('button', { name: 'Save name' }).click();
  await page.getByRole('button', { name: 'confirmed-ticket.pdf', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download copy' }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('confirmed-ticket.pdf');
  expect(await readFile((await download.path())!)).toEqual(document);
  await page.getByRole('dialog').getByRole('button', { name: 'Close preview', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Open Flight Tickets folder' }).click();
  await page.getByRole('button', { name: 'Open Travel paperwork folder' }).click();
  await expect(page.getByRole('button', { name: 'confirmed-ticket.pdf', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Move confirmed-ticket.pdf', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Destination folder').selectOption({ label: 'All files / Extras' });
  await page.getByRole('dialog').getByRole('button', { name: 'Move item', exact: true }).click();
  await page.goto(bookingPath);
  await page.getByRole('button', { name: 'Open Extras folder' }).click();
  await page.getByRole('button', { name: 'Delete confirmed-ticket.pdf', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page.getByRole('button', { name: 'confirmed-ticket.pdf', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'All files', exact: true }).click();
  await page.getByRole('button', { name: 'Open Flight Tickets folder' }).click();
  await page.getByRole('button', { name: 'Delete Travel paperwork', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page.getByRole('button', { name: 'Open Travel paperwork folder' })).toHaveCount(0);

  await page.goto(customerPath);
  const csvEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const csv = await csvEvent;
  expect(await readFile((await csv.path())!, 'utf8')).toContain('BROWSER-E2E-001');
  await page.getByRole('button', { name: 'Delete account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Delete permanently', exact: true })).toBeDisabled();
  await page.getByRole('dialog').getByRole('textbox').fill('browser-launch@example.test');
  await page.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Customer Data' })).toBeVisible();
  const deleted = await context.request.get(`${origin}/api/organizations/${seed.orgId}/customers/${customerId}`);
  expect(deleted.status()).toBe(404);
  expect(errors).toEqual([]);
});

test('customer receipts, administrator approval and rejection, customer balance and access restrictions', async ({ page, context, browser }) => {
  await authenticate(context);
  const bookingPath = await createBooking(page, seed.customerId, 'PAYMENT-E2E-001');
  const customerContext = await browser.newContext({ baseURL: origin });
  const pdfReceipt = await receiptPdf(`Browser bank receipt ${randomUUID()}`);
  try {
    await authenticate(customerContext, 'customer@example.test');
    const customer = await customerContext.newPage();
    await customer.goto(bookingPath);
    await expect(customer.getByRole('button', { name: 'New folder', exact: true })).toHaveCount(0);
    await expect(customer.getByRole('form', { name: 'Submit booking payment', exact: true })).toHaveCount(0);
    await customer.getByRole('main').getByRole('link', { name: 'My bookings', exact: true }).click();
    await customer.getByRole('main').getByRole('link', { name: 'My account', exact: true }).click();
    const customerPayments = customer.getByRole('region', { name: 'Payment history', exact: true });
    async function submitReceipt(amount: string, note: string) {
      // Account receipt deduplication spans bookings, so each transfer needs its own evidence bytes.
      const receipt = await sharp(randomBytes(31 * 33 * 3), { raw: { width: 31, height: 33, channels: 3 } }).png().toBuffer();
      await customer.getByRole('button', { name: 'Make a payment', exact: true }).click();
      const invoices = await (await customerContext.request.get(`/api/organizations/${seed.orgId}/customers/${seed.customerId}/invoices/outstanding`)).json();
      const invoice = invoices.invoices.find((item: { booking_reference: string }) => item.booking_reference === 'PAYMENT-E2E-001');
      expect(invoice).toBeDefined();
      await customer.getByRole('combobox', { name: 'Invoice to pay' }).selectOption(invoice.id);
      await customer.getByLabel('Amount paid (GBP)').fill(amount);
      await customer.getByLabel('Payment note').fill(note);
      await customer.getByLabel('Choose receipt files', { exact: true }).setInputFiles([
        { name: 'receipt.png', mimeType: 'image/png', buffer: receipt },
        ...(amount === '120.00' ? [{ name: 'bank-receipt.pdf', mimeType: 'application/pdf', buffer: pdfReceipt }] : []),
      ]);
      await customer.getByRole('button', { name: 'Submit payment for review', exact: true }).click();
      await expect(customer.getByText('Payment submitted for review.', { exact: false })).toBeVisible();
    }
    await submitReceipt('120.00', 'Bank transfer verified by browser workflow');
    await page.goto(`/o/${seed.orgId}/payment-reviews?q=${encodeURIComponent('Bank transfer verified by browser workflow')}`);
    await page.getByRole('button', { name: /^Review payment / }).click();
    const receiptPreview = page.getByRole('button', { name: /^Preview receipt \d+: receipt\.webp$/ });
    await receiptPreview.focus();
    await receiptPreview.press('Enter');
    await expect(page.getByRole('dialog', { name: 'receipt.webp' }).getByRole('img', { name: 'receipt.webp', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'receipt.webp' })).toHaveCount(0);
    await expect(receiptPreview).toBeFocused();
    await page.getByRole('button', { name: /^Preview receipt \d+: bank-receipt\.pdf$/ }).click();
    const pdfDialog = page.getByRole('dialog', { name: 'bank-receipt.pdf', exact: true });
    await expect(pdfDialog.locator('.textLayer')).toContainText('Browser bank receipt');
    await pdfDialog.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(pdfDialog.locator('.textLayer')).toContainText('Bank confirmation details');
    const downloaded = page.waitForEvent('download');
    await pdfDialog.getByRole('link', { name: 'Download copy', exact: true }).click();
    const pdfDownload = await downloaded;
    expect(pdfDownload.suggestedFilename()).toBe('bank-receipt.pdf');
    expect(await readFile((await pdfDownload.path())!)).toEqual(pdfReceipt);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Approve payment', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Confirm approval' })).toBeDisabled();
    await page.getByLabel('I have checked the receipts and verified that the money was received.').check();
    await page.getByRole('button', { name: 'Confirm approval' }).click();
    await expect(page.getByText('Payment for PAYMENT-E2E-001 approved and recorded.', { exact: false })).toBeVisible();
    await customer.reload();
    await expect(customerPayments.getByRole('article').filter({ hasText: 'Bank transfer verified by browser workflow' })).toContainText(/approved/i);
    await submitReceipt('50.00', 'Duplicate transfer for rejection');
    await page.goto(`/o/${seed.orgId}/payment-reviews?q=${encodeURIComponent('Duplicate transfer for rejection')}`);
    await page.getByRole('button', { name: /^Review payment / }).click();
    await page.getByRole('button', { name: 'Reject submission' }).click();
    await page.getByLabel('Reason visible to the customer').fill('Duplicate receipt, please send the correct transfer.');
    await page.getByRole('button', { name: 'Confirm rejection' }).click();
    await expect(page.getByText('Payment for PAYMENT-E2E-001 rejected.', { exact: false })).toBeVisible();
    await customer.reload();
    await expect(customerPayments.getByRole('article').filter({ hasText: 'Duplicate transfer for rejection' })).toContainText(/rejected/i);
    const own = await customerContext.request.get(`${origin}/api/organizations/${seed.orgId}/customers/${seed.customerId}/statement`);
    expect((await own.json()).current_balance_minor).toBe('38000');
    const forbidden = await customerContext.request.get(`${origin}/api/organizations/${seed.orgId}/customers/${seed.secondCustomerId}/statement`);
    expect(forbidden.status()).toBe(404);
  } finally { await customerContext.close(); }
});

test('manual ledger posting, reversal, statement filtering and persistence', async ({ page, context }) => {
  await authenticate(context);
  await page.goto(`/o/${seed.orgId}/customers/${seed.secondCustomerId}`);
  await page.getByRole('button', { name: 'Record transaction', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: /^Transaction type/ }).selectOption('charge');
  await dialog.getByLabel('Amount (GBP)').fill('29.95');
  await dialog.getByLabel('Description').fill('Browser ledger charge');
  await dialog.getByRole('button', { name: 'Record transaction', exact: true }).click();
  await expect(page.getByText('Browser ledger charge', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Reverse entry/ }).click();
  await page.getByRole('dialog').getByLabel('Reason for reversal').fill('Correct browser entry');
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm reversal' }).click();
  await expect(page.getByText('Correct browser entry', { exact: true })).toBeVisible();
  await page.reload();
  const result = await context.request.get(`${origin}/api/organizations/${seed.orgId}/customers/${seed.secondCustomerId}/statement`);
  const statement = await result.json();
  expect(statement.current_balance_minor).toBe('0');
  expect(statement.entries).toHaveLength(2);
});

test('navigation, directory filtering, persisted themes and mobile layout', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await authenticate(context);
  for (const route of ['', '/users', '/customers', '/customer-ledger', '/payment-reviews', '/access', '/companies', '/settings']) {
    await page.goto(`/o/${seed.orgId}${route}`);
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('[role="alert"]')).toHaveCount(0);
    const logo = page.locator('.sidebar').getByRole('img', { name: 'Umrah Packages UK', exact: true });
    await expect(logo).toBeVisible();
    await expect(logo).toHaveAttribute('src', '/branding/umrah-packages-source.png');
    await expect.poll(() => logo.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
    if (!route) {
      await expect(page.getByRole('link', { name: 'Record payment', exact: true }).and(page.locator('.button'))).toHaveCSS('background-color', 'rgb(219, 170, 58)');
      await page.screenshot({ path: '.local/e2e/dashboard-brand-desktop.png', fullPage: true });
    }
  }
  await page.getByText('Dark', { exact: true }).click();
  await page.getByText('Violet', { exact: true }).click();
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Violet', exact: true })).toBeChecked();
  await page.goto(`/o/${seed.orgId}/customers`);
  await page.getByLabel('Search customers').fill('Aster');
  await expect(page.getByRole('link', { name: /Aster Studio customer@example.test/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Beacon Store beacon@example.test/ })).toHaveCount(0);
  await page.getByLabel('Search customers').fill('no-such-customer-999');
  await expect(page.getByRole('heading', { name: 'No matching customers' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ['', '/users', '/companies', '/settings']) {
    await page.goto(`/o/${seed.orgId}${route}`);
    await expect(page.locator('h1')).toBeVisible();
    const logo = page.locator('.topbar-brand').getByRole('img', { name: 'Umrah Packages UK', exact: true });
    await expect(logo).toBeVisible();
    await expect(logo).toHaveAttribute('src', '/branding/umrah-packages-logo-dark-transparent.png');
    await expect.poll(() => logo.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    if (!route) await page.screenshot({ path: '.local/e2e/dashboard-brand-mobile.png', fullPage: true });
  }
  expect(errors).toEqual([]);
});

test('reminder totals can be below the balance and cannot exceed it', async ({ page, context }) => {
  await authenticate(context);
  const reference = 'PARTIAL-REMINDERS-E2E';
  await page.goto(`/o/${seed.orgId}/customers/${seed.customerId}/bookings/new`);
  await page.getByLabel('Booking reference', { exact: true }).fill(reference);
  await page.getByLabel(/^Departure \(/).fill('2026-12-20T10:30');
  await page.getByLabel('Booking total (GBP)', { exact: true }).fill('500.00');
  await page.getByLabel('Charge effective date').fill('2026-11-09');
  await page.getByLabel('Amount (GBP)', { exact: true }).fill('400.00');
  await page.getByRole('button', { name: 'Create booking', exact: true }).click();
  await expect(page.getByRole('heading', { name: reference, exact: true })).toBeVisible();
  const path = new URL(page.url()).pathname;
  const bookingBase = `${origin}/api/organizations/${seed.orgId}/customers/${seed.customerId}/bookings/${path.split('/').at(-1)}`;
  const created = await (await context.request.get(bookingBase)).json();
  expect(created.total_minor).toBe('50000');
  expect(created.instalments.map((item: { amount_minor: string }) => item.amount_minor)).toEqual(['40000']);
  await page.getByRole('button', { name: 'Edit booking', exact: true }).click();
  const form = page.getByRole('form', { name: 'Edit booking', exact: true });
  await form.getByLabel('Amount (GBP)', { exact: true }).fill('500.01');
  await form.getByLabel('Reason for change').fill('Change reminder amount');
  await form.getByRole('button', { name: 'Save booking', exact: true }).click();
  await expect(form).toContainText('Reminders exceed the remaining balance');
  await form.getByLabel('Amount (GBP)', { exact: true }).fill('200.00');
  await form.getByRole('button', { name: 'Save booking', exact: true }).click();
  await expect(form).toHaveCount(0);
  const updated = await (await context.request.get(bookingBase)).json();
  expect(updated.total_minor).toBe('50000');
  expect(String(updated.charge_entry_id)).toBe(String(created.charge_entry_id));
  expect(updated.instalments.map((item: { amount_minor: string }) => item.amount_minor)).toEqual(['20000']);
});

test('booking corrections, issuance, text editing, binary replacement, version restore and cancellation',async({page,context})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await authenticate(context);
  const path=await createBooking(page,seed.secondCustomerId,'EDIT-E2E-001');
  await page.getByRole('button',{name:'Edit booking',exact:true}).click();
  const form=page.getByRole('form',{name:'Edit booking',exact:true});
  await form.getByLabel('Booking reference',{exact:true}).fill('EDIT-E2E-002');
  await form.getByLabel('Booking total (GBP)',{exact:true}).fill('650.00');
  await form.getByLabel('Amount (GBP)',{exact:true}).fill('650.00');
  await form.getByLabel('Reason for change').fill('Add upgraded hotel room');
  await form.getByRole('button',{name:'Save booking',exact:true}).click();
  await expect(page.getByRole('heading',{name:'EDIT-E2E-002',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Mark issued: Flight Tickets',exact:true}).click();
  await expect(page.getByRole('button',{name:'Mark not issued: Flight Tickets',exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button',{name:'Mark not issued: Flight Tickets',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Open Flight Tickets folder'}).click();
  await page.getByLabel('Choose files',{exact:true}).setInputFiles({name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('Original travel notes')});
  await page.getByRole('button',{name:'Edit file and versions notes.txt',exact:true}).click();
  await page.getByRole('button',{name:'Edit text',exact:true}).click();
  await page.getByLabel('File content',{exact:true}).fill('Updated travel notes – UTF-8');
  await page.getByRole('button',{name:'Save text',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'Edit file and versions notes.txt',exact:true}).click();
  await page.getByRole('button',{name:'Edit text',exact:true}).click();
  await expect(page.getByLabel('File content',{exact:true})).toHaveValue('Updated travel notes – UTF-8');
  await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();

  const original=Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
  const replacement=Buffer.from('%PDF-1.4\n% replacement bytes\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
  await page.getByLabel('Choose files',{exact:true}).setInputFiles({name:'replace.pdf',mimeType:'application/pdf',buffer:original});
  await page.getByRole('button',{name:'Edit file and versions replace.pdf',exact:true}).click();
  await page.getByLabel('Replacement file',{exact:true}).setInputFiles({name:'new.pdf',mimeType:'application/pdf',buffer:replacement});
  await page.getByRole('button',{name:'Save replacement',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'Edit file and versions replace.pdf',exact:true}).click();
  const event=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download version 1',exact:true}).click();
  expect(await readFile((await (await event).path())!)).toEqual(original);
  await page.getByRole('button',{name:'Restore version 1',exact:true}).click();
  await page.getByRole('button',{name:'Confirm restore',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'replace.pdf',exact:true}).click();
  const restored=page.waitForEvent('download');
  await page.getByRole('link',{name:'Download copy'}).click();
  expect(await readFile((await (await restored).path())!)).toEqual(original);
  await page.getByRole('dialog').getByRole('button',{name:'Close preview',exact:true}).click();
  await page.getByRole('button',{name:'Delete replace.pdf',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Delete permanently'}).click();
  await expect(page.getByRole('button',{name:'replace.pdf',exact:true})).toHaveCount(0);

  await page.getByRole('button',{name:'Cancel booking',exact:true}).click();
  const cancellation=page.getByRole('form',{name:'Cancel booking',exact:true});
  await cancellation.getByLabel('Cancellation reason').fill('Customer cancelled the test trip');
  await cancellation.getByLabel('Type EDIT-E2E-002 to confirm').fill('EDIT-E2E-002');
  await cancellation.getByRole('button',{name:'Confirm cancellation'}).click();
  await expect(page).toHaveURL(new RegExp(`/users/${seed.secondCustomerId}$`));
  const endpoint=`${origin}/api/organizations/${seed.orgId}/customers/${seed.secondCustomerId}`;
  expect((await context.request.get(`${endpoint}/bookings/${path.split('/').at(-1)}`)).status()).toBe(404);
  expect((await (await context.request.get(`${endpoint}/statement`)).json()).current_balance_minor).toBe('0');
  expect(errors).toEqual([]);
});

test('notification schedule persists and customers control their own reminder preference',async({page,context,browser})=>{
  await authenticate(context);
  await page.goto(`/o/${seed.orgId}/settings`);
  await expect(page.getByRole('heading',{name:'Notifications & reminders'})).toBeVisible();
  await page.getByLabel('Days before payment is due').fill('5');
  await page.getByLabel('Repeat no sooner than (days)').fill('7');
  await page.getByLabel('Daily send hour').selectOption('10');
  await page.getByLabel('Time zone',{exact:true}).fill('Europe/London');
  await page.getByRole('button',{name:'Save reminder schedule'}).click();
  await expect(page.getByText('Reminder schedule saved.',{exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Days before payment is due')).toHaveValue('5');
  await expect(page.getByLabel('Time zone',{exact:true})).toHaveValue('Europe/London');
  // Exercise enabling with no live recipient: the fixture always uses private email files.
  await page.getByLabel('Enable due and overdue reminders for this workspace').check();
  await page.getByRole('button',{name:'Save reminder schedule'}).click();
  await expect(page.getByText('Reminder schedule saved.',{exact:true})).toBeVisible();
  await page.getByLabel('Enable due and overdue reminders for this workspace').uncheck();
  await page.getByRole('button',{name:'Save reminder schedule'}).click();
  const customerContext=await browser.newContext({baseURL:origin});
  try {
    await authenticate(customerContext,'customer@example.test');
    const customer=await customerContext.newPage();await customer.goto(`/o/${seed.orgId}/settings`);
    await expect(customer.getByLabel('Receive automatic payment reminders')).toBeChecked();
    await customer.route(`**/customers/${seed.customerId}/reminder-preferences`,route=>route.fulfill({status:500,json:{message:'Temporary test outage'}}),{times:1});
    await customer.getByLabel('Receive automatic payment reminders').click();
    await expect(customer.getByRole('alert')).toContainText('Temporary test outage');
    await expect(customer.getByLabel('Receive automatic payment reminders')).toBeChecked();
    await customer.getByLabel('Receive automatic payment reminders').uncheck();
    await expect(customer.getByText('Payment reminders turned off.',{exact:true})).toBeVisible();
    await customer.reload();await expect(customer.getByLabel('Receive automatic payment reminders')).not.toBeChecked();
    await expect(customer.getByLabel('Enable due and overdue reminders for this workspace')).toHaveCount(0);
  } finally {await customerContext.close();}
});
