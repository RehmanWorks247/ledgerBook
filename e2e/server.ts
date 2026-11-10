import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pdfPreviewAssets } from '../apps/web/pdf-preview-assets';
import { request } from '@playwright/test';

async function main() {
  if (process.env.NODE_ENV !== 'test' || process.env.AUTH_PROVIDER !== 'local'
      || process.env.EMAIL_MODE !== 'file' || process.env.DOCUMENT_STORAGE !== 'database')
    throw new Error('Browser fixture requires the isolated test environment.');
  if (process.env.TEST_DATABASE_URL && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.TEST_DATABASE_URL).hostname))
    throw new Error('Browser fixture requires a disposable loopback test database.');
  process.env.PUBLIC_APP_URL = 'http://127.0.0.1:4312';
  process.env.BUSINESS_TIME_ZONE = 'Asia/Karachi';
  process.env.MAIL_DIRECTORY = resolve('.local/e2e/mail');
  // Never read .env: only the disposable TEST_DATABASE_URL is permitted.
  delete process.env.DATABASE_URL;
  const [{ setupTestDatabase }, { createApp }, { RatesService }, { createServer }, { default: react }] = await Promise.all([
    import('../tests/helpers'), import('../apps/api/src/app'),
    import('../apps/api/src/currency/rates.service'), import('vite'), import('@vitejs/plugin-react'),
  ]);
  const database = await setupTestDatabase();
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  let closing: Promise<void> | undefined;
  function close() {
    return closing ??= (async () => {
      try { await vite?.close(); }
      finally { try { await app?.close(); } finally { await database.close(); } }
    })();
  }
  const stop = () => { void close().then(() => process.exit(0), () => process.exit(1)); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
  const seed = await database.seed();
  await database.db.query("UPDATE organizations SET currency='GBP'");
  await mkdir('.local/e2e', { recursive: true, mode: 0o700 });
  app = await createApp({ database: database.db, logger: false });
  app.get(RatesService).get = async () => ({ fetched_at: new Date().toISOString(), unavailable: false, rates: {
    GBP: { rate: '1', date: '2026-11-09', source: 'identity', stale: false },
    USD: { rate: '1.3', date: '2026-11-09', source: 'Frankfurter', stale: false },
    PKR: { rate: '360', date: '2026-11-09', source: 'Frankfurter', stale: false },
  } });
  await app.listen(4311, '127.0.0.1');
  // Authenticate each fixture identity once through the actual HTTP boundary.
  // Repeated feature tests must not exhaust the unchanged login rate limits.
  const sessions: Record<string, Awaited<ReturnType<import('@playwright/test').BrowserContext['cookies']>>> = {};
  for (const email of ['admin@example.test', 'customer@example.test']) {
    const client = await request.newContext();
    try {
      const login = await client.post('http://127.0.0.1:4311/api/auth/login', {
        headers: { Origin: process.env.PUBLIC_APP_URL, 'X-CSRF-Protection': '1' },
        data: { email, password: 'Test-only password 47!' },
      });
      if (login.status() !== 200) throw new Error(`Browser fixture login failed: ${login.status()}`);
      sessions[email] = (await client.storageState()).cookies;
    } finally { await client.dispose(); }
  }
  await writeFile('.local/e2e/seed.json', JSON.stringify({ orgId: seed.orgId, customerId: seed.customerId, secondCustomerId: seed.secondCustomerId, sessions }), { mode: 0o600 });
  vite = await createServer({
    configFile: false, root: resolve('apps/web'), envDir: false,
    plugins: [react(), pdfPreviewAssets()],
    // Lazy preview workers must not trigger Vite's first-use dependency reload
    // while a browser test is interacting with an open modal.
    optimizeDeps: { include: ['mammoth', 'fflate', 'dompurify', 'pdfjs-dist'] },
    resolve: { alias: [{ find: /^@clerk\/react$/, replacement: resolve('e2e/clerk-test-adapter.tsx') }] },
    server: { host: '127.0.0.1', port: 4312, strictPort: true, proxy: { '/api': 'http://127.0.0.1:4311' } },
  });
  await vite.listen();
  console.log('Isolated browser fixture ready on http://127.0.0.1:4312');
  } catch (error) { await close(); throw error; }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
