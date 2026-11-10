import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import { parseBody } from '../auth/auth.controller';
import { DatabaseService } from '../database/database.service';

const text = (max: number) => z.string().trim().max(max).refine(value => !value.includes('\0'), 'Text cannot contain null characters.');
const profileSchema = z.object({
  name: text(160).min(1).refine(value => !/[\r\n\t]/.test(value), 'Use a single line for the workspace name.'),
  description: text(1000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Choose a valid six-digit color.').transform(value => value.toLowerCase()),
});
export const createWorkspaceSchema = profileSchema.extend({
  description: profileSchema.shape.description.default(''),
  color: profileSchema.shape.color.default('#13795b'),
  idempotency_key: z.uuid(),
}).strict();
export const updateWorkspaceSchema = profileSchema.partial().extend({ expected_version: z.number().int().min(1).max(2147483646) }).strict()
  .refine(value => Object.keys(value).some(key => key !== 'expected_version'), 'Provide at least one workspace field to update.');
export const deleteWorkspaceSchema = z.object({
  confirmation_name: z.string().min(1).max(160).refine(value => !value.includes('\0'), 'Text cannot contain null characters.'),
  expected_version: z.number().int().min(1).max(2147483646),
}).strict();

const profileFields = ['name', 'description', 'color'] as const;
const profileColumns = 'id,name,description,color,currency,currency_exponent,version,created_at,updated_at';
export interface WorkspaceProfile {
  id: string;
  name: string;
  description: string;
  color: string;
  currency: string;
  currency_exponent: number;
  version: number;
  created_at: string;
  updated_at: string;
}
interface WorkspaceRow extends Omit<WorkspaceProfile, 'created_at' | 'updated_at'>, QueryResultRow {
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at?: Date | null;
}
function profile(row: WorkspaceRow): WorkspaceProfile {
  const { deleted_at: _deleted, ...visible } = row;
  return { ...visible, created_at: new Date(row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString() };
}

@Injectable()
export class OrganizationsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}

  private async requireCreator(userId: string, client: PoolClient) {
    const hasRetainedCapability = async () => Boolean((await client.query<{ workspace_creator: boolean }>(
      'SELECT workspace_creator FROM users WHERE id=$1', [userId],
    )).rows[0]?.workspace_creator);
    if (await hasRetainedCapability()) return;
    // Lock the qualifying organization before its membership, matching account
    // revocation/deletion. A completed purge grants capability independently.
    const organization = (await client.query<{ id: string }>(`SELECT o.id FROM organizations o
      WHERE o.deleted_at IS NULL AND EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id=o.id AND m.user_id=$1
        AND m.role='admin' AND m.is_active AND m.deleted_at IS NULL)
      ORDER BY o.id LIMIT 1 FOR SHARE OF o`, [userId])).rows[0];
    if (!organization) {
      // An overlapping last-workspace deletion may have granted this after our
      // first capability read while this statement waited for its row lock.
      if (await hasRetainedCapability()) return;
      throw new ForbiddenException('Administrator access is required to create workspaces.');
    }
    const member = await client.query(`SELECT id FROM memberships WHERE user_id=$1 AND organization_id=$2
      AND role='admin' AND is_active AND deleted_at IS NULL FOR SHARE`, [userId, organization.id]);
    if (!member.rowCount && !await hasRetainedCapability()) throw new ForbiddenException('Administrator access is required to create workspaces.');
  }

  async create(userId: string, raw: unknown): Promise<WorkspaceProfile> {
    const data = parseBody(createWorkspaceSchema, raw);
    const { idempotency_key: key, ...fields } = data;
    const requestHash = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
    return this.db.transaction(async client => {
      // Serialize only this actor's creation requests; other administrators and
      // all unrelated workspace reads/writes can continue concurrently.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`workspace-create:${userId}`]);
      await this.requireCreator(userId, client);
      const previous = (await client.query<{ request_hash: string; response: WorkspaceProfile | null; organization_id: string | null }>(
        'SELECT request_hash,response,organization_id FROM workspace_create_requests WHERE actor_id=$1 AND idempotency_key=$2', [userId, key],
      )).rows[0];
      if (previous) {
        if (previous.request_hash !== requestHash) throw new ConflictException('This submission key has already been used for a different workspace.');
        if (!previous.organization_id || !previous.response) throw new ConflictException('This workspace was deleted. Use a new submission key to create another workspace.');
        const workspace = (await client.query('SELECT deleted_at FROM organizations WHERE id=$1 FOR SHARE', [previous.organization_id])).rows[0];
        if (!workspace || workspace.deleted_at) throw new ConflictException('This workspace was deleted. Use a new submission key to create another workspace.');
        await this.access.membership(userId, previous.organization_id, true, client);
        return previous.response;
      }
      const id = randomUUID();
      const created = (await client.query<WorkspaceRow>(`INSERT INTO organizations
        (id,name,description,color,currency,currency_exponent)
        VALUES($1,$2,$3,$4,'GBP',2) RETURNING ${profileColumns}`,
      [id, ...profileFields.map(field => fields[field])])).rows[0];
      await client.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'admin')", [randomUUID(), id, userId]);
      const response = profile(created);
      await client.query(`INSERT INTO workspace_create_requests(actor_id,idempotency_key,organization_id,request_hash,response)
        VALUES($1,$2,$3,$4,$5::jsonb)`, [userId, key, id, requestHash, JSON.stringify(response)]);
      await client.query(`INSERT INTO audit_events(organization_id,actor_id,action,object_id,metadata)
        VALUES($1,$2,'workspace.created',$3,$4::jsonb)`, [id, userId, id, JSON.stringify({ profile: fields, version: 1 })]);
      return response;
    });
  }

  async get(userId: string, orgId: string): Promise<WorkspaceProfile> {
    return this.db.transaction(async client => {
      await this.access.membership(userId, orgId, false, client);
      const existing = (await client.query<WorkspaceRow>(`SELECT ${profileColumns} FROM organizations WHERE id=$1 AND deleted_at IS NULL`, [orgId])).rows[0];
      if (!existing) throw new NotFoundException('Workspace was not found.');
      return profile(existing);
    });
  }

  async update(userId: string, orgId: string, raw: unknown): Promise<WorkspaceProfile> {
    const data = parseBody(updateWorkspaceSchema, raw);
    return this.db.transaction(async client => {
      const existing = (await client.query<WorkspaceRow>(`SELECT ${profileColumns},deleted_at FROM organizations WHERE id=$1 FOR UPDATE`, [orgId])).rows[0];
      await this.access.membership(userId, orgId, true, client);
      if (!existing || existing.deleted_at) throw new NotFoundException('Workspace was not found.');
      if (existing.version !== data.expected_version) throw new ConflictException('This workspace changed in another session. Reload it before saving.');
      const changes = profileFields.filter(field => data[field] !== undefined && data[field] !== existing[field]);
      if (changes.length === 0) return profile(existing);
      const updated = (await client.query<WorkspaceRow>(`UPDATE organizations SET
        ${changes.map((field, index) => `${field}=$${index + 3}`).join(',')},version=version+1,updated_at=now()
        WHERE id=$1 AND version=$2 RETURNING ${profileColumns}`, [orgId, data.expected_version, ...changes.map(field => data[field])])).rows[0];
      await client.query(`INSERT INTO audit_events(organization_id,actor_id,action,object_id,metadata)
        VALUES($1,$2,'workspace.updated',$3,$4::jsonb)`, [orgId, userId, orgId, JSON.stringify({
        changed_fields: changes, before: Object.fromEntries(changes.map(field => [field, existing[field]])),
        after: Object.fromEntries(changes.map(field => [field, updated[field]])), version: updated.version,
      })]);
      return profile(updated);
    });
  }

  async remove(userId: string, orgId: string, raw: unknown) {
    const data = parseBody(deleteWorkspaceSchema, raw);
    const requestHash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    return this.db.transaction(async client => {
      const existing = (await client.query<WorkspaceRow>(`SELECT ${profileColumns},deleted_at FROM organizations WHERE id=$1 FOR UPDATE`, [orgId])).rows[0];
      if (!existing) {
        const receipt = (await client.query<{ request_hash: string; files_pending: number }>(
          'SELECT request_hash,files_pending FROM workspace_delete_receipts WHERE organization_id=$1 AND actor_id=$2', [orgId, userId],
        )).rows[0];
        if (!receipt) throw new NotFoundException('Workspace was not found.');
        if (receipt.request_hash !== requestHash) throw new ConflictException('This workspace was already deleted with different confirmation details.');
        return { id: orgId, deleted: true, files_pending: receipt.files_pending };
      }
      const member = (await client.query<{ role: string }>(`SELECT role FROM memberships WHERE organization_id=$1
        AND user_id=$2 AND is_active AND deleted_at IS NULL FOR SHARE`, [orgId, userId])).rows[0];
      if (!member || existing.deleted_at) throw new NotFoundException('Workspace was not found.');
      if (member.role !== 'admin') throw new ForbiddenException('Workspace administrator access is required.');
      if (data.confirmation_name !== existing.name) throw new BadRequestException('Enter the exact workspace name to confirm deletion.');
      if (data.expected_version !== existing.version) {
        throw new ConflictException('This workspace changed in another session. Reload it before deleting.');
      }
      try {
        return (await client.query<{ result: { id: string; deleted: true; files_pending: number } }>(
          'SELECT permanently_delete_workspace($1,$2,$3,$4,$5) AS result',
          [userId, orgId, data.confirmation_name, data.expected_version, requestHash],
        )).rows[0].result;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === '42501') throw new ForbiddenException('Workspace administrator access is required.');
        if (code === 'P0002') throw new NotFoundException('Workspace was not found.');
        if (code === '22023') throw new BadRequestException('Enter the exact workspace name to confirm deletion.');
        if (code === '40001') throw new ConflictException('This workspace changed in another session. Reload it before deleting.');
        throw error;
      }
    });
  }
}
