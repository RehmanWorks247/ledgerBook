import { fixtureSessionCookies } from './session-fixture';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const origin = 'http://127.0.0.1:4312';
const writeHeaders = { Origin: origin, 'X-CSRF-Protection': '1' };
type Workspace = { id: string; name: string; description: string; color: string; version: number };
let seed: { orgId: string; customerId: string };
let adminCookies: Awaited<ReturnType<BrowserContext['cookies']>>;
let customerCookies: Awaited<ReturnType<BrowserContext['cookies']>>;
const fixtures = new WeakMap<BrowserContext, Set<string>>();
const pageErrors = new WeakMap<Page, string[]>();

test.beforeAll(async () => {
  seed = JSON.parse(await readFile('.local/e2e/seed.json', 'utf8'));
  adminCookies = await fixtureSessionCookies('admin@example.test');
  customerCookies = await fixtureSessionCookies('customer@example.test');
});

test.beforeEach(({ context, page }) => {
  fixtures.set(context, new Set());
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
});

test.afterEach(async ({ context, page }) => {
  // Only delete IDs created by this test. The shared seed workspace and its
  // customers remain available to all other browser suites.
  for (const id of fixtures.get(context) ?? []) {
    expect(id).not.toBe(seed.orgId);
    const current = await context.request.get(`${origin}/api/organizations/${id}`);
    if (current.status() === 404) continue;
    expect(current.status(), await current.text()).toBe(200);
    const workspace = await current.json() as Workspace;
    const removed = await context.request.delete(`${origin}/api/organizations/${id}`, {
      headers: writeHeaders, data: { confirmation_name: workspace.name, expected_version: workspace.version },
    });
    expect(removed.status(), await removed.text()).toBe(200);
  }
  expect(pageErrors.get(page)).toEqual([]);
});

async function authenticate(context: BrowserContext, customer = false) {
  await context.addCookies(customer ? customerCookies : adminCookies);
  await context.addInitScript(email => {
    localStorage.setItem('e2e-email', email);
    localStorage.setItem('ledgerbook-accent', 'blue');
  }, customer ? 'customer@example.test' : 'admin@example.test');
  await context.route('**/api/auth/config', route => route.fulfill({ json: { provider: 'clerk', publishableKey: 'isolated-test-only' } }));
}

function track(context: BrowserContext, workspace: Workspace) {
  fixtures.get(context)!.add(workspace.id);
  return workspace;
}

async function createWorkspace(context: BrowserContext, name = `Workspace fixture ${randomUUID().slice(0, 8)}`) {
  const response = await context.request.post(`${origin}/api/organizations`, {
    headers: writeHeaders,
    data: { name, description: 'Isolated workspace browser fixture', color: '#284fa0', idempotency_key: randomUUID() },
  });
  expect(response.status(), await response.text()).toBe(201);
  return track(context, await response.json() as Workspace);
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
}

