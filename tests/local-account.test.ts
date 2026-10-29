import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { it } from 'node:test';
import { ensureLocalAccount } from '../scripts/local-account';
import { hashPassword } from '../apps/api/src/auth/crypto';
import { setupTestDatabase } from './helpers';

it('provisions one random local admin and preserves changed passwords and existing accounts',async()=>{
  const prior=process.env.NODE_ENV;
  process.env.NODE_ENV='test';
  const directory=await mkdtemp(resolve(tmpdir(),'ledgerbook-local-account-'));
  const database=await setupTestDatabase();
  try {
    const first=await ensureLocalAccount(database.db,{directory});
    assert.equal(first.created,true);
    assert.ok(first.password&&first.password.length>=24);
    assert.equal(first.email,'admin@ledgerbook.local');
    const repeated=await ensureLocalAccount(database.db,{directory});
    assert.equal(repeated.created,false);
    assert.equal(repeated.organizationId,first.organizationId);
    assert.equal(repeated.password,first.password);
    assert.equal((await database.db.query('SELECT count(*)::text AS n FROM users')).rows[0].n,'1');
    assert.equal((await database.db.query('SELECT count(*)::text AS n FROM customers')).rows[0].n,'0');
    const saved=await readFile(resolve(directory,'admin-login.json'),'utf8');
    await database.db.query('UPDATE users SET password_hash=$1',[await hashPassword('A changed local passphrase 48!')]);
    const afterChange=await ensureLocalAccount(database.db,{directory});
    assert.equal(afterChange.password,undefined,'A changed password is never reset to the original generated credential.');
    assert.equal(await readFile(resolve(directory,'admin-login.json'),'utf8'),saved);
    process.env.NODE_ENV='production';
    await assert.rejects(ensureLocalAccount(database.db,{directory}),/development-only/);
  }finally {
    process.env.NODE_ENV=prior;
    if(prior===undefined) delete process.env.NODE_ENV;
    await database.close();
    assert.ok(directory.startsWith(resolve(tmpdir(),'ledgerbook-local-account-')));
    await rm(directory,{recursive:true,force:true});
  }
});
