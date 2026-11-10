import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, stat, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Pool } from 'pg';
import { backupDatabase, postgresToolEnvironment, restoreDatabase } from '../scripts/database-backup';
import { setupTestDatabase } from './helpers';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';

test('backup tool credentials remain environment-only and production forces verified TLS',()=>{
  const env=postgresToolEnvironment(new URL('postgres://owner:p%40ss@db.example.test:6543/ledger?sslmode=require'),{NODE_ENV:'production',PGOPTIONS:'injected',PGSERVICE:'unexpected'});
  assert.equal(env.PGPASSWORD,'p@ss'); assert.equal(env.PGSSLMODE,'verify-full'); assert.equal(env.PGPORT,'6543');
  assert.equal(env.PGSSLROOTCERT,'system');
  assert.equal(env.PGOPTIONS,undefined); assert.equal(env.PGSERVICE,undefined);
});

test('PostgreSQL custom archive restores a complete booking, private bytes and immutable ledger into an empty database',{skip:!process.env.TEST_DATABASE_URL,timeout:120000},async()=>{
  const source=await setupTestDatabase(),seed=await source.seed();
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL}),databaseName=`ledger_restore_${randomUUID().replaceAll('-','')}`;
  const target=new URL(process.env.TEST_DATABASE_URL!); target.pathname=`/${databaseName}`; target.search='';
  const directory=await mkdtemp(join(tmpdir(),'ledger-backup-')),archive=join(directory,'database.dump');
  let restored:Pool|undefined;
  try {
    await source.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1",[seed.orgId]);
    const access=new AccessService(source.db),bookings=new BookingsService(source.db,access),member=await access.membership(seed.adminId,seed.orgId);
    const booking=await bookings.create(member,seed.customerId,{reference:'RESTORE-DRILL',departure_at:'2026-12-01T10:00:00Z',required_services:['flight'],amount:'42.39',effective_date:'2026-01-01',idempotency_key:randomUUID()});
    const folder=(await bookings.files(member,seed.customerId,booking.id as string)).items.find(item=>item.serviceKey==='flight')!;
    const bytes=Buffer.from('Private voucher retained by backup and verified after restore.');
    const file=await bookings.upload(member,seed.customerId,booking.id as string,folder.id,'voucher.txt',randomUUID(),bytes);
    const cloudFile=await bookings.upload(member,seed.customerId,booking.id as string,folder.id,'cloud-voucher.txt',randomUUID(),bytes);
    const objects=[randomUUID(),randomUUID(),randomUUID()];
    for(const objectId of objects) await source.db.query(`INSERT INTO document_objects(id,organization_id,customer_id,booking_id,bucket,object_key,checksum,size,state)
      VALUES($1,$2,$3,$4,'fixture-production',$5,$6,$7,'ready')`,[objectId,seed.orgId,seed.customerId,booking.id,`documents/${objectId}`,createHash('sha256').update(bytes).digest('hex'),bytes.length]);
    await source.db.query('UPDATE booking_nodes SET content=NULL,storage_object_id=$1,content_version=2 WHERE id=$2',[objects[0],cloudFile.id]);
    await source.db.query(`INSERT INTO document_versions(document_id,version,name,mime_type,size,storage_object_id,created_at)
      VALUES($1,1,'cloud-voucher.txt','text/plain',$2,$3,now())`,[cloudFile.id,bytes.length,objects[1]]);
    const schema=(await source.db.query<{schema:string}>('SELECT current_schema() AS schema')).rows[0].schema;
    const env:NodeJS.ProcessEnv={...process.env,NODE_ENV:'test',DATABASE_SSL:'false',DATABASE_URL:process.env.TEST_DATABASE_URL,DATABASE_MIGRATION_URL:process.env.TEST_DATABASE_URL,
      DATABASE_SCHEMA:schema,PG_TOOLS_MODE:process.env.PG_TOOLS_MODE || 'docker',RESTORE_DATABASE_URL:target.toString()};
    delete env.DATABASE_SSL_CA_FILE;
    const manifest=await backupDatabase(archive,env);
    assert.equal(manifest.tables.bookings,'1'); assert.equal(manifest.ledger_total_minor,'4239');
    assert.equal(manifest.cloud_objects,'3');
    assert.deepEqual(manifest.referenced_objects.map(object=>object.id).sort(),objects.slice(0,2).sort(),'Include current and historical cloud references, excluding unattached objects.');
    assert.equal((await stat(archive)).mode & 0o777,0o600);
    await assert.rejects(backupDatabase(archive,env),/already exists/);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await assert.rejects(restoreDatabase(archive,'wrong-target',env),/exact empty target/);
    const result=await restoreDatabase(archive,databaseName,env);
    assert.equal(result.status,'verified'); assert.equal(result.ledger_total_minor,'4239'); assert.ok(result.tables>20);
    restored=new Pool({connectionString:target.toString()});
    assert.deepEqual((await restored.query(`SELECT content FROM "${schema}".booking_nodes WHERE id=$1`,[file.id])).rows[0].content,bytes);
    assert.equal((await restored.query(`SELECT reference,total_minor::text AS total FROM "${schema}".bookings WHERE id=$1`,[booking.id])).rows[0].total,'4239');
    await assert.rejects(restored.query(`UPDATE "${schema}".ledger_entries SET amount_minor=1 WHERE id=$1`,[booking.charge_entry_id]),/cannot be edited/);
    await assert.rejects(restoreDatabase(archive,databaseName,env),/empty database/);
    const corrupted=join(directory,'corrupt.dump');
    await copyFile(`${archive}.json`,`${corrupted}.json`); await writeFile(corrupted,Buffer.concat([await readFile(archive),Buffer.from('tamper')]));
    await assert.rejects(restoreDatabase(corrupted,databaseName,env),/checksum/);
  } finally {
    if(restored) await restored.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end(); await source.close(); await rm(directory,{recursive:true,force:true});
  }
});
