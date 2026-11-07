import { Logger } from '@nestjs/common';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { AccessService } from '../apps/api/src/access/access.service';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { ClerkService, type ClerkIdentity } from '../apps/api/src/auth/clerk.service';
import { opaqueToken } from '../apps/api/src/auth/crypto';
import { CustomersService } from '../apps/api/src/customers/customers.service';
import { InvitationService } from '../apps/api/src/invitations/invitation.service';
import { NotificationsService } from '../apps/api/src/notifications/notifications.service';
import { UsersService } from '../apps/api/src/users/users.service';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

class FakeClerk extends ClerkService {
  override get enabled() { return true; }
  identities = new Map<string, ClerkIdentity>();
  sent: (Parameters<ClerkService['invite']>[0] & { id: string })[] = [];
  revoked: string[] = [];
  banned: string[] = [];
  unbanned: string[] = [];
  deleted: string[] = [];
  failDelivery = false;
  deliveryError: unknown;
  failManagement = false;
  failRevocation = false;
  invitationStates = new Map<string,'pending' | 'accepted' | 'revoked'>();
  override async verify(token?: string) { return this.identities.get(token ?? '') ?? null; }
  override async userExists(email: string) { return [...this.identities.values()].some((identity) => identity.email === email); }
  override async invite(params: Parameters<ClerkService['invite']>[0]) {
    if (this.failDelivery) throw this.deliveryError ?? new Error('Provider unavailable');
    const invitation = { ...params,id:`inv_${randomUUID()}` };
    this.sent.push(invitation);
    this.invitationStates.set(invitation.id,'pending');
    return invitation as unknown as Awaited<ReturnType<ClerkService['invite']>>;
  }
  override async revokeInvitation(id: string) {
    if (this.failRevocation) throw new Error('Provider unavailable');
    if (this.invitationStates.get(id) === 'accepted' || this.invitationStates.get(id) === 'revoked') return;
    this.revoked.push(id); this.invitationStates.set(id,'revoked');
  }
  override async banUser(id: string) { if (this.failManagement) throw new Error('Provider unavailable'); this.banned.push(id); }
  override async unbanUser(id: string) { this.unbanned.push(id); }
  override async deleteUser(id: string) { this.deleted.push(id); }
}
class ForbiddenNotifications extends NotificationsService {
  override async send(): Promise<void> { throw new Error('Clerk flow must never use the legacy email provider'); }
}