test('admins create, customize, switch, and permanently delete a workspace on desktop and mobile', async ({ page, context }) => {
  await authenticate(context);
  await page.goto('/workspaces');
  await expect(page.getByRole('heading', { name: 'Workspaces', exact: true })).toBeVisible();
  const trigger = page.getByRole('button', { name: 'Create workspace', exact: true });
  await trigger.click();
  let dialog = page.getByRole('dialog', { name: 'Create a workspace', exact: true });
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await dialog.getByRole('button', { name: 'Close workspace dialog', exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Create workspace', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Close workspace dialog', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await noHorizontalOverflow(page);
  await trigger.click();
  dialog = page.getByRole('dialog', { name: 'Create a workspace', exact: true });
  const name = `Browser travel ${randomUUID().slice(0, 8)}`;
  await dialog.getByLabel('Workspace name', { exact: true }).fill(name);
  await dialog.getByLabel(/^Description/).fill('Travel operations for the northern office.');
  await dialog.getByLabel('Hex color', { exact: true }).fill('#a93864');
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(391);
  expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: '.local/e2e/workspace-create-mobile.png', fullPage: true });
  const createdResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/organizations' && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Create workspace', exact: true }).click();
  const response = await createdResponse;
  expect(response.status(), await response.text()).toBe(201);
  const workspace = track(context, await response.json() as Workspace);
  await expect(page).toHaveURL(`/o/${workspace.id}`);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole('link', { name: 'Workspaces', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  const details = page.getByRole('region', { name: 'Workspace details', exact: true });
  await expect(details.getByLabel('Workspace name', { exact: true })).toHaveValue(name);
  const editedName = `Edited workspace ${randomUUID().slice(0, 8)}`;
  await details.getByLabel('Workspace name', { exact: true }).fill(editedName);
  await details.getByLabel(/^Description/).fill('Updated description for switching and search.');
  await details.getByLabel('Hex color', { exact: true }).fill('#e7b631');
  await details.getByRole('button', { name: 'Save workspace', exact: true }).click();
  await expect(details.getByRole('status')).toHaveText('Workspace details saved.');
  await expect(page.locator('.organization-label strong')).toHaveText(editedName);
  await expect(page.locator('.organization-monogram')).toHaveCSS('background-color', 'rgb(231, 182, 49)');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue');
  await page.screenshot({ path: '.local/e2e/workspace-settings-desktop.png', fullPage: true });
  const saved = await context.request.get(`${origin}/api/organizations/${workspace.id}`);
  expect(await saved.json()).toMatchObject({ name: editedName, description: 'Updated description for switching and search.', color: '#e7b631', version: 2 });

  await page.getByRole('link', { name: 'Workspaces', exact: true }).click();
  await page.getByLabel('Search workspaces', { exact: true }).fill('switching and search');
  await expect(page.locator('.workspace-management-card')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: editedName, exact: true })).toBeVisible();
  await page.getByLabel('Search workspaces', { exact: true }).fill('');
  await page.screenshot({ path: '.local/e2e/workspaces-desktop.png', fullPage: true });
  await page.locator(`.workspace-card[href="/o/${seed.orgId}"]`).click();
  await expect(page).toHaveURL(`/o/${seed.orgId}`);
  await expect(page.locator('.organization-label strong')).not.toHaveText(editedName);
  await page.getByRole('link', { name: 'Workspaces', exact: true }).click();
  await page.getByRole('link', { name: `Manage ${editedName}`, exact: true }).click();
  await expect(details.getByLabel('Workspace name', { exact: true })).toHaveValue(editedName);
  await page.setViewportSize({ width: 390, height: 844 });
  await noHorizontalOverflow(page);
  await details.getByRole('button', { name: 'Delete workspace', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: 'Permanently delete workspace?', exact: true });
  await expect(deletion).toContainText('This cannot be undone.');
  await expect(deletion).toContainText('ledger history will be permanently removed');
  await expect(deletion).toContainText('after upload links expire');
  const remove = deletion.getByRole('button', { name: 'Delete workspace permanently', exact: true });
  await expect(remove).toBeDisabled();
  await deletion.getByRole('textbox').fill(editedName.toLowerCase());
  await expect(remove).toBeDisabled();
  await deletion.getByRole('textbox').fill(`${editedName} `);
  await expect(remove).toBeDisabled();
  await deletion.getByRole('textbox').fill(editedName);
  await expect(remove).toBeEnabled();
  await noHorizontalOverflow(page);
  await remove.click();
  await expect(page).toHaveURL('/workspaces?deleted=1');
  await expect(page.getByText('Workspace permanently deleted.', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: editedName, exact: true })).toHaveCount(0);
  expect((await context.request.get(`${origin}/api/organizations/${workspace.id}`)).status()).toBe(404);
  expect((await context.request.get(`${origin}/api/organizations/${seed.orgId}`)).status()).toBe(200);
  await noHorizontalOverflow(page);
  await page.screenshot({ path: '.local/e2e/workspaces-mobile.png', fullPage: true });
});

