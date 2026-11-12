import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import { AccessService, type Membership } from '../access/access.service';
import { config } from '../config';
import { DatabaseService } from '../database/database.service';
import { validDate } from '../ledger/money';
import { addDays, businessDate } from './time';
import { positionCtes } from './receivables';
import { ReportCache } from './report-cache';

const date = z.string().refine(validDate, 'Use a valid date in YYYY-MM-DD format.');
const dates = z.object({ start: date.optional(), end: date.optional() }).strict();
const ledgerFilters = dates.extend({
  search: z.string().trim().max(200).default(''),
  status: z.enum(['all', 'outstanding', 'settled', 'credit', 'overdue']).default('all'),
  kind: z.enum(['all', 'payment']).default('all'),
  min_balance: z.string().regex(/^-?\d{1,12}(\.\d{1,3})?$/).optional(),
  max_balance: z.string().regex(/^-?\d{1,12}(\.\d{1,3})?$/).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new BadRequestException(result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`));
  const values = result.data as { start?: string; end?: string };
  if (values.start && values.end && values.start > values.end) throw new BadRequestException('Start date must be on or before end date.');
  return result.data;
}

function balanceValue(value: string | undefined, exponent: number): string | null {
  if (value === undefined) return null;
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  if (fraction.length > exponent) throw new BadRequestException(`Balance filters accept at most ${exponent} decimal places.`);
  return (BigInt(`${whole}${fraction.padEnd(exponent, '0')}`) * (value.startsWith('-') ? -1n : 1n)).toString();
}

interface DashboardTotals extends QueryResultRow {
  customer_count:number; customers_added_this_month:number; total_debt_minor:string;
  total_credit_minor:string; overdue_minor:string; overdue_customer_count:number;
}
interface Attention extends QueryResultRow {
  id:string; customer_id:string; customer_name:string; customer_code:string; booking_id:string; booking_reference:string;
  amount_minor:string; unpaid_minor:string; due_date:string; status:'overdue'|'due_soon';
  reminder_status:string|null; reminder_at:Date|null;
}
interface Departure extends QueryResultRow {
  id:string; customer_id:string; customer_name:string; customer_code:string; reference:string; departure_at:Date;
  required_services:string[]; within_24_hours:boolean;
}
interface Activity extends QueryResultRow {
  id:string; action:string; created_at:Date; object_id:string; customer_id:string; customer_name:string; customer_code:string; booking_id:string|null;
}
interface LedgerTotals extends QueryResultRow {
  total:number; customer_count:number; charges_minor:string; payments_minor:string;
  net_minor:string; current_balance_minor:string; outstanding_minor:string;
}


@Injectable()
export class DashboardService {
  private readonly reports = new ReportCache();
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AccessService) private readonly access: AccessService) {}

  private async fingerprint(orgId:string) {
    // Audit history is append-only. Customer purge changes the customer hash as
    // well as deleting its audit rows; count detects late commits below max(id).
    const row=(await this.db.query<{revision:string}>(`SELECT concat(
      (SELECT md5(COALESCE(string_agg(id::text||':'||report_version::text,',' ORDER BY id),'')) FROM customers WHERE organization_id=$1),':',
      (SELECT count(*)::text||':'||COALESCE(max(id)::text,'') FROM audit_events WHERE organization_id=$1)) AS revision`,[orgId])).rows[0];
    return row.revision;
  }

  async overview(member: Membership, raw: unknown = {}, now?:Date) {
    const filter=parse(dates,raw);
    const active=await this.access.membership(member.user_id,member.organization_id,true);
    const at=now??new Date();
    const revision=await this.fingerprint(active.organization_id);
    const key=JSON.stringify(['overview',active.organization_id,active.currency,active.currency_exponent,revision,filter,
      businessDate(at),now?.toISOString()??Math.floor(at.getTime()/5000)]);
    return this.reports.get(key,()=>this.computeOverview(active,filter,at));
  }

  private async computeOverview(member: Membership, raw: unknown = {}, now = new Date()) {
    const filter = parse(dates, raw);
    const today = businessDate(now);
    const period = { start: filter.start ?? `${today.slice(0,7)}-01`, end: filter.end ?? today };
    if (period.start > period.end) throw new BadRequestException('Start date must be on or before end date.');
    return this.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      // Compiling these reporting expressions adds substantial latency at scale.
      await client.query('SET LOCAL jit = off');
      const active = await this.access.membership(member.user_id, member.organization_id, true, client);
      const totals = await client.query<DashboardTotals>(`WITH ${positionCtes}
        SELECT (SELECT COUNT(*)::int FROM customers WHERE organization_id=$1) AS customer_count,
        (SELECT COUNT(*)::int FROM customers WHERE organization_id=$1
          AND (created_at AT TIME ZONE $3)::date >= $4::date AND (created_at AT TIME ZONE $3)::date <= $2::date) AS customers_added_this_month,
        (SELECT COALESCE(SUM(GREATEST(balance,0)),0)::text FROM balances) AS total_debt_minor,
        (SELECT COALESCE(SUM(GREATEST(-balance,0)),0)::text FROM balances) AS total_credit_minor,
        (SELECT COALESCE(SUM(unpaid),0)::text FROM positioned WHERE due_date<$2::date) AS overdue_minor,
        (SELECT COUNT(DISTINCT customer_id)::int FROM positioned WHERE due_date<$2::date AND unpaid>0) AS overdue_customer_count`,
      [active.organization_id, today, config.businessTimeZone, `${today.slice(0,7)}-01`]);
      // Reversals are dated money movements; an earlier payment reversed in this
      // period correctly reduces this period's net receipts.
      const payments = await client.query<{payments_received_minor:string}>(`SELECT COALESCE(-SUM(e.amount_minor),0)::text AS payments_received_minor
        FROM account_ledger_entries e LEFT JOIN ledger_entries original ON original.id=e.reversal_of
        WHERE e.organization_id=$1 AND e.effective_date BETWEEN $2::date AND $3::date
        AND (e.kind='payment' OR (e.kind='reversal' AND original.kind='payment'))`,
      [active.organization_id, period.start, period.end]);
      const attention = await client.query<Attention>(`WITH ${positionCtes}, attention AS MATERIALIZED (
          SELECT * FROM positioned WHERE unpaid>0 AND due_date<=$3::date
          ORDER BY due_date,customer_name,id LIMIT 100
        )
        SELECT p.id,p.customer_id,p.customer_name,p.customer_code,p.booking_id,p.booking_reference,p.amount_minor::text,
          p.unpaid::text AS unpaid_minor,p.due_date::text,
          CASE WHEN p.due_date<$2::date THEN 'overdue' ELSE 'due_soon' END AS status,
          COALESCE(reminder.metadata->>'status',split_part(reminder.action,'.',2)) AS reminder_status,reminder.created_at AS reminder_at
        FROM attention p LEFT JOIN LATERAL (
          SELECT action,metadata,created_at FROM (
            (SELECT id,action,metadata,created_at FROM audit_events a
              WHERE a.organization_id=$1 AND a.action LIKE 'reminder.%' AND a.metadata->>'instalment_id'=p.id
              ORDER BY a.created_at DESC,a.id DESC LIMIT 1)
            UNION ALL
            (SELECT id,action,metadata,created_at FROM audit_events a
              WHERE a.organization_id=$1 AND a.action LIKE 'reminder.%' AND a.metadata->>'instalment_id' IS NULL
                AND COALESCE(a.metadata->>'customer_id',a.metadata->>'customerId')=p.customer_id::text
                AND (a.metadata->>'booking_id' IS NULL OR a.metadata->>'booking_id'=p.booking_id::text)
              ORDER BY a.created_at DESC,a.id DESC LIMIT 1)
          ) matching ORDER BY created_at DESC,id DESC LIMIT 1
        ) reminder ON true
        ORDER BY due_date,customer_name,p.id`,
      [active.organization_id, today, addDays(today, 7)]);
      const departures = await this.departures(client, active.organization_id, now);
      const activity = await this.activity(client, active.organization_id, period);
      return { ...totals.rows[0], ...payments.rows[0], today, time_zone: config.businessTimeZone, period,
        attention: attention.rows, departures, activity,
        currency: active.currency, currency_exponent: active.currency_exponent };
    });
  }

  private async departures(client: PoolClient, orgId: string, now: Date) {
    const rows = await client.query<Departure>(`SELECT b.id,b.customer_id,c.name AS customer_name,c.customer_code,b.reference,b.departure_at,b.required_services,
      b.departure_at <= $2::timestamptz + interval '24 hours' AS within_24_hours
      FROM bookings b JOIN customers c ON c.organization_id=b.organization_id AND c.id=b.customer_id
      WHERE b.organization_id=$1 AND b.deleted_at IS NULL AND b.departure_at >= $2::timestamptz AND b.departure_at <= $2::timestamptz + interval '7 days'
      AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reversal_of=b.charge_entry_id)
      ORDER BY b.departure_at,b.id LIMIT 100`, [orgId, now.toISOString()]);
    if (!rows.rows.length) return [];
    const nodes = await client.query<{booking_id:string;service_key:string;document_count:number;issued:boolean}>(`SELECT booking_id,service_key,
      COUNT(*) FILTER (WHERE kind='file')::int AS document_count,
      BOOL_OR(issued_at IS NOT NULL) AS issued
      FROM booking_nodes WHERE organization_id=$1 AND booking_id=ANY($2::uuid[])
      GROUP BY booking_id,service_key`, [orgId, rows.rows.map(row => row.id)]);
    const names: Record<string,string> = { flight: 'Flight Tickets', makkah: 'Makkah Hotel', madinah: 'Madinah Hotel', transfers: 'Transfers', visas: 'Visas', extras: 'Extras' };
    return rows.rows.map(row => {
      const services = Object.entries(names).map(([key,name]) => {
        const node = nodes.rows.find(value => value.booking_id === row.id && value.service_key === key);
        return { key,name,required: (row.required_services as string[]).includes(key),issued: Boolean(node?.issued),document_count: node?.document_count ?? 0 };
      });
      return { ...row,services,missing_documents: services.filter(service => service.required && !service.document_count).map(service => service.name) };
    });
  }

  private async activity(client: PoolClient, orgId: string, period: {start:string;end:string}) {
    const events = await client.query<Activity>(`WITH events AS (
      SELECT a.id::text,a.action,a.created_at,a.object_id,
        COALESCE(a.metadata->>'customer_id',a.metadata->>'customerId',
          CASE WHEN a.action LIKE 'customer.%' THEN a.object_id END) AS customer_id,
        a.metadata->>'booking_id' AS booking_id
      FROM audit_events a WHERE a.organization_id=$1 AND (a.action IN
        ('customer.created','invitation.created','invitation.accepted','booking.created','booking.updated','booking.cancelled','document.uploaded','document.replaced','document.restored') OR a.action LIKE 'reminder.%')
      UNION ALL
      SELECT 'ledger-'||e.id::text,CASE WHEN e.kind='payment' THEN 'payment.received' ELSE 'payment.reversed' END,
        e.created_at,e.id::text,e.customer_id::text,NULL::text
      FROM account_ledger_entries e LEFT JOIN ledger_entries original ON original.id=e.reversal_of
      WHERE e.organization_id=$1 AND (e.kind='payment' OR (e.kind='reversal' AND original.kind='payment'))
    ) SELECT events.*,c.name AS customer_name,c.customer_code FROM events JOIN customers c ON c.id::text=events.customer_id AND c.organization_id=$1
      WHERE (events.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
      ORDER BY events.created_at DESC,events.id DESC LIMIT 30`, [orgId, period.start, period.end, config.businessTimeZone]);
    return events.rows;
  }

  async combinedLedger(member: Membership, raw: unknown = {}) {
    const filter=parse(ledgerFilters,raw);
    const active=await this.access.membership(member.user_id,member.organization_id,true);
    const revision=await this.fingerprint(active.organization_id);
    const key=JSON.stringify(['ledger',active.organization_id,active.currency,active.currency_exponent,revision,filter,businessDate()]);
    return this.reports.get(key,()=>this.computeCombinedLedger(active,filter));
  }

  private async computeCombinedLedger(member: Membership, raw: unknown = {}) {
    const filter = parse(ledgerFilters, raw);
    return this.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await client.query('SET LOCAL jit = off');
      const active = await this.access.membership(member.user_id, member.organization_id, true, client);
      const minimum = balanceValue(filter.min_balance, active.currency_exponent!);
      const maximum = balanceValue(filter.max_balance, active.currency_exponent!);
      if (minimum !== null && maximum !== null && BigInt(minimum)>BigInt(maximum)) throw new BadRequestException('Minimum balance must be on or below maximum balance.');
      const values = [active.organization_id,filter.start??null,filter.end??null,filter.search,filter.status,minimum,maximum,filter.kind,businessDate()];
      const base = `WITH ${positionCtes}, running AS (
        SELECT e.*,SUM(e.amount_minor) OVER (PARTITION BY e.customer_id ORDER BY e.effective_date,e.id ROWS UNBOUNDED PRECEDING) AS running_balance_minor,
          original.kind AS original_kind
        FROM account_ledger_entries e LEFT JOIN ledger_entries original ON original.id=e.reversal_of WHERE e.organization_id=$1
      ), filtered AS (
        SELECT e.*,c.name AS customer_name,c.customer_code,p.balance AS current_balance_minor FROM running e
        JOIN customers c ON c.id=e.customer_id AND c.organization_id=e.organization_id JOIN balances p ON p.id=e.customer_id
        WHERE ($2::date IS NULL OR effective_date >= $2::date) AND ($3::date IS NULL OR effective_date <= $3::date)
        AND ($4='' OR position(lower($4) in lower(concat_ws(' ', c.customer_code,c.name,c.id::text,c.email,c.phone,
          '#' || e.id::text,e.description,e.reference,e.kind,e.effective_date::text,to_char(e.effective_date,'DD Mon YYYY'),e.currency)))>0)
        AND ($5='all' OR ($5='outstanding' AND p.balance>0) OR ($5='settled' AND p.balance=0) OR ($5='credit' AND p.balance<0)
          OR ($5='overdue' AND EXISTS (SELECT 1 FROM positioned i WHERE i.customer_id=c.id AND i.due_date<$9::date AND i.unpaid>0)))
        AND ($6::bigint IS NULL OR p.balance >= $6::bigint) AND ($7::bigint IS NULL OR p.balance <= $7::bigint)
        AND ($8='all' OR e.kind='payment' OR (e.kind='reversal' AND e.original_kind='payment'))
      )`;
      const summary = await client.query<LedgerTotals>(`${base} SELECT COUNT(*)::int AS total,COUNT(DISTINCT customer_id)::int AS customer_count,
        COALESCE(SUM(amount_minor) FILTER (WHERE kind IN ('charge','opening') OR (kind='reversal' AND original_kind IN ('charge','opening'))),0)::text AS charges_minor,
        COALESCE(-SUM(amount_minor) FILTER (WHERE kind='payment' OR (kind='reversal' AND original_kind='payment')),0)::text AS payments_minor,
        COALESCE(SUM(amount_minor),0)::text AS net_minor,
        (SELECT COALESCE(SUM(balance),0)::text FROM balances WHERE id IN (SELECT customer_id FROM filtered)) AS current_balance_minor,
        (SELECT COALESCE(SUM(GREATEST(balance,0)),0)::text FROM balances WHERE id IN (SELECT customer_id FROM filtered)) AS outstanding_minor
        FROM filtered`, values);
      const total = summary.rows[0].total;
      const page = Math.min(filter.page, Math.max(1,Math.ceil(total/filter.page_size)));
      const entries = await client.query(`${base} SELECT id::text,customer_id,customer_name,customer_code,kind,amount_minor::text,currency,
        effective_date::text,description,reference,reversal_of::text,running_balance_minor::text,current_balance_minor::text,created_at
        FROM filtered ORDER BY effective_date DESC,id DESC LIMIT $10 OFFSET $11`, [...values,filter.page_size,(page-1)*filter.page_size]);
      const { customer_count, total: _total, ...totals } = summary.rows[0];
      return { entries:entries.rows,total,customer_count,page,page_size:filter.page_size,totals,currency:active.currency,currency_exponent:active.currency_exponent };
    });
  }
}