describe('Clerk identity, invitation and administrator account boundaries', () => {
  let context: TestDatabase;
  let seed: TestSeed;
  let clerk: FakeClerk;
  let auth: AuthService;
  let access: AccessService;
  let invitations: InvitationService;
  let users: UsersService;
  before(async () => {
    context = await setupTestDatabase(); seed = await context.seed(); clerk = new FakeClerk();
    const notifications = new ForbiddenNotifications();
    auth = new AuthService(context.db,notifications,clerk); access = new AccessService(context.db);
    invitations = new InvitationService(context.db,access,auth,notifications,clerk);
    users = new UsersService(context.db,access,invitations,clerk);
  });
  after(async () => { await context?.close(); });

  async function customer(email = `${randomUUID()}@example.test`, orgId = seed.orgId, creatorId = seed.adminId) {
    const id = randomUUID();
    await context.db.query(`INSERT INTO customers(id,organization_id,name,email,created_by,idempotency_key,request_hash)
      VALUES($1,$2,'Clerk Test Person',$3,$4,$5,$6)`, [id,orgId,email,creatorId,randomUUID(),'1'.repeat(64)]);
    return id;
  }
  async function signIn(email: string, clerkId = `user_${randomUUID()}`) {
    const token = `verified_${randomUUID()}`;
    clerk.identities.set(token,{id:clerkId,email,name:'Verified Person'});
    const user = await auth.authenticate(token);
    assert.ok(user);
    return { user,token,clerkId };
  }
  async function joined() {
    const email = `${randomUUID()}@example.test`;
    const customerId = await customer(email);
    await invitations.invite(seed.admin,customerId);
    const invitation = clerk.sent.at(-1)!;
    const identity = await signIn(email);
    const accepted = await invitations.accept(invitation.token,identity.user.id);
    return { ...identity,customerId,membershipId:accepted.membershipId };
  }

  it('links only a verified provider identity, preserves the UUID and removes local password access', async () => {
    assert.equal(await auth.authenticate('forged token'),null);
    const identity = await signIn('admin@example.test','user_existing_admin');
    assert.equal(identity.user.id,seed.adminId);
    assert.equal((await context.db.query('SELECT password_hash FROM users WHERE id=$1',[seed.adminId])).rows[0].password_hash,null);
    assert.equal((await auth.session(identity.user)).memberships[0].role,'admin');
    const otherProviderAccount = await signIn('different@example.test');
    assert.equal((await auth.session(otherProviderAccount.user)).memberships.length,0);
    clerk.identities.set('wrong_subject',{id:'user_wrong_subject',email:'admin@example.test',name:'Wrong'});
    await assert.rejects(auth.authenticate('wrong_subject'),/still linked to another LedgerBook identity/);
    await assert.rejects(auth.login('admin@example.test','password'),/Use Clerk/);
    assert.throws(() => auth.forgotPassword('admin@example.test'),/Use Clerk/);
    await assert.rejects(auth.resetPassword(opaqueToken(),'password'),/Use Clerk/);
    await assert.rejects(auth.createSession(seed.adminId),/Use Clerk/);
  });

  it('sends through Clerk and reveals trusted greeting data only with the opaque capability', async () => {
    const email = `${randomUUID()}@example.test`;
    const id = await customer(email);
    const sent = await invitations.invite(seed.admin,id);
    assert.equal(sent.delivery_status,'sent');
    const delivery = clerk.sent.at(-1)!;
    assert.equal(delivery.email,email); assert.equal(delivery.name,'Clerk Test Person');
    assert.equal(delivery.organizationName,'North Trading');
    assert.deepEqual(await invitations.inspect(opaqueToken()),{status:'invalid'});
    assert.deepEqual(await invitations.inspect(delivery.token),{status:'valid',email,name:'Clerk Test Person',organizationName:'North Trading',existingUser:false,provider:'clerk'});
    await assert.rejects(invitations.accept(delivery.token,undefined,'Local password must not work 47!'),/Sign in/);
    const wrongIdentity = await signIn('wrong@example.test');
    await assert.rejects(invitations.accept(delivery.token,wrongIdentity.user.id),/email address/);
    const identity = await signIn(email);
    const accepted = await invitations.accept(delivery.token,identity.user.id);
    assert.equal(accepted.token,undefined);
    assert.equal((await access.membership(identity.user.id,seed.orgId)).customer_id,id);
    await assert.rejects(invitations.accept(delivery.token,identity.user.id),/already been accepted/);
  });

  it('closes pending existing-user provider invitations and safely retries provider failures without granting access', async () => {
    const email = `${randomUUID()}@example.test`;
    const identity = await signIn(email);
    const id = await customer(email);
    await invitations.invite(seed.admin,id);
    const pending = clerk.sent.at(-1)!;
    assert.equal(clerk.invitationStates.get(pending.id),'pending');
    clerk.failRevocation = true;
    try { await assert.rejects(invitations.accept(pending.token,identity.user.id),/invitation could not be finalized/); }
    finally { clerk.failRevocation = false; }
    await assert.rejects(access.membership(identity.user.id,seed.orgId),/unavailable/);
    assert.equal((await invitations.inspect(pending.token)).status,'valid');
    await invitations.accept(pending.token,identity.user.id);
    assert.equal(clerk.invitationStates.get(pending.id),'revoked');
    assert.equal((await access.membership(identity.user.id,seed.orgId)).customer_id,id);
    await assert.rejects(invitations.accept(pending.token,identity.user.id),/already been accepted/);

    // A new signup has already consumed its provider invitation; finalization is a no-op.
    const signupEmail = `${randomUUID()}@example.test`;
    const signupCustomer = await customer(signupEmail);
    await invitations.invite(seed.admin,signupCustomer);
    const signup = clerk.sent.at(-1)!;
    const newIdentity = await signIn(signupEmail);
    clerk.invitationStates.set(signup.id,'accepted');
    await invitations.accept(signup.token,newIdentity.user.id);
    assert.equal(clerk.invitationStates.get(signup.id),'accepted');
    assert.equal(clerk.revoked.includes(signup.id),false);
    assert.equal((await access.membership(newIdentity.user.id,seed.orgId)).customer_id,signupCustomer);
  });

  it('revokes provider and local links on resend/revoke and persists delivery failures for retry', async () => {
    const id = await customer();
    await invitations.invite(seed.admin,id);
    const old = clerk.sent.at(-1)!;
    await invitations.invite(seed.admin,id);
    assert.ok(clerk.revoked.includes(old.id));
    assert.equal((await invitations.inspect(old.token)).status,'revoked');
    const latest = clerk.sent.at(-1)!;
    await invitations.revoke(seed.admin,id);
    assert.ok(clerk.revoked.includes(latest.id));
    assert.equal((await invitations.inspect(latest.token)).status,'revoked');
    clerk.failDelivery = true;
    try { assert.equal((await invitations.invite(seed.admin,id)).delivery_status,'failed'); }
    finally { clerk.failDelivery = false; }
    assert.equal((await invitations.invite(seed.admin,id)).delivery_status,'sent');
  });

  it('records useful invitation failure diagnostics without provider messages, PII, tokens or arbitrary error codes', async (test) => {
    const id = await customer('private-recipient@example.test');
    const warnings: string[] = [];
    const warningMock = test.mock.method(Logger.prototype,'warn',(message: unknown) => { warnings.push(String(message)); });
    clerk.failDelivery = true;
    clerk.deliveryError = {
      status:429,
      errors:[
        {code:'rate_limit_exceeded',message:'private-recipient@example.test secret-ticket-123'},
        {code:'private-recipient@example.test',message:'sk_test_secret'},
        {code:'arbitrary_secret_code',longMessage:'raw provider response'},
      ],
      response:{email:'private-recipient@example.test',token:'secret-ticket-123'},
    };
    try {
      const result = await invitations.invite(seed.admin,id);
      assert.equal(result.delivery_status,'failed');
      assert.equal(warnings.length,1);
      const failure = {operation:'create_invitation',providerStatus:429,providerCodes:['rate_limit_exceeded']};
      assert.deepEqual(JSON.parse(warnings[0]),{event:'clerk_invitation_failed',invitationId:result.id,...failure});
      const audit = await context.db.query('SELECT metadata FROM audit_events WHERE object_id=$1',[result.id]);
      assert.deepEqual(audit.rows[0].metadata.deliveryFailure,failure);
      const diagnostics = warnings[0]+JSON.stringify(audit.rows[0].metadata);
      for (const secret of ['private-recipient@example.test','secret-ticket-123','sk_test_secret','arbitrary_secret_code','raw provider response']) assert.equal(diagnostics.includes(secret),false);
    } finally { clerk.failDelivery = false; clerk.deliveryError = undefined; warningMock.mock.restore(); }
  });

  it('disables and restores customer access through Clerk and immediately enforces local membership state', async () => {
    const account = await joined();
    assert.ok((await users.list(seed.admin)).users.some((entry) => entry.id === account.membershipId));
    await users.update(seed.admin,account.membershipId,'disable');
    assert.ok(clerk.banned.includes(account.clerkId));
    await assert.rejects(access.membership(account.user.id,seed.orgId),/unavailable/);
    await users.update(seed.admin,account.membershipId,'enable');
    assert.ok(clerk.unbanned.includes(account.clerkId));
    assert.equal((await access.membership(account.user.id,seed.orgId)).is_active,true);
  });

  it('supports existing Clerk users and restores a disabled user only after a new invitation is accepted', async () => {
    const account = await joined();
    await users.update(seed.admin,account.membershipId,'disable');
    await invitations.invite(seed.admin,account.customerId);
    const delivery = clerk.sent.at(-1)!;
    assert.equal((await invitations.inspect(delivery.token)).existingUser,true);
    assert.ok(clerk.unbanned.includes(account.clerkId));
    await assert.rejects(access.membership(account.user.id,seed.orgId),/unavailable/);
    const accepted = await invitations.accept(delivery.token,account.user.id);
    assert.equal(accepted.membershipId,account.membershipId);
    assert.equal((await access.membership(account.user.id,seed.orgId)).is_active,true);
    const otherCustomer = await customer(account.user.email,seed.otherOrgId,seed.otherAdminId);
    await invitations.invite(seed.otherAdmin,otherCustomer);
    const otherDelivery = clerk.sent.at(-1)!;
    assert.equal((await invitations.inspect(otherDelivery.token)).existingUser,true);
    await invitations.accept(otherDelivery.token,account.user.id);
    assert.equal((await access.membership(account.user.id,seed.otherOrgId)).customer_id,otherCustomer);
  });

  it('permanently deletes the customer, financial data and orphaned Clerk identity', async () => {
    const account = await joined();
    await context.db.query(`INSERT INTO ledger_entries(organization_id,customer_id,kind,amount_minor,currency,effective_date,description,created_by,idempotency_key,request_hash)
      VALUES($1,$2,'charge',100,'USD','2026-01-01','Preserved charge',$3,$4,$5)`, [seed.orgId,account.customerId,seed.adminId,randomUUID(),'2'.repeat(64)]);
    await users.update(seed.admin,account.membershipId,'delete',account.user.email);
    assert.ok(clerk.deleted.includes(account.clerkId));
    assert.equal((await users.list(seed.admin)).users.some((entry) => entry.id === account.membershipId),false);
    await assert.rejects(access.membership(account.user.id,seed.orgId),/unavailable/);
    assert.equal((await context.db.query('SELECT id FROM customers WHERE id=$1',[account.customerId])).rowCount,0);
    assert.equal((await context.db.query('SELECT id FROM ledger_entries WHERE customer_id=$1',[account.customerId])).rowCount,0);
    assert.equal((await context.db.query('SELECT id FROM audit_events WHERE object_id=$1',[account.membershipId])).rowCount,0);
    assert.equal((await context.db.query('SELECT id FROM users WHERE id=$1',[account.user.id])).rowCount,0);
  });

  it('keeps subject identity stable after a verified email change and never transfers old-email access implicitly', async () => {
    const account = await joined();
    const originalEmail = account.user.email;
    const changedEmail = `${randomUUID()}@example.test`;
    clerk.identities.set(account.token,{id:account.clerkId,email:changedEmail,name:'Updated Name'});
    const updated = await auth.authenticate(account.token);
    assert.ok(updated);
    assert.equal(updated.id,account.user.id);
    assert.equal(updated.email,changedEmail);
    assert.equal((await access.membership(updated.id,seed.orgId)).customer_id,account.customerId);

    // A later owner of the old mailbox is a new identity with no inherited roles.
    const newOwner = await signIn(originalEmail);
    assert.notEqual(newOwner.user.id,account.user.id);
    assert.equal((await auth.session(newOwner.user)).memberships.length,0);
    await assert.rejects(invitations.invite(seed.admin,account.customerId),/different sign-in email/);

    // Access state changes must continue working after email divergence.
    await users.update(seed.admin,account.membershipId,'disable');
    await assert.rejects(access.membership(updated.id,seed.orgId),/unavailable/);
    await assert.rejects(invitations.invite(seed.admin,account.customerId),/different sign-in email/);
    await users.update(seed.admin,account.membershipId,'enable');
    assert.equal((await access.membership(updated.id,seed.orgId)).is_active,true);
    await users.update(seed.admin,account.membershipId,'delete',account.user.email);
    await assert.rejects(access.membership(updated.id,seed.orgId),/unavailable/);

    // Only explicit administrator deletion plus a fresh invitation transfers access.
    const freshCustomer = await customer(originalEmail);
    await invitations.invite(seed.admin,freshCustomer);
    const fresh = clerk.sent.at(-1)!;
    const accepted = await invitations.accept(fresh.token,newOwner.user.id);
    assert.notEqual(accepted.membershipId,account.membershipId);
    assert.equal((await access.membership(newOwner.user.id,seed.orgId)).customer_id,freshCustomer);
    const memberships = await context.db.query('SELECT is_active,deleted_at FROM memberships WHERE customer_id=$1',[freshCustomer]);
    assert.equal(memberships.rows.filter((member) => member.deleted_at !== null).length,0);
    assert.equal(memberships.rows.filter((member) => member.is_active).length,1);
    const customers = new CustomersService(context.db,access,invitations);
    const listed = await customers.list(seed.admin,{search:originalEmail});
    assert.equal(listed.items.length,1);
    assert.equal(listed.items[0].invitation_status,'accepted');

    // The migration must still reject bypassing invitation email proof at INSERT.
    const unrelated = await customer();
    await assert.rejects(context.db.query(`INSERT INTO memberships(id,organization_id,user_id,role,customer_id)
      VALUES($1,$2,$3,'customer',$4)`,[randomUUID(),seed.otherOrgId,newOwner.user.id,unrelated]),/match the customer email/);
  });

  it('preserves cross-organization invitations when a sole current membership is disabled or deleted', async () => {
    const account = await joined();
    await users.update(seed.admin,account.membershipId,'disable');
    const otherCustomer = await customer(account.user.email,seed.otherOrgId,seed.otherAdminId);
    await invitations.invite(seed.otherAdmin,otherCustomer);
    const invitation = clerk.sent.at(-1)!;
    assert.ok(clerk.unbanned.includes(account.clerkId));
    await assert.rejects(access.membership(account.user.id,seed.orgId),/unavailable/);
    const bans = clerk.banned.filter((id) => id === account.clerkId).length;
    await users.update(seed.admin,account.membershipId,'disable');
    assert.equal(clerk.banned.filter((id) => id === account.clerkId).length,bans);
    await users.update(seed.admin,account.membershipId,'delete',account.user.email);
    assert.equal(clerk.deleted.includes(account.clerkId),false);
    await invitations.accept(invitation.token,account.user.id);
    assert.equal((await access.membership(account.user.id,seed.otherOrgId)).customer_id,otherCustomer);

    // The other organization's invitation can also precede the first disable.
    const second = await joined();
    const pendingCustomer = await customer(second.user.email,seed.otherOrgId,seed.otherAdminId);
    await invitations.invite(seed.otherAdmin,pendingCustomer);
    await users.update(seed.admin,second.membershipId,'disable');
    assert.equal(clerk.banned.includes(second.clerkId),false);
    await invitations.accept(clerk.sent.at(-1)!.token,second.user.id);
    assert.equal((await access.membership(second.user.id,seed.otherOrgId)).customer_id,pendingCustomer);
  });

  it('fails clearly on a stale email collision without transferring identity or existing memberships', async () => {
    const account = await joined();
    const changedEmail = `${randomUUID()}@example.test`;
    clerk.identities.set(account.token,{id:account.clerkId,email:changedEmail,name:'Updated'});
    const newToken = `verified_${randomUUID()}`;
    clerk.identities.set(newToken,{id:`user_${randomUUID()}`,email:account.user.email,name:'New mailbox owner'});
    await assert.rejects(auth.authenticate(newToken),/former account holder must sign in with their updated email/);
    assert.equal((await access.membership(account.user.id,seed.orgId)).customer_id,account.customerId);
    await auth.authenticate(account.token);
    const newOwner = await auth.authenticate(newToken);
    assert.ok(newOwner);
    assert.notEqual(newOwner.id,account.user.id);
    assert.equal((await auth.session(newOwner)).memberships.length,0);
  });

  it('allows a fresh invited account after permanent deletion, including after a verified email change', async () => {
    const account = await joined();
    const changedEmail = `${randomUUID()}@example.test`;
    clerk.identities.set(account.token,{id:account.clerkId,email:changedEmail,name:'Updated'});
    await auth.authenticate(account.token);
    await users.update(seed.admin,account.membershipId,'delete',account.user.email);
    const replacement = await customer(changedEmail);
    await invitations.invite(seed.admin,replacement);
    const fresh = await signIn(changedEmail);
    await invitations.accept(clerk.sent.at(-1)!.token,fresh.user.id);
    assert.notEqual(fresh.user.id,account.user.id);
    assert.equal((await access.membership(fresh.user.id,seed.orgId)).customer_id,replacement);
    assert.equal((await context.db.query('SELECT id FROM memberships WHERE user_id=$1',[account.user.id])).rowCount,0);
  });

  it('never applies global Clerk bans/deletion to identities with another organization', async () => {
    const account = await joined();
    const otherCustomer = await customer(account.user.email,seed.otherOrgId,seed.otherAdminId);
    await context.db.query(`INSERT INTO memberships(id,organization_id,user_id,role,customer_id) VALUES($1,$2,$3,'customer',$4)`,[randomUUID(),seed.otherOrgId,account.user.id,otherCustomer]);
    await users.update(seed.admin,account.membershipId,'disable');
    assert.equal(clerk.banned.includes(account.clerkId),false);
    assert.equal((await access.membership(account.user.id,seed.otherOrgId)).is_active,true);
    await users.update(seed.admin,account.membershipId,'delete',account.user.email);
    assert.equal(clerk.deleted.includes(account.clerkId),false);
    assert.equal((await access.membership(account.user.id,seed.otherOrgId)).is_active,true);
  });

  it('denies customer management, cross-organization access and self deletion; remote errors preserve access state', async () => {
    const account = await joined();
    await assert.rejects(users.update(seed.customerMember,account.membershipId,'disable'),/administrator/);
    await assert.rejects(users.update(seed.otherAdmin,account.membershipId,'delete'),/not found/);
    await assert.rejects(users.update(seed.admin,seed.admin.id,'delete'),/own administrator/);
    await assert.rejects(users.update(seed.admin,seed.admin.id,'disable'),/own administrator/);
    clerk.failManagement = true;
    try { await assert.rejects(users.update(seed.admin,account.membershipId,'disable'),/Clerk could not update/); }
    finally { clerk.failManagement = false; }
    assert.equal((await access.membership(account.user.id,seed.orgId)).is_active,true);
  });
});
