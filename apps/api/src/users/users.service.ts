import { BadRequestException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { AccessService, type Membership } from '../access/access.service';
import { ClerkService } from '../auth/clerk.service';
import { DatabaseService } from '../database/database.service';
import { AccountDeletionService } from './account-deletion.service';
import { InvitationService } from '../invitations/invitation.service';

@Injectable()
export class UsersService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(InvitationService) private readonly invitations: InvitationService,
    @Optional() @Inject(ClerkService) private readonly clerk: ClerkService = new ClerkService(),
    @Optional() @Inject(AccountDeletionService) private readonly deletion: AccountDeletionService = new AccountDeletionService(db,access,clerk),
  ) {}

  async list(membership: Membership) {
    const member = await this.access.membership(membership.user_id, membership.organization_id, true);
    const result = await this.db.query(
      `SELECT m.id,m.user_id,m.role,m.is_active,m.customer_id,m.created_at,u.email,
       COALESCE(NULLIF(u.name,''),c.name,u.email) AS name,c.name AS customer_name,c.email AS customer_email
       FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN customers c ON c.id=m.customer_id
       WHERE m.organization_id=$1 AND m.deleted_at IS NULL ORDER BY m.role,u.email,m.id`, [member.organization_id],
    );
    return { users: result.rows };
  }

  async deleteCustomer(membership: Membership, customerId: string, confirmationEmail?: string) {
    return this.deletion.removeCustomer(membership,customerId,confirmationEmail);
  }

  async update(membership: Membership, membershipId: string, action: 'disable' | 'enable' | 'delete', confirmationEmail?: string) {
    if (action === 'delete') return this.deletion.removeMembership(membership,membershipId,confirmationEmail);
    return this.db.transaction(async (client) => {
      // Serialize administrator changes before checking the last active administrator.
      await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [membership.organization_id]);
      const actor = await this.access.membership(membership.user_id, membership.organization_id, true, client);
      let target = (await client.query<Membership & { deleted_at: Date | null }>(
        'SELECT * FROM memberships WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [membershipId,actor.organization_id],
      )).rows[0];
      if (!target) throw new NotFoundException('User was not found in this organization.');
      if (target.user_id === actor.user_id && action !== 'enable') throw new BadRequestException('You cannot disable or delete your own administrator account.');
      if (target.role === 'admin' && target.is_active && action !== 'enable') {
        const admins = await client.query(`SELECT COUNT(*)::int AS count FROM memberships WHERE organization_id=$1 AND role='admin' AND is_active=true AND deleted_at IS NULL`, [actor.organization_id]);
        if (admins.rows[0].count <= 1) throw new BadRequestException('The organization must retain an active administrator.');
      }
      if (target.customer_id) {
        const customer = await this.access.customer(actor,target.customer_id,client,true);
        if (action === 'enable' && customer.status !== 'active') throw new BadRequestException('Restore the customer account before enabling access.');
      }
      // Match invitation acceptance's customer -> user -> membership lock order.
      const user = (await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [target.user_id])).rows[0];
      target = (await client.query<Membership & { deleted_at: Date | null }>(
        'SELECT * FROM memberships WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL FOR UPDATE', [membershipId,actor.organization_id],
      )).rows[0];
      if (!target) throw new NotFoundException('User was not found in this organization.');
      const otherOrganizations = await client.query(`SELECT 1 FROM memberships WHERE user_id=$1 AND organization_id<>$2 AND deleted_at IS NULL
        UNION ALL SELECT 1 FROM invitations i JOIN customers c ON c.id=i.customer_id
          WHERE i.email=$3 AND i.organization_id<>$2 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
          AND i.expires_at>now() AND i.delivery_status='sent' AND c.status='active' LIMIT 1`, [target.user_id,actor.organization_id,user.email]);
      if (action !== 'enable' && target.customer_id) {
        await this.invitations.revokeProviderInvitations(target.customer_id,client);
        await client.query('UPDATE invitations SET revoked_at=now() WHERE customer_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL', [target.customer_id]);
      }
      // Clerk identities are global. Never ban/delete one with membership or a live invitation in another organization.
      if (this.clerk.enabled && user.clerk_user_id) {
        try {
          if (action === 'enable' && user.clerk_banned_by_app) {
            await this.clerk.unbanUser(user.clerk_user_id);
            await client.query('UPDATE users SET clerk_banned_by_app=false WHERE id=$1', [target.user_id]);
          } else if (otherOrganizations.rowCount === 0 && action === 'disable') {
            await this.clerk.banUser(user.clerk_user_id);
            await client.query('UPDATE users SET clerk_banned_by_app=true WHERE id=$1', [target.user_id]);

          }
        } catch { throw new ServiceUnavailableException('Clerk could not update this account. Try again.'); }
      }
      await client.query('UPDATE memberships SET is_active=$2 WHERE id=$1', [target.id,action === 'enable']);
      if (action !== 'enable') await client.query('DELETE FROM sessions WHERE user_id=$1', [target.user_id]);
      await client.query(`INSERT INTO audit_events (organization_id,actor_id,action,object_id,metadata) VALUES ($1,$2,$3,$4,$5)`,
        [actor.organization_id,actor.user_id,`user.${action === 'enable' ? 'enabled' : 'disabled'}`,target.id,JSON.stringify({userId:target.user_id,customerId:target.customer_id})]);
      return { message: action === 'disable' ? 'User access disabled.' : 'User access enabled.' };
    });
  }
}
