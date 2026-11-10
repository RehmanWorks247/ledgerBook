import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { AccessService, type Membership } from '../access/access.service';
import { DatabaseService } from '../database/database.service';
import { formatMoney, parseMoney, UUID_PATTERN, validDate } from './money';
import { convertMinor } from '../currency/math';
import type { Rate } from '../currency/rates.service';
import { ensureBookingInvoice, issueBookingInvoice } from '../invoices/invoices.service';

export interface PostEntryInput {
  kind: 'opening' | 'charge' | 'payment' | 'reversal';
  amount?: string;
  effective_date: string;
  description: string;
  reference?: string;
  idempotency_key: string;
  reversal_of?: string;
}

export interface StatementFilters {
  start?: string;
  end?: string;
  search?: string;
  page?: number | string;
  page_size?: number | string;
}

export interface LedgerEntry extends QueryResultRow {
  id: string;
  organization_id: string;
  customer_id: string;
  kind: string;
  amount_minor: string;
  currency: string;
  effective_date: string;
  description: string;
  reference: string;
  created_by: string | null;
  created_at: Date;
  reversal_of: string | null;
  reversed_by?: string | null;
  idempotency_key: string;
  request_hash: string;
  running_balance_minor?: string;
}

function text(value: unknown, label: string, max: number, required = true): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new BadRequestException(`${label} ${required ? 'is required and ' : ''}must contain at most ${max} characters.`);
  }
  return value.trim();
}

function normalizeFilters(filters: StatementFilters) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw new BadRequestException('Provide valid statement filters.');
  const allowed = new Set(['start', 'end', 'search', 'page', 'page_size']);
  if (Object.keys(filters).some((key) => !allowed.has(key))) throw new BadRequestException('The statement contains unsupported filters.');
  const start = filters.start || undefined;
  const end = filters.end || undefined;
  if ((start && !validDate(start)) || (end && !validDate(end))) throw new BadRequestException('Use a valid date in YYYY-MM-DD format.');
  if (start && end && start > end) throw new BadRequestException('Start date must be on or before end date.');
  const search = text(filters.search ?? '', 'Search', 200, false);
  const rawPage = filters.page ?? 1;
  const rawPageSize = filters.page_size ?? 50;
  for (const value of [rawPage, rawPageSize]) {
    if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d*$/.test(String(value))) {
      throw new BadRequestException('Page and page size must be positive integers.');
    }
  }
  const page = Number(rawPage);
  const pageSize = Number(rawPageSize);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new BadRequestException('Page must be positive and page size must be between 1 and 100.');
  }
  return { start, end, search, page, pageSize };
}

/** Quote every cell and neutralize spreadsheet formula prefixes in user-authored text. */
export function csvCell(value: unknown, userText = false): string {
  let output = String(value ?? '');
  if (userText && /^[\s\uFEFF]*[=+\-@]/u.test(output)) output = `'${output}`;
  return `"${output.replaceAll('"', '""')}"`;
}

