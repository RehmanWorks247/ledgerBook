import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, Optional, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AccessService, type Membership } from '../access/access.service';
import { AuthService, type AuthUser } from '../auth/auth.service';
import { hashPassword, opaqueToken, tokenHash, validatePassword } from '../auth/crypto';
import { DatabaseService } from '../database/database.service';
import { NotificationsService } from '../notifications/notifications.service';
import { randomUUID } from 'node:crypto';
import { ClerkService } from '../auth/clerk.service';
import { config } from '../config';

export type InvitationState = 'valid' | 'expired' | 'revoked' | 'accepted' | 'invalid';
type InvitationRow = {
  id: string; organization_id: string; customer_id: string; email: string;
  expires_at: Date; accepted_at: Date | null; revoked_at: Date | null;
  organization_name: string; customer_status: string; customer_email: string; customer_name: string; clerk_invitation_id: string | null;
};

function state(invitation?: InvitationRow): InvitationState {
  if (!invitation) return 'invalid';
  if (invitation.accepted_at) return 'accepted';
  if (invitation.revoked_at || invitation.customer_status !== 'active' || invitation.customer_email !== invitation.email) return 'revoked';
  if (new Date(invitation.expires_at).getTime() <= Date.now()) return 'expired';
  return 'valid';
}

const SAFE_CLERK_ERROR_CODES = new Set([
  'rate_limit_exceeded', 'request_rate_limited', 'too_many_requests',
  'form_identifier_exists', 'form_identifier_invalid', 'form_param_format_invalid',
  'form_param_nil', 'form_param_value_invalid', 'form_param_unknown', 'form_param_missing',
  'email_address_invalid', 'invitation_already_exists', 'invitation_already_accepted',
  'invitation_already_revoked', 'invitation_not_pending', 'resource_not_found',
  'user_banned', 'user_locked', 'api_key_invalid', 'authentication_invalid',
  'authorization_invalid', 'feature_not_enabled', 'invalid_redirect_url', 'unexpected_error',
]);
type InvitationFailure = { operation: 'create_invitation' | 'enable_account'; providerStatus: number | null; providerCodes: string[] };

function safeInvitationFailure(error: unknown, operation: InvitationFailure['operation']): InvitationFailure {
  const value = error && typeof error === 'object' ? error as { status?: unknown; errors?: unknown } : {};
  const providerStatus = typeof value.status === 'number' && Number.isInteger(value.status) && value.status >= 400 && value.status <= 599 ? value.status : null;
  const codes = Array.isArray(value.errors) ? value.errors.flatMap((entry: unknown) => {
    const code = entry && typeof entry === 'object' ? (entry as { code?: unknown }).code : null;
    return typeof code === 'string' && SAFE_CLERK_ERROR_CODES.has(code) ? [code] : [];
  }) : [];
  // Never log provider messages, arbitrary codes, response bodies, email addresses or tokens.
  return { operation, providerStatus, providerCodes: [...new Set(codes)].slice(0, 5) };
}

