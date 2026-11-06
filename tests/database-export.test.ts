import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { test } from 'node:test';
import { openLocalDatabase } from '../scripts/local-database';

test('offline logical export preserves schema, exact values, bytes and constraints', async () => {
  const previousMode = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  await mkdir(resolve('.local'), { recursive: true });
  const directory = await mkdtemp(resolve('.local', 'export-test-'));
  let local: Awaited<ReturnType<typeof openLocalDatabase>> | undefined;
  const restored = new PGlite();
  try {
    local = await openLocalDatabase({ directory });
    await local.db.query('CREATE TABLE export_probe(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, exact bigint NOT NULL, bytes bytea NOT NULL, label text UNIQUE NOT NULL)');
    const bytes = Buffer.from([0, 1, 127, 255]);
    await local.db.query('INSERT INTO export_probe(exact,bytes,label) VALUES($1,$2,$3)', ['9223372036854775807', bytes, "Client's document"]);
    const migrationCount = (await local.db.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n;
    const dump = await local.exportSql();
    assert.match(dump, /CREATE TABLE/);
    await restored.exec(dump);
    await restored.exec('SET search_path TO public');
    const result = await restored.query<{ exact: string; bytes: Uint8Array; label: string }>('SELECT exact::text,bytes,label FROM export_probe');
    assert.equal(result.rows[0].exact, '9223372036854775807');
    assert.deepEqual(Buffer.from(result.rows[0].bytes), bytes);
    assert.equal(result.rows[0].label, "Client's document");
    assert.equal((await restored.query<{ n: number }>('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, migrationCount);
    await assert.rejects(restored.query('INSERT INTO export_probe(exact,bytes,label) VALUES(1,$1,$2)', [bytes, "Client's document"]), /unique/);
    assert.equal((await restored.query<{ id: number }>('INSERT INTO export_probe(exact,bytes,label) VALUES(2,$1,$2) RETURNING id::int', [bytes, 'Next document'])).rows[0].id, 3);
  } finally {
    await local?.close();
    await restored.close();
    if (previousMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousMode;
    const target = resolve(directory);
    assert.ok(target.startsWith(`${resolve('.local')}${sep}export-test-`));
    await rm(target, { recursive: true, force: true });
  }
});
