import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';

export interface Membership extends QueryResultRow {
  id: string;
  organization_id: string;
  user_id: string;
  role: 'admin' | 'customer';
  is_active: boolean;
  customer_id: string | null;
  organization_name?: string;
  currency?: string;
  currency_exponent?: number;
}

export interface Customer extends QueryResultRow {
  id: string;
  organization_id: string;
  name: string;
  email: string;
  phone: string;
  notes: string;
  status: 'active' | 'archived';
  created_by: string | null;
}

@Injectable()
export class AccessService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async membership(userId: string, orgId: string, admin = false, client?: PoolClient): Promise<Membership> {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuid.test(userId) || !uuid.test(orgId)) throw new NotFoundException('Organization access is unavailable.');
    const source: Pick<DatabaseService, 'query'> = client ?? this.db;
    // Account disable/deletion locks the organization before memberships. A
    // joined FOR SHARE OF m,o can lock m first and deadlock with those writes.
    // Acquire the organization separately so all transactional readers agree.
    if (client) await client.query('SELECT id FROM organizations WHERE id=$1 AND deleted_at IS NULL FOR SHARE', [orgId]);
    const result = await source.query<Membership>(
      `SELECT m.*, o.name AS organization_name, o.currency, o.currency_exponent
       FROM memberships m JOIN organizations o ON o.id = m.organization_id
       WHERE m.user_id = $1 AND m.organization_id = $2 AND m.is_active = true AND m.deleted_at IS NULL AND o.deleted_at IS NULL
       ${client ? 'FOR SHARE OF m' : ''}`,
      [userId, orgId],
    );
    const member = result.rows[0];
    if (!member) throw new NotFoundException('Organization access is unavailable.');
    if (admin && member.role !== 'admin') throw new ForbiddenException('Organization administrator access is required.');
    return member;
  }

  async customer(member: Membership, customerId: string, client?: PoolClient, lock = false): Promise<Customer> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(customerId)) {
      throw new NotFoundException('Customer account was not found.');
    }
    if (member.role !== 'admin' && member.customer_id !== customerId) {
      throw new NotFoundException('Customer account was not found.');
    }
    const source: Pick<DatabaseService, 'query'> = client ?? this.db;
    const result = await source.query<Customer>(
      `SELECT * FROM customers WHERE id = $1 AND organization_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
      [customerId, member.organization_id],
    );
    if (!result.rows[0]) throw new NotFoundException('Customer account was not found.');
    return result.rows[0];
  }
}
