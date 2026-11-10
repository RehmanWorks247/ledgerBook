import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

let orgId: string;
const errors = new WeakMap<Page, string[]>();
test.beforeAll(async () => { ({ orgId } = JSON.parse(await readFile('.local/e2e/seed.json', 'utf8'))); });
test.beforeEach(async ({ page, context }) => {
  const response = await context.request.post('/api/auth/login', {
    headers: { Origin: 'http://127.0.0.1:4312', 'X-CSRF-Protection': '1' },
    data: { email: 'admin@example.test', password: 'Test-only password 47!' },
  });
  expect(response.status()).toBe(200);
  await context.addInitScript(() => { localStorage.setItem('e2e-email', 'admin@example.test'); });
  await context.route('**/api/auth/config', route => route.fulfill({ json: { provider: 'clerk', publishableKey: 'isolated-test-only' } }));
  const list: string[] = []; errors.set(page, list); page.on('pageerror', error => list.push(error.message));
  await page.goto(`/o/${orgId}/settings`);
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible();
});
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });
async function events(page: Page, method: string) {
  return page.evaluate(name => JSON.parse(sessionStorage.getItem('e2e-account-events') ?? '[]').filter((event: { method: string }) => event.method === name), method);
}

test('custom account controls share Settings navigation, preserve profile edits on failure, and fit mobile themes', async ({ page }) => {
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link', { name: 'Account settings', exact: true })).toHaveCount(0);
  await expect(page.locator('.cl-userProfile-root, iframe')).toHaveCount(0);
  const profile = page.getByRole('region', { name: 'Profile', exact: true });
  await profile.getByLabel('First name', { exact: true }).fill('Aisha');
  await profile.getByLabel('Last name', { exact: true }).fill('Khan');
  await page.evaluate(() => localStorage.setItem('e2e-account-fail', 'user.update'));
  await profile.getByRole('button', { name: 'Save profile' }).click();
  await expect(profile.getByRole('alert')).toContainText('Temporary account service failure');
  await expect(profile.getByLabel('First name', { exact: true })).toHaveValue('Aisha');
  await profile.getByRole('button', { name: 'Save profile' }).click();
  await expect(profile.getByRole('status')).toContainText('Profile saved.');
  await page.reload();
  await expect(profile.getByLabel('First name', { exact: true })).toHaveValue('Aisha');
  await page.screenshot({ path: '.local/e2e/account-settings-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: '.local/e2e/account-settings-mobile-dark.png', fullPage: true });
  await page.goto('/account?from=bookmark#/security');
  await expect(page).toHaveURL('/settings?from=bookmark#/security');
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('email verification can recover after delivery failure, rejects bad codes, and gates primary email changes', async ({ page }) => {
  const emails = page.getByRole('region', { name: 'Email addresses', exact: true });
  await emails.getByLabel('Add an email address', { exact: true }).fill('new@example.test');
  await page.evaluate(() => localStorage.setItem('e2e-account-fail', 'email.prepare'));
  await emails.getByRole('button', { name: 'Add email address', exact: true }).click();
  await expect(emails.getByRole('alert')).toContainText('Temporary account service failure');
  await expect(emails.getByLabel('Email verification code')).toBeVisible();
  await expect(emails.getByRole('button', { name: 'Make primary' })).toHaveCount(0);
  await emails.getByRole('button', { name: 'Resend code' }).click();
  await expect(emails.getByRole('status')).toContainText('new verification code');
  expect(await events(page, 'email.create')).toHaveLength(1);
  await emails.getByLabel('Email verification code').fill('000000');
  await emails.getByRole('button', { name: 'Verify email address', exact: true }).click();
  await expect(emails.getByRole('alert')).toContainText('incorrect');
  await emails.getByLabel('Email verification code').fill('123456');
  await emails.getByRole('button', { name: 'Verify email address', exact: true }).click();
  await expect(emails.getByRole('status')).toContainText('Email verified.');
  const added = emails.getByRole('listitem').filter({ hasText: 'new@example.test' });
  await added.getByRole('button', { name: 'Make primary' }).click();
  await expect(added).toContainText('Primary');
  await expect(added.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
  const previous = emails.getByRole('listitem').filter({ hasText: 'admin@example.test' });
  await previous.getByRole('button', { name: 'Remove', exact: true }).click();
  await previous.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await events(page, 'email.remove')).toHaveLength(0);
  await previous.getByRole('button', { name: 'Remove', exact: true }).click();
  await previous.getByRole('button', { name: 'Remove email', exact: true }).click();
  await expect(previous).toHaveCount(0);
  await page.reload();
  await expect(emails.getByRole('listitem')).toHaveCount(1);
  await expect(emails.getByRole('listitem')).toContainText('new@example.test');
});

test('password changes validate confirmation and current password, then complete custom multi-factor verification', async ({ page }) => {
  const password = page.getByRole('region', { name: 'Password', exact: true });
  await password.getByLabel('Current password', { exact: true }).fill('Test-only password 47!');
  await expect(password.getByText('At least 8 characters. No special characters required.')).toBeVisible();
  await password.getByLabel('New password', { exact: true }).fill('abcdefg');
  await password.getByLabel('Confirm new password', { exact: true }).fill('abcdefg');
  await password.getByRole('button', { name: 'Update password' }).click();
  expect(await events(page, 'password.update')).toHaveLength(0);
  await password.getByLabel('Current password', { exact: true }).fill('incorrect password');
  await password.getByLabel('New password', { exact: true }).fill('abcdefgh');
  await password.getByLabel('Confirm new password', { exact: true }).fill('ijklmnop');
  await password.getByRole('button', { name: 'Update password' }).click();
  await expect(password.getByRole('alert')).toContainText('do not match');
  expect(await events(page, 'password.update')).toHaveLength(0);
  await password.getByLabel('Confirm new password', { exact: true }).fill('abcdefgh');
  await password.getByRole('button', { name: 'Update password' }).click();
  await expect(password.getByRole('alert')).toContainText('Current password is incorrect');
  await password.getByLabel('Current password', { exact: true }).fill('Test-only password 47!');
  await page.evaluate(() => localStorage.setItem('e2e-reverification', 'mfa'));
  await password.getByRole('button', { name: 'Update password' }).click();
  const dialog = page.getByRole('dialog', { name: 'Verify it’s you' });
  await dialog.getByLabel('Password', { exact: true }).fill('Test-only password 47!');
  await dialog.getByRole('button', { name: 'Verify & continue' }).click();
  await expect(dialog.getByLabel('Verification method')).toHaveValue('0');
  await dialog.getByLabel('Verification code', { exact: true }).fill('000000');
  await dialog.getByRole('button', { name: 'Verify & continue' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Invalid authenticator code');
  expect(await events(page, 'password.update')).toHaveLength(1);
  await dialog.getByLabel('Verification code', { exact: true }).fill('654321');
  await dialog.getByRole('button', { name: 'Verify & continue' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(password.getByRole('status')).toContainText('Other devices have been signed out');
  await expect(password.getByLabel('Current password', { exact: true })).toHaveValue('');
  await expect(password.getByLabel('New password', { exact: true })).toHaveValue('');
  await expect(password.getByLabel('Confirm new password', { exact: true })).toHaveValue('');
  await expect(page.getByRole('region', { name: 'Signed-in devices' }).getByRole('listitem')).toHaveCount(1);
});

test('custom verification cancellation makes no change and email-code verification resumes the original action', async ({ page }) => {
  const profile = page.getByRole('region', { name: 'Profile', exact: true });
  await profile.getByLabel('First name', { exact: true }).fill('Updated');
  await page.evaluate(() => localStorage.setItem('e2e-reverification', 'first_factor'));
  await profile.getByRole('button', { name: 'Save profile' }).click();
  const dialog = page.getByRole('dialog', { name: 'Verify it’s you' });
  await expect(dialog.getByLabel('Password', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(profile.getByRole('button', { name: 'Save profile' })).toBeEnabled();
  expect(await events(page, 'user.update')).toHaveLength(0);
  await profile.getByRole('button', { name: 'Save profile' }).click();
  await dialog.getByLabel('Verification method').selectOption('1');
  await expect(dialog.getByRole('button', { name: 'Verify & continue' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Send code' }).click();
  await dialog.getByLabel('Verification code', { exact: true }).fill('123456');
  await dialog.getByRole('button', { name: 'Verify & continue' }).click();
  await expect(profile.getByRole('status')).toContainText('Profile saved.');
  expect(await events(page, 'user.update')).toHaveLength(1);
});

test('failed device sign-out keeps the device visible and successful retry removes only that device', async ({ page }) => {
  const devices = page.getByRole('region', { name: 'Signed-in devices' });
  await expect(devices.getByRole('listitem')).toHaveCount(2);
  await page.evaluate(() => localStorage.setItem('e2e-account-fail', 'session.revoke'));
  await devices.getByRole('button', { name: 'Sign out device', exact: true }).click();
  await expect(devices.getByRole('alert')).toContainText('Temporary account service failure');
  await expect(devices.getByRole('listitem')).toHaveCount(2);
  await devices.getByRole('button', { name: 'Sign out device', exact: true }).click();
  await expect(devices.getByRole('listitem')).toHaveCount(1);
  await expect(devices.getByRole('listitem')).toContainText('This device');
  await expect(devices.getByRole('status')).toContainText('Device signed out.');
  expect(await events(page, 'session.revoke')).toEqual([
    { method: 'session.revoke', data: 'other-device' }, { method: 'session.revoke', data: 'other-device' },
  ]);
});

test('account changes request the strongest available verification when the provider omits a level', async ({ page }) => {
  const emails = page.getByRole('region', { name: 'Email addresses', exact: true });
  await emails.getByLabel('Add an email address', { exact: true }).fill('verified-session@example.test');
  await page.evaluate(() => localStorage.setItem('e2e-reverification', 'strongest'));
  await emails.getByRole('button', { name: 'Add email address', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Verify it’s you' });
  await expect(dialog.getByLabel('Verification code', { exact: true })).toBeVisible();
  expect(await events(page, 'verification.start')).toEqual([{ method: 'verification.start', data: { level: 'second_factor' } }]);
  expect(await events(page, 'email.create')).toHaveLength(0);
  await dialog.getByLabel('Verification code', { exact: true }).fill('654321');
  await dialog.getByRole('button', { name: 'Verify & continue' }).click();
  await expect(emails.getByLabel('Email verification code')).toBeVisible();
  expect(await events(page, 'email.create')).toHaveLength(1);
});
