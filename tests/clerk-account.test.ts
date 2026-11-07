import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { provisionClerkAdministrator } from '../scripts/clerk-account';
import { setupTestDatabase } from './helpers';

test('Clerk bootstrap links a verified operations identity without replacing existing organization data',async()=>{
  const database=await setupTestDatabase();
  try {
    const fixture=await database.seed();
    const before=await database.db.query('SELECT id,name,email FROM customers ORDER BY id');
    const input={clerkUserId:'user_TestAdministrator',email:'clerk-admin@example.test',displayName:'Clerk Administrator',organizationId:fixture.orgId,name:'North Trading',currency:'USD'};
    const added=await provisionClerkAdministrator(database.db,input);
    assert.equal(added.organizationId,fixture.orgId);
    assert.equal(added.createdOrganization,false);
    assert.equal(added.createdMembership,true);
    const user=(await database.db.query('SELECT email,name,clerk_user_id,password_hash FROM users WHERE id=$1',[added.userId])).rows[0];
    assert.deepEqual(user,{email:input.email,name:input.displayName,clerk_user_id:input.clerkUserId,password_hash:null});
    assert.deepEqual((await database.db.query('SELECT id,name,email FROM customers ORDER BY id')).rows,before.rows);
    assert.equal((await database.db.query("SELECT count(*)::int AS count FROM memberships WHERE organization_id=$1 AND role='admin' AND is_active=true",[fixture.orgId])).rows[0].count,2);
    assert.equal((await provisionClerkAdministrator(database.db,input)).createdMembership,false);
    assert.equal((await database.db.query("SELECT count(*)::int AS count FROM audit_events WHERE action='administrator.provisioned'")).rows[0].count,1);
    await assert.rejects(provisionClerkAdministrator(database.db,{...input,clerkUserId:'user_DifferentIdentity'}),/another Clerk user/);
    assert.equal((await database.db.query('SELECT clerk_user_id FROM users WHERE id=$1',[added.userId])).rows[0].clerk_user_id,input.clerkUserId);
    await database.db.query('UPDATE memberships SET is_active=false WHERE user_id=$1 AND organization_id=$2',[added.userId,fixture.orgId]);
    await assert.rejects(provisionClerkAdministrator(database.db,input),/disabled or deleted/);
    assert.equal((await database.db.query('SELECT is_active FROM memberships WHERE user_id=$1 AND organization_id=$2',[added.userId,fixture.orgId])).rows[0].is_active,false);
  } finally {await database.close();}
});

test('Clerk bootstrap prevents customer promotion and rolls back invalid organization assignments',async()=>{
  const database=await setupTestDatabase();
  try {
    const fixture=await database.seed();
    const input={clerkUserId:'user_ProvisioningTest',email:'customer@example.test',displayName:'Customer',organizationId:fixture.orgId,name:'North Trading',currency:'USD'};
    await assert.rejects(provisionClerkAdministrator(database.db,input),/customer membership/);
    const customer=(await database.db.query('SELECT clerk_user_id,password_hash FROM users WHERE id=$1',[fixture.customerUserId])).rows[0];
    assert.equal(customer.clerk_user_id,null);
    assert.ok(customer.password_hash,'Failed provisioning must preserve the original login.');
    await database.db.query('UPDATE memberships SET is_active=false,deleted_at=now() WHERE user_id=$1',[fixture.customerUserId]);
    await assert.rejects(provisionClerkAdministrator(database.db,input),/customer membership/);
    await assert.rejects(provisionClerkAdministrator(database.db,{...input,email:'new@example.test',organizationId:'00000000-0000-4000-8000-000000000000'}),/does not exist/);
    assert.equal((await database.db.query('SELECT id FROM users WHERE email=$1',['new@example.test'])).rowCount,0);
    const created=await provisionClerkAdministrator(database.db,{...input,email:'new@example.test',organizationId:undefined,name:'New Company',currency:'PKR'});
    assert.equal(created.createdOrganization,true);
    assert.equal((await provisionClerkAdministrator(database.db,{...input,email:'new@example.test',organizationId:undefined,name:'New Company',currency:'PKR'})).organizationId,created.organizationId);
  } finally {await database.close();}
});
