import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { AccessService, type Membership } from '../access/access.service';
import { AuthService, type AuthUser } from '../auth/auth.service';
import { hashPassword, opaqueToken, tokenHash, validatePassword } from '../auth/crypto';
import { DatabaseService } from '../database/database.service';
import { NotificationsService } from '../notifications/notifications.service';
import { randomUUID } from 'node:crypto';
import { config } from '../config';

export type InvitationState = 'valid' | 'expired' | 'revoked' | 'accepted' | 'invalid';
type InvitationRow = {
  id: string; organization_id: string; customer_id: string; email: string;
  expires_at: Date; accepted_at: Date | null; revoked_at: Date | null;
  organization_name: string; customer_status: string; customer_email: string;
};

function state(invitation?: InvitationRow): InvitationState {
  if (!invitation) return 'invalid';
  if (invitation.accepted_at) return 'accepted';
  if (invitation.revoked_at || invitation.customer_status !== 'active' || invitation.customer_email !== invitation.email) return 'revoked';
  if (new Date(invitation.expires_at).getTime() <= Date.now()) return 'expired';
  return 'valid';
}

@Injectable()
export class InvitationService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  /** Sending again always revokes any previous outstanding link under the account lock. */
  async invite(membership: Membership, customerId: string) {
    const delivery = await this.db.transaction(async (client) => {
      const member = await this.access.membership(membership.user_id, membership.organization_id, true, client);
      const customer = await this.access.customer(member, customerId, client, true);
      if (customer.status !== 'active') throw new BadRequestException('Restore the customer account before inviting them.');
      const association = await client.query(
        `SELECT m.role,m.customer_id,m.is_active FROM memberships m JOIN users u ON u.id=m.user_id
         WHERE m.organization_id=$1 AND u.email=$2`, [member.organization_id, customer.email],
      );
      if (association.rows[0]) {
        const existing = association.rows[0];
        if (existing.role !== 'customer' || existing.customer_id !== customerId) {
          throw new ConflictException('This email is already associated with another organization account.');
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
    let delivered = false;
    try {
      const base = config.appUrl;
      await this.notifications.send({
        to: delivery.customer.email,
        subject: 'Your LedgerBook account invitation',
        text: `${delivery.organizationName} has invited you to view your customer account in LedgerBook.\n\n${base}/invite#${delivery.token}\n\nThis link expires in ${config.invitationTtlHours} hours and can only be used once. Existing users must sign in with the invited email. Your administrator never sets or sees your password.`,
      });
      delivered = true;
    } catch {
      // Customer and invitation are already committed. Admin can explicitly resend.
    }
    await this.db.query(
      `UPDATE invitations SET delivery_status=$1,delivered_at=CASE WHEN $1='sent' THEN now() ELSE NULL END WHERE id=$2`,
      [delivered ? 'sent' : 'failed', delivery.invitation.id],
    );
    return { ...delivery.invitation, delivery_status: delivered ? 'sent' : 'failed' };
  }

  async revoke(membership: Membership, customerId: string): Promise<void> {
    await this.db.transaction(async (client) => {
      const member = await this.access.membership(membership.user_id, membership.organization_id, true, client);
      await this.access.customer(member, customerId, client, true);
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
      `SELECT i.*,o.name AS organization_name,c.status AS customer_status,c.email AS customer_email
       FROM invitations i JOIN organizations o ON o.id=i.organization_id JOIN customers c ON c.id=i.customer_id
       WHERE i.token_hash=$1`, [tokenHash(token)],
    );
    const invitation = result.rows[0];
    const status = state(invitation);
    if (status !== 'valid') return { status };
    const existing = await this.db.query(`SELECT 1 FROM users WHERE email=$1`, [invitation.email]);
    return { status, email: invitation.email, organizationName: invitation.organization_name, existingUser: existing.rowCount !== 0 };
  }

  async accept(token: string, userId?: string, password?: string): Promise<{ user: AuthUser; token?: string; membershipId: string }> {
    const digest = tokenHash(token);
    const candidate = await this.db.query<InvitationRow>(
      `SELECT i.*,o.name AS organization_name,c.status AS customer_status,c.email AS customer_email
       FROM invitations i JOIN organizations o ON o.id=i.organization_id JOIN customers c ON c.id=i.customer_id
       WHERE i.token_hash=$1`, [digest],
    );
    if (state(candidate.rows[0]) !== 'valid') this.rejectState(state(candidate.rows[0]));
    const initial = candidate.rows[0];
    let passwordHash: string | undefined;
    if (!userId && password !== undefined) {
      validatePassword(password, initial.email);
      passwordHash = await hashPassword(password);
    }
    return this.db.transaction(async (client) => {
      // Both acceptance and admin revocation serialize on the ledger-account row.
      await client.query(`SELECT id FROM customers WHERE id=$1 FOR UPDATE`, [initial.customer_id]);
      const fresh = await client.query<InvitationRow>(
        `SELECT i.*,o.name AS organization_name,c.status AS customer_status,c.email AS customer_email
         FROM invitations i JOIN organizations o ON o.id=i.organization_id JOIN customers c ON c.id=i.customer_id
         WHERE i.token_hash=$1 FOR UPDATE OF i`, [digest],
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
      const prior = await client.query(`SELECT * FROM memberships WHERE organization_id=$1 AND user_id=$2 FOR UPDATE`, [invitation.organization_id, user.id]);
      let membershipId: string;
      if (prior.rows[0]) {
        if (prior.rows[0].role !== 'customer' || prior.rows[0].customer_id !== invitation.customer_id) {
          throw new ConflictException('This identity is already associated with another account in this organization.');
        }
        membershipId = prior.rows[0].id;
        await client.query(`UPDATE memberships SET is_active=true WHERE id=$1`, [membershipId]);
      } else {
        const inserted = await client.query(
          `INSERT INTO memberships (id,organization_id,user_id,role,customer_id,is_active) VALUES ($1,$2,$3,'customer',$4,true) RETURNING id`,
          [randomUUID(), invitation.organization_id, user.id, invitation.customer_id],
        );
        membershipId = inserted.rows[0].id;
      }
      await client.query(`UPDATE invitations SET accepted_at=now() WHERE id=$1`, [invitation.id]);
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