@Injectable()
export class LedgerService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService, @Inject(AccessService) private readonly access: AccessService) {}

  async post(member: Membership, customerId: string, input: PostEntryInput): Promise<LedgerEntry> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new BadRequestException('Provide a transaction object.');
    }
    const allowed = new Set(['kind', 'amount', 'effective_date', 'description', 'reference', 'idempotency_key', 'reversal_of']);
    if (Object.keys(input).some((key) => !allowed.has(key))) throw new BadRequestException('The transaction contains unsupported fields.');
    if (!UUID_PATTERN.test(customerId) || !UUID_PATTERN.test(input.idempotency_key ?? '')) {
      throw new BadRequestException('A valid customer and idempotency key are required.');
    }
    if (!['opening', 'charge', 'payment', 'reversal'].includes(input.kind)) throw new BadRequestException('Invalid transaction type.');
    if (!validDate(input.effective_date)) throw new BadRequestException('Enter a valid effective date in YYYY-MM-DD format.');
    const description = text(input.description, 'Description', 1000);
    const reference = text(input.reference ?? '', 'Reference', 160, false);
    if (input.kind === 'reversal' && (typeof input.reversal_of !== 'string' || !/^[1-9]\d{0,18}$/.test(input.reversal_of) || BigInt(input.reversal_of) > 9_223_372_036_854_775_807n)) {
      throw new BadRequestException('Select an original transaction to reverse.');
    }
    if (input.kind !== 'reversal' && input.reversal_of != null) throw new BadRequestException('Only a reversal can link to an original transaction.');

    return this.db.transaction(async (client) => {
      const authorized = await this.access.membership(member.user_id, member.organization_id, true, client);
      const customer = await this.access.customer(authorized, customerId, client, true);
      const exponent = authorized.currency_exponent!;
      let amount: bigint;
      let original: LedgerEntry | undefined;
      if (input.kind === 'reversal') {
        const result = await client.query<LedgerEntry>(
          `SELECT *, effective_date::text AS effective_date FROM ledger_entries
           WHERE id = $1 AND organization_id = $2 AND customer_id = $3`,
          [input.reversal_of, authorized.organization_id, customerId],
        );
        original = result.rows[0];
        if (!original || original.kind === 'reversal') throw new BadRequestException('Only an original transaction on this account can be reversed.');
        if (input.effective_date < original.effective_date) throw new BadRequestException('A reversal cannot be dated before its original transaction.');
        amount = -BigInt(original.amount_minor);
      } else {
        amount = parseMoney(input.amount!, exponent, input.kind === 'opening');
        if (input.kind === 'payment') amount = -amount;
      }
      const fingerprint = createHash('sha256').update(JSON.stringify({
        organization: authorized.organization_id,
        customer: customerId,
        creator: authorized.user_id,
        kind: input.kind,
        amount: amount.toString(),
        effective_date: input.effective_date,
        description,
        reference,
        reversal_of: original?.id ?? null,
      })).digest('hex');
      const prior = await client.query<LedgerEntry>(
        'SELECT *, effective_date::text AS effective_date FROM ledger_entries WHERE organization_id = $1 AND idempotency_key = $2',
        [authorized.organization_id, input.idempotency_key],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== fingerprint) throw new ConflictException('This submission key was already used for a different transaction.');
        return prior.rows[0];
      }
      if (customer.status !== 'active') throw new ConflictException('Archived accounts cannot receive new transactions. Restore the account first.');
      if (input.kind === 'opening') {
        const previous = await client.query('SELECT 1 FROM ledger_entries WHERE customer_id = $1 LIMIT 1', [customerId]);
        if (previous.rows.length) throw new ConflictException('An opening balance must be the first entry. Use a charge, payment, or reversal to correct later balances.');
      }
      if (original) {
        const reversed = await client.query('SELECT 1 FROM ledger_entries WHERE reversal_of = $1', [original.id]);
        if (reversed.rows.length) throw new ConflictException('This transaction has already been reversed.');
      }
      // Only explicitly associated booking money affects its invoice. General
      // account payments cannot safely be allocated to a particular trip.
      const affectedBookings=original ? (await client.query<{id:string}>(`SELECT b.id FROM bookings b
        WHERE b.organization_id=$1 AND b.customer_id=$2 AND (b.charge_entry_id=$3 OR EXISTS (
          SELECT 1 FROM booking_payments p WHERE p.booking_id=b.id AND p.ledger_entry_id=$3 AND p.status='approved'
        )) ORDER BY b.id FOR UPDATE OF b`,[authorized.organization_id,customerId,original.id])).rows : [];
      for(const booking of affectedBookings) await ensureBookingInvoice(client,{organizationId:authorized.organization_id,
        customerId,bookingId:booking.id,actorId:authorized.user_id});
      // Account lock serializes ledger posts and reversals. A second unique key also guards
      // a malicious/reused submission key across separate customer accounts.
      const result = await client.query<LedgerEntry>(
        `INSERT INTO ledger_entries
          (organization_id, customer_id, kind, amount_minor, currency, effective_date,
           description, reference, created_by, reversal_of, idempotency_key, request_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (organization_id, idempotency_key) DO NOTHING
         RETURNING *, effective_date::text AS effective_date`,
        [authorized.organization_id, customerId, input.kind, amount.toString(), authorized.currency,
          input.effective_date, description, reference, authorized.user_id, original?.id ?? null,
          input.idempotency_key, fingerprint],
      );
      if (!result.rows[0]) throw new ConflictException('This submission key was already used for another transaction.');
      await client.query(
        `INSERT INTO audit_events (organization_id,actor_id,action,object_id,metadata)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [authorized.organization_id, authorized.user_id, original ? 'ledger.reversed' : 'ledger.posted', result.rows[0].id,
          JSON.stringify({ customer_id: customerId, kind: input.kind, reversal_of: original?.id ?? null })],
      );
      for(const booking of affectedBookings) await issueBookingInvoice(client,{organizationId:authorized.organization_id,
        customerId,bookingId:booking.id,actorId:authorized.user_id,reason:original!.kind==='payment'?'payment_reversed':'charge_reversed',
        eventKey:`ledger-reversed:${result.rows[0].id}`});
      return result.rows[0];
    });
  }

  private async statementData(client: PoolClient, member: Membership, customerId: string, filters: StatementFilters, exportAll = false) {
    const normalized = normalizeFilters(filters);
    const authorized = await this.access.membership(member.user_id, member.organization_id, false, client);
    const customer = await this.access.customer(authorized, customerId, client);
    const values: unknown[] = [authorized.organization_id, customerId];
    const criteria: string[] = [];
    if (normalized.start) { values.push(normalized.start); criteria.push(`effective_date >= $${values.length}::date`); }
    if (normalized.end) { values.push(normalized.end); criteria.push(`effective_date <= $${values.length}::date`); }
    const matchesAccount = [customer.id, customer.name, customer.customer_code, customer.email, customer.phone]
      .some(value => typeof value === 'string' && value.toLowerCase().includes(normalized.search.toLowerCase()));
    if (normalized.search && !matchesAccount) {
      values.push(normalized.search);
      criteria.push(`position(lower($${values.length}) in lower(concat_ws(' ', '#' || id::text, description, reference, kind,
        effective_date::text, to_char(effective_date,'DD Mon YYYY'), currency))) > 0`);
    }
    const where = criteria.length ? `AND ${criteria.join(' AND ')}` : '';
    const count = await client.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM ledger_entries WHERE organization_id = $1 AND customer_id = $2 ${where}`, values,
    );
    const total = Number(count.rows[0].total);
    if (exportAll && total > 10_000) throw new BadRequestException('CSV exports are limited to 10,000 entries. Narrow the date range before exporting.');
    const page = Math.min(normalized.page, Math.max(1, Math.ceil(total / normalized.pageSize)));
    const limit = exportAll ? 10_000 : normalized.pageSize;
    const offset = exportAll ? 0 : (page - 1) * normalized.pageSize;
    const entries = await client.query<LedgerEntry>(
      `WITH running AS (
         SELECT e.*, sum(amount_minor) OVER (ORDER BY effective_date,id ROWS UNBOUNDED PRECEDING)::text AS running_balance_minor
         FROM ledger_entries e WHERE organization_id = $1 AND customer_id = $2
       ) SELECT *, effective_date::text AS effective_date,
         (SELECT r.id::text FROM ledger_entries r WHERE r.reversal_of=running.id) AS reversed_by
       FROM running WHERE true ${where}
       ORDER BY running.effective_date,running.id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    );
    const balances = await client.query<{ current: string; opening: string; closing: string; total_amount: string; total_paid: string }>(
      `SELECT coalesce(sum(e.amount_minor),0)::text AS current,
        coalesce(sum(e.amount_minor) FILTER (WHERE $3::date IS NOT NULL AND e.effective_date < $3::date),0)::text AS opening,
        coalesce(sum(e.amount_minor) FILTER (WHERE $4::date IS NULL OR e.effective_date <= $4::date),0)::text AS closing,
        coalesce(sum(e.amount_minor) FILTER (WHERE coalesce(original.kind,e.kind) <> 'payment'),0)::text AS total_amount,
        (-coalesce(sum(e.amount_minor) FILTER (WHERE coalesce(original.kind,e.kind) = 'payment'),0))::text AS total_paid
       FROM ledger_entries e
       LEFT JOIN ledger_entries original ON original.id = e.reversal_of
         AND original.organization_id = e.organization_id AND original.customer_id = e.customer_id
       WHERE e.organization_id = $1 AND e.customer_id = $2`,
      [authorized.organization_id, customerId, normalized.start ?? null, normalized.end ?? null],
    );
    const visibleCustomer = authorized.role === 'admin' ? customer : {
      id: customer.id, organization_id: customer.organization_id, customer_code: customer.customer_code, name: customer.name,
      email: customer.email, phone: customer.phone, status: customer.status,
      created_at: customer.created_at, updated_at: customer.updated_at,
    };
    return {
      customer: visibleCustomer, entries: entries.rows, page, page_size: normalized.pageSize, total,
      opening_balance_minor: balances.rows[0].opening,
      closing_balance_minor: balances.rows[0].closing,
      current_balance_minor: balances.rows[0].current,
      total_amount_minor: balances.rows[0].total_amount,
      total_paid_minor: balances.rows[0].total_paid,
      currency: authorized.currency!, currency_exponent: authorized.currency_exponent!,
    };
  }

  async statement(member: Membership, customerId: string, filters: StatementFilters = {}) {
    if (!UUID_PATTERN.test(customerId)) throw new BadRequestException('Invalid customer account.');
    return this.db.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return this.statementData(client, member, customerId, filters);
    });
  }

  async csv(member: Membership, customerId: string, filters: StatementFilters = {}, conversion?: { code: string; exponent: number; rate: Rate }): Promise<string> {
    if (!UUID_PATTERN.test(customerId)) throw new BadRequestException('Invalid customer account.');
    const statement = await this.db.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return this.statementData(client, member, customerId, filters, true);
    });
    const converted = conversion && conversion.code !== statement.currency;
    const amount = (value: string) => converted
      ? formatMoney(convertMinor(value, statement.currency_exponent, conversion.exponent, conversion.rate.rate), conversion.exponent)
      : formatMoney(value, statement.currency_exponent);
    const headers = ['Transaction ID', 'Effective date', 'Type', 'Description', 'Reference', 'Currency', 'Amount', 'Running balance', 'Reversal of'];
    if (converted) headers.push('Accounting currency', 'Accounting amount', 'Exchange rate', 'Rate date', 'Rate source', 'Stale rate');
    const lines = [headers.map((value) => csvCell(value)).join(',')];
    for (const entry of statement.entries) {
      lines.push([
        csvCell(entry.id), csvCell(entry.effective_date), csvCell(entry.kind), csvCell(entry.description, true),
        csvCell(entry.reference, true), csvCell(converted ? conversion.code : entry.currency), csvCell(amount(entry.amount_minor)),
        csvCell(amount(entry.running_balance_minor!)), csvCell(entry.reversal_of),
        ...(converted ? [csvCell(statement.currency), csvCell(formatMoney(entry.amount_minor, statement.currency_exponent)),
          csvCell(conversion.rate.rate), csvCell(conversion.rate.date), csvCell(conversion.rate.source), csvCell(conversion.rate.stale)] : []),
      ].join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
  }

  async dashboard(member: Membership) {
    return this.db.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const authorized = await this.access.membership(member.user_id, member.organization_id, true, client);
      const totals = await client.query<{ total_debt_minor: string; total_credit_minor: string; customer_count: number }>(
        `WITH balances AS (
           SELECT c.id, coalesce(sum(e.amount_minor),0) AS balance FROM customers c
           LEFT JOIN ledger_entries e ON e.customer_id=c.id AND e.organization_id=c.organization_id
           WHERE c.organization_id=$1 GROUP BY c.id
         ) SELECT coalesce(sum(balance) FILTER (WHERE balance>0),0)::text AS total_debt_minor,
           coalesce(-sum(balance) FILTER (WHERE balance<0),0)::text AS total_credit_minor,
           count(*)::integer AS customer_count FROM balances`, [authorized.organization_id],
      );
      const recent = await client.query<LedgerEntry>(
        `SELECT e.*, e.effective_date::text AS effective_date,c.name AS customer_name
         FROM ledger_entries e JOIN customers c ON c.id=e.customer_id
         WHERE e.organization_id=$1 ORDER BY e.created_at DESC,e.id DESC LIMIT 10`, [authorized.organization_id],
      );
      return { ...totals.rows[0], recent_entries: recent.rows, currency: authorized.currency, currency_exponent: authorized.currency_exponent };
    });
  }
}
