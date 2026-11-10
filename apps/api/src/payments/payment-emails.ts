import type { PoolClient } from 'pg';
import { config } from '../config';
import { formatMoney } from '../ledger/money';

type CustomerPaymentEmail = {
  organizationId:string; organizationName:string; customerId:string; customerName:string; recipient:string;
  bookingId:string; bookingReference:string; paymentId:string; submittedBy:string;
  amountMinor:string; currency:string; paymentDate:string; invoiceId?:string;
} & ({kind:'received'; receiptCount:number} | {kind:'approved'} | {kind:'rejected'; reason:string; bookingCancelled?:boolean});

/** Only records intent. Provider I/O always runs after the business transaction commits. */
export async function queueCustomerPaymentEmail(client:PoolClient, event:CustomerPaymentEmail) {
  const link=`${config.appUrl}/o/${event.organizationId}/users/${event.customerId}/bookings/${event.bookingId}`;
  const details=`Booking: ${event.bookingReference}\nAmount: ${event.currency} ${formatMoney(event.amountMinor,2)}\nPayment date: ${event.paymentDate}`;
  const messages={
    received:{subject:'Your payment receipt has been received',
      text:event.kind==='received' ? `We received ${event.receiptCount} payment receipt file(s) for ${event.organizationName}.\n\n${details}\n\nSubmitting a receipt does not credit your account. An administrator must verify and approve the payment. We will email you when it is approved or rejected.\n\nView your receipt and current payment status:\n${link}` : ''},
    approved:{subject:'Your payment has been approved',
      text:`Your payment has been approved by ${event.organizationName}.\n\n${details}\n\nThe payment has been credited to your account.${event.invoiceId ? ' Your updated booking invoice is attached.' : ''} View your booking:\n${link}`},
    rejected:{subject:'Your payment was not approved',
      text:event.kind==='rejected' ? `Your payment receipt was reviewed by ${event.organizationName} and was not approved.\n\n${details}\n\nReason:\n${event.reason}\n\nThis submission has not been credited to your account. ${event.bookingCancelled ? 'The booking was cancelled. Contact the administrator if you need help with this payment.' : 'Open your booking to review the reason and submit corrected evidence, or contact the administrator if you need help.'}\n\nView your payment:\n${link}` : ''},
  };
  const message=messages[event.kind];
  // Preserve existing approval keys across releases and keep every retry immutable.
  const key=`payment-${event.kind}:${event.paymentId}${event.kind==='approved'?'':`:${event.submittedBy}`}`;
  await client.query(`INSERT INTO payment_email_outbox(organization_id,recipient,subject,body,dedupe_key,invoice_id)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING`,
  [event.organizationId,event.recipient,message.subject,`Hello ${event.customerName},\n\n${message.text}`,key,event.kind==='approved' ? event.invoiceId??null : null]);
}

/** The booking, first invoice and confirmation intent commit together. */
export async function queueBookingCreatedEmail(client:PoolClient,event:{
  organizationId:string; organizationName:string; customerId:string; customerName:string; recipient:string;
  bookingId:string; bookingReference:string; invoiceId:string;
}) {
  const link=`${config.appUrl}/o/${event.organizationId}/users/${event.customerId}/bookings/${event.bookingId}`;
  const text=`Hello ${event.customerName},\n\n${event.organizationName} has created your booking.\n\nBooking: ${event.bookingReference}\n\nYour booking invoice is attached. It shows the charges, confirmed payments and remaining balance when it was issued. You can find the latest invoice and invoice history in your booking:\n${link}`;
  await client.query(`INSERT INTO payment_email_outbox(organization_id,recipient,subject,body,dedupe_key,invoice_id)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING`,
  [event.organizationId,event.recipient,'Your booking confirmation and invoice',text,`booking-created:${event.bookingId}`,event.invoiceId]);
}

/** A claimed send may already have reached the provider; never rewrite its payload or key. */
export async function cancelUnsentPaymentReviewEmails(client:PoolClient, organizationId:string, paymentIds:string[]) {
  if(!paymentIds.length) return;
  await client.query(`UPDATE payment_email_outbox SET state='cancelled',delivery_status='cancelled',
    delivery_updated_at=now(),lease_token=NULL,lease_until=NULL,last_error='Payment was reviewed before notification delivery.'
    WHERE id IN (SELECT id FROM payment_email_outbox WHERE organization_id=$1 AND state='pending' AND attempts=0
      AND dedupe_key LIKE ANY($2::text[]) ORDER BY id FOR UPDATE SKIP LOCKED)`,
  [organizationId,paymentIds.map(id=>`payment-submitted:${id}:%`)]);
}
