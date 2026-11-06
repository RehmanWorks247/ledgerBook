import { Inject, Injectable, Optional, type OnApplicationBootstrap, type BeforeApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AccessService, type Membership } from '../access/access.service';

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

  private async deliverBatch() {
    let sent = 0;
    for (let index = 0; index < 10 && !this.stopping; index++) {
      const token = randomUUID();
      const claimed = await this.db.transaction(client => client.query<{
        id:string; recipient:string; subject:string; body:string; attempts:number;
      }>(`WITH candidate AS (
        SELECT id FROM payment_email_outbox
        WHERE (state='pending' AND next_attempt_at<=now())
          OR (state='processing' AND lease_until<=now())
        ORDER BY next_attempt_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE payment_email_outbox e SET state='processing',lease_token=$1,
        lease_until=now()+interval '2 minutes',attempts=e.attempts+1
      FROM candidate c WHERE e.id=c.id RETURNING e.id,e.recipient,e.subject,e.body,e.attempts`, [token]));
      const email = claimed.rows[0];
      if (!email) break;
      try {
        await this.notifications.send({to:email.recipient,subject:email.subject,text:email.body},
          {idempotencyKey:`payment-email/${email.id}`});
        await this.db.query(`UPDATE payment_email_outbox SET state='sent',sent_at=now(),
          lease_token=NULL,lease_until=NULL,last_error=NULL WHERE id=$1 AND lease_token=$2`, [email.id,token]);
        sent++;
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
        count(*) FILTER (WHERE state<>'sent')::int AS queued,
        count(*) FILTER (WHERE state<>'sent' AND attempts>0)::int AS retrying,
        count(*) FILTER (WHERE state='sent')::int AS sent,
        min(created_at) FILTER (WHERE state<>'sent') AS oldest_queued_at
        FROM payment_email_outbox WHERE organization_id=$1`, [active.organization_id]);
      return result.rows[0];
    });
  }
}
