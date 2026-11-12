import type { PoolClient } from 'pg';
import { nextInvoiceNumber } from '../invoices/invoice-number';
import { renderInvoicePdf } from '../invoices/invoice-pdf';
import type { InvoiceSnapshot } from '../invoices/invoice.types';

/** Migration-owner only; the caller must wrap SQL + this hook in one transaction. */
export async function renumberExistingInvoices(client: Pick<PoolClient, 'query'>) {
  // Keep other writers out until every stored PDF matches its new identifier.
  await client.query('LOCK TABLE booking_invoices IN ACCESS EXCLUSIVE MODE');
  await client.query('ALTER TABLE booking_invoices DISABLE TRIGGER booking_invoices_preserve');
  const invoices = await client.query<{ id: string; organization_id: string; customer_id: string;
    booking_id: string; invoice_number: string; snapshot: InvoiceSnapshot }>(
    'SELECT id,organization_id,customer_id,booking_id,invoice_number,snapshot FROM booking_invoices ORDER BY issued_at,id');
  for (const invoice of invoices.rows) {
    const number = await nextInvoiceNumber(client);
    const filename = `${number}.pdf`;
    const snapshot = { ...invoice.snapshot, invoice_number: number, filename };
    const pdf = await renderInvoicePdf(snapshot);
    await client.query('UPDATE booking_invoices SET invoice_number=$1,filename=$2,snapshot=$3::jsonb,pdf=$4 WHERE id=$5',
      [number, filename, JSON.stringify(snapshot), pdf, invoice.id]);
    await client.query(`INSERT INTO audit_events(organization_id,action,object_id,metadata)
      VALUES($1,'invoice.renumbered',$2,$3::jsonb)`, [invoice.organization_id, invoice.id, JSON.stringify({
      customer_id: invoice.customer_id, booking_id: invoice.booking_id,
      previous_invoice_number: invoice.invoice_number, invoice_number: number,
    })]);
  }
  await client.query('ALTER TABLE booking_invoices ENABLE TRIGGER booking_invoices_preserve');
}