test('customers land on bookings without workspace navigation or settings on desktop and mobile', async ({ page, context }) => {
  await authenticate(context, true);
  await page.goto('/workspaces');
  await expect(page).toHaveURL(`/o/${seed.orgId}/users/${seed.customerId}`);
  await expect(page.getByRole('heading', { name: 'My bookings', exact: true })).toBeVisible();
  await expect(page.locator('.workspace-card, .organization-label, .breadcrumb')).toHaveCount(0);
  await expect(page.locator('a[href="/workspaces"]')).toHaveCount(0);
  await expect(page.getByText(/workspace/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create workspace', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Manage / })).toHaveCount(0);
  await page.screenshot({ path: '.local/e2e/customer-account-desktop.png', fullPage: true });
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Workspace details', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Save workspace|Delete workspace/ })).toHaveCount(0);
  await expect(page.getByText(/workspace/i)).toHaveCount(0);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
  await expect(page.locator('a[href="/workspaces"]')).toHaveCount(0);
  await expect(page.getByText(/workspace/i)).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to my account', exact: true }).click();
  await expect(page).toHaveURL(`/o/${seed.orgId}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByRole('link', { name: 'My account', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'My bookings', exact: true })).toBeVisible();
  await expect(page.locator('a[href="/workspaces"]')).toHaveCount(0);
  await expect(page.getByText(/workspace/i)).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.screenshot({ path: '.local/e2e/customer-navigation-mobile.png', fullPage: true, animations: 'disabled' });
  await nav.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
  await expect(page.getByText(/workspace/i)).toHaveCount(0);
});

test('stale workspace edits require an explicit reload before saving again', async ({ page, context }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  await page.goto(`/o/${workspace.id}/settings`);
  const details = page.getByRole('region', { name: 'Workspace details', exact: true });
  await expect(details.getByLabel('Workspace name', { exact: true })).toHaveValue(workspace.name);
  await details.getByLabel('Workspace name', { exact: true }).fill('Unsaved local change');
  const external = await context.request.patch(`${origin}/api/organizations/${workspace.id}`, {
    headers: writeHeaders,
    data: { name: 'Saved by another administrator', description: 'Latest shared description', color: '#5f256c', expected_version: workspace.version },
  });
  expect(external.status(), await external.text()).toBe(200);
  await details.getByRole('button', { name: 'Save workspace', exact: true }).click();
  await expect(details.getByRole('alert')).toBeVisible();
  await expect(details.getByLabel('Workspace name', { exact: true })).toHaveValue('Unsaved local change');
  await expect(details.getByRole('button', { name: 'Save workspace', exact: true })).toBeDisabled();
  await details.getByRole('button', { name: 'Reload saved details', exact: true }).click();
  await expect(details.getByLabel('Workspace name', { exact: true })).toHaveValue('Saved by another administrator');
  await expect(details.getByLabel(/^Description/)).toHaveValue('Latest shared description');
  await expect(details.getByLabel('Hex color', { exact: true })).toHaveValue('#5f256c');
  await details.getByLabel('Workspace name', { exact: true }).fill('Resolved workspace name');
  await details.getByRole('button', { name: 'Save workspace', exact: true }).click();
  await expect(details.getByRole('status')).toHaveText('Workspace details saved.');
  const saved = await context.request.get(`${origin}/api/organizations/${workspace.id}`);
  expect(await saved.json()).toMatchObject({ name: 'Resolved workspace name', version: 3 });
});

test('creation retries reuse one key and a failed session refresh does not create duplicates', async ({ page, context }) => {
  await authenticate(context);
  await page.goto('/workspaces');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a workspace', exact: true });
  const name = `Retry create ${randomUUID().slice(0, 8)}`;
  await dialog.getByLabel('Workspace name', { exact: true }).fill(name);
  const keys: string[] = [];
  let workspace: Workspace | undefined;
  await page.route('**/api/organizations', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().postDataJSON().idempotency_key);
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    workspace = track(context, await response.json() as Workspace);
    if (keys.length === 1) return route.fulfill({ status: 503, json: { message: 'Simulated lost creation response' } });
    await route.fulfill({ response });
  });
  await page.route('**/api/auth/session', route => route.fulfill({ status: 503, json: { message: 'Temporary session refresh outage' } }), { times: 1 });
  await dialog.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Simulated lost creation response');
  await dialog.getByRole('button', { name: 'Create workspace', exact: true }).click();
  const created = page.getByRole('dialog', { name: 'Workspace created', exact: true });
  await expect(created.getByRole('status')).toContainText('was created successfully');
  await expect(created.getByRole('alert')).toContainText('workspace was created');
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  const session = await context.request.get(`${origin}/api/auth/session`);
  expect((await session.json()).memberships.filter((member: { organization_name: string }) => member.organization_name === name)).toHaveLength(1);
  await created.getByRole('button', { name: 'Refresh access & open', exact: true }).click();
  await expect(page).toHaveURL(`/o/${workspace!.id}`);
  expect(keys).toHaveLength(2);
});

test('committed deletion survives response and session refresh failures without another destructive request', async ({ page, context }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  await page.goto(`/o/${workspace.id}/settings`);
  await expect(page.getByLabel('Workspace name', { exact: true })).toHaveValue(workspace.name);
  await page.getByRole('button', { name: 'Delete workspace', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: 'Permanently delete workspace?', exact: true });
  await deletion.getByRole('textbox').fill(workspace.name);
  const requests: unknown[] = [];
  await page.route(`**/api/organizations/${workspace.id}`, async route => {
    if (route.request().method() !== 'DELETE') return route.continue();
    requests.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    if (requests.length === 1) return route.fulfill({ status: 503, json: { message: 'Simulated lost deletion response' } });
    await route.fulfill({ response });
  });
  await page.route('**/api/auth/session', route => route.fulfill({ status: 503, json: { message: 'Temporary session refresh outage' } }), { times: 1 });
  await deletion.getByRole('button', { name: 'Delete workspace permanently', exact: true }).click();
  await expect(deletion.getByRole('alert')).toHaveText('Simulated lost deletion response');
  expect((await context.request.get(`${origin}/api/organizations/${workspace.id}`)).status()).toBe(404);
  await deletion.getByRole('button', { name: 'Delete workspace permanently', exact: true }).click();
  const deleted = page.getByRole('dialog', { name: 'Workspace deleted', exact: true });
  await expect(deleted.getByRole('status')).toContainText('Workspace deletion is complete');
  await expect(deleted.getByRole('alert')).toContainText('permanently deleted');
  await expect(deleted.getByRole('button', { name: 'Close workspace dialog', exact: true })).toBeDisabled();
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  await deleted.getByRole('button', { name: 'Refresh workspace list', exact: true }).click();
  await expect(page).toHaveURL('/workspaces?deleted=1');
  expect(requests).toHaveLength(2);
  await expect(page.getByRole('heading', { name: workspace.name, exact: true })).toHaveCount(0);
});

test('a superseded post-create refresh keeps completion visible until access is refreshed successfully', async ({ page, context }) => {
  await authenticate(context);
  await page.goto('/workspaces');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a workspace', exact: true });
  const name = `Refresh race ${randomUUID().slice(0, 8)}`;
  await dialog.getByLabel('Workspace name', { exact: true }).fill(name);
  let createRequests = 0, sessionRequests = 0;
  let firstSessionHeld = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let workspace: Workspace | undefined;
  await page.route('**/api/organizations', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    createRequests++;
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    workspace = track(context, await response.json() as Workspace);
    await route.fulfill({ response });
  });
  await page.route('**/api/auth/session', async route => {
    sessionRequests++;
    if (sessionRequests === 1) {
      const response = await route.fetch();
      firstSessionHeld = true;
      await held;
      await route.fulfill({ response });
    } else if (sessionRequests === 2) {
      await route.fulfill({ status: 503, json: { message: 'Background session refresh unavailable' } });
    } else await route.continue();
  });
  try {
    await dialog.getByRole('button', { name: 'Create workspace', exact: true }).click();
    await expect.poll(() => firstSessionHeld).toBe(true);
    const created = page.getByRole('dialog', { name: 'Workspace created', exact: true });
    await expect(created.getByRole('status')).toContainText('was created successfully');
    // A focus refresh supersedes the still-pending mutation refresh. Its failed
    // response must not remove the successful creation or unlock stale access.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => sessionRequests).toBe(2);
    release();
    await expect(created.getByRole('alert')).toContainText('workspace was created');
    await expect(page).toHaveURL('/workspaces');
    expect(createRequests).toBe(1);
    await created.getByRole('button', { name: 'Refresh access & open', exact: true }).click();
    await expect(page).toHaveURL(`/o/${workspace!.id}`);
    expect(createRequests).toBe(1);
    expect(sessionRequests).toBe(3);
  } finally { release(); }
});
