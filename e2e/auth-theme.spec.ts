import { test, expect, type BrowserContext } from '@playwright/test';

async function publicAuth(context: BrowserContext) {
  await context.route('**/api/auth/config', route => route.fulfill({
    json: { provider: 'clerk', publishableKey: 'isolated-test-only' },
  }));
}

test('branded login changes appearance without losing form input and remembers customization', async ({ page, context }) => {
  await publicAuth(context);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/login');
  await expect(page.locator('.umrah-auth')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'gold');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  const logo = page.getByRole('img', { name: 'Umrah Packages UK', exact: true });
  await expect(logo).toBeVisible();
  await expect.poll(() => logo.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  await expect(logo).toHaveAttribute('src', '/branding/umrah-packages-source.png');
  const signIn = page.getByRole('button', { name: 'Sign in', exact: true });
  await expect(signIn).toHaveCSS('background-color', 'rgb(219, 170, 58)');
  await page.screenshot({ path: '.local/e2e/auth-light.png', fullPage: true });
  await page.getByRole('textbox', { name: 'Email address', exact: true }).fill('traveller@example.test');
  await page.getByLabel('Password', { exact: true }).fill('Unsubmitted form value');
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(logo).toHaveAttribute('src', '/branding/umrah-packages-logo-dark-transparent.png');
  await expect(signIn).toHaveCSS('background-color', 'rgb(219, 170, 58)');
  await expect.poll(() => logo.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  await expect(page.getByRole('textbox', { name: 'Email address', exact: true })).toHaveValue('traveller@example.test');
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('Unsubmitted form value');
  await page.screenshot({ path: '.local/e2e/auth-dark.png', fullPage: true });

  const buttonColor = await signIn.evaluate(element => getComputedStyle(element).backgroundColor);
  await page.getByRole('button', { name: 'Customize appearance', exact: true }).click();
  await page.getByRole('radio', { name: 'Blue', exact: true }).check();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue');
  await expect.poll(() => signIn.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(buttonColor);
  await page.getByRole('radio', { name: 'System', exact: true }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Customize appearance', exact: true })).toBeFocused();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Customize appearance', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Blue', exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'System', exact: true })).toBeChecked();
  expect(errors).toEqual([]);
});

test('mobile login and appearance controls fit light and dark layouts, and recovery retains the branding', async ({ page, context }) => {
  await publicAuth(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/login');
  const logo = page.getByRole('img', { name: 'Umrah Packages UK', exact: true });
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute('src', '/branding/umrah-packages-source.png');
  await expect.poll(() => logo.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/e2e/auth-mobile-light.png', fullPage: true });
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
  await expect(logo).toHaveAttribute('src', '/branding/umrah-packages-logo-dark-transparent.png');
  await expect.poll(() => logo.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  await page.screenshot({ path: '.local/e2e/auth-mobile-dark.png', fullPage: true });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.getByRole('button', { name: 'Customize appearance', exact: true }).click();
  await page.getByRole('radio', { name: 'Gold', exact: true }).check();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Forgot password?', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reset your password', exact: true })).toBeVisible();
  await expect(page.locator('.umrah-auth')).toBeVisible();
  await expect(logo).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send reset code', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
});

test('a previously saved palette remains selected on the new login screen', async ({ page, context }) => {
  await publicAuth(context);
  await context.addInitScript(() => {
    localStorage.setItem('ledgerbook-accent', 'green');
    localStorage.setItem('ledgerbook-theme', 'dark');
  });
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'green');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Customize appearance', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Emerald', exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked();
});
