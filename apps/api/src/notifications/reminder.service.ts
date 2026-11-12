import { BadRequestException, ConflictException, Inject, Injectable, Optional, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { AccessService, type Membership } from '../access/access.service';
import { config } from '../config';
import { positionCtes } from '../dashboard/receivables';
import { businessDate } from '../dashboard/time';
import { DatabaseService } from '../database/database.service';
import { EmailDeliveryService } from './email-delivery.service';
import { NotificationsService } from './notifications.service';

const settingsSchema=z.object({enabled:z.boolean(),due_soon_days:z.number().int().min(0).max(14),repeat_days:z.number().int().min(1).max(30),
  send_hour:z.number().int().min(0).max(23),time_zone:z.string().max(100).refine(value=>{
    try {if(/^[+-]/.test(value))return false;new Intl.DateTimeFormat('en',{timeZone:value}).format();return true;} catch {return false;}
  },'Use a valid IANA time zone.').transform(value=>new Intl.DateTimeFormat('en',{timeZone:value}).resolvedOptions().timeZone),expected_version:z.number().int().nonnegative().optional()}).strict();
type Settings=z.infer<typeof settingsSchema>&{organization_id:string;last_scheduled_date:string|null;updated_at:Date;version:number};
type Reminder={id:string;organization_id:string;customer_id:string;booking_id:string;instalment_id:string|null;recipient:string;subject:string;body:string;attempts:number;first_attempt_at:Date};
const defaults={version:0,enabled:false,due_soon_days:3,repeat_days:7,send_hour:9,time_zone:config.businessTimeZone,last_scheduled_date:null};
function parse<T>(schema:z.ZodType<T>,raw:unknown):T {
  const value=schema.safeParse(raw);
  if(!value.success) throw new BadRequestException(value.error.issues.map(issue=>`${issue.path.join('.')}: ${issue.message}`));
  return value.data;
}

@Injectable()
export class ReminderService implements OnApplicationBootstrap,BeforeApplicationShutdown {
  private timer?:NodeJS.Timeout;
  private running?:Promise<{queued:number;sent:number}>;
  private stopping=false;
  constructor(@Inject(DatabaseService) private readonly db:DatabaseService,@Inject(AccessService) private readonly access:AccessService,
    @Inject(NotificationsService) private readonly notifications:NotificationsService,@Inject(EmailDeliveryService) private readonly delivery:EmailDeliveryService,
    @Optional() @Inject('REMINDER_WORKER_ENABLED') private readonly enabled=true) {}

  onApplicationBootstrap() {
    if(!this.enabled) return;
    this.timer=setInterval(()=>{void this.flush().catch(()=>console.error(JSON.stringify({event:'reminder_worker_unavailable'})));},30_000);
    this.timer.unref();
  }
  async beforeApplicationShutdown() {this.stopping=true;if(this.timer)clearInterval(this.timer);await this.running?.catch(()=>undefined);}
  flush(now=new Date()) {
    if(this.running)return this.running;
    this.running=this.run(now).finally(()=>{this.running=undefined;});return this.running;
  }
  private async run(now:Date) {const queued=await this.schedule(now);const sent=await this.deliver();return {queued,sent};}

  async settings(member:Membership) {
    return this.db.transaction(async client=>{
      const active=await this.access.membership(member.user_id,member.organization_id,true,client);
      const result=await client.query<Settings>('SELECT *,last_scheduled_date::text AS last_scheduled_date FROM reminder_settings WHERE organization_id=$1',[active.organization_id]);
      return {...defaults,...result.rows[0],email_mode:config.emailMode,delivery_tracking_configured:Boolean(config.resendWebhookSecret)};
    });
  }

  async updateSettings(member:Membership,raw:unknown) {
    const value=parse(settingsSchema,raw);
    return this.db.transaction(async client=>{
      const active=await this.access.membership(member.user_id,member.organization_id,true,client);
      const result=await client.query<Settings>(`INSERT INTO reminder_settings(organization_id,enabled,due_soon_days,repeat_days,send_hour,time_zone)
        SELECT $1,$2,$3,$4,$5,$6 WHERE $7::integer IS NULL OR $7=0 OR EXISTS(SELECT 1 FROM reminder_settings WHERE organization_id=$1)
        ON CONFLICT(organization_id) DO UPDATE SET enabled=EXCLUDED.enabled,due_soon_days=EXCLUDED.due_soon_days,
        repeat_days=EXCLUDED.repeat_days,send_hour=EXCLUDED.send_hour,time_zone=EXCLUDED.time_zone,updated_at=now(),version=reminder_settings.version+1
        WHERE $7::integer IS NULL OR reminder_settings.version=$7 RETURNING *`,
      [active.organization_id,value.enabled,value.due_soon_days,value.repeat_days,value.send_hour,value.time_zone,value.expected_version??null]);
      if(!result.rows[0])throw new ConflictException('This reminder schedule changed in another session. Refresh notifications and reload the saved schedule before editing again.');
      await client.query(`INSERT INTO audit_events(organization_id,actor_id,action,object_id,metadata) VALUES($1::uuid,$2,'notification.settings_updated',$1::text,$3)`,
        [active.organization_id,active.user_id,JSON.stringify(value)]);
      return {...result.rows[0],email_mode:config.emailMode,delivery_tracking_configured:Boolean(config.resendWebhookSecret)};
    });
  }

  async preference(member:Membership,customerId:string,raw?:unknown) {
    const value=raw===undefined?undefined:parse(z.object({enabled:z.boolean()}).strict(),raw);
    return this.db.transaction(async client=>{
      const active=await this.access.membership(member.user_id,member.organization_id,false,client);
      await this.access.customer(active,customerId,client,value!==undefined);
      if(value) {
        await client.query(`INSERT INTO customer_reminder_preferences(customer_id,organization_id,enabled) VALUES($1,$2,$3)
          ON CONFLICT(customer_id) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=now()`,[customerId,active.organization_id,value.enabled]);
        await client.query(`INSERT INTO audit_events(organization_id,actor_id,action,object_id,metadata) VALUES($1,$2,'notification.preference_updated',$3,$4)`,
          [active.organization_id,active.user_id,customerId,JSON.stringify({customer_id:customerId,enabled:value.enabled})]);
      }
      const result=await client.query(`SELECT COALESCE(p.enabled,true) AS enabled,EXISTS(SELECT 1 FROM email_suppressions s
        WHERE s.organization_id=c.organization_id AND s.recipient_hash=encode(sha256(convert_to(lower(c.email),'UTF8')),'hex')) AS suppressed
        FROM customers c LEFT JOIN customer_reminder_preferences p ON p.customer_id=c.id WHERE c.id=$1`,[customerId]);
      return result.rows[0];
    });
  }

  async history(member:Membership) {
    return this.db.transaction(async client=>{
      const active=await this.access.membership(member.user_id,member.organization_id,true,client);
      const base=`SELECT id,recipient,subject,state,attempts,last_error,created_at,sent_at,delivery_status,delivery_updated_at,'reminder'::text AS kind
        FROM reminder_email_outbox WHERE organization_id=$1 UNION ALL
        SELECT id,recipient,subject,state,attempts,last_error,created_at,sent_at,delivery_status,delivery_updated_at,'payment'::text AS kind
        FROM payment_email_outbox WHERE organization_id=$1`;
      const rows=await client.query(`SELECT * FROM (${base}) emails ORDER BY created_at DESC,id LIMIT 100`,[active.organization_id]);
      const summary=await client.query(`SELECT count(*) FILTER(WHERE state IN ('pending','processing'))::int AS queued,
        count(*) FILTER(WHERE state IN ('pending','processing') AND attempts>0)::int AS retrying,
        count(*) FILTER(WHERE state='sent')::int AS sent,count(*) FILTER(WHERE delivery_status='delivered')::int AS delivered,
        count(*) FILTER(WHERE delivery_status='bounced')::int AS bounced,count(*) FILTER(WHERE delivery_status='complained')::int AS complained,
        count(*) FILTER(WHERE delivery_status='failed')::int AS failed,count(*) FILTER(WHERE delivery_status='suppressed')::int AS suppressed,
        min(created_at) FILTER(WHERE state IN ('pending','processing')) AS oldest_queued_at FROM (${base}) emails`,[active.organization_id]);
      const webhook=await client.query(`SELECT max(delivery_updated_at) AS last_delivery_update_at FROM (${base}) emails WHERE delivery_status NOT IN ('queued','accepted')`,[active.organization_id]);
      return {summary:summary.rows[0],messages:rows.rows,...webhook.rows[0]};
    });
  }

  /** Daily scan is claimed per organization and works across API replicas. */
  async schedule(now=new Date()) {
    const organizations=await this.db.query<{organization_id:string}>(`SELECT s.organization_id FROM reminder_settings s
      JOIN organizations o ON o.id=s.organization_id WHERE s.enabled AND o.deleted_at IS NULL
      AND EXTRACT(HOUR FROM $1::timestamptz AT TIME ZONE s.time_zone)>=s.send_hour
      AND (s.last_scheduled_date IS NULL OR s.last_scheduled_date<($1::timestamptz AT TIME ZONE s.time_zone)::date)
      ORDER BY s.last_scheduled_date NULLS FIRST,s.organization_id LIMIT 20`,[now.toISOString()]);
    let queued=0;
    for(const org of organizations.rows) {
      if(this.stopping)break;
      queued+=await this.db.transaction(async client=>{
        await client.query('SET LOCAL jit = off');
        const organization=await client.query('SELECT id FROM organizations WHERE id=$1 AND deleted_at IS NULL FOR SHARE',[org.organization_id]);
        if(!organization.rows.length)return 0;
        const settings=(await client.query<Settings>('SELECT *,last_scheduled_date::text AS last_scheduled_date FROM reminder_settings WHERE organization_id=$1 FOR UPDATE SKIP LOCKED',[org.organization_id])).rows[0];
        if(!settings?.enabled)return 0;
        const today=businessDate(now,settings.time_zone);
        if(settings.last_scheduled_date && String(settings.last_scheduled_date).slice(0,10)>=today)return 0;
        const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:settings.time_zone,hour:'2-digit',hourCycle:'h23'}).format(now));
        if(hour<settings.send_hour)return 0;
        // Audit invalidation and account writes lock customers before booking
        // foreign keys/outbox rows. Keep that order for the scheduled batch.
        await client.query(`WITH ${positionCtes} SELECT c.id FROM customers c WHERE c.organization_id=$1 AND c.status='active'
          AND EXISTS(SELECT 1 FROM positioned p WHERE p.customer_id=c.id AND p.unpaid>0 AND p.due_date<=$2::date+$3::integer)
          ORDER BY c.id FOR UPDATE OF c`,[org.organization_id,today,settings.due_soon_days]);
        const inserted=await client.query<{id:string;customer_id:string;booking_id:string;instalment_id:string}>(`WITH ${positionCtes}, candidates AS (
          SELECT DISTINCT ON(p.customer_id) p.* FROM positioned p JOIN customers c ON c.id=p.customer_id
          LEFT JOIN customer_reminder_preferences pref ON pref.customer_id=c.id
          WHERE p.unpaid>0 AND p.due_date<=$2::date+$3::integer AND c.status='active' AND COALESCE(pref.enabled,true)
            AND (SELECT COALESCE(SUM(e.amount_minor),0) FROM account_ledger_entries e WHERE e.organization_id=$1 AND e.customer_id=c.id)>0
            AND NOT EXISTS(SELECT 1 FROM email_suppressions s WHERE s.organization_id=$1 AND s.recipient_hash=encode(sha256(convert_to(lower(c.email),'UTF8')),'hex'))
            AND NOT EXISTS(SELECT 1 FROM reminder_email_outbox e WHERE e.customer_id=p.customer_id
              AND (e.state IN ('pending','processing') OR (e.state<>'cancelled' AND e.scheduled_date>$2::date-$4::integer)))
          ORDER BY p.customer_id,p.due_date,p.id
        ) INSERT INTO reminder_email_outbox(organization_id,customer_id,booking_id,instalment_id,scheduled_date,recipient,subject,body)
        SELECT $1,p.customer_id,p.booking_id,p.id::uuid,$2::date,c.email,'Payment reminder · '||o.name,
          'Hello '||c.name||E',\n\nA payment for booking '||p.booking_reference||' is due on '||p.due_date::text||
          E'.\nPlease check your current account balance and payment history in My Account:\n'||$5::text||'/o/'||$1::text||
          E'\n\nIf you have already paid, please upload your receipt for review.\nYou can turn off payment reminders in your account Settings.\n\n'||o.name
        FROM candidates p JOIN customers c ON c.id=p.customer_id JOIN organizations o ON o.id=$1
        ON CONFLICT(instalment_id,scheduled_date) DO NOTHING RETURNING id,customer_id,booking_id,instalment_id`,
        [org.organization_id,today,settings.due_soon_days,settings.repeat_days,config.appUrl]);
        // One audit insert for the entire scan; avoids a query per customer.
        if(inserted.rows.length) await client.query(`INSERT INTO audit_events(organization_id,action,object_id,metadata)
          SELECT $1,'reminder.queued',id::text,jsonb_build_object('customer_id',customer_id,'booking_id',booking_id,'instalment_id',instalment_id,'status','queued')
          FROM reminder_email_outbox WHERE id=ANY($2::uuid[])`,[org.organization_id,inserted.rows.map(row=>row.id)]);
        await client.query('UPDATE reminder_settings SET last_scheduled_date=$2 WHERE organization_id=$1',[org.organization_id,today]);
        return inserted.rows.length;
      });
    }
    return queued;
  }

  private async audit(client:PoolClient,email:Reminder,status:string) {
    await client.query(`INSERT INTO audit_events(organization_id,action,object_id,metadata) VALUES($1,$2,$3,$4)`,
      [email.organization_id,`reminder.${status}`,email.id,JSON.stringify({customer_id:email.customer_id,booking_id:email.booking_id,instalment_id:email.instalment_id,status})]);
  }

  async deliver() {
    let sent=0;
    for(let index=0;index<20&&!this.stopping;index++) {
      const token=randomUUID();
      const email=(await this.db.transaction(client=>client.query<Reminder>(`WITH candidate AS(SELECT id FROM reminder_email_outbox
        WHERE (state='pending' AND next_attempt_at<=now()) OR (state='processing' AND lease_until<=now())
        ORDER BY next_attempt_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE reminder_email_outbox e SET state='processing',lease_token=$1,lease_until=now()+interval '2 minutes',attempts=e.attempts+1,
        first_attempt_at=COALESCE(e.first_attempt_at,now()) FROM candidate c WHERE e.id=c.id RETURNING e.*`,[token]))).rows[0];
      if(!email)break;
      try {
        const accepted=await this.db.transaction(async client=>{
          await client.query('SET LOCAL jit = off');
          const organization=await client.query('SELECT id FROM organizations WHERE id=$1 AND deleted_at IS NULL FOR SHARE',[email.organization_id]);
          if(!organization.rows.length) {
            const cancelled=await client.query(`UPDATE reminder_email_outbox SET state='cancelled',delivery_status='cancelled',delivery_updated_at=now(),
              lease_token=NULL,lease_until=NULL,last_error='Reminder cancelled because this workspace was deleted.'
              WHERE id=$1 AND lease_token=$2 RETURNING id`,[email.id,token]);
            if(cancelled.rows.length)await this.audit(client,email,'cancelled');
            return false;
          }
          const settings=(await client.query<Settings>('SELECT * FROM reminder_settings WHERE organization_id=$1 FOR SHARE',[email.organization_id])).rows[0];
          await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE',[email.customer_id]);
          await client.query('SELECT id FROM bookings WHERE id=$1 FOR SHARE',[email.booking_id]);
          const current=await client.query('SELECT id FROM reminder_email_outbox WHERE id=$1 AND lease_token=$2 FOR UPDATE',[email.id,token]);
          if(!current.rows.length)return false;
          if(email.attempts>12 || Date.now()-new Date(email.first_attempt_at).getTime()>23*3600_000) {
            await client.query(`UPDATE reminder_email_outbox SET state='failed',delivery_status='failed',lease_token=NULL,lease_until=NULL,
              last_error='Automatic retries stopped before the provider idempotency window expired. Check provider delivery records.' WHERE id=$1`,[email.id]);
            await this.audit(client,email,'failed');return false;
          }
          const due=await client.query(`WITH ${positionCtes} SELECT p.id FROM positioned p JOIN customers c ON c.id=p.customer_id
            LEFT JOIN customer_reminder_preferences pref ON pref.customer_id=c.id
            WHERE p.id=$2 AND p.unpaid>0 AND c.status='active' AND COALESCE(pref.enabled,true) AND lower(c.email)=lower($5::text)
              AND (SELECT COALESCE(SUM(e.amount_minor),0) FROM account_ledger_entries e WHERE e.organization_id=$1 AND e.customer_id=c.id)>0
              AND p.due_date<=$3::date+$4::integer AND NOT EXISTS(SELECT 1 FROM email_suppressions s
                WHERE s.organization_id=$1 AND s.recipient_hash=encode(sha256(convert_to(lower(c.email),'UTF8')),'hex'))`,
          [email.organization_id,email.instalment_id,businessDate(new Date(),settings?.time_zone??config.businessTimeZone),settings?.due_soon_days??0,email.recipient]);
          if(!settings?.enabled || !due.rows.length) {
            await client.query(`UPDATE reminder_email_outbox SET state='cancelled',delivery_status='cancelled',lease_token=NULL,lease_until=NULL,
              last_error='Reminder cancelled because the balance, account or reminder preference changed.' WHERE id=$1`,[email.id]);
            await this.audit(client,email,'cancelled');return false;
          }
          // The customer's lock is held through provider acceptance, using the
          // same order as settlement/deletion. A completed payment cannot race
          // this final balance check. Retry bodies and keys remain immutable.
          const receipt=await this.notifications.send({to:email.recipient,subject:email.subject,text:email.body},{idempotencyKey:`reminder-email/${email.id}`});
          // Provider acceptance precedes reconciliation: an early delivered/bounce
          // event must remain the latest audit status in the dashboard.
          await this.audit(client,email,'accepted');
          await this.delivery.accepted(client,'reminder_email_outbox',email.id,receipt?.providerMessageId);
          await client.query(`UPDATE reminder_email_outbox SET state='sent',sent_at=now(),lease_token=NULL,lease_until=NULL,last_error=NULL WHERE id=$1 AND lease_token=$2`,[email.id,token]);
          return true;
        });
        if(accepted)sent++;
      } catch {
        const delay=Math.min(3600,30*2**Math.min(email.attempts-1,7));
        await this.db.query(`UPDATE reminder_email_outbox SET state='pending',lease_token=NULL,lease_until=NULL,next_attempt_at=now()+($3::integer*interval '1 second'),
          last_error='Delivery was not accepted; retry scheduled.' WHERE id=$1 AND lease_token=$2`,[email.id,token,delay]);
      }
    }
    return sent;
  }
}
