export type InvoiceReason = 'booking_created' | 'payment_approved' | 'payment_reversed' | 'booking_updated' | 'booking_cancelled' | 'charge_reversed' | 'legacy_snapshot';
export type InvoiceStatus = 'unpaid' | 'partially_paid' | 'paid' | 'overpaid' | 'cancelled';

export interface InvoiceMetadata {
  id: string;
  invoice_number: string;
  version: number;
  reason: InvoiceReason;
  issued_at: string;
  total_minor: string;
  paid_minor: string;
  balance_minor: string;
  currency: string;
  status: InvoiceStatus;
  filename: string;
}

/** Everything printed is captured at issue time; later edits never alter a PDF. */
export interface InvoiceSnapshot extends InvoiceMetadata {
  template_version: 1 | 2;
  organization: { id: string; name: string };
  customer: { id: string; name: string; email: string; phone?: string; customer_code: string };
  booking: {
    id: string;
    reference: string;
    departure_at: string;
    required_services: string[];
    original_total_minor: string;
    cancelled_at: string | null;
    charge_reversed: boolean;
  };
  currency_exponent: 2;
  time_zone: string;
  approved_payment_count: number;
  latest_payment_date: string | null;
  instalments: { due_date: string; amount_minor: string }[];
}
