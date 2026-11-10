import { BadRequestException, ConflictException, Inject, Injectable, Logger, Optional, UnauthorizedException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { ClerkService } from './clerk.service';
import { DatabaseService } from '../database/database.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DUMMY_PASSWORD_HASH, hashPassword, opaqueToken, tokenHash, validatePassword, verifyPassword } from './crypto';

export type AuthUser = { id: string; email: string; name?: string; clerk_user_id?: string | null };
const EMAIL_LINK_CONFLICT = 'This email is still linked to another LedgerBook identity. The former account holder must sign in with their updated email, or an administrator must reconcile the accounts. Access has not been transferred.';
const GENERIC_RECOVERY_MESSAGE = 'If an account exists, a password reset link will be sent.';

@Injectable()
export class AuthService {
  private readonly pendingRecovery = new Set<Promise<void>>();
  private acceptingRecovery = true;
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Optional() @Inject(ClerkService) private readonly clerk: ClerkService = new ClerkService(),
  ) {}

  private requireLocal(): void {
    if (this.clerk.enabled) throw new BadRequestException('Use Clerk to sign in and manage your password.');
  }

  async authenticateClerk(token?: string): Promise<AuthUser | null> {
    const identity = await this.clerk.verify(token);
    if (!identity) return null;
    return this.db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [identity.email]);
      const linked = await client.query<AuthUser>('SELECT id,email,name,clerk_user_id FROM users WHERE clerk_user_id=$1 FOR UPDATE', [identity.id]);
      if (linked.rows[0]) {
        if(linked.rows[0].email===identity.email && linked.rows[0].name===identity.name) return linked.rows[0];
        const collision = await client.query('SELECT id FROM users WHERE email=$1 AND id<>$2', [identity.email,linked.rows[0].id]);
        if (collision.rowCount) throw new ConflictException(EMAIL_LINK_CONFLICT);
        // Clerk is the source of truth for the verified account email and display name.
        const updated = await client.query<AuthUser>('UPDATE users SET email=$2,name=$3 WHERE id=$1 RETURNING id,email,name,clerk_user_id', [linked.rows[0].id,identity.email,identity.name]);
        return updated.rows[0];
      }
      const existing = await client.query<AuthUser>('SELECT id,email,clerk_user_id FROM users WHERE email=$1 FOR UPDATE', [identity.email]);
      if (existing.rows[0]?.clerk_user_id) throw new ConflictException(EMAIL_LINK_CONFLICT);
      if (existing.rows[0]) {
        const updated = await client.query<AuthUser>('UPDATE users SET clerk_user_id=$2,name=$3,password_hash=NULL WHERE id=$1 RETURNING id,email,name,clerk_user_id', [existing.rows[0].id,identity.id,identity.name]);
        await client.query('DELETE FROM sessions WHERE user_id=$1', [existing.rows[0].id]);
        return updated.rows[0];
      }
      const inserted = await client.query<AuthUser>('INSERT INTO users (id,email,name,clerk_user_id) VALUES ($1,$2,$3,$4) RETURNING id,email,name,clerk_user_id', [randomUUID(),identity.email,identity.name,identity.id]);
      return inserted.rows[0];
    });
  }

  async createSession(userId: string, client?: PoolClient): Promise<string> {
    this.requireLocal();
    const token = opaqueToken();
    const duration = config.sessionTtlSeconds;
    const source: Pick<DatabaseService, 'query'> = client ?? this.db;
    await source.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2,now() + $3 * interval '1 second')`,
      [tokenHash(token), userId, duration],
    );
    return token;
  }

  async authenticate(token?: string): Promise<AuthUser | null> {
    if (this.clerk.enabled) return this.authenticateClerk(token);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const result = await this.db.query<AuthUser>(
      `SELECT u.id, u.email FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.expires_at>now()`, [tokenHash(token)],
    );
    return result.rows[0] ?? null;
  }

  async login(email: string, password: string): Promise<{ user: AuthUser; token: string }> {
    this.requireLocal();
    const result = await this.db.query<AuthUser & { password_hash: string }>(
      `SELECT id,email,password_hash FROM users WHERE email=$1`, [email.trim().toLowerCase()],
    );
    const candidate = result.rows[0];
    const matches = await verifyPassword(password, candidate?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!candidate || !matches) throw new UnauthorizedException('Email or password is incorrect.');
    return this.db.transaction(async (client) => {
      const fresh = await client.query(`SELECT password_hash FROM users WHERE id=$1 FOR UPDATE`, [candidate.id]);
      if (fresh.rows[0]?.password_hash !== candidate.password_hash) throw new UnauthorizedException('Email or password is incorrect.');
      const token = await this.createSession(candidate.id, client);
      return { user: { id: candidate.id, email: candidate.email }, token };
    });
  }

  async logout(token?: string): Promise<void> {
    if (this.clerk.enabled) return;
    if (token) await this.db.query('DELETE FROM sessions WHERE token_hash=$1', [tokenHash(token)]);
  }

  async session(user: AuthUser) {
    const [memberships, capability] = await Promise.all([this.db.query(
      `SELECT m.id,m.organization_id,m.role,m.is_active,m.customer_id,o.name AS organization_name,o.currency,o.currency_exponent,
        o.description AS organization_description,o.color AS organization_color,o.version AS organization_version
       FROM memberships m JOIN LATERAL (
         SELECT name,currency,currency_exponent,description,color,version FROM organizations
         WHERE id=m.organization_id AND deleted_at IS NULL LIMIT 1
       ) o ON true
       WHERE m.user_id=$1 AND m.is_active=true AND m.deleted_at IS NULL ORDER BY o.name,m.id`, [user.id],
    ), this.db.query<{ allowed: boolean }>(
      'SELECT workspace_creator AS allowed FROM users WHERE id=$1', [user.id],
    )]);
    // The bounded lateral lookup avoids scanning every tenant as the service
    // grows. Removing a last workspace preserves only the creator capability.
    return { user, can_create_workspaces: Boolean(capability.rows[0]?.allowed) || memberships.rows.some(member => member.role === 'admin'),
      memberships: memberships.rows.map(member => ({ ...member, time_zone: config.businessTimeZone })) };
  }

  /** All requests return before identity lookup or email, including unknown addresses. */
  forgotPassword(email: string): { message: string } {
    this.requireLocal();
    if (!this.acceptingRecovery) return { message: GENERIC_RECOVERY_MESSAGE };
    const job = Promise.resolve().then(() => this.deliverRecovery(email.trim().toLowerCase()));
    this.pendingRecovery.add(job);
    void job.catch(() => this.logger.warn('A password recovery request could not be delivered.')).finally(() => this.pendingRecovery.delete(job));
    return { message: GENERIC_RECOVERY_MESSAGE };
  }

  async drainRecovery(): Promise<void> {
    await Promise.allSettled([...this.pendingRecovery]);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.acceptingRecovery = false;
    await this.drainRecovery();
  }

  private async deliverRecovery(email: string): Promise<void> {
    const delivery = await this.db.transaction(async (client) => {
      const result = await client.query<AuthUser>(`SELECT id,email FROM users WHERE email=$1 FOR UPDATE`, [email]);
      const user = result.rows[0];
      if (!user) return null;
      await client.query(`UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL`, [user.id]);
      const token = opaqueToken();
      await client.query(
        `INSERT INTO password_resets (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now() + interval '30 minutes')`,
        [randomUUID(), user.id, tokenHash(token)],
      );
      return { user, token };
    });
    if (!delivery) return;
    const base = config.appUrl;
    await this.notifications.send({
      to: delivery.user.email,
      subject: 'Reset your LedgerBook password',
      text: `Use this link to choose a new password. The link expires in 30 minutes and can only be used once.\n\n${base}/reset-password#${delivery.token}\n\nIf you did not request this, you can ignore this email.`,
    });
  }

  async resetPassword(token: string, password: string): Promise<void> {
    this.requireLocal();
    validatePassword(password);
    const digest = tokenHash(token);
    const candidate = await this.db.query<{ user_id: string }>(
      `SELECT user_id FROM password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now()`, [digest],
    );
    if (!candidate.rows[0]) throw new BadRequestException('This password reset link is invalid or has expired.');
    const passwordHash = await hashPassword(password);
    await this.db.transaction(async (client) => {
      await client.query(`SELECT id FROM users WHERE id=$1 FOR UPDATE`, [candidate.rows[0].user_id]);
      const consumed = await client.query(
        `UPDATE password_resets SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING user_id`, [digest],
      );
      if (!consumed.rows[0]) throw new BadRequestException('This password reset link is invalid or has expired.');
      await client.query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [passwordHash, consumed.rows[0].user_id]);
      await client.query(`UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL`, [consumed.rows[0].user_id]);
      await client.query(`DELETE FROM sessions WHERE user_id=$1`, [consumed.rows[0].user_id]);
    });
  }
}
