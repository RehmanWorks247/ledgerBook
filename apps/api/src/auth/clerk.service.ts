import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createClerkClient, verifyToken } from '@clerk/backend';
import { config } from '../config';

export type ClerkIdentity = { id: string; email: string; name: string };

/** Only this gateway handles Clerk identities. No client-supplied claims establish access. */
@Injectable()
export class ClerkService {
  private readonly client = config.clerkSecretKey ? createClerkClient({ secretKey: config.clerkSecretKey, publishableKey: config.clerkPublishableKey }) : null;
  get enabled() { return config.authProvider === 'clerk'; }

  private sdk() {
    if (!this.client) throw new ServiceUnavailableException('Clerk authentication is not configured.');
    return this.client;
  }

  async verify(token?: string): Promise<ClerkIdentity | null> {
    if (!token || token.length > 8192) return null;
    try {
      const claims = await verifyToken(token, { secretKey: config.clerkSecretKey, authorizedParties: [config.appUrl] });
      if (!claims.sub || !claims.sid || claims.sts === 'pending') return null;
      // Live checks make disabled/deleted accounts and revoked sessions effective immediately.
      const [session, user] = await Promise.all([
        this.sdk().sessions.getSession(claims.sid), this.sdk().users.getUser(claims.sub),
      ]);
      if (session.status !== 'active' || session.userId !== user.id || user.banned || user.locked || user.deprovisioned) return null;
      const email = user.emailAddresses.find((entry) => entry.id === user.primaryEmailAddressId && entry.verification?.status === 'verified');
      if (!email) return null;
      return { id: user.id, email: email.emailAddress.trim().toLowerCase(), name: [user.firstName, user.lastName].filter(Boolean).join(' ') };
    } catch { return null; }
  }

  async userExists(email: string): Promise<boolean> {
    const result = await this.sdk().users.getUserList({ emailAddress: [email], limit: 1 });
    return result.data.length > 0;
  }

  async invite(params: { email: string; name: string; organizationName: string; invitationId: string; token: string }) {
    return this.sdk().invitations.createInvitation({
      emailAddress: params.email,
      redirectUrl: `${config.appUrl}/invite?token=${encodeURIComponent(params.token)}`,
      publicMetadata: { invitationId: params.invitationId, name: params.name, organizationName: params.organizationName },
      notify: true, ignoreExisting: true, expiresInDays: Math.ceil(config.invitationTtlHours / 24),
    });
  }

  async revokeInvitation(id: string): Promise<void> {
    try { await this.sdk().invitations.revokeInvitation(id); }
    catch (error) {
      const status = (error as { status?: number }).status;
      const codes = ((error as { errors?: { code: string }[] }).errors ?? []).map((entry) => entry.code);
      // Already consumed or revoked links are terminal and need no further action.
      if (status !== 404 && !codes.some((code) => ['invitation_already_accepted', 'invitation_already_revoked', 'invitation_not_pending'].includes(code))) throw error;
    }
  }

  async banUser(id: string): Promise<void> { await this.sdk().users.banUser(id); }
  async unbanUser(id: string): Promise<void> { await this.sdk().users.unbanUser(id); }
  async deleteUser(id: string): Promise<void> {
    try { await this.sdk().users.deleteUser(id); }
    catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
  }
}
