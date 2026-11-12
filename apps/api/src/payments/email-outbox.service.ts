import { Inject, Injectable, Optional, type OnApplicationBootstrap, type BeforeApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { NotificationsService, type EmailAttachment } from '../notifications/notifications.service';
import { AccessService, type Membership } from '../access/access.service';
import { EmailDeliveryService } from '../notifications/email-delivery.service';
import { UUID_PATTERN } from '../ledger/money';

type QueuedPaymentEmail = {
  id:string; organization_id:string; recipient:string; subject:string; body:string; dedupe_key:string; attempts:number; first_attempt_at:Date;
  invoice_id:string|null;
};

/** One durable lease at a time; safe across API replicas and process restarts. */
@Injectable()
export class PaymentEmailOutbox implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running?: Promise<number>;
  private stopping = false;

  constructor(@Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(AccessService) private readonly access: AccessService,
    @Optional() @Inject('PAYMENT_EMAIL_WORKER_ENABLED') private readonly enabled = true) {}

  onApplicationBootstrap() {
    if (!this.enabled) return;
    this.timer = setInterval(() => {
      void this.flush().catch(() => {
        // Never include provider payloads, email addresses, or database errors.
        console.error(JSON.stringify({event:'payment_email_worker_unavailable'}));
      });
    }, 5000);
    this.timer.unref();
  }

  async beforeApplicationShutdown() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => undefined);
  }

  flush(): Promise<number> {
    if (this.running) return this.running;
    this.running = this.deliverBatch().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async cancellationReason(client:PoolClient,email:QueuedPaymentEmail):Promise<string|null> {
    const [kind,paymentId,submittedBy]=email.dedupe_key.split(':');
    if(kind==='booking-created') {
      if(!UUID_PATTERN.test(paymentId??'') || !email.invoice_id) return 'Booking notification source is invalid.';
      // Admin-created customers may not yet have a login. The booking email is
      // authorized by the current active customer record, not a user membership.
      const customer=await client.query(`SELECT c.id,c.status,c.email FROM customers c JOIN bookings b
        ON b.customer_id=c.id AND b.organization_id=c.organization_id
        WHERE b.id=$1 AND b.organization_id=$2 FOR SHARE OF c`,[paymentId,email.organization_id]);
      if(!customer.rows.length || customer.rows[0].status!=='active') return 'Booking notification account is no longer active.';
      if(customer.rows[0].email!==email.recipient) return 'Booking notification recipient changed.';
      const booking=await client.query(`SELECT id,deleted_at FROM bookings WHERE id=$1 AND organization_id=$2 FOR SHARE`,[paymentId,email.organization_id]);
      if(!booking.rows.length) return 'Booking notification source is no longer available.';
      if(email.attempts===1 && booking.rows[0].deleted_at) return 'Booking was cancelled before notification delivery.';
      return null;
    }
    if(!['payment-submitted','payment-received','payment-approved','payment-rejected'].includes(kind)) return null;
    if(!UUID_PATTERN.test(paymentId??'')) return 'Payment notification source is invalid.';
    // Match review/account-removal lock order before touching the outbox. Re-read
    // the payment after acquiring the customer lock: a review may have just committed.
    const customer=await client.query(`SELECT c.id FROM customers c JOIN booking_payments p
      ON p.customer_id=c.id AND p.organization_id=c.organization_id
      WHERE p.id=$1 AND p.organization_id=$2 FOR SHARE OF c`,[paymentId,email.organization_id]);
    if(!customer.rows.length) return 'Payment notification source is no longer available.';
    const result=await client.query<{status:string;submitted_by:string;customer_id:string;email:string;customer_status:string}>(
      `SELECT p.status,p.submitted_by,p.customer_id,c.email,c.status AS customer_status FROM booking_payments p
       JOIN customers c ON c.id=p.customer_id AND c.organization_id=p.organization_id
       WHERE p.id=$1 AND p.organization_id=$2 AND p.deleted_at IS NULL FOR SHARE OF p`,[paymentId,email.organization_id]);
    const payment=result.rows[0];
    if(!payment || payment.customer_status!=='active') return 'Payment notification account is no longer active.';
    if(kind==='payment-submitted') {
      const reviewer=await client.query(`SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1
        AND m.role='admin' AND m.is_active AND m.deleted_at IS NULL AND u.email=$2 FOR SHARE OF m,u`,[email.organization_id,email.recipient]);
      if(!reviewer.rows.length) return 'Notification cancelled because administrator access changed.';
      // Later attempts may be replaying an accepted send whose acknowledgement
      // was lost. Keep its original body/key; new submission copy is historical.
      if(email.attempts===1 && payment.status!=='pending') return 'Payment was reviewed before notification delivery.';
      return null;
    }
    if(kind!=='payment-approved' && submittedBy!==payment.submitted_by) return 'Payment notification recipient is no longer authorized.';
    if(payment.email!==email.recipient) return 'Payment notification recipient changed.';
    const recipient=await client.query(`SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.organization_id=$1 AND m.customer_id=$2 AND m.user_id=$3 AND m.role='customer'
        AND m.is_active AND m.deleted_at IS NULL AND u.email=$4 FOR SHARE OF m,u`,
    [email.organization_id,payment.customer_id,payment.submitted_by,email.recipient]);
    if(!recipient.rows.length) return 'Payment notification recipient is no longer authorized.';
    if((kind==='payment-approved' && payment.status!=='approved') || (kind==='payment-rejected' && payment.status!=='rejected')) {
      return 'Payment notification no longer matches the recorded review.';
    }
    return null;
  }

  private async invoiceAttachment(client:PoolClient,email:QueuedPaymentEmail):Promise<EmailAttachment|null> {
    const [kind,sourceId]=email.dedupe_key.split(':');
    if(!email.invoice_id || !UUID_PATTERN.test(sourceId??'') || !['booking-created','payment-approved'].includes(kind)) return null;
    // Never resolve "latest" during a retry: the original version, amount and
    // bytes belong to this event even when later payments create new invoices.
    const invoice=await client.query<{filename:string;pdf:Buffer}>(`SELECT i.filename,i.pdf FROM booking_invoices i
      JOIN customers c ON c.id=i.customer_id AND c.organization_id=i.organization_id
      WHERE i.id=$1 AND i.organization_id=$2 AND c.email=$3 AND c.status='active'
        AND (($4='booking-created' AND i.booking_id=$5::uuid) OR ($4='payment-approved' AND EXISTS (
          SELECT 1 FROM booking_payments p WHERE p.id=$5::uuid AND p.organization_id=i.organization_id
            AND p.customer_id=i.customer_id AND p.booking_id=i.booking_id AND p.deleted_at IS NULL)))`,
    [email.invoice_id,email.organization_id,email.recipient,kind,sourceId]);
    const saved=invoice.rows[0];
    return saved ? {filename:saved.filename,content:Buffer.from(saved.pdf),contentType:'application/pdf'} : null;
  }

  private async deliverBatch() {
    let sent = 0;
    for (let index = 0; index < 10 && !this.stopping; index++) {
      const token = randomUUID();
      const claimed = await this.db.transaction(client => client.query<QueuedPaymentEmail>(`WITH candidate AS (
        SELECT id FROM payment_email_outbox
        WHERE (state='pending' AND next_attempt_at<=now())
          OR (state='processing' AND lease_until<=now())
        ORDER BY next_attempt_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE payment_email_outbox e SET state='processing',lease_token=$1,
        lease_until=now()+interval '2 minutes',attempts=e.attempts+1,first_attempt_at=COALESCE(first_attempt_at,now())
      FROM candidate c WHERE e.id=c.id RETURNING e.*`, [token]));
      const email = claimed.rows[0];
      if (!email) break;
      try {
        const delivered=await this.db.transaction(async client=>{
          // Coordinate with account removal, so deleted accounts cannot retain
          // an already-claimed email that is sent after the deletion completes.
          const organization=await client.query('SELECT id FROM organizations WHERE id=$1 AND deleted_at IS NULL FOR SHARE',[email.organization_id]);
          const cancelled=organization.rows.length ? await this.cancellationReason(client,email)
            : 'Notification cancelled because this workspace was deleted.';
          const current=await client.query('SELECT id FROM payment_email_outbox WHERE id=$1 AND lease_token=$2 FOR UPDATE',[email.id,token]);
          if(!current.rows.length) return false;
          if(cancelled) {
            await client.query(`UPDATE payment_email_outbox SET state='cancelled',delivery_status='cancelled',delivery_updated_at=now(),
              lease_token=NULL,lease_until=NULL,last_error=$2 WHERE id=$1`,[email.id,cancelled]);return false;
          }
          if(email.attempts>12 || Date.now()-new Date(email.first_attempt_at).getTime()>23*3600_000) {
            await client.query(`UPDATE payment_email_outbox SET state='failed',delivery_status='failed',lease_token=NULL,lease_until=NULL,
              last_error='Automatic retries stopped before the provider idempotency window expired. Check provider delivery records.' WHERE id=$1`,[email.id]);
            return false;
          }
          const suppressed=await client.query(`SELECT 1 FROM email_suppressions WHERE organization_id=$1
            AND recipient_hash=encode(sha256(convert_to(lower($2),'UTF8')),'hex')`,[email.organization_id,email.recipient]);
          if(suppressed.rows.length) {
            await client.query(`UPDATE payment_email_outbox SET state='cancelled',delivery_status='suppressed',lease_token=NULL,lease_until=NULL,
              last_error='Recipient suppressed after a bounce or complaint.' WHERE id=$1`,[email.id]);return false;
          }
          const attachment=email.invoice_id ? await this.invoiceAttachment(client,email) : null;
          if(email.invoice_id && !attachment) {
            await client.query(`UPDATE payment_email_outbox SET state='cancelled',delivery_status='cancelled',delivery_updated_at=now(),
              lease_token=NULL,lease_until=NULL,last_error='Invoice notification source is no longer available.' WHERE id=$1`,[email.id]);return false;
          }
          const receipt=await this.notifications.send({to:email.recipient,subject:email.subject,text:email.body,
            ...(attachment ? {attachments:[attachment]} : {})},
            {idempotencyKey:`payment-email/${email.id}`});
          await new EmailDeliveryService(this.db).accepted(client,'payment_email_outbox',email.id,receipt?.providerMessageId);
          await client.query(`UPDATE payment_email_outbox SET state='sent',sent_at=now(),
            lease_token=NULL,lease_until=NULL,last_error=NULL WHERE id=$1 AND lease_token=$2`,[email.id,token]);
          return true;
        });
        if(delivered) sent++;
      } catch {
        // A timeout may follow provider acceptance: retain the same provider
        // idempotency key on every attempt. Durable retry has a one-hour cap.
        const delay = Math.min(3600, 30 * 2 ** Math.min(email.attempts - 1, 7));
        await this.db.query(`UPDATE payment_email_outbox SET state='pending',lease_token=NULL,lease_until=NULL,
          next_attempt_at=now()+($3::int * interval '1 second'),last_error='Delivery was not accepted; retry scheduled.'
          WHERE id=$1 AND lease_token=$2`, [email.id,token,delay]);
      }
    }
    return sent;
  }

  async status(member: Membership) {
    return this.db.transaction(async client => {
      const active = await this.access.membership(member.user_id,member.organization_id,true,client);
      const result = await client.query(`SELECT
        count(*) FILTER (WHERE state IN ('pending','processing'))::int AS queued,
        count(*) FILTER (WHERE state IN ('pending','processing') AND attempts>0)::int AS retrying,
        count(*) FILTER (WHERE state='sent')::int AS sent,
        count(*) FILTER (WHERE delivery_status='delivered')::int AS delivered,
        count(*) FILTER (WHERE delivery_status='bounced')::int AS bounced,
        count(*) FILTER (WHERE delivery_status='complained')::int AS complained,
        count(*) FILTER (WHERE delivery_status='failed')::int AS failed,
        count(*) FILTER (WHERE delivery_status='suppressed')::int AS suppressed,
        min(created_at) FILTER (WHERE state IN ('pending','processing')) AS oldest_queued_at
        FROM payment_email_outbox WHERE organization_id=$1`, [active.organization_id]);
      return result.rows[0];
    });
  }
}
