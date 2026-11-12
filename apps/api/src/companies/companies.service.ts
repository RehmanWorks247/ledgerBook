import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { AccessService } from '../access/access.service';
import { parseBody } from '../auth/auth.controller';
import { DatabaseService } from '../database/database.service';
import {
  companyAmount, companyPaidAmount, companyFields, createCompanySchema, deleteCompanySchema, exportCompanySchema, listCompaniesSchema,
  moneyFields, updateCompanySchema, updateCompanyPaidSchema, validateStay, type CompanyInput,
} from './companies.schema';

type MoneyField = typeof moneyFields[number];
type StoredFields = Omit<CompanyInput, MoneyField> & Record<`${MoneyField}_minor`, string | null>;
interface VoucherTotals {
  total_minor: string | null; paid_minor: string; balance_minor: string | null;
  unpaid_minor: string | null; unpriced_count: number; voucher_count: number; paid_version: number | null;
}
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
function storedValues(fields: Partial<CompanyInput>, exponent: number): Record<string, string | number | null> {
  return Object.fromEntries(companyFields.filter(field => fields[field] !== undefined).map(field => [storedColumn(field),
    field === 'voucher_price' ? companyAmount(fields[field]!, exponent) : fields[field]!]));
}
const changedMessage = 'This voucher changed in another session. Reload it before saving or deleting.';

