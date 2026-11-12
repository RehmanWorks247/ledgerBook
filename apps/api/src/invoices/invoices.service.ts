import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { AccessService, type Membership } from '../access/access.service';
import { config } from '../config';
import { DatabaseService } from '../database/database.service';
import { UUID_PATTERN } from '../ledger/money';
import { renderInvoicePdf } from './invoice-pdf';
import { nextInvoiceNumber } from './invoice-number';
import type { InvoiceMetadata, InvoiceReason, InvoiceSnapshot, InvoiceStatus } from './invoice.types';

export type { InvoiceMetadata, InvoiceReason, InvoiceSnapshot, InvoiceStatus } from './invoice.types';

export interface InvoiceContext {
  organizationId: string;
  customerId: string;
  bookingId: string;
  actorId: string;
}
type IssueContext = InvoiceContext & { reason: InvoiceReason; eventKey: string };
type InvoiceRow = Omit<InvoiceMetadata, 'issued_at'> & { issued_at: Date | string; pdf?: Buffer };
const metadataColumns = `id,invoice_number,version,reason,issued_at,total_minor::text AS total_minor,
  paid_minor::text AS paid_minor,balance_minor::text AS balance_minor,currency,status,filename`;
const scopeParams = (context: InvoiceContext) => [context.organizationId, context.customerId, context.bookingId];
function metadata(row: InvoiceRow): InvoiceMetadata {
  const { pdf: _pdf, ...rest } = row;
  return { ...rest, issued_at: new Date(row.issued_at).toISOString() };
}

async function lockBooking(client: PoolClient, context: InvoiceContext) {
  const result = await client.query(`SELECT id FROM bookings WHERE organization_id=$1 AND customer_id=$2 AND id=$3 FOR UPDATE`, scopeParams(context));
  if (!result.rows[0]) throw new NotFoundException('Booking was not found for this customer.');
}

/**
 * Call inside the business transaction, after taking its customer lock. Every
 * payment/booking writer follows the same customer -> booking lock order.
 * An event key is local to one booking and always returns the original bytes.
 */
export async function issueBookingInvoice(client: PoolClient, context: IssueContext): Promise<InvoiceMetadata & { content: Buffer }> {
  if (!context.eventKey || context.eventKey.length > 200) throw new BadRequestException('A valid invoice event key is required.');
  await lockBooking(client, context);
  const prior = await client.query<InvoiceRow>(`SELECT ${metadataColumns},pdf FROM booking_invoices
    WHERE organization_id=$1 AND customer_id=$2 AND booking_id=$3 AND event_key=$4`, [...scopeParams(context), context.eventKey]);
  if (prior.rows[0]) return { ...metadata(prior.rows[0]), content: Buffer.from(prior.rows[0].pdf!) };

  const booking = await client.query<{
    reference: string; departure_at: Date | string; required_services: string[]; total_minor: string; currency: string;
    deleted_at: Date | string | null; organization_name: string; customer_name: string; customer_email: string;
    customer_phone: string; customer_code: string; charge_reversed: boolean;
  }>(`SELECT b.reference,b.departure_at,b.required_services,b.total_minor::text AS total_minor,b.currency,b.deleted_at,
    o.name AS organization_name,c.name AS customer_name,c.email AS customer_email,c.phone AS customer_phone,c.customer_code,
    EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reversal_of=b.charge_entry_id) AS charge_reversed
    FROM bookings b JOIN organizations o ON o.id=b.organization_id
    JOIN customers c ON c.organization_id=b.organization_id AND c.id=b.customer_id
    WHERE b.organization_id=$1 AND b.customer_id=$2 AND b.id=$3`, scopeParams(context));
  const current = booking.rows[0];
  const approved = await client.query<{ paid_minor: string; payment_count: number; latest_payment_date: string | null }>(
    `SELECT coalesce(sum(p.amount_minor),0)::text AS paid_minor,count(*)::int AS payment_count,
      max(p.payment_date)::text AS latest_payment_date FROM booking_payments p
      WHERE p.organization_id=$1 AND p.customer_id=$2 AND p.booking_id=$3 AND p.status='approved'
        AND p.deleted_at IS NULL AND p.ledger_entry_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reversal_of=p.ledger_entry_id)`, scopeParams(context));
  const instalments = await client.query<{ due_date: string; amount_minor: string }>(
    `SELECT due_date::text AS due_date,amount_minor::text AS amount_minor FROM booking_instalments
      WHERE organization_id=$1 AND customer_id=$2 AND booking_id=$3 ORDER BY due_date,id`, scopeParams(context));
  const sequence = await client.query<{ version: number; issued_at: Date | string }>(
    `SELECT coalesce(max(version),0)+1 AS version,clock_timestamp() AS issued_at FROM booking_invoices
      WHERE organization_id=$1 AND customer_id=$2 AND booking_id=$3`, scopeParams(context));
  const version = sequence.rows[0].version;
  const cancelled = current.deleted_at !== null || current.charge_reversed;
  const total = cancelled ? 0n : BigInt(current.total_minor);
  const paid = BigInt(approved.rows[0].paid_minor);
  const balance = total - paid;
  const status: InvoiceStatus = cancelled ? 'cancelled' : balance < 0n ? 'overpaid' : balance === 0n ? 'paid' : paid > 0n ? 'partially_paid' : 'unpaid';
  const number = await nextInvoiceNumber(client);
  const details: InvoiceMetadata = {
    id: randomUUID(), invoice_number: number, version, reason: context.reason,
    issued_at: new Date(sequence.rows[0].issued_at).toISOString(), total_minor: total.toString(),
    paid_minor: paid.toString(), balance_minor: balance.toString(), currency: current.currency, status,
    filename: `${number}.pdf`,
  };
  const snapshot: InvoiceSnapshot = {
    ...details, template_version: 3,
    organization: { id: context.organizationId, name: current.organization_name },
    customer: { id: context.customerId, name: current.customer_name, email: current.customer_email, phone: current.customer_phone, customer_code: current.customer_code },
    booking: {
      id: context.bookingId, reference: current.reference, departure_at: new Date(current.departure_at).toISOString(),
      required_services: current.required_services, original_total_minor: current.total_minor,
      cancelled_at: current.deleted_at ? new Date(current.deleted_at).toISOString() : null, charge_reversed: current.charge_reversed,
    },
    currency_exponent: 2, time_zone: config.businessTimeZone,
    approved_payment_count: approved.rows[0].payment_count, latest_payment_date: approved.rows[0].latest_payment_date,
    instalments: instalments.rows,
  };
  const content = await renderInvoicePdf(snapshot);
  await client.query(`INSERT INTO booking_invoices(id,organization_id,customer_id,booking_id,invoice_number,version,
      reason,event_key,issued_at,total_minor,paid_minor,balance_minor,currency,status,filename,snapshot,pdf)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)`,
  [details.id, ...scopeParams(context), number, version, context.reason, context.eventKey, details.issued_at,
    details.total_minor, details.paid_minor, details.balance_minor, details.currency, status, details.filename, JSON.stringify(snapshot), content]);
  await client.query(`INSERT INTO audit_events(organization_id,actor_id,action,object_id,metadata) VALUES($1,$2,'invoice.issued',$3,$4::jsonb)`,
    [context.organizationId, context.actorId, details.id, JSON.stringify({ customer_id: context.customerId, booking_id: context.bookingId,
      invoice_number: number, version, reason: context.reason })]);
  return { ...details, content };
}

