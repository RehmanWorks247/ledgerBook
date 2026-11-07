import { BadRequestException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AccessService, type Membership } from '../access/access.service';
import { ClerkService } from '../auth/clerk.service';
import { DatabaseService } from '../database/database.service';

type Identity = {id:string;email:string;clerk_user_id:string|null};

@Injectable()
export class AccountDeletionService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AccessService) private readonly access: AccessService,
    @Optional() @Inject(ClerkService) private readonly clerk: ClerkService = new ClerkService(),
  ) {}

  private confirm(expected: string, provided?: string) {
    if (!provided || provided.trim().toLowerCase() !== expected) throw new BadRequestException('Enter the account email exactly to confirm permanent deletion.');
  }

  async removeCustomer(membership: Membership, customerId: string, confirmationEmail?: string) {
    return this.db.transaction(async (client) => {
      await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[membership.organization_id]);
      const actor = await this.access.membership(membership.user_id,membership.organization_id,true,client);
      const customer = await this.access.customer(actor,customerId,client,true);
      this.confirm(customer.email,confirmationEmail);
      const identities = await client.query<Identity>(`SELECT id,email,clerk_user_id FROM users WHERE id IN
        (SELECT user_id FROM memberships WHERE organization_id=$1 AND customer_id=$2) ORDER BY id FOR UPDATE`,
        [actor.organization_id,customerId]);
      if (this.clerk.enabled) {
        const providerInvitations = await client.query<{clerk_invitation_id:string}>(
          'SELECT clerk_invitation_id FROM invitations WHERE organization_id=$1 AND customer_id=$2 AND clerk_invitation_id IS NOT NULL ORDER BY created_at',
          [actor.organization_id,customerId]);
        try {
          for (const invitation of providerInvitations.rows) await this.clerk.revokeInvitation(invitation.clerk_invitation_id);
        } catch { throw new ServiceUnavailableException('Clerk could not revoke this account’s invitations. Local account data has been retained. Try again.'); }
      }
      await client.query('SELECT permanently_delete_customer($1,$2,$3,$4)',[actor.user_id,actor.organization_id,customerId,customer.email]);
      await this.removeOrphanIdentities(identities.rows,client);
      return { message: 'Customer account and associated data permanently deleted.' };
    });
  }

  async removeMembership(membership: Membership, membershipId: string, confirmationEmail?: string) {
    const actor = await this.access.membership(membership.user_id,membership.organization_id,true);
    const initial = (await this.db.query<Membership>('SELECT * FROM memberships WHERE id=$1 AND organization_id=$2',[membershipId,actor.organization_id])).rows[0];
    if (!initial) throw new NotFoundException('User was not found in this organization.');
    if (initial.customer_id) return this.removeCustomer(actor,initial.customer_id,confirmationEmail);
    return this.db.transaction(async (client) => {
      await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[actor.organization_id]);
      const freshActor = await this.access.membership(actor.user_id,actor.organization_id,true,client);
      if (initial.user_id === freshActor.user_id) throw new BadRequestException('You cannot delete your own administrator account.');
      const identity = (await client.query<Identity>('SELECT id,email,clerk_user_id FROM users WHERE id=$1 FOR UPDATE',[initial.user_id])).rows[0];
      const target = (await client.query<Membership>('SELECT * FROM memberships WHERE id=$1 AND organization_id=$2 FOR UPDATE',[membershipId,actor.organization_id])).rows[0];
      if (!target || !identity) throw new NotFoundException('User was not found in this organization.');
      this.confirm(identity.email,confirmationEmail);
      if (target.is_active) {
        const admins = await client.query(`SELECT count(*)::int AS count FROM memberships WHERE organization_id=$1 AND role='admin' AND is_active AND deleted_at IS NULL`,[actor.organization_id]);
        if (admins.rows[0].count <= 1) throw new BadRequestException('The organization must retain an active administrator.');
      }
      await client.query('SELECT permanently_delete_administrator($1,$2,$3,$4)',[freshActor.user_id,freshActor.organization_id,membershipId,identity.email]);
      await this.removeOrphanIdentities([identity],client);
      return { message: 'Administrator account permanently deleted. Other customers’ financial records remain with anonymous attribution.' };
    });
  }

  private async removeOrphanIdentities(identities: Identity[], client: PoolClient): Promise<void> {
    for (const identity of identities) {
      // Another business's records or outstanding invitations keep its shared identity intact.
      const references = await client.query(`SELECT 1 FROM memberships WHERE user_id=$1
        UNION ALL SELECT 1 FROM customers WHERE created_by=$1
        UNION ALL SELECT 1 FROM ledger_entries WHERE created_by=$1
        UNION ALL SELECT 1 FROM invitations WHERE created_by=$1
        UNION ALL SELECT 1 FROM audit_events WHERE actor_id=$1
        UNION ALL SELECT 1 FROM exchange_rate_overrides WHERE updated_by=$1
        UNION ALL SELECT 1 FROM bookings WHERE created_by=$1
        UNION ALL SELECT 1 FROM booking_nodes WHERE created_by=$1
        UNION ALL SELECT 1 FROM booking_payments WHERE submitted_by=$1 OR reviewed_by=$1
        UNION ALL SELECT 1 FROM invitations i JOIN customers c ON c.id=i.customer_id
          WHERE i.email=$2 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now()
            AND i.delivery_status='sent' AND c.status='active' LIMIT 1`,[identity.id,identity.email]);
      if (references.rowCount) continue;
      if (this.clerk.enabled && identity.clerk_user_id) {
        try { await this.clerk.deleteUser(identity.clerk_user_id); }
        catch { throw new ServiceUnavailableException('Clerk could not delete this sign-in account. Local account data has been retained. Try again.'); }
      }
      // User deletion also cascades local sessions and password-reset data.
      await client.query('DELETE FROM users WHERE id=$1',[identity.id]);
    }
  }
}
