import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { AccessService } from '../apps/api/src/access/access.service';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { hashPassword, opaqueToken, tokenHash, verifyPassword } from '../apps/api/src/auth/crypto';
import { RateLimitService } from '../apps/api/src/auth/rate-limit.service';
import { config } from '../apps/api/src/config';
import { InvitationService } from '../apps/api/src/invitations/invitation.service';
import { NotificationsService, type EmailMessage } from '../apps/api/src/notifications/notifications.service';
import { setupTestDatabase, type TestDatabase, type TestSeed, testPassword } from './helpers';

class CapturedNotifications extends NotificationsService {
  messages: EmailMessage[] = [];
  fail = false;
  async send(message: EmailMessage): Promise<void> {
    if (this.fail) throw new Error('Simulated transport failure');
    this.messages.push(message);
  }
  token(): string {
    const text = this.messages.at(-1)?.text ?? '';
    const token = text.match(/#([A-Za-z0-9_-]{43})/)?.[1];
    assert.ok(token, 'Expected a fragment-only email token');
    return token;
  }
}

describe('Authentication, invitations, recovery and abuse controls', () => {
  let context: TestDatabase;
  let seed: TestSeed;
  let auth: AuthService;
  let access: AccessService;
  let invitations: InvitationService;
  let notifications: CapturedNotifications;

  before(async () => {
    context = await setupTestDatabase();
    seed = await context.seed();
    notifications = new CapturedNotifications();
    auth = new AuthService(context.db, notifications);
    access = new AccessService(context.db);
    invitations = new InvitationService(context.db, access, auth, notifications);
  });
  after(async () => {
    await auth?.drainRecovery();
    await context?.close();
  });

  async function customer(email = `${randomUUID()}@example.test`, organizationId = seed.orgId, creatorId = seed.adminId) {
    const id = randomUUID();
    await context.db.query(
      `INSERT INTO customers(id,organization_id,name,email,created_by,idempotency_key,request_hash)
       VALUES($1,$2,'Invitation test',$3,$4,$5,$6)`, [id, organizationId, email, creatorId, randomUUID(), '1'.repeat(64)],
    );
    return id;
  }

  it('uses salted scrypt and rejects incorrect passwords without storing plaintext', async () => {
    const first = await hashPassword(testPassword);
    const second = await hashPassword(testPassword);
    assert.notEqual(first, second);
    assert.equal(first.includes(testPassword), false);
    assert.equal(await verifyPassword(testPassword, first), true);
    assert.equal(await verifyPassword('Incorrect password', first), false);
  });

  it('creates hashed opaque sessions, authenticates and revokes them on logout', async () => {
    const result = await auth.login(' ADMIN@example.test ', testPassword);
    assert.equal(result.user.id, seed.adminId);
    assert.equal((await auth.authenticate(result.token))?.id, seed.adminId);
    const stored = await context.db.query('SELECT token_hash FROM sessions WHERE user_id=$1', [seed.adminId]);
    assert.equal(stored.rows[0].token_hash, tokenHash(result.token));
    assert.notEqual(stored.rows[0].token_hash, result.token);
    await auth.logout(result.token);
    assert.equal(await auth.authenticate(result.token), null);
    const expired = opaqueToken();
    await context.db.query(`INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES($1,$2,now()-interval '2 hours',now()-interval '1 hour')`, [tokenHash(expired), seed.adminId]);
    assert.equal(await auth.authenticate(expired), null);
    await assert.rejects(auth.login('admin@example.test', 'wrong'), /Email or password is incorrect/);
    await assert.rejects(auth.login('unknown@example.test', 'wrong'), /Email or password is incorrect/);
  });

  it('makes a new invited identity and membership atomically with one-use email proof', async () => {
    const email = `${randomUUID()}@example.test`;
    const customerId = await customer(email);
    const invitation = await invitations.invite(seed.admin, customerId);
    assert.equal(invitation.delivery_status, 'sent');
    const token = notifications.token();
    assert.deepEqual(await invitations.inspect(token), { status: 'valid', email, name: 'Invitation test', organizationName: 'North Trading', existingUser: false, provider: 'local' });
    const stored = await context.db.query('SELECT token_hash FROM invitations WHERE id=$1', [invitation.id]);
    assert.equal(stored.rows[0].token_hash, tokenHash(token));
    const accepted = await invitations.accept(token, undefined, testPassword);
    assert.equal(accepted.user.email, email);
    assert.ok(accepted.token);
    assert.equal((await auth.authenticate(accepted.token))?.id, accepted.user.id);
    const membership = await access.membership(accepted.user.id, seed.orgId);
    assert.equal(membership.customer_id, customerId);
    assert.equal(membership.role, 'customer');
    assert.deepEqual(await invitations.inspect(token), { status: 'accepted' });
    await assert.rejects(invitations.accept(token, undefined, testPassword), /already been accepted/);
    await assert.rejects(invitations.invite(seed.admin, customerId), /already has active access/);
  });

  it('requires an existing identity to authenticate the invited email and preserves its password', async () => {
    const customerId = await customer('customer@example.test', seed.otherOrgId, seed.otherAdminId);
    await invitations.invite(seed.otherAdmin, customerId);
    const token = notifications.token();
    assert.equal((await invitations.inspect(token)).existingUser, true);
    await assert.rejects(invitations.accept(token, undefined, 'A replacement password 53!'), /Sign in with the invited email/);
    await assert.rejects(invitations.accept(token, seed.adminId), /email address this invitation was sent to/);
    const beforeHash = await context.db.query('SELECT password_hash FROM users WHERE id=$1', [seed.customerUserId]);
    const accepted = await invitations.accept(token, seed.customerUserId, 'A replacement password 53!');
    assert.equal(accepted.user.id, seed.customerUserId);
    assert.equal(accepted.token, undefined);
    const afterHash = await context.db.query('SELECT password_hash FROM users WHERE id=$1', [seed.customerUserId]);
    assert.equal(afterHash.rows[0].password_hash, beforeHash.rows[0].password_hash);
    const identities = await context.db.query('SELECT count(*) FROM users WHERE email=$1', ['customer@example.test']);
    assert.equal(identities.rows[0].count, '1');
    assert.equal((await access.membership(seed.customerUserId, seed.otherOrgId)).customer_id, customerId);
  });

  it('resending invalidates old links and revocation leaves the customer intact', async () => {
    const customerId = await customer();
    await invitations.invite(seed.admin, customerId);
    const original = notifications.token();
    await invitations.invite(seed.admin, customerId);
    const current = notifications.token();
    assert.notEqual(original, current);
    assert.deepEqual(await invitations.inspect(original), { status: 'revoked' });
    await assert.rejects(invitations.accept(original, undefined, testPassword), /revoked/);
    assert.equal((await invitations.inspect(current)).status, 'valid');
    await invitations.revoke(seed.admin, customerId);
    await assert.rejects(invitations.accept(current, undefined, testPassword), /revoked/);
    assert.equal((await context.db.query('SELECT id FROM customers WHERE id=$1', [customerId])).rowCount, 1);
  });

  it('gives clear invalid and expired outcomes without granting access', async () => {
    assert.deepEqual(await invitations.inspect(opaqueToken()), { status: 'invalid' });
    const customerId = await customer();
    const customerRow = await context.db.query('SELECT email FROM customers WHERE id=$1', [customerId]);
    const token = opaqueToken();
    await context.db.query(
      `INSERT INTO invitations(id,organization_id,customer_id,email,token_hash,created_by,created_at,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,now()-interval '2 days',now()-interval '1 day')`,
      [randomUUID(), seed.orgId, customerId, customerRow.rows[0].email, tokenHash(token), seed.adminId],
    );
    assert.deepEqual(await invitations.inspect(token), { status: 'expired' });
    await assert.rejects(invitations.accept(token, undefined, testPassword), /expired/);
    await invitations.invite(seed.admin, customerId);
    assert.equal((await invitations.inspect(notifications.token())).status, 'valid');
  });

  it('concurrent resends leave only one outstanding invitation', async () => {
    const customerId = await customer();
    const before = notifications.messages.length;
    await Promise.all([invitations.invite(seed.admin, customerId), invitations.invite(seed.admin, customerId)]);
    const tokens = notifications.messages.slice(before).map((message) => message.text.match(/#([A-Za-z0-9_-]{43})/)![1]);
    const statuses = await Promise.all(tokens.map(async (token) => (await invitations.inspect(token)).status));
    assert.deepEqual(statuses.sort(), ['revoked', 'valid']);
    const outstanding = await context.db.query('SELECT count(*) FROM invitations WHERE customer_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL', [customerId]);
    assert.equal(outstanding.rows[0].count, '1');
  });

  it('preserves customer records on delivery failure and permits a fresh retry', async () => {
    const customerId = await customer();
    notifications.fail = true;
    let failed;
    try { failed = await invitations.invite(seed.admin, customerId); }
    finally { notifications.fail = false; }
    assert.equal(failed.delivery_status, 'failed');
    assert.equal((await context.db.query('SELECT id FROM customers WHERE id=$1', [customerId])).rowCount, 1);
    const retried = await invitations.invite(seed.admin, customerId);
    assert.equal(retried.delivery_status, 'sent');
    assert.notEqual(retried.id, failed.id);
    assert.ok((await context.db.query('SELECT revoked_at FROM invitations WHERE id=$1', [failed.id])).rows[0].revoked_at);
  });

  it('denies cross-tenant and customer invitation management and rechecks revoked admin access', async () => {
    await assert.rejects(invitations.invite(seed.admin, seed.otherCustomerId), /not found/);
    await assert.rejects(invitations.invite(seed.customerMember, seed.secondCustomerId), /administrator/);
    await assert.rejects(invitations.revokeAccess(seed.customerMember, seed.customerId), /administrator/);
    await context.db.query('UPDATE memberships SET is_active=false WHERE id=$1', [seed.otherAdmin.id]);
    await assert.rejects(invitations.invite(seed.otherAdmin, seed.otherCustomerId), /unavailable/);
    await context.db.query('UPDATE memberships SET is_active=true WHERE id=$1', [seed.otherAdmin.id]);
  });

  it('revokes customer access without deleting history and can restore it through a new invitation', async () => {
    const customerId = await customer();
    await invitations.invite(seed.admin, customerId);
    const accepted = await invitations.accept(notifications.token(), undefined, testPassword);
    await invitations.revokeAccess(seed.admin, customerId);
    await assert.rejects(access.membership(accepted.user.id, seed.orgId), /unavailable/);
    await invitations.invite(seed.admin, customerId);
    const reaccepted = await invitations.accept(notifications.token(), accepted.user.id);
    assert.equal(reaccepted.membershipId, accepted.membershipId);
    assert.equal((await access.membership(accepted.user.id, seed.orgId)).is_active, true);
    const audit = await context.db.query("SELECT count(*) FROM audit_events WHERE object_id=$1 AND action='customer.access_revoked'", [customerId]);
    assert.equal(audit.rows[0].count, '1');
  });

  it('serializes duplicate acceptance so exactly one account and membership are activated', async () => {
    const email = `${randomUUID()}@example.test`;
    const customerId = await customer(email);
    await invitations.invite(seed.admin, customerId);
    const token = notifications.token();
    const results = await Promise.allSettled([
      invitations.accept(token, undefined, testPassword),
      invitations.accept(token, undefined, testPassword),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal((await context.db.query('SELECT count(*) FROM users WHERE email=$1', [email])).rows[0].count, '1');
    assert.equal((await context.db.query('SELECT count(*) FROM memberships WHERE customer_id=$1', [customerId])).rows[0].count, '1');
  });

  it('returns the same recovery response for known and unknown email addresses', async () => {
    const known = auth.forgotPassword('admin@example.test');
    const unknown = auth.forgotPassword('missing@example.test');
    assert.deepEqual(known, unknown);
    await auth.drainRecovery();
    assert.equal(notifications.messages.at(-1)?.to, 'admin@example.test');
  });

  it('expires reset links, invalidates previous links and consumes reset tokens exactly once', async () => {
    const identity = await auth.login('admin@example.test', testPassword);
    auth.forgotPassword('admin@example.test');
    await auth.drainRecovery();
    const old = notifications.token();
    auth.forgotPassword('admin@example.test');
    await auth.drainRecovery();
    const latest = notifications.token();
    const nextPassword = 'New secure password for admin 69!';
    await assert.rejects(auth.resetPassword(old, nextPassword), /invalid or has expired/);
    await auth.resetPassword(latest, nextPassword);
    await assert.rejects(auth.resetPassword(latest, nextPassword), /invalid or has expired/);
    assert.equal(await auth.authenticate(identity.token), null);
    await assert.rejects(auth.login('admin@example.test', testPassword), /incorrect/);
    assert.equal((await auth.login('admin@example.test', nextPassword)).user.id, seed.adminId);
    const expired = opaqueToken();
    await context.db.query(
      `INSERT INTO password_resets(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now()-interval '2 hours',now()-interval '1 hour')`,
      [randomUUID(), seed.adminId, tokenHash(expired)],
    );
    await assert.rejects(auth.resetPassword(expired, nextPassword), /invalid or has expired/);
  });

  it('enforces atomic shared rate limits, hashes identity bucket keys, and resets expired windows', async () => {
    const rates = new RateLimitService(context.db);
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => rates.consume('test-login', 'private@example.test', 3, 60)));
    assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 3);
    assert.equal(outcomes.filter((result) => result.status === 'rejected').length, 2);
    const bucket = await context.db.query('SELECT key,count FROM rate_limits WHERE key=$1', [tokenHash('test-login:private@example.test')]);
    assert.equal(bucket.rows[0].count, 5);
    assert.equal(bucket.rows[0].key.includes('private'), false);
    await context.db.query('UPDATE rate_limits SET expires_at=now()-interval \'1 second\' WHERE key=$1', [bucket.rows[0].key]);
    await rates.consume('test-login', 'private@example.test', 3, 60);
  });

  it('isolates provider email transport and rejects failures without exposing message bodies', async (test) => {
    const originalMode = config.emailMode;
    const originalKey = config.resendApiKey;
    config.emailMode = 'resend';
    config.resendApiKey = 'test-only-not-a-real-key';
    const transport = new NotificationsService();
    const message = { to: 'test@example.test', subject: 'Test subject', text: 'Test private message' };
    let succeed = true;
    const mock = test.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
      assert.equal(url, 'https://api.resend.com/emails');
      assert.equal(options?.method, 'POST');
      assert.equal(options?.redirect, 'error');
      assert.deepEqual(JSON.parse(String(options?.body)), { from: config.emailFrom, to: [message.to], subject: message.subject, text: message.text });
      return new Response(succeed ? '{"id":"test"}' : 'Test private message', { status: succeed ? 200 : 429 });
    });
    try {
      await transport.send(message);
      succeed = false;
      await assert.rejects(transport.send(message), /^Error: Email delivery was not accepted\.$/);
      assert.equal(mock.mock.calls.length, 2);
    } finally {
      config.emailMode = originalMode;
      config.resendApiKey = originalKey;
      mock.mock.restore();
    }
  });

  it('drains pending recovery delivery before the database shutdown phase', async () => {
    let release!: () => void;
    const delivery = new Promise<void>((resolve) => { release = resolve; });
    class DelayedNotifications extends NotificationsService {
      calls = 0;
      async send(): Promise<void> { this.calls++; await delivery; }
    }
    const delayed = new DelayedNotifications();
    const shuttingDown = new AuthService(context.db, delayed);
    shuttingDown.forgotPassword('admin@example.test');
    let finished = false;
    const shutdown = shuttingDown.beforeApplicationShutdown().then(() => { finished = true; });
    shuttingDown.forgotPassword('customer@example.test');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(finished, false);
    release();
    await shutdown;
    assert.equal(delayed.calls, 1);
  });
});
