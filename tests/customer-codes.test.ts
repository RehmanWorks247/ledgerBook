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

test('UK44 migration renumbers existing display codes chronologically and preserves related records', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE customers(id integer PRIMARY KEY,name text,created_at timestamptz);
      INSERT INTO customers VALUES(2,'Second','2026-02-01'),(1,'First','2026-01-01');
      CREATE TABLE bookings(id integer PRIMARY KEY,customer_id integer REFERENCES customers(id));
      INSERT INTO bookings VALUES(10,1),(20,2);`);
    await db.exec(await readFile('apps/api/src/database/migrations/005_customer_codes.sql', 'utf8'));
    await db.exec("SELECT setval('customer_code_sequence',850)");
    await db.exec(`BEGIN;${await readFile('apps/api/src/database/migrations/022_uk44_customer_codes.sql', 'utf8')}COMMIT;`);
    assert.deepEqual((await db.query('SELECT id,name,customer_code FROM customers ORDER BY id')).rows,
      [{ id: 1, name: 'First', customer_code: 'UK44001' }, { id: 2, name: 'Second', customer_code: 'UK44002' }]);
    assert.deepEqual((await db.query('SELECT * FROM bookings ORDER BY id')).rows, [{ id: 10, customer_id: 1 }, { id: 20, customer_id: 2 }]);
    await db.exec("INSERT INTO customers(id,name,created_at) VALUES(3,'New','2026-03-01')");
    assert.equal((await db.query<{ customer_code: string }>('SELECT customer_code FROM customers WHERE id=3')).rows[0].customer_code, 'UK44003');
    await assert.rejects(db.exec("UPDATE customers SET customer_code='UK44999' WHERE id=1"), /cannot be changed/i);
    await assert.rejects(db.exec("INSERT INTO customers(id,customer_code) VALUES(4,'UK44001')"), /unique/i);
    await db.exec("ALTER SEQUENCE customer_code_sequence RESTART WITH 999; INSERT INTO customers(id) VALUES(5),(6)");
    assert.deepEqual((await db.query('SELECT customer_code FROM customers WHERE id IN (5,6) ORDER BY id')).rows,
      [{ customer_code: 'UK44999' }, { customer_code: 'UK441000' }]);
  } finally { await db.close(); }
});

test('UK44 migration starts empty databases at 001 and rolls back codes and sequence together', async () => {
  const db = new PGlite();
  try {
    await db.exec('CREATE TABLE customers(id integer PRIMARY KEY,created_at timestamptz)');
    await db.exec(await readFile('apps/api/src/database/migrations/005_customer_codes.sql', 'utf8'));
    const migration = await readFile('apps/api/src/database/migrations/022_uk44_customer_codes.sql', 'utf8');
    await db.exec(`BEGIN;${migration}COMMIT; INSERT INTO customers(id) VALUES(1)`);
    assert.equal((await db.query<{ customer_code: string }>('SELECT customer_code FROM customers')).rows[0].customer_code, 'UK44001');
  } finally { await db.close(); }
  const rollback = new PGlite();
  try {
    await rollback.exec('CREATE TABLE customers(id integer PRIMARY KEY,created_at timestamptz)');
    await rollback.exec(await readFile('apps/api/src/database/migrations/005_customer_codes.sql', 'utf8'));
    await rollback.exec('INSERT INTO customers(id) VALUES(1)');
    await rollback.exec(`BEGIN;${await readFile('apps/api/src/database/migrations/022_uk44_customer_codes.sql', 'utf8')}ROLLBACK; INSERT INTO customers(id) VALUES(2)`);
    assert.deepEqual((await rollback.query('SELECT customer_code FROM customers ORDER BY id')).rows,
      [{ customer_code: 'UK000001' }, { customer_code: 'UK000002' }]);
  } finally { await rollback.close(); }
});