@Injectable()
export class InvitationService {
  private readonly logger = new Logger(InvitationService.name);
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Optional() @Inject(ClerkService) private readonly clerk: ClerkService = new ClerkService(),
  ) {}

  /** Sending again always revokes any previous outstanding link under the account lock. */
  async invite(membership: Membership, customerId: string) {
    if (this.clerk.enabled) return this.inviteClerk(membership, customerId);
    const delivery = await this.db.transaction(async (client) => {
      const member = await this.access.membership(membership.user_id, membership.organization_id, true, client);
      const customer = await this.access.customer(member, customerId, client, true);
      if (customer.status !== 'active') throw new BadRequestException('Restore the customer account before inviting them.');
      const association = await client.query(
        `SELECT m.role,m.customer_id,m.is_active,u.email,u.id AS user_id,u.clerk_user_id,u.clerk_banned_by_app FROM memberships m JOIN users u ON u.id=m.user_id
         WHERE m.organization_id=$1 AND (u.email=$2 OR (m.customer_id=$3 AND m.deleted_at IS NULL))`, [member.organization_id, customer.email, customerId],
      );
      for (const existing of association.rows) {
        if (existing.customer_id === customerId && existing.email !== customer.email) {
          throw new ConflictException('This customer belongs to a user with a different sign-in email. Enable that user or delete their access before inviting someone else.');
        }
        if (existing.role !== 'customer' || existing.customer_id !== customerId) {
          throw new ConflictException('This sign-in identity is already associated with another account in this organization, including retained account history. Reuse that account or invite a different identity.');
        }
        if (existing.is_active) throw new ConflictException('This customer already has active access.');
      }
      await client.query(
        `UPDATE invitations SET revoked_at=now() WHERE customer_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL`, [customerId],
      );
      const token = opaqueToken();
      const result = await client.query(
        `INSERT INTO invitations (id,organization_id,customer_id,email,token_hash,expires_at,created_by)
         VALUES ($1,$2,$3,$4,$5,now() + $6 * interval '1 hour',$7) RETURNING id,expires_at,delivery_status`,
        [randomUUID(), member.organization_id, customerId, customer.email, tokenHash(token), config.invitationTtlHours, member.user_id],
      );
      await client.query(
        `INSERT INTO audit_events (organization_id,actor_id,action,object_id,metadata) VALUES ($1,$2,'invitation.created',$3,$4)`,
        [member.organization_id, member.user_id, result.rows[0].id, JSON.stringify({ customerId })],
      );
      return { invitation: result.rows[0], customer, token, organizationName: member.organization_name };
    });
    return this.db.transaction(async client => {
      // Keep workspace access locked through delivery. Deletion may have
      // committed after the invitation was saved, before this send started.
      const member = await this.access.membership(membership.user_id, membership.organization_id, true, client);
      const customer = await this.access.customer(member, customerId, client, true);
      if (customer.status !== 'active') throw new BadRequestException('Restore the customer account before inviting them.');
      let delivered = false;
      try {
        const base = config.appUrl;
        await this.notifications.send({
          to: customer.email,
          subject: 'Your LedgerBook account invitation',
          text: `${member.organization_name} invited you to view your balance and statements in LedgerBook. Open the link to join and choose your password. If you already have an account, sign in with ${customer.email} to accept.\n\n${base}/invite#${delivery.token}\n\nThis link expires in ${config.invitationTtlHours} hours and can only be used once.`,
        });
        delivered = true;
      } catch {
        // The saved invitation remains available for an explicit resend.
      }
      await client.query(
        `UPDATE invitations SET delivery_status=$1,delivered_at=CASE WHEN $1='sent' THEN now() ELSE NULL END WHERE id=$2`,
        [delivered ? 'sent' : 'failed', delivery.invitation.id],
      );
      return { ...delivery.invitation, delivery_status: delivered ? 'sent' : 'failed' };
    });
  }

  private async inviteClerk(membership: Membership, customerId: string) {
    return this.db.transaction(async (client) => {
      const member = await this.access.membership(membership.user_id, membership.organization_id, true, client);
      const customer = await this.access.customer(member, customerId, client, true);
      if (customer.status !== 'active') throw new BadRequestException('Restore the customer account before inviting them.');
      const association = await client.query(
        `SELECT m.role,m.customer_id,m.is_active,u.email,u.id AS user_id,u.clerk_user_id,u.clerk_banned_by_app FROM memberships m JOIN users u ON u.id=m.user_id
         WHERE m.organization_id=$1 AND (u.email=$2 OR (m.customer_id=$3 AND m.deleted_at IS NULL))`, [member.organization_id, customer.email, customerId],
      );
      for (const existing of association.rows) {
        if (existing.customer_id === customerId && existing.email !== customer.email) {
          throw new ConflictException('This customer belongs to a user with a different sign-in email. Enable that user or delete their access before inviting someone else.');
        }
        if (existing.role !== 'customer' || existing.customer_id !== customerId) throw new ConflictException('This sign-in identity is already associated with another account in this organization, including retained account history. Reuse that account or invite a different identity.');
        if (existing.is_active) throw new ConflictException('This customer already has active access.');
      }
      // Serialize global account management with cross-organization invitations.
      const invitedIdentity = (await client.query('SELECT id,clerk_user_id,clerk_banned_by_app FROM users WHERE email=$1 FOR UPDATE', [customer.email])).rows[0];
      await this.revokeProviderInvitations(customerId, client);
      await client.query(`UPDATE invitations SET revoked_at=now() WHERE customer_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL`, [customerId]);
      const token = opaqueToken();
      const id = randomUUID();
      await client.query(
        `INSERT INTO invitations (id,organization_id,customer_id,email,token_hash,expires_at,created_by)
         VALUES ($1,$2,$3,$4,$5,now() + $6 * interval '1 hour',$7)`,
        [id,member.organization_id,customerId,customer.email,tokenHash(token),config.invitationTtlHours,member.user_id],
      );
      let clerkInvitationId: string | null = null;
      let deliveryFailure: InvitationFailure | undefined;
      let operation: InvitationFailure['operation'] = 'create_invitation';
      try {
        const invitation = await this.clerk.invite({ email: customer.email, name: customer.name, organizationName: member.organization_name ?? '', invitationId: id, token });
        clerkInvitationId = invitation.id;
        if (invitedIdentity?.clerk_banned_by_app && invitedIdentity.clerk_user_id) {
          operation = 'enable_account';
          await this.clerk.unbanUser(invitedIdentity.clerk_user_id);
          await client.query('UPDATE users SET clerk_banned_by_app=false WHERE id=$1', [invitedIdentity.id]);
        }
      } catch (error) {
        deliveryFailure = safeInvitationFailure(error, operation);
        this.logger.warn(JSON.stringify({ event: 'clerk_invitation_failed', invitationId: id, ...deliveryFailure }));
        if (clerkInvitationId) {
          await this.clerk.revokeInvitation(clerkInvitationId);
          clerkInvitationId = null;
        }
        // The durable failed row makes a delivery failure visible and safely retryable.
      }
      const saved = await client.query(
        `UPDATE invitations SET clerk_invitation_id=$2,delivery_status=$3,delivered_at=CASE WHEN $3='sent' THEN now() ELSE NULL END
         WHERE id=$1 RETURNING id,expires_at,delivery_status`, [id,clerkInvitationId,clerkInvitationId ? 'sent' : 'failed'],
      );
      await client.query(`INSERT INTO audit_events (organization_id,actor_id,action,object_id,metadata)
        VALUES ($1,$2,'invitation.created',$3,$4)`, [member.organization_id,member.user_id,id,JSON.stringify({customerId,provider:'clerk',...(deliveryFailure ? {deliveryFailure} : {})})]);
      return saved.rows[0];
    });
  }

  async revokeProviderInvitations(customerId: string, source: Pick<DatabaseService, 'query'> = this.db): Promise<void> {
    if (!this.clerk.enabled) return;
    const previous = await source.query<{clerk_invitation_id:string}>(
      `SELECT clerk_invitation_id FROM invitations WHERE customer_id=$1 AND clerk_invitation_id IS NOT NULL
       AND accepted_at IS NULL AND revoked_at IS NULL`, [customerId],
    );
    for (const invitation of previous.rows) await this.clerk.revokeInvitation(invitation.clerk_invitation_id);
  }

  async revoke(membership: Membership, customerId: string): Promise<void> {
    await this.db.transaction(async (client) => {
      const member = await this.access.membership(membership.user_id, membership.organization_id, true, client);
      await this.access.customer(member, customerId, client, true);
      await this.revokeProviderInvitations(customerId, client);
      await client.query(
        `UPDATE invitations SET revoked_at=now() WHERE customer_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL`, [customerId],
      );
      await client.query(
        `INSERT INTO audit_events (organization_id,actor_id,action,object_id,metadata) VALUES ($1,$2,'invitation.revoked',$3,'{}')`,
        [member.organization_id, member.user_id, customerId],
      );
    });
  }

  async revokeAccess(membership: Membership, customerId: string): Promise<void> {
    await this.db.transaction(async (client) => {
      const member = await this.access.membership(membership.user_id, membership.organization_id, true, client);
      await this.access.customer(member, customerId, client, true);
      await this.revokeProviderInvitations(customerId, client);
      await client.query(`UPDATE memberships SET is_active=false WHERE organization_id=$1 AND customer_id=$2 AND role='customer'`, [member.organization_id, customerId]);
      await client.query(`UPDATE invitations SET revoked_at=now() WHERE customer_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL`, [customerId]);
      await client.query(
        `INSERT INTO audit_events (organization_id,actor_id,action,object_id,metadata) VALUES ($1,$2,'customer.access_revoked',$3,'{}')`,
        [member.organization_id, member.user_id, customerId],
      );
    });
  }

  async inspect(token: string) {
    const result = await this.db.query<InvitationRow>(
      `SELECT i.*,o.name AS organization_name,c.status AS customer_status,c.email AS customer_email,c.name AS customer_name
       FROM invitations i JOIN organizations o ON o.id=i.organization_id JOIN customers c ON c.id=i.customer_id
       WHERE i.token_hash=$1 AND o.deleted_at IS NULL`, [tokenHash(token)],
    );
    const invitation = result.rows[0];
    const status = this.clerk.enabled && !invitation?.clerk_invitation_id ? 'invalid' : state(invitation);
    if (status !== 'valid') return { status };
    const existing = await this.db.query(`SELECT 1 FROM users WHERE email=$1`, [invitation.email]);
    return { status, email: invitation.email, name: invitation.customer_name, organizationName: invitation.organization_name, existingUser: this.clerk.enabled ? await this.clerk.userExists(invitation.email) : existing.rowCount !== 0, provider: this.clerk.enabled ? 'clerk' : 'local' };
  }

  async accept(token: string, userId?: string, password?: string): Promise<{ user: AuthUser; token?: string; membershipId: string }> {
    const digest = tokenHash(token);
    const candidate = await this.db.query<InvitationRow>(
      `SELECT i.*,o.name AS organization_name,c.status AS customer_status,c.email AS customer_email,c.name AS customer_name
       FROM invitations i JOIN organizations o ON o.id=i.organization_id JOIN customers c ON c.id=i.customer_id
       WHERE i.token_hash=$1 AND o.deleted_at IS NULL`, [digest],
    );
    if (this.clerk.enabled && (!candidate.rows[0]?.clerk_invitation_id || !userId)) throw new UnauthorizedException('Sign in with the invited email address to accept this invitation.');
    if (state(candidate.rows[0]) !== 'valid') this.rejectState(state(candidate.rows[0]));
    const initial = candidate.rows[0];
    let passwordHash: string | undefined;
    if (!this.clerk.enabled && !userId && password !== undefined) {
      validatePassword(password);
      passwordHash = await hashPassword(password);
    }
    return this.db.transaction(async (client) => {
      // Match deletion's organization -> customer -> membership lock order.
      const organization = await client.query('SELECT id FROM organizations WHERE id=$1 AND deleted_at IS NULL FOR SHARE', [initial.organization_id]);
      if (!organization.rows.length) this.rejectState('invalid');
      // Both acceptance and admin revocation serialize on the ledger-account row.
      await client.query(`SELECT id FROM customers WHERE id=$1 FOR UPDATE`, [initial.customer_id]);
      const fresh = await client.query<InvitationRow>(
        `SELECT i.*,o.name AS organization_name,c.status AS customer_status,c.email AS customer_email,c.name AS customer_name
         FROM invitations i JOIN organizations o ON o.id=i.organization_id JOIN customers c ON c.id=i.customer_id
         WHERE i.token_hash=$1 AND o.deleted_at IS NULL FOR UPDATE OF i`, [digest],
      );
      const invitation = fresh.rows[0];
      const currentState = state(invitation);
      if (currentState !== 'valid') this.rejectState(currentState);
      // Serialize same-email signups across different tenant invitations.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [invitation.email]);
      const users = await client.query<AuthUser>(`SELECT id,email FROM users WHERE email=$1 FOR UPDATE`, [invitation.email]);
      let user = users.rows[0];
      let created = false;
      if (user) {
        if (!userId) throw new UnauthorizedException('Sign in with the invited email address to accept this invitation.');
        if (user.id !== userId) throw new ForbiddenException('Sign in with the email address this invitation was sent to.');
      } else {
        if (userId) throw new ForbiddenException('Sign out and use the email address this invitation was sent to.');
        if (!passwordHash) throw new BadRequestException('Choose your password to accept this invitation.');
        const inserted = await client.query<AuthUser>(`INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3) RETURNING id,email`, [randomUUID(), invitation.email, passwordHash]);
        user = inserted.rows[0];
        created = true;
      }
      if (this.clerk.enabled) {
        const identity = await client.query('SELECT clerk_user_id,clerk_banned_by_app FROM users WHERE id=$1', [user.id]);
        if (!identity.rows[0]?.clerk_user_id) throw new UnauthorizedException('A verified Clerk account is required.');
      }
      const occupied = await client.query('SELECT user_id FROM memberships WHERE customer_id=$1 AND deleted_at IS NULL AND user_id<>$2 FOR UPDATE', [invitation.customer_id,user.id]);
      if (occupied.rowCount) throw new ConflictException('This customer is already linked to another user. Ask your administrator to review their access.');
      const prior = await client.query(`SELECT * FROM memberships WHERE organization_id=$1 AND user_id=$2 FOR UPDATE`, [invitation.organization_id, user.id]);
      let membershipId: string;
      if (prior.rows[0]) {
        if (prior.rows[0].role !== 'customer' || prior.rows[0].customer_id !== invitation.customer_id) {
          throw new ConflictException('This identity is already associated with another account in this organization.');
        }
        membershipId = prior.rows[0].id;
        await client.query(`UPDATE memberships SET is_active=true,deleted_at=NULL WHERE id=$1`, [membershipId]);
      } else {
        const inserted = await client.query(
          `INSERT INTO memberships (id,organization_id,user_id,role,customer_id,is_active) VALUES ($1,$2,$3,'customer',$4,true) RETURNING id`,
          [randomUUID(), invitation.organization_id, user.id, invitation.customer_id],
        );
        membershipId = inserted.rows[0].id;
      }
      if (this.clerk.enabled && invitation.clerk_invitation_id) {
        try {
          // Signup tickets are already accepted by Clerk. Existing users sign in
          // normally, so close their still-pending provider ticket before committing
          // access. Terminal accepted/revoked states are idempotent in the gateway.
          await this.clerk.revokeInvitation(invitation.clerk_invitation_id);
        } catch {
          // Roll back membership activation and keep the local invitation retryable.
          throw new ServiceUnavailableException('Your sign-in is ready, but the invitation could not be finalized. Try joining the workspace again.');
        }
      }
      await client.query(`UPDATE invitations SET accepted_at=now() WHERE id=$1`, [invitation.id]);
      await client.query(`INSERT INTO payment_email_outbox(organization_id,recipient,subject,body,dedupe_key,source_customer_id)
        SELECT m.organization_id,u.email,$2,$3,$4||u.id::text,$5::uuid FROM memberships m JOIN users u ON u.id=m.user_id
        WHERE m.organization_id=$1 AND m.role='admin' AND m.is_active AND m.deleted_at IS NULL
        ON CONFLICT(dedupe_key) DO NOTHING`, [invitation.organization_id,'Invitation accepted · '+invitation.customer_name,
        `${invitation.customer_name} (${invitation.email}) just accepted their invitation to ${invitation.organization_name}.\n\nThey can now sign in to view their account and submit payments.\n\nView customer:\n${config.appUrl}/o/${invitation.organization_id}/users/${invitation.customer_id}`,
        `invitation-accepted:${invitation.id}:`,invitation.customer_id]);
      await client.query(
        `INSERT INTO audit_events (organization_id,actor_id,action,object_id,metadata) VALUES ($1,$2,'invitation.accepted',$3,$4)`,
        [invitation.organization_id, user.id, invitation.id, JSON.stringify({ customerId: invitation.customer_id, membershipId })],
      );
      return { user, membershipId, ...(created ? { token: await this.auth.createSession(user.id, client) } : {}) };
    });
  }

  private rejectState(status: InvitationState): never {
    const messages: Record<InvitationState, string> = {
      invalid: 'This invitation is invalid.', expired: 'This invitation has expired. Ask your administrator to resend it.',
      revoked: 'This invitation has been revoked. Ask your administrator for a new invitation.',
      accepted: 'This invitation has already been accepted. Sign in to view your account.', valid: 'This invitation is unavailable.',
    };
    throw new BadRequestException(messages[status]);
  }
}
