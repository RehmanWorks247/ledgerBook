import { authenticateFixture } from './session-fixture';
import { test, expect, type BrowserContext } from '@playwright/test';
import { readFile } from 'node:fs/promises';

let orgId: string;
test.beforeAll(async () => { ({ orgId } = JSON.parse(await readFile('.local/e2e/seed.json', 'utf8'))); });

async function authenticate(context: BrowserContext) {
  await authenticateFixture(context, 'admin@example.test');
  await context.addInitScript(() => localStorage.setItem('e2e-email', 'admin@example.test'));
  await context.route('**/api/auth/config', route => route.fulfill({ json: { provider: 'clerk', publishableKey: 'isolated-test-only' } }));
}

function gate() {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { pending, release };
}

test('a slow first page download keeps the shell visible and navigation responsive', async ({ page, context }) => {
  await authenticate(context);
  const download = gate();
  await page.route('**/src/companies/CompaniesPage.tsx*', async route => {
    await download.pending;
    await route.continue();
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`/o/${orgId}`);
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
    const shell = await page.locator('.app-shell').elementHandle();
    let documents = 0;
    page.on('request', request => { if (request.resourceType() === 'document') documents++; });
    await nav.getByRole('link', { name: 'Companies', exact: true }).click();
    await expect(page.getByRole('status', { name: 'Loading page', exact: true })).toBeVisible();
    await expect(nav).toBeVisible();
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Companies', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.loading.full')).toHaveCount(0);
    // The user can leave a pending tab without waiting for its download.
    await nav.getByRole('link', { name: 'Overview', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
    download.release();
    await nav.getByRole('link', { name: 'Companies', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Companies', exact: true })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Overview', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.goForward();
    await expect(page.getByRole('heading', { name: 'Companies', exact: true })).toBeVisible();
    expect(await shell!.evaluate(element => element === document.querySelector('.app-shell'))).toBe(true);
    expect(documents).toBe(0);
    expect(errors).toEqual([]);
  } finally { download.release(); }
});

test('table skeletons stay local; revisits and refreshes retain rows while filters never show another query', async ({ page, context }) => {
  await authenticate(context);
  let response = gate();
  let requests = 0;
  await page.route(`**/api/organizations/${orgId}/customers?*`, async route => {
    requests++;
    await response.pending;
    await route.continue();
  });
  try {
    await page.goto(`/o/${orgId}/customers`);
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    const customer = page.getByRole('link', { name: /Aster Studio customer@example.test/ });
    await expect(page.getByRole('status', { name: 'Loading customers', exact: true })).toBeVisible();
    await expect(nav).toBeVisible();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('.table-skeleton .skeleton').first()).toHaveCSS('animation-name', 'none');
    await page.screenshot({ path: '.local/e2e/navigation-skeleton-desktop.png', fullPage: true });
    response.release();
    await expect(customer).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh customers', exact: true })).toBeEnabled();

    await nav.getByRole('link', { name: 'Overview', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
    response = gate();
    const beforeReturn = requests;
    await nav.getByRole('link', { name: 'Customer Data', exact: true }).click();
    await expect.poll(() => requests).toBeGreaterThan(beforeReturn);
    await expect(customer).toBeVisible();
    await expect(page.locator('.table-skeleton, .loading.full')).toHaveCount(0);
    response.release();
    await expect(page.getByRole('button', { name: 'Refresh customers', exact: true })).toBeEnabled();

    response = gate();
    await page.getByRole('button', { name: 'Refresh customers', exact: true }).click();
    await expect(customer).toBeVisible();
    await expect(page.locator('.table-skeleton')).toHaveCount(0);
    response.release();
    await expect(page.getByRole('button', { name: 'Refresh customers', exact: true })).toBeEnabled();

    response = gate();
    await page.getByLabel('Search customers').fill('no-such-customer');
    await expect(page.getByRole('status', { name: 'Loading customers', exact: true })).toBeVisible();
    await expect(customer).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '.local/e2e/navigation-skeleton-mobile.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await expect(nav).toBeVisible();
    await nav.getByRole('link', { name: 'Overview', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
    response.release();
  } finally { response.release(); }
});

test('a failed table request stops its skeleton and can retry without hiding navigation', async ({ page, context }) => {
  await authenticate(context);
  let fail = true;
  await page.route(`**/api/organizations/${orgId}/customers?*`, async route => {
    if (fail) await route.fulfill({ status: 503, json: { message: 'Customers are temporarily unavailable.' } });
    else await route.continue();
  });
  await page.goto(`/o/${orgId}/customers`);
  await expect(page.getByRole('alert')).toHaveText('Customers are temporarily unavailable.');
  await expect(page.locator('.table-skeleton, .loading.full')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('link', { name: /Aster Studio customer@example.test/ })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
