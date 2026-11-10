import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { AccessService } from '../apps/api/src/access/access.service';
import { ClerkService } from '../apps/api/src/auth/clerk.service';
import { LedgerService, type PostEntryInput } from '../apps/api/src/ledger/ledger.service';
import { AccountDeletionService } from '../apps/api/src/users/account-deletion.service';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

class DeletionClerk extends ClerkService {
  override get enabled() { return true; }
  deleted: string[] = [];
  revoked: string[] = [];
  failDeleteAt = 0;
  override async revokeInvitation(id: string) { this.revoked.push(id); }
  override async deleteUser(id: string) {
    if (this.failDeleteAt && this.deleted.length + 1 === this.failDeleteAt) throw new Error('Provider unavailable');
    if (!this.deleted.includes(id)) this.deleted.push(id);
  }
}

describe('permanent account deletion scope and immutable-history boundaries', () => {
  let context: TestDatabase;
  let seed: TestSeed;
  let access: AccessService;
  let ledger: LedgerService;
  let clerk: DeletionClerk;
  let deletion: AccountDeletionService;
  before(async () => {
    context=await setupTestDatabase(); seed=await context.seed(); access=new AccessService(context.db);
    ledger=new LedgerService(context.db,access); clerk=new DeletionClerk(); deletion=new AccountDeletionService(context.db,access,clerk);
  });
  after(async () => context?.close());

  async function customer(email=`${randomUUID()}@example.test`, actor=seed.admin) {
    const id=randomUUID(); const key=randomUUID();
    await context.db.query(`INSERT INTO customers(id,organization_id,name,email,created_by,idempotency_key,request_hash)
      VALUES($1,$2,'Delete fixture',$3,$4,$5,$6)`,[id,actor.organization_id,email,actor.user_id,key,'1'.repeat(64)]);
    return {id,email,key};
  }
  async function identity(email: string) {
    const id=randomUUID(); const clerkId=`user_${randomUUID()}`;
    await context.db.query('INSERT INTO users(id,email,clerk_user_id) VALUES($1,$2,$3)',[id,email,clerkId]);
    return {id,email,clerkId};
  }
  async function member(userId: string, customerId: string, org=seed.orgId) {
    const id=randomUUID();
    await context.db.query("INSERT INTO memberships(id,organization_id,user_id,role,customer_id) VALUES($1,$2,$3,'customer',$4)",[id,org,userId,customerId]);
    return id;
  }
  async function invitation(account: {id:string;email:string}, state: 'accepted'|'revoked'|'pending'='pending', actor=seed.admin) {
    const id=randomUUID(); const provider=`inv_${id}`;
    await context.db.query(`INSERT INTO invitations(id,organization_id,customer_id,email,token_hash,expires_at,created_by,clerk_invitation_id,delivery_status,accepted_at,revoked_at)
      VALUES($1,$2,$3,$4,$5,now()+interval '1 day',$6,$7,'sent',CASE WHEN $8='accepted' THEN now() END,CASE WHEN $8='revoked' THEN now() END)`,
      [id,actor.organization_id,account.id,account.email,id.replaceAll('-','').repeat(2),actor.user_id,provider,state]);
    return {id,provider};
  }
  function entry(extra: Partial<PostEntryInput>={}): PostEntryInput {
    return {kind:'charge',amount:'10.00',effective_date:'2026-01-01',description:'Fixture',idempotency_key:randomUUID(),...extra};
  }
  async function audit(objectId: string, metadata: object, actor=seed.admin) {
    return (await context.db.query(`INSERT INTO audit_events(organization_id,actor_id,action,object_id,metadata)
      VALUES($1,$2,'fixture.created',$3,$4) RETURNING id`,[actor.organization_id,actor.user_id,objectId,metadata])).rows[0].id as string;
  }
  async function absent(table: string,column: string,id: string) {
    assert.equal((await context.db.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`,[id])).rowCount,0,`${table}.${column} retained ${id}`);
  }

  it('purges archived customer history, originals/reversals, all invitations, old memberships, local sessions and reset data', async () => {
    const account=await customer(); const older=await identity(account.email); const oldMember=await member(older.id,account.id);
    await context.db.query('UPDATE memberships SET is_active=false,deleted_at=now() WHERE id=$1',[oldMember]);
    await context.db.query('UPDATE users SET email=$1 WHERE id=$2',[`${randomUUID()}@example.test`,older.id]);
    const current=await identity(account.email); const currentMember=await member(current.id,account.id);
    const invs=[await invitation(account,'accepted'),await invitation(account,'revoked'),await invitation(account)];
    const opening=await ledger.post(seed.admin,account.id,entry({kind:'opening',amount:'50.00'}));
    const charge=await ledger.post(seed.admin,account.id,entry());
    await ledger.post(seed.admin,account.id,entry({kind:'payment',amount:'4.00'}));
    await ledger.post(seed.admin,account.id,entry({kind:'reversal',amount:undefined,reversal_of:charge.id}));
    const eventIds=await Promise.all([
      audit(account.id,{}),audit(currentMember,{}),audit('metadata-only',{customerId:account.id}),
      audit('metadata-snake',{customer_id:account.id}),audit('member',{membershipId:oldMember}),
      audit('identity',{userId:older.id}),audit('invitation',{invitationId:invs[0].id}),audit(opening.id,{}),
    ]);
    await context.db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",['a'.repeat(64),current.id]);
    await context.db.query("INSERT INTO password_resets(id,token_hash,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",[randomUUID(),'b'.repeat(64),older.id]);
    await context.db.query("UPDATE customers SET status='archived' WHERE id=$1",[account.id]);
    const unrelated=await ledger.post(seed.admin,seed.secondCustomerId,entry());
    await deletion.removeCustomer(seed.admin,account.id,account.email.toUpperCase());
    for (const table of ['customers','invitations','memberships','ledger_entries']) await absent(table,table==='customers'?'id':'customer_id',account.id);
    for (const id of eventIds) await absent('audit_events','id',id);
    for (const user of [older,current]) {
      await absent('users','id',user.id); await absent('sessions','user_id',user.id); await absent('password_resets','user_id',user.id);
      assert.ok(clerk.deleted.includes(user.clerkId));
    }
    for (const inv of invs) assert.ok(clerk.revoked.includes(inv.provider));
    assert.equal((await context.db.query('SELECT id FROM ledger_entries WHERE id=$1',[unrelated.id])).rowCount,1);
    assert.equal((await context.db.query('SELECT * FROM account_purge_context')).rowCount,0);
    await assert.rejects(ledger.statement(seed.admin,account.id),/not found/);
    const fresh=await customer(account.email);
    assert.notEqual(fresh.id,account.id);
    assert.equal((await ledger.statement(seed.admin,fresh.id)).current_balance_minor,'0');
  });

  it('deletes pending accounts without deleting an unassociated same-email identity, and releases customer idempotency keys', async () => {
    const account=await customer(); const unassociated=await identity(account.email); const inv=await invitation(account);
    await deletion.removeCustomer(seed.admin,account.id,account.email);
    await absent('invitations','id',inv.id);
    assert.equal(clerk.deleted.includes(unassociated.clerkId),false);
    assert.equal((await context.db.query('SELECT id FROM users WHERE id=$1',[unassociated.id])).rowCount,1);
    await context.db.query(`INSERT INTO customers(id,organization_id,name,email,created_by,idempotency_key,request_hash)
      VALUES($1,$2,'Fresh customer',$3,$4,$5,$6)`,[randomUUID(),seed.orgId,account.email,seed.adminId,account.key,'2'.repeat(64)]);
  });

  it('preserves shared identity, sessions, other organization ledger and pending invitations', async () => {
    const account=await customer(); const user=await identity(account.email); await member(user.id,account.id);
    const other=await customer(account.email,seed.otherAdmin); await member(user.id,other.id,seed.otherOrgId);
    const otherInvite=await invitation(other,'pending',seed.otherAdmin);
    const otherEntry=await ledger.post(seed.otherAdmin,other.id,entry());
    const sessionHash=randomUUID().replaceAll('-','').repeat(2);
    await context.db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",[sessionHash,user.id]);
    await deletion.removeCustomer(seed.admin,account.id,account.email);
    assert.equal((await context.db.query('SELECT user_id FROM sessions WHERE token_hash=$1',[sessionHash])).rows[0].user_id,user.id);
    assert.equal(clerk.deleted.includes(user.clerkId),false);
    assert.equal(clerk.revoked.includes(otherInvite.provider),false);
    assert.equal((await access.membership(user.id,seed.otherOrgId)).customer_id,other.id);
    assert.equal((await ledger.statement(seed.otherAdmin,other.id)).entries[0].id,otherEntry.id);
  });

  it('requires current administrator scope and exact confirmation and never accepts a forged generic purge switch', async () => {
    const account=await customer(); const posted=await ledger.post(seed.admin,account.id,entry());
    await assert.rejects(deletion.removeCustomer(seed.admin,account.id,'wrong@example.test'),/email exactly/);
    await assert.rejects(deletion.removeCustomer(seed.otherAdmin,account.id,account.email),/not found/);
    await assert.rejects(deletion.removeCustomer({...seed.customerMember,role:'admin'},account.id,account.email),/administrator/);
    await assert.rejects(deletion.removeMembership(seed.admin,seed.admin.id,'admin@example.test'),/own administrator/);
    await assert.rejects(context.db.query('SELECT permanently_delete_customer($1,$2,$3,$4)',[seed.customerUserId,seed.orgId,account.id,account.email]),/administrator/);
    await context.db.query("SELECT set_config('ledger.permanent_delete','true',false)");
    await assert.rejects(context.db.query('DELETE FROM ledger_entries WHERE id=$1',[posted.id]),/cannot be edited or deleted/);
    await assert.rejects(context.db.query('UPDATE ledger_entries SET created_by=NULL WHERE id=$1',[posted.id]),/cannot be edited or deleted/);
    assert.equal((await context.db.query('SELECT * FROM account_purge_context')).rowCount,0);
  });

  it('rejects unrelated deletions even while an authorized purge is running and clears scope after rollback', async () => {
    const account=await customer(); await ledger.post(seed.admin,account.id,entry());
    const unrelated=await ledger.post(seed.admin,seed.secondCustomerId,entry());
    await context.db.query(`CREATE FUNCTION attempt_outside_purge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      DELETE FROM ledger_entries WHERE id=${unrelated.id}; RETURN OLD; END $$`);
    await context.db.query(`CREATE TRIGGER zz_attempt_outside_purge BEFORE DELETE ON ledger_entries FOR EACH ROW
      WHEN (OLD.customer_id='${account.id}'::uuid) EXECUTE FUNCTION attempt_outside_purge()`);
    try { await assert.rejects(deletion.removeCustomer(seed.admin,account.id,account.email),/cannot be edited or deleted/); }
    finally { await context.db.query('DROP TRIGGER zz_attempt_outside_purge ON ledger_entries'); await context.db.query('DROP FUNCTION attempt_outside_purge()'); }
    assert.equal((await context.db.query('SELECT * FROM account_purge_context')).rowCount,0);
    assert.equal((await ledger.statement(seed.admin,account.id)).total,1);
    assert.equal((await context.db.query('SELECT id FROM ledger_entries WHERE id=$1',[unrelated.id])).rowCount,1);
    await deletion.removeCustomer(seed.admin,account.id,account.email);
    await assert.rejects(context.db.query('DELETE FROM ledger_entries WHERE id=$1',[unrelated.id]),/cannot be edited or deleted/);
  });

  it('anonymizes deleted administrator attribution without changing other customers or their financial facts', async () => {
    const user=await identity(`${randomUUID()}@example.test`); const membershipId=randomUUID();
    await context.db.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'admin')",[membershipId,seed.orgId,user.id]);
    const admin=await access.membership(user.id,seed.orgId,true);
    const account=await customer(undefined,admin); const inv=await invitation(account,'pending',admin);
    const posted=await ledger.post(admin,account.id,entry()); const auditId=await audit(account.id,{customer_id:account.id},admin);
    const identityAudit=await audit(membershipId,{userId:user.id});
    const customerBefore=(await context.db.query('SELECT * FROM customers WHERE id=$1',[account.id])).rows[0];
    const entryBefore=(await context.db.query('SELECT * FROM ledger_entries WHERE id=$1',[posted.id])).rows[0];
    await deletion.removeMembership(seed.admin,membershipId,user.email);
    await absent('memberships','id',membershipId); await absent('users','id',user.id); await absent('audit_events','id',identityAudit);
    const customerAfter=(await context.db.query('SELECT * FROM customers WHERE id=$1',[account.id])).rows[0];
    const entryAfter=(await context.db.query('SELECT * FROM ledger_entries WHERE id=$1',[posted.id])).rows[0];
    assert.ok(BigInt(customerAfter.report_version)>BigInt(customerBefore.report_version),'anonymized activity invalidates reporting');
    assert.deepEqual(customerAfter,{...customerBefore,created_by:null,report_version:customerAfter.report_version});
    assert.deepEqual(entryAfter,{...entryBefore,created_by:null});
    assert.equal((await context.db.query('SELECT actor_id FROM audit_events WHERE id=$1',[auditId])).rows[0].actor_id,null);
    assert.equal((await context.db.query('SELECT created_by FROM invitations WHERE id=$1',[inv.id])).rows[0].created_by,null);
    assert.equal((await ledger.statement(seed.admin,account.id)).current_balance_minor,'1000');
    await assert.rejects(context.db.query('UPDATE audit_events SET metadata=$1 WHERE id=$2',[{},auditId]),/cannot be edited or deleted/);
    await assert.rejects(context.db.query('UPDATE ledger_entries SET created_by=$1 WHERE id=$2',[seed.adminId,posted.id]),/cannot be edited or deleted/);
    assert.equal((await context.db.query('SELECT * FROM account_purge_context')).rowCount,0);
  });

  it('retains local data after a partial provider failure and supports an idempotent retry', async () => {
    const account=await customer(); const older=await identity(account.email); const oldMembership=await member(older.id,account.id);
    await context.db.query('UPDATE memberships SET is_active=false,deleted_at=now() WHERE id=$1',[oldMembership]);
    await context.db.query('UPDATE users SET email=$1 WHERE id=$2',[`${randomUUID()}@example.test`,older.id]);
    const current=await identity(account.email); await member(current.id,account.id);
    const posted=await ledger.post(seed.admin,account.id,entry());
    clerk.failDeleteAt=clerk.deleted.length+2;
    try { await assert.rejects(deletion.removeCustomer(seed.admin,account.id,account.email),/Local account data has been retained/); }
    finally { clerk.failDeleteAt=0; }
    assert.equal((await ledger.statement(seed.admin,account.id)).entries[0].id,posted.id);
    assert.equal((await context.db.query('SELECT id FROM memberships WHERE customer_id=$1',[account.id])).rowCount,2);
    assert.equal((await context.db.query('SELECT * FROM account_purge_context')).rowCount,0);
    await deletion.removeCustomer(seed.admin,account.id,account.email);
    await absent('customers','id',account.id); await absent('users','id',older.id); await absent('users','id',current.id);
  });
});
