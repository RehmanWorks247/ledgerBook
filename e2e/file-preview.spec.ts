import { fixtureSessionCookies } from './session-fixture';
import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { strToU8, zipSync } from 'fflate';
import sharp from 'sharp';

const origin = 'http://127.0.0.1:4312';
const writeHeaders = { Origin: origin, 'X-CSRF-Protection': '1' };
let orgId: string;
let adminCookies: Awaited<ReturnType<BrowserContext['cookies']>>;
test.beforeAll(async () => {
  ({ orgId } = JSON.parse(await readFile('.local/e2e/seed.json', 'utf8')));
  adminCookies = await fixtureSessionCookies('admin@example.test');
});
const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
});
test.afterEach(({ page }) => { expect(pageErrors.get(page)).toEqual([]); });

async function openFiles(page: Page, context: BrowserContext) {
  await context.addCookies(adminCookies);
  await context.addInitScript(() => localStorage.setItem('e2e-email', 'admin@example.test'));
  await context.route('**/api/auth/config', route => route.fulfill({ json: { provider: 'clerk', publishableKey: 'isolated-test-only' } }));
  // Separate customers keep these fixtures from changing the shared workflow balances.
  const customerResponse = await context.request.post(`${origin}/api/organizations/${orgId}/customers`, {
    headers: writeHeaders,
    data: { name: 'File preview browser fixture', email: `preview-${randomUUID()}@example.test`, idempotency_key: randomUUID() },
  });
  expect(customerResponse.status(), await customerResponse.text()).toBe(201);
  const customer = await customerResponse.json();
  const bookingResponse = await context.request.post(`${origin}/api/organizations/${orgId}/customers/${customer.id}/bookings`, {
    headers: writeHeaders,
    data: { reference: `PREVIEW-${randomUUID().slice(0, 8)}`, departure_at: '2026-12-20T10:30:00Z', amount: '50.00', effective_date: '2026-11-09', idempotency_key: randomUUID() },
  });
  expect(bookingResponse.status(), await bookingResponse.text()).toBe(201);
  const booking = await bookingResponse.json();
  await page.goto(`/o/${orgId}/users/${customer.id}/bookings/${booking.id}`);
  await page.getByRole('button', { name: 'Open Flight Tickets folder' }).click();
}

async function upload(page: Page, name: string, buffer: Buffer, mimeType: string) {
  await page.getByLabel('Choose files', { exact: true }).setInputFiles({ name, mimeType, buffer });
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
}

async function downloadCopy(page: Page, name: string, bytes: Buffer) {
  const downloaded = page.waitForEvent('download');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('link', { name: 'Download copy' }).or(dialog.getByRole('button', { name: 'Download copy' })).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe(name);
  expect(await readFile((await file.path())!)).toEqual(bytes);
}

async function selectAndCopyText(page: Page, content: Locator, text: string, rotation: 0 | 90 = 0) {
  await expect(content).toBeVisible();
  await content.scrollIntoViewIfNeeded();
  const bounds = await content.evaluate((element, { text, rotation }) => {
    window.getSelection()?.removeAllRanges();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const lines = text.split('\n');
    const firstText = lines[0];
    const lastText = lines[lines.length - 1];
    let first: Range | undefined;
    let last: Range | undefined;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const start = node.textContent!.indexOf(firstText);
      if (!first && start >= 0) {
        first = document.createRange();
        first.setStart(node, start);
        first.setEnd(node, start + 1);
      }
      const end = node.textContent!.indexOf(lastText);
      if (first && end >= 0) {
        last = document.createRange();
        last.setStart(node, end + lastText.length - 1);
        last.setEnd(node, end + lastText.length);
        break;
      }
    }
    if (first && last) {
      const firstBounds = first.getBoundingClientRect();
      const lastBounds = last.getBoundingClientRect();
      // Stay inside each glyph despite subpixel layout and native mouse
      // coordinate rounding, while remaining on the outer half of its caret.
      if (rotation === 90) {
        return {
          startX: firstBounds.left + firstBounds.width / 2, startY: firstBounds.top + firstBounds.height / 4,
          endX: lastBounds.left + lastBounds.width / 2, endY: lastBounds.bottom - lastBounds.height / 4,
        };
      }
      return {
        startX: firstBounds.left + firstBounds.width / 4, startY: firstBounds.top + firstBounds.height / 2,
        endX: lastBounds.right - lastBounds.width / 4, endY: lastBounds.top + lastBounds.height / 2,
      };
    }
    throw new Error(`Selectable text was not found: ${text}`);
  }, { text, rotation });
  // Use a real drag: programmatically adding a Range would pass even when CSS
  // or an overlay prevents the user from selecting the document.
  await page.mouse.move(bounds.startX, bounds.startY);
  await page.mouse.down();
  await page.mouse.move(bounds.endX, bounds.endY, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(text);
  if (page.context().browser()?.browserType().name() === 'chromium') {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await page.keyboard.press('ControlOrMeta+c');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  }
}

