import type { PoolClient } from 'pg';

export async function nextInvoiceNumber(client: Pick<PoolClient, 'query'>): Promise<string> {
  const result = await client.query<{ value: string }>("SELECT nextval('invoice_number_sequence')::text AS value");
  return `Inv-up${result.rows[0].value.padStart(3, '0')}`;
}
