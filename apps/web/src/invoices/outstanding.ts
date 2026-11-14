import type { BookingInvoice } from './model';

export type OutstandingInvoice = BookingInvoice & {
  booking_id: string;
  booking_reference: string;
  departure_at: string;
  outstanding_minor: string;
};
export type OutstandingInvoicesResponse = { invoices: OutstandingInvoice[] };
export const outstandingInvoicesPath = (organizationId:string,customerId:string) =>
  `/organizations/${organizationId}/customers/${customerId}/invoices/outstanding`;