@Injectable()
export class CompaniesService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}

  async list(userId: string, orgId: string, raw: unknown) {
    const query = parseBody(listCompaniesSchema, raw);
    return this.read(userId, orgId, query);
  }

  async export(userId: string, orgId: string, raw: unknown) {
    const query = parseBody(exportCompanySchema, raw);
    const data = await this.read(userId, orgId, listCompaniesSchema.parse(query), true);
    return {
      company_name: query.company_name, items: data.items, total: data.total,
      currency: 'SAR', currency_exponent: data.currency_exponent, totals: data.totals,
    };
  }

  private async read(userId: string, orgId: string, query: ReturnType<typeof listCompaniesSchema.parse>, all = false) {
    return this.db.transaction(async client => {
      const member = await this.access.membership(userId, orgId, true, client);
      const values: unknown[] = [orgId];
      const conditions = ['organization_id=$1'];
      if (query.company_name) {
        values.push(query.company_name);
        conditions.push(`lower(company_name)=lower($${values.length}::text)`);
      }
      if (query.search) {
        // Escape LIKE metacharacters so entered percentages and underscores are literal.
        values.push(`%${query.search.replace(/[\\%_]/g, '\\$&')}%`);
        conditions.push(`(${['company_name', 'hotel_name', 'customer_name', 'room_type', 'voucher_number', 'remarks']
          .map(field => `${field} ILIKE $${values.length} ESCAPE E'\\\\'`).join(' OR ')})`);
      }
      if (query.start) { values.push(query.start); conditions.push(`${query.date_field}>=$${values.length}::date`); }
      if (query.end) { values.push(query.end); conditions.push(`${query.date_field}<=$${values.length}::date`); }
      const where = conditions.join(' AND ');
      // Company totals deliberately ignore table filters and pagination: the
      // independently entered paid amount belongs to the entire company.
      const companyNameIndex = values.length + 1;
      const result = await client.query<{ total: number; items: CompanyRow[]; totals: VoucherTotals }>(`WITH filtered AS (
          SELECT ${columns} FROM companies WHERE ${where}
        ), page AS (SELECT * FROM filtered ORDER BY created_at DESC,id DESC LIMIT $${values.length + 2} OFFSET $${values.length + 3}),
        company_total AS (
          SELECT count(*)::int AS voucher_count,count(*) FILTER (WHERE voucher_price_minor IS NULL)::int AS unpriced_count,
            CASE WHEN count(*) FILTER (WHERE voucher_price_minor IS NULL)>0 THEN NULL ELSE coalesce(sum(voucher_price_minor),0) END AS total_minor
          FROM companies WHERE organization_id=$1 AND ($${companyNameIndex}::text IS NULL OR lower(company_name)=lower($${companyNameIndex}::text))
        ), company_paid AS (
          SELECT coalesce(sum(paid_minor),0) AS paid_minor,coalesce(max(version),0) AS paid_version
          FROM company_balances WHERE organization_id=$1 AND ($${companyNameIndex}::text IS NULL OR company_key=lower($${companyNameIndex}::text))
        )
        SELECT (SELECT count(*)::int FROM filtered) AS total,
          coalesce((SELECT jsonb_agg(page ORDER BY created_at DESC,id DESC) FROM page),'[]'::jsonb) AS items,
          (SELECT jsonb_build_object('total_minor',t.total_minor::text,'paid_minor',p.paid_minor::text,
            'balance_minor',(t.total_minor-p.paid_minor)::text,
            'unpaid_minor',CASE WHEN t.total_minor IS NULL THEN NULL ELSE greatest(t.total_minor-p.paid_minor,0)::text END,
            'unpriced_count',t.unpriced_count,'voucher_count',t.voucher_count,
            'paid_version',CASE WHEN $${companyNameIndex}::text IS NULL THEN NULL ELSE p.paid_version END)
          FROM company_total t CROSS JOIN company_paid p) AS totals`,
      [...values, query.company_name ?? null, all ? null : query.page_size, all ? 0 : (query.page - 1) * query.page_size]);
      return {
        items: result.rows[0].items.map(snapshot), total: result.rows[0].total, page: query.page, page_size: query.page_size,
        currency: member.currency, currency_exponent: member.currency_exponent,
        totals: result.rows[0].totals,
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
      const id = randomUUID();
      await client.query(`INSERT INTO companies(id,organization_id,${names.join(',')})
        VALUES($1,$2,${names.map((_, index) => `$${index + 3}`).join(',')})`, [id, orgId, ...Object.values(fields)]);
      const row = (await client.query<CompanyRow>(`SELECT ${columns} FROM companies WHERE organization_id=$1 AND id=$2`, [orgId, id])).rows[0];
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
      await client.query(`UPDATE companies SET
        ${[...changes.map((field, index) => `${field}=$${index + 4}`),'version=version+1','updated_at=now()'].join(',')}
        WHERE organization_id=$1 AND id=$2 AND version=$3`,
      [orgId, id, data.expected_version, ...changes.map(field => fields[field])]);
      const updated = (await client.query<CompanyRow>(`SELECT ${columns} FROM companies WHERE organization_id=$1 AND id=$2`, [orgId, id])).rows[0];
      return snapshot(updated);
    });
  }

  async updatePaid(userId: string, orgId: string, raw: unknown) {
    const data = parseBody(updateCompanyPaidSchema, raw);
    return this.db.transaction(async client => {
      const member = await this.access.membership(userId, orgId, true, client);
      const paid = companyPaidAmount(data.paid, member.currency_exponent!);
      const key = (await client.query<{ key: string }>('SELECT lower($1::text) AS key', [data.company_name])).rows[0].key;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`company-paid:${orgId}:${key}`]);
      const existing = (await client.query<{ paid_minor: string; version: number }>(
        'SELECT paid_minor::text,version FROM company_balances WHERE organization_id=$1 AND company_key=$2 FOR UPDATE', [orgId, key])).rows[0];
      if ((existing?.version ?? 0) !== data.expected_version)
        throw new ConflictException('The company paid amount changed in another session. Refresh company totals before saving.');
      if (existing?.paid_minor === paid) return { company_name: data.company_name, ...existing };
      const saved = (await client.query<{ paid_minor: string; version: number }>(`INSERT INTO company_balances(organization_id,company_key,paid_minor)
        VALUES($1,$2,$3) ON CONFLICT(organization_id,company_key) DO UPDATE
        SET paid_minor=excluded.paid_minor,version=company_balances.version+1,updated_at=now()
        RETURNING paid_minor::text,version`, [orgId, key, paid])).rows[0];
      return { company_name: data.company_name, ...saved };
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
