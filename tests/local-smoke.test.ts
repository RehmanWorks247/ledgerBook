import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { after, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from '../apps/api/src/app';
import { config } from '../apps/api/src/config';
import { verifyLocalApp } from '../scripts/local-smoke';
import { setupTestDatabase, testPassword, type TestDatabase } from './helpers';

let database: TestDatabase | undefined;
let app: NestExpressApplication | undefined;
after(async () => {
  if (app) await app.close();
  if (database) await database.close();
});

test('local smoke verifies the built frontend, persistent-database interface, and admin lifecycle', {
  skip: !existsSync('apps/web/dist/index.html') && 'Run npm run build:web to verify served production assets.',
}, async () => {
  database = await setupTestDatabase();
  const fixture = await database.seed();
  app = await createApp({ database: database.db, logger: false });
  await app.listen(0, '127.0.0.1');
  const result = await verifyLocalApp(app, {
    email: 'admin@example.test', password: testPassword,
    organizationId: fixture.orgId, origin: config.appUrl,
  });
  assert.equal(result.checks.length, 9);
  assert.ok(['tcp', 'in-process'].includes(result.transport));
  assert.equal(JSON.stringify(result).includes(testPassword), false);
  assert.equal((await database.db.query('SELECT * FROM sessions')).rowCount, 0);
  assert.equal((await database.db.query('SELECT * FROM ledger_entries')).rowCount, 0);
});