/** Save one honest present-day snapshot for a booking created before invoices. */
export async function ensureBookingInvoice(client: PoolClient, context: InvoiceContext): Promise<InvoiceMetadata> {
  await lockBooking(client, context);
  const existing = await client.query<InvoiceRow>(`SELECT ${metadataColumns} FROM booking_invoices
    WHERE organization_id=$1 AND customer_id=$2 AND booking_id=$3 ORDER BY version DESC LIMIT 1`, scopeParams(context));
  if (existing.rows[0]) return metadata(existing.rows[0]);
  const { content: _content, ...created } = await issueBookingInvoice(client, {
    ...context, reason: 'legacy_snapshot', eventKey: `legacy:${context.bookingId}`,
  });
  return created;
}

const pageSchema = z.object({
  limit: z.string().regex(/^\d{1,3}$/).transform(Number).pipe(z.number().int().min(1).max(100)).optional(),
  before_version: z.string().regex(/^\d{1,10}$/).transform(Number).pipe(z.number().int().min(1).max(2147483647)).optional(),
}).strict();

@Injectable()
export class InvoicesService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService, @Inject(AccessService) private readonly access: AccessService) {}

  async list(member: Membership, customerId: string, bookingId: string, raw: unknown = {}) {
    const parsed = pageSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException('Use limit 1–100 and a positive before_version cursor.');
    if (!UUID_PATTERN.test(bookingId)) throw new BadRequestException('Select a valid booking.');
    const limit = parsed.data.limit ?? 25;
    return this.db.transaction(async client => {
      const active = await this.access.membership(member.user_id, member.organization_id, false, client);
      await this.access.customer(active, customerId, client);
      const context = { organizationId: active.organization_id, customerId, bookingId, actorId: active.user_id };
      const existing = await client.query(`SELECT 1 FROM booking_invoices WHERE organization_id=$1 AND customer_id=$2 AND booking_id=$3 LIMIT 1`, scopeParams(context));
      if (!existing.rows[0]) {
        // Normal history reads need no account write lock. Only a legacy
        // booking's first snapshot follows the financial writer lock order.
        await this.access.customer(active, customerId, client, true);
        await ensureBookingInvoice(client, context);
      }
      const result = await client.query<InvoiceRow>(`SELECT ${metadataColumns} FROM booking_invoices
        WHERE organization_id=$1 AND customer_id=$2 AND booking_id=$3 AND ($4::integer IS NULL OR version<$4)
        ORDER BY version DESC LIMIT $5`, [...scopeParams(context), parsed.data.before_version ?? null, limit + 1]);
      const invoices = result.rows.slice(0, limit).map(metadata);
      const hasMore = result.rows.length > limit;
      return { invoices, has_more: hasMore, next_before_version: hasMore ? invoices[invoices.length - 1].version : null };
    });
  }

  async pdf(member: Membership, customerId: string, bookingId: string, invoiceId: string) {
    if (!UUID_PATTERN.test(bookingId) || !UUID_PATTERN.test(invoiceId)) throw new NotFoundException('Invoice was not found for this booking.');
    return this.db.transaction(async client => {
      const active = await this.access.membership(member.user_id, member.organization_id, false, client);
      await this.access.customer(active, customerId, client);
      const result = await client.query<{ filename: string; pdf: Buffer }>(`SELECT filename,pdf FROM booking_invoices
        WHERE organization_id=$1 AND customer_id=$2 AND booking_id=$3 AND id=$4`, [active.organization_id, customerId, bookingId, invoiceId]);
      if (!result.rows[0]) throw new NotFoundException('Invoice was not found for this booking.');
      return { filename: result.rows[0].filename, content: Buffer.from(result.rows[0].pdf) };
    });
  }
}