async function expectPdfTextAligned(dialog: Locator, text: string, rotation: 0 | 90 = 0) {
  await expect(dialog.locator('.file-preview-pdf-scroll')).toHaveAttribute('aria-busy', 'false');
  const layer = dialog.locator('.file-preview-pdf-sheet .textLayer');
  const label = layer.getByText(text, { exact: true });
  await expect(label).toBeVisible();
  const canvas = (await dialog.locator('canvas').boundingBox())!;
  const overlay = (await layer.boundingBox())!;
  const labelBounds = (await label.boundingBox())!;
  const scale = canvas.width / (rotation === 90 ? 160 : 240);
  expect(Math.abs(overlay.x - canvas.x)).toBeLessThan(1);
  expect(Math.abs(overlay.y - canvas.y)).toBeLessThan(1);
  expect(Math.abs(overlay.width - canvas.width)).toBeLessThan(1);
  expect(Math.abs(overlay.height - canvas.height)).toBeLessThan(1);
  // The fixture places a 13-point line at PDF coordinates (18, 124).
  // Its overlay must cover that rendered line at every zoom and viewport size.
  if (rotation === 90) {
    expect(Math.abs(labelBounds.y - (canvas.y + 18 * scale))).toBeLessThan(1);
    const baseline = canvas.x + 124 * scale;
    expect(labelBounds.x).toBeLessThan(baseline);
    expect(labelBounds.x + labelBounds.width).toBeGreaterThan(baseline);
    expect(Math.abs(labelBounds.width - 13 * scale)).toBeLessThan(2);
  } else {
    expect(Math.abs(labelBounds.x - (canvas.x + 18 * scale))).toBeLessThan(1);
    const baseline = canvas.y + (160 - 124) * scale;
    expect(labelBounds.y).toBeLessThan(baseline);
    expect(labelBounds.y + labelBounds.height).toBeGreaterThan(baseline);
    expect(Math.abs(labelBounds.height - 13 * scale)).toBeLessThan(2);
  }
  return label;
}

