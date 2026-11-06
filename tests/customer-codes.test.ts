import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

test('short customer ID migration backfills existing records and fails safely at capacity', async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE TABLE customers(id integer PRIMARY KEY, name text); INSERT INTO customers VALUES(1,'Existing'),(2,'Another');");
    await db.exec(await readFile('apps/api/src/database/migrations/005_customer_codes.sql', 'utf8'));
    const result = await db.query<{ id: number; name: string; customer_code: string }>('SELECT * FROM customers ORDER BY id');
    assert.deepEqual(result.rows.map(row => [row.id, row.name]), [[1, 'Existing'], [2, 'Another']]);
    assert.equal(new Set(result.rows.map(row => row.customer_code)).size, 2);
    for (const row of result.rows) assert.match(row.customer_code, /^UK[0-9]{6}$/);
    await assert.rejects(db.query('INSERT INTO customers(id,customer_code) VALUES(3,$1)', [result.rows[0].customer_code]), /unique/i);
    await db.exec("SELECT setval('customer_code_sequence',999998)");
    await db.exec('INSERT INTO customers(id) VALUES(4)');
    assert.equal((await db.query<{ customer_code: string }>('SELECT customer_code FROM customers WHERE id=4')).rows[0].customer_code, 'UK999999');
    await assert.rejects(db.exec('INSERT INTO customers(id) VALUES(5)'), /maximum value/i);
    assert.equal((await db.query('SELECT * FROM customers')).rows.length, 3);
  } finally { await db.close(); }
});
