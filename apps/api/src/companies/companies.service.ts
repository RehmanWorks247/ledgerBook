import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { AccessService } from '../access/access.service';
import { parseBody } from '../auth/auth.controller';
import { DatabaseService } from '../database/database.service';
import {
  companyAmount, companyFields, createCompanySchema, deleteCompanySchema, listCompaniesSchema,
  moneyFields, updateCompanySchema, validateStay, type CompanyInput,
} from './companies.schema';

type MoneyField = typeof moneyFields[number];
type StoredFields = Omit<CompanyInput, MoneyField> & Record<`${MoneyField}_minor`, string | null>;
export interface Company extends StoredFields {
  id: string;
  organization_id: string;
  version: number;
  created_at: string;
  updated_at: string;
}
interface CompanyRow extends Omit<Company, 'created_at' | 'updated_at'>, QueryResultRow {
  created_at: Date | string;
  updated_at: Date | string;
}
const storedColumn = (field: keyof CompanyInput) => moneyFields.includes(field as MoneyField) ? `${field}_minor` : field;
const columns = ['id', 'organization_id', ...companyFields.map(field => {
  const column = storedColumn(field);
  return moneyFields.includes(field as MoneyField) || ['check_in', 'check_out', 'booking_date'].includes(field)
    ? `${column}::text AS ${column}` : column;
}), 'version', 'created_at', 'updated_at'].join(',');
function snapshot(row: CompanyRow): Company {
  return { ...row, created_at: new Date(row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString() };
}
function storedValues(fields: Partial<CompanyInput>, exponent: number): Record<string, string | null> {
  return Object.fromEntries(companyFields.filter(field => fields[field] !== undefined).map(field => [storedColumn(field),
    moneyFields.includes(field as MoneyField) ? companyAmount(fields[field]!, exponent, field === 'balance') : fields[field]!]));
}
const changedMessage = 'This company changed in another session. Reload it before saving or deleting.';

@Injectable()
export class CompaniesService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}

  async list(userId: string, orgId: string, raw: unknown) {
    const query = parseBody(listCompaniesSchema, raw);
    return this.db.transaction(async client => {
      const member = await this.access.membership(userId, orgId, true, client);
      const values: unknown[] = [orgId];
      const conditions = ['organization_id=$1'];
      if (query.search) {
        // Escape LIKE metacharacters so entered percentages and underscores are literal.
        values.push(`%${query.search.replace(/[\\%_]/g, '\\$&')}%`);
        conditions.push(`(${['company_name', 'hotel_name', 'customer_name', 'room_type', 'voucher_number', 'remarks']
          .map(field => `${field} ILIKE $${values.length} ESCAPE E'\\\\'`).join(' OR ')})`);
      }
      if (query.start) { values.push(query.start); conditions.push(`${query.date_field}>=$${values.length}::date`); }
      if (query.end) { values.push(query.end); conditions.push(`${query.date_field}<=$${values.length}::date`); }
      const where = conditions.join(' AND ');
      // One statement keeps the count and page consistent when another admin edits the register.
      const result = await client.query<{ total: number; items: CompanyRow[] }>(`WITH filtered AS (
          SELECT ${columns} FROM companies WHERE ${where}
        ), page AS (SELECT * FROM filtered ORDER BY created_at DESC,id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2})
        SELECT (SELECT count(*)::int FROM filtered) AS total,coalesce((SELECT jsonb_agg(page ORDER BY created_at DESC,id DESC) FROM page),'[]'::jsonb) AS items`,
      [...values, query.page_size, (query.page - 1) * query.page_size]);
      return {
        items: result.rows[0].items.map(snapshot), total: result.rows[0].total, page: query.page, page_size: query.page_size,
        currency: member.currency, currency_exponent: member.currency_exponent,
      };
    });
  }

  async create(userId: string, orgId: string, raw: unknown): Promise<Company> {
    const data = parseBody(createCompanySchema, raw);
    validateStay(data.check_in, data.check_out);
    return this.db.transaction(async client => {
      const member = await this.access.membership(userId, orgId, true, client);
      const fields = storedValues(data, member.currency_exponent!);
      const requestHash = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`company-create:${orgId}:${data.idempotency_key}`]);
      const previous = (await client.query<{ request_hash: string; company_id: string | null; response: Company | null }>(
        'SELECT request_hash,company_id,response FROM company_create_requests WHERE organization_id=$1 AND idempotency_key=$2',
        [orgId, data.idempotency_key],
      )).rows[0];
      if (previous) {
        if (previous.request_hash !== requestHash) throw new ConflictException('This submission key was already used for a different company.');
        if (!previous.company_id || !previous.response) throw new ConflictException('This company was deleted. Use a new submission key to add it again.');
        return previous.response;
      }
      const names = Object.keys(fields);
      const row = (await client.query<CompanyRow>(`INSERT INTO companies(id,organization_id,${names.join(',')})
        VALUES($1,$2,${names.map((_, index) => `$${index + 3}`).join(',')}) RETURNING ${columns}`,
      [randomUUID(), orgId, ...Object.values(fields)])).rows[0];
      const response = snapshot(row);
      await client.query(`INSERT INTO company_create_requests(organization_id,idempotency_key,company_id,request_hash,response)
        VALUES($1,$2,$3,$4,$5::jsonb)`, [orgId, data.idempotency_key, row.id, requestHash, JSON.stringify(response)]);
      return response;
    });
  }

  async update(userId: string, orgId: string, id: string, raw: unknown): Promise<Company> {
    const data = parseBody(updateCompanySchema, raw);
    return this.db.transaction(async client => {
      const member = await this.access.membership(userId, orgId, true, client);
      const existing = (await client.query<CompanyRow>(`SELECT ${columns} FROM companies WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [orgId, id])).rows[0];
      if (!existing) throw new NotFoundException('Company was not found.');
      if (existing.version !== data.expected_version) throw new ConflictException(changedMessage);
      validateStay(data.check_in === undefined ? existing.check_in : data.check_in, data.check_out === undefined ? existing.check_out : data.check_out);
      const fields = storedValues(data, member.currency_exponent!);
      const changes = Object.keys(fields).filter(field => fields[field] !== existing[field]);
      if (!changes.length) return snapshot(existing);
      const updated = (await client.query<CompanyRow>(`UPDATE companies SET
        ${changes.map((field, index) => `${field}=$${index + 4}`).join(',')},version=version+1,updated_at=now()
        WHERE organization_id=$1 AND id=$2 AND version=$3 RETURNING ${columns}`,
      [orgId, id, data.expected_version, ...changes.map(field => fields[field])])).rows[0];
      return snapshot(updated);
    });
  }

  async remove(userId: string, orgId: string, id: string, raw: unknown) {
    const data = parseBody(deleteCompanySchema, raw);
    return this.db.transaction(async client => {
      await this.access.membership(userId, orgId, true, client);
      const existing = (await client.query<{ version: number }>('SELECT version FROM companies WHERE organization_id=$1 AND id=$2 FOR UPDATE', [orgId, id])).rows[0];
      if (!existing) throw new NotFoundException('Company was not found.');
      if (existing.version !== data.expected_version) throw new ConflictException(changedMessage);
      // Keep only the opaque submission receipt so delayed retries cannot recreate deleted data.
      await client.query('UPDATE company_create_requests SET response=NULL WHERE organization_id=$1 AND company_id=$2', [orgId, id]);
      await client.query('DELETE FROM companies WHERE organization_id=$1 AND id=$2 AND version=$3', [orgId, id, data.expected_version]);
      return { id, deleted: true };
    });
  }
}