function twoPagePdf({ rotation = 0, userUnit = 1 }: { rotation?: 0 | 90; userUnit?: number } = {}) {
  const first = '1 0 0 rg 0 0 240 160 re f BT /F1 13 Tf 1 1 1 rg 18 124 Td (Outbound boarding pass) Tj 0 -22 Td (Flight AB 123) Tj ET';
  const second = '0 0 1 rg 0 0 240 160 re f BT /F1 13 Tf 1 1 1 rg 18 124 Td (Return boarding pass) Tj 0 -22 Td (Flight BA 321) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] /Rotate ${rotation} /UserUnit ${userUnit} /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${first.length} >>\nstream\n${first}\nendstream`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] /Rotate ${rotation} /UserUnit ${userUnit} /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>`,
    `<< /Length ${second.length} >>\nstream\n${second}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let document = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  document += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(document);
}

function wordDocument() {
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>Confirmed travel itinerary</w:t></w:r></w:p><w:p><w:hyperlink r:id="rIdUnsafe"><w:r><w:t>Unsafe document link</w:t></w:r></w:hyperlink></w:p><w:p><w:r><w:t>Keep your passport with you.</w:t></w:r></w:p></w:body></w:document>'),
    'word/_rels/document.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdUnsafe" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:window.previewUnsafe=true" TargetMode="External"/></Relationships>'),
  }));
}

test('image previews zoom, download original bytes, trap focus and fit a mobile viewport', async ({ page, context }) => {
  await openFiles(page, context);
  let externalImageRequests = 0;
  await page.route('https://preview-test.invalid/**', async route => {
    externalImageRequests++;
    await route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.alloc(0) });
  });
  const images = await Promise.all((['png', 'jpeg'] as const).map(async format => ({
    name: format === 'png' ? 'receipt.png' : 'passport.jpeg', mimeType: `image/${format}`,
    bytes: await sharp({ create: { width: 320, height: 180, channels: 3, background: '#245a9b' } })[format]().toBuffer(),
  })));
  images.push({ name: 'vector.svg', mimeType: 'image/svg+xml', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" onload="window.previewSvgUnsafe=true"><script>window.previewSvgUnsafe=true</script><image href="https://preview-test.invalid/tracker.png" width="320" height="180"/><rect width="320" height="180" fill="#245a9b"/></svg>') });
  for (const { name, bytes, mimeType } of images) {
    await upload(page, name, bytes, mimeType);
    const trigger = page.getByRole('button', { name, exact: true });
    await trigger.focus();
    await trigger.press('Enter');
    const dialog = page.getByRole('dialog', { name });
    await expect(dialog).toBeVisible();
    const picture = dialog.getByRole('img', { name, exact: true });
    await expect(picture).toBeVisible();
    await expect.poll(() => picture.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(320);
    const fitWidth = (await picture.boundingBox())!.width;
    await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect(dialog.getByText('125%', { exact: true })).toBeVisible();
    await expect.poll(async () => (await picture.boundingBox())!.width).toBeGreaterThan(fitWidth * 1.2);
    await dialog.getByRole('button', { name: 'Zoom out', exact: true }).click();
    await expect(dialog.getByText('100%', { exact: true })).toBeVisible();
    await downloadCopy(page, name, bytes);
    await dialog.getByRole('button', { name: 'Close preview', exact: true }).focus();
    for (let index = 0; index < 12; index++) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
  expect(await page.evaluate(() => 'previewSvgUnsafe' in window)).toBe(false);
  expect(externalImageRequests).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'receipt.png', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'receipt.png' });
  await expect(dialog.getByRole('img')).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
  await dialog.getByRole('button', { name: 'Close preview', exact: true }).click();
});

test('PDF text stays selectable and aligned when zooming, navigating and resizing', async ({ page, context }) => {
  await openFiles(page, context);
  const bytes = twoPagePdf();
  await upload(page, 'boarding-passes.pdf', bytes, 'application/pdf');
  await page.getByRole('button', { name: 'boarding-passes.pdf', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'boarding-passes.pdf' });
  const canvas = dialog.locator('canvas');
  const color = () => canvas.evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    return Array.from(canvas.getContext('2d')!.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data).slice(0, 3);
  });
  await expect(canvas).toBeVisible();
  await expect.poll(color).toEqual([255, 0, 0]);
  const fitWidth = (await canvas.boundingBox())!.width;
  await selectAndCopyText(page, await expectPdfTextAligned(dialog, 'Outbound boarding pass'), 'Outbound boarding pass');
  await selectAndCopyText(page, dialog.locator('.textLayer'), 'Outbound boarding pass\nFlight AB 123');
  await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(dialog.getByText('125%', { exact: true })).toBeVisible();
  await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThan(fitWidth * 1.2);
  await selectAndCopyText(page, await expectPdfTextAligned(dialog, 'Outbound boarding pass'), 'Outbound boarding pass');
  await selectAndCopyText(page, dialog.locator('.textLayer'), 'Outbound boarding pass\nFlight AB 123');
  await expect(dialog.getByRole('button', { name: 'Previous page', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect.poll(color).toEqual([0, 0, 255]);
  await expect(dialog.locator('.textLayer')).not.toContainText('Outbound boarding pass');
  await selectAndCopyText(page, await expectPdfTextAligned(dialog, 'Return boarding pass'), 'Return boarding pass');
  await expect(dialog.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect.poll(color).toEqual([255, 0, 0]);
  await selectAndCopyText(page, await expectPdfTextAligned(dialog, 'Outbound boarding pass'), 'Outbound boarding pass');
  await dialog.getByRole('button', { name: 'Fit page', exact: true }).click();
  await expect(dialog.getByText('100%', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await canvas.boundingBox())?.width ?? fitWidth).toBeLessThan(fitWidth);
  await selectAndCopyText(page, await expectPdfTextAligned(dialog, 'Outbound boarding pass'), 'Outbound boarding pass');
  expect(context.pages()).toHaveLength(1);
  await downloadCopy(page, 'boarding-passes.pdf', bytes);
});

test('rotated PDFs with nondefault user units retain aligned selectable text', async ({ page, context }) => {
  // Keep the full vertical text drag inside the scroll viewport, avoiding
  // browser autoscroll while the selection coordinates are being exercised.
  await page.setViewportSize({ width: 1280, height: 1100 });
  await openFiles(page, context);
  const bytes = twoPagePdf({ rotation: 90, userUnit: 2 });
  await upload(page, 'rotated-boarding-passes.pdf', bytes, 'application/pdf');
  await page.getByRole('button', { name: 'rotated-boarding-passes.pdf', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'rotated-boarding-passes.pdf' });
  await selectAndCopyText(page, await expectPdfTextAligned(dialog, 'Outbound boarding pass', 90), 'Outbound boarding pass', 90);
  await dialog.getByRole('button', { name: 'Next page', exact: true }).click();
  await selectAndCopyText(page, await expectPdfTextAligned(dialog, 'Return boarding pass', 90), 'Return boarding pass', 90);
});

test('Word documents render safely and text files display markup as literal text', async ({ page, context }) => {
  await openFiles(page, context);
  const bytes = wordDocument();
  await upload(page, 'itinerary.docx', bytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  await page.getByRole('button', { name: 'itinerary.docx', exact: true }).click();
  const word = page.getByRole('dialog', { name: 'itinerary.docx' });
  await expect(word.getByText('Confirmed travel itinerary', { exact: true })).toBeVisible();
  await expect(word.getByText('Keep your passport with you.', { exact: true })).toBeVisible();
  await selectAndCopyText(page, word.getByText('Confirmed travel itinerary', { exact: true }), 'Confirmed travel itinerary');
  await expect(word.locator('a[href^="javascript:"], script, iframe')).toHaveCount(0);
  expect(await page.evaluate(() => 'previewUnsafe' in window)).toBe(false);
  await downloadCopy(page, 'itinerary.docx', bytes);
  await page.keyboard.press('Escape');
  const source = '<script>window.previewUnsafe=true</script>\n<img src=x onerror="window.previewUnsafe=true">\nTravel notes – UTF-8 ✓';
  await upload(page, 'travel-notes.txt', Buffer.from(source), 'text/plain');
  await page.getByRole('button', { name: 'travel-notes.txt', exact: true }).click();
  const text = page.getByRole('dialog', { name: 'travel-notes.txt' });
  await expect(text.locator('pre')).toHaveText(source);
  await selectAndCopyText(page, text.locator('pre'), 'Travel notes – UTF-8 ✓');
  await expect(text.locator('script, img')).toHaveCount(0);
  expect(await page.evaluate(() => 'previewUnsafe' in window)).toBe(false);
});

test('legacy Word and TIFF use authenticated converted previews and download their originals', async ({ page, context }) => {
  await openFiles(page, context);
  const document = await readFile('tests/fixtures/document-preview/legacy-word.doc');
  await upload(page, 'legacy-word.doc', document, 'application/msword');
  await page.getByRole('button', { name: 'legacy-word.doc', exact: true }).click();
  const word = page.getByRole('dialog', { name: 'legacy-word.doc' });
  await expect(word.locator('pre')).toContainText('Legacy Word preview fixture');
  await expect(word.locator('pre')).toContainText('Unicode: café مرحبا');
  await expect(word.locator('pre')).toContainText('<script>alert("inert document text")</script>');
  await selectAndCopyText(page, word.locator('pre'), 'Legacy Word preview fixture');
  await expect(word.locator('script')).toHaveCount(0);
  await downloadCopy(page, 'legacy-word.doc', document);
  await downloadCopy(page, 'legacy-word.doc', document);
  await page.keyboard.press('Escape');

  const image = await sharp({ create: { width: 48, height: 30, channels: 3, background: '#1f7755' } }).tiff().toBuffer();
  await upload(page, 'scanned-receipt.tiff', image, 'image/tiff');
  await page.getByRole('button', { name: 'scanned-receipt.tiff', exact: true }).click();
  const tiff = page.getByRole('dialog', { name: 'scanned-receipt.tiff' });
  const picture = tiff.getByRole('img', { name: 'scanned-receipt.tiff', exact: true });
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(48);
  await expect(tiff.getByText('First page preview', { exact: true })).toBeVisible();
  await downloadCopy(page, 'scanned-receipt.tiff', image);
  await downloadCopy(page, 'scanned-receipt.tiff', image);
});

test('unsupported and damaged files retain a working original-file download', async ({ page, context }) => {
  await openFiles(page, context);
  const archive = Buffer.from(zipSync({ 'notes.txt': strToU8('Travel documents') }));
  await upload(page, 'documents.zip', archive, 'application/zip');
  await page.getByRole('button', { name: 'documents.zip', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'documents.zip' });
  await expect(dialog.getByText(/preview.*not available|cannot.*preview|can’t.*preview|download.*open/i).first()).toBeVisible();
  await downloadCopy(page, 'documents.zip', archive);
  await page.keyboard.press('Escape');
  const corrupt = Buffer.from('This is not a Word document.');
  await upload(page, 'damaged.docx', corrupt, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  await page.getByRole('button', { name: 'damaged.docx', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'damaged.docx' }).getByRole('alert')).toBeVisible();
  await downloadCopy(page, 'damaged.docx', corrupt);
});

test('authenticated previews retry failed reads and closing a pending read prevents stale content', async ({ page, context }) => {
  await openFiles(page, context);
  await upload(page, 'retry.txt', Buffer.from('Recovered preview content'), 'text/plain');
  await upload(page, 'second.txt', Buffer.from('Second document stays visible'), 'text/plain');
  const documents = '**/api/organizations/*/customers/*/bookings/*/documents/*';
  let requestHeaders: Record<string, string> = {};
  await page.route(documents, async route => {
    requestHeaders = await route.request().allHeaders();
    await route.fulfill({ status: 503, json: { message: 'Temporary preview outage' } });
  }, { times: 1 });
  await page.getByRole('button', { name: 'retry.txt', exact: true }).click();
  const retry = page.getByRole('dialog', { name: 'retry.txt' });
  await expect(retry.getByRole('alert')).toBeVisible();
  expect(requestHeaders['x-csrf-protection']).toBe('1');
  // The successful retry reaches the real session-protected endpoint; WebKit
  // does not expose its Cookie header on intercepted requests.
  await retry.getByRole('button', { name: 'Retry preview', exact: true }).click();
  await expect(retry.locator('pre')).toHaveText('Recovered preview content');
  await page.keyboard.press('Escape');

  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let complete!: () => void;
  const completed = new Promise<void>(resolve => { complete = resolve; });
  let intercepted = false;
  let pendingUrl = '';
  let aborted = false;
  page.on('requestfailed', request => { if (request.url() === pendingUrl) aborted = true; });
  await page.route(documents, async route => {
    intercepted = true;
    pendingUrl = route.request().url();
    await held;
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'Old request must never replace the new preview' }).catch(() => {});
    complete();
  }, { times: 1 });
  try {
    await page.getByRole('button', { name: 'retry.txt', exact: true }).click();
    await expect.poll(() => intercepted).toBe(true);
    await expect(retry.getByRole('status')).toContainText('Loading preview');
    await page.keyboard.press('Escape');
    await expect(retry).toHaveCount(0);
    await page.getByRole('button', { name: 'second.txt', exact: true }).click();
    const second = page.getByRole('dialog', { name: 'second.txt' });
    await expect(second.locator('pre')).toHaveText('Second document stays visible');
    release();
    await completed;
    await expect.poll(() => aborted).toBe(true);
    await expect(second.locator('pre')).toHaveText('Second document stays visible');
    await expect(page.getByText('Old request must never replace the new preview', { exact: true })).toHaveCount(0);
  } finally { release(); }
});
