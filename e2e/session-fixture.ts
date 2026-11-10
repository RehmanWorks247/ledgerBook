import type { BrowserContext } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/** Reuse real HTTP sessions created once for this disposable browser server. */
export async function fixtureSessionCookies(email: string) {
  const seed = JSON.parse(await readFile('.local/e2e/seed.json', 'utf8')) as {
    sessions: Record<string, Awaited<ReturnType<BrowserContext['cookies']>>>;
  };
  const cookies = seed.sessions[email];
  if (!cookies?.length) throw new Error(`Missing browser fixture session for ${email}`);
  return cookies;
}

export async function authenticateFixture(context: BrowserContext, email = 'admin@example.test') {
  await context.addCookies(await fixtureSessionCookies(email));
}
