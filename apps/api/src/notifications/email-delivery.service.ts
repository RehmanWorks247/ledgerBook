import { BadRequestException, Controller, HttpCode, Inject, Injectable, Post, Req, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { config } from '../config';
import { DatabaseService } from '../database/database.service';

const eventSchema = z.object({type:z.string().max(100),created_at:z.string().datetime({offset:true}),
  data:z.object({email_id:z.string().min(1).max(200)}).passthrough()}).passthrough();
const statuses:Record<string,string> = {'email.sent':'accepted','email.delivered':'delivered','email.delivery_delayed':'delayed',
  'email.bounced':'bounced','email.complained':'complained','email.failed':'failed','email.suppressed':'suppressed'};
const statusRank = (column:string) => `CASE ${column} WHEN 'complained' THEN 7 WHEN 'bounced' THEN 6 WHEN 'suppressed' THEN 5 WHEN 'failed' THEN 4 WHEN 'delivered' THEN 3 WHEN 'delayed' THEN 2 WHEN 'accepted' THEN 1 ELSE 0 END`;
type VerifiedEvent = {id:string;providerId:string;status:string;occurredAt:string}|null;
export type VerifiedWebhookRequest = Request & {verifiedResendWebhook?:{event:VerifiedEvent}};

/** Svix signs exact raw bytes and binds the event identifier and timestamp. */
export function verifyResendSignature(body:Buffer, headers:Record<string,string|string[]|undefined>, secret:string|undefined, now=Date.now()) {
  if (!secret) throw new ServiceUnavailableException('Email delivery tracking is not configured.');
  const id=headers['svix-id'],timestamp=headers['svix-timestamp'],signature=headers['svix-signature'];
  if (!Buffer.isBuffer(body) || body.length>65536 || typeof id!=='string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)
    || typeof timestamp!=='string' || !/^\d{1,12}$/.test(timestamp) || typeof signature!=='string' || signature.length>4096
    || Math.abs(now/1000-Number(timestamp))>300) throw new UnauthorizedException('Invalid webhook signature.');
  const key=Buffer.from(secret.replace(/^whsec_/,''),'base64');
  if (key.length<16) throw new ServiceUnavailableException('Email delivery tracking is not configured.');
  const expected=createHmac('sha256',key).update(`${id}.${timestamp}.`).update(body).digest();
  const valid=signature.split(' ').some(value=>{
    if (!/^v1,[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
    const actual=Buffer.from(value.slice(3),'base64');
    return actual.length===expected.length && timingSafeEqual(actual,expected);
  });
  if (!valid) throw new UnauthorizedException('Invalid webhook signature.');
  return id;
}

export function parseResendWebhook(body:Buffer,headers:Record<string,string|string[]|undefined>,secret=config.resendWebhookSecret,now=Date.now()):VerifiedEvent {
  const id=verifyResendSignature(body,headers,secret,now);
  let raw:unknown;
  try { raw=JSON.parse(body.toString('utf8')); } catch { throw new BadRequestException('Invalid webhook body.'); }
  if (raw && typeof raw==='object' && 'type' in raw && typeof raw.type==='string' && !Object.hasOwn(statuses,raw.type)) return null;
  const parsed=eventSchema.safeParse(raw);
  if (!parsed.success || new Date(parsed.data.created_at).getTime()>now+300_000) throw new BadRequestException('Invalid webhook event.');
  return {id,providerId:parsed.data.data.email_id,status:statuses[parsed.data.type],occurredAt:parsed.data.created_at};
}

/** Mount after express.raw, before CSRF. Only authenticated POST requests get an exemption. */
export function resendWebhookVerifier():RequestHandler {
  return (request:VerifiedWebhookRequest,response,next)=>{
    if(request.method!=='POST') {response.status(405).json({message:'Method not allowed.'});return;}
    try {
      request.verifiedResendWebhook={event:parseResendWebhook(request.body,request.headers)};
      next();
    } catch(error) {
      const status=error instanceof ServiceUnavailableException?503:error instanceof BadRequestException?400:401;
      response.status(status).json({message:status===503?'Email delivery tracking is not configured.':'Invalid email webhook.'});
    }
  };
}

@Injectable()
export class EmailDeliveryService {
  constructor(@Inject(DatabaseService) private readonly db:DatabaseService) {}

  /** Safe if the webhook arrives before the send response is committed. */
  async accepted(client:PoolClient,table:'payment_email_outbox'|'reminder_email_outbox',id:string,providerId:string|undefined) {
    if(providerId) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`email:${providerId}`]);
    await client.query(`UPDATE ${table} SET provider_message_id=$2,delivery_status='accepted',delivery_updated_at=now() WHERE id=$1`,[id,providerId??null]);
    if (!providerId) return;
    const events=await client.query<{status:string;occurred_at:Date}>(`SELECT status,occurred_at FROM email_delivery_events WHERE provider_message_id=$1
      ORDER BY ${statusRank('status')} DESC,occurred_at DESC LIMIT 1`,[providerId]);
    if(events.rows[0]) await this.apply(client,table,providerId,events.rows[0].status,events.rows[0].occurred_at);
  }

  async ingest(event:VerifiedEvent) {
    if (!event) return {received:true};
    return this.db.transaction(async client=>{
      // Serialize correlation with the provider-response commit, including when
      // the incoming event reaches us before that response.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`email:${event.providerId}`]);
      const inserted=await client.query(`INSERT INTO email_delivery_events(event_id,provider_message_id,status,occurred_at)
        VALUES($1,$2,$3,$4) ON CONFLICT(event_id) DO NOTHING RETURNING event_id`,[event.id,event.providerId,event.status,event.occurredAt]);
      if(!inserted.rowCount) return {received:true,duplicate:true};
      await this.apply(client,'payment_email_outbox',event.providerId,event.status,event.occurredAt);
      await this.apply(client,'reminder_email_outbox',event.providerId,event.status,event.occurredAt);
      return {received:true};
    });
  }

  private async apply(client:PoolClient,table:'payment_email_outbox'|'reminder_email_outbox',providerId:string,status:string,at:Date|string) {
    await client.query(`SELECT id FROM organizations WHERE id IN (SELECT organization_id FROM ${table} WHERE provider_message_id=$1) ORDER BY id FOR SHARE`,[providerId]);
    if(table==='reminder_email_outbox') await client.query(`SELECT id FROM customers WHERE id IN
      (SELECT customer_id FROM reminder_email_outbox WHERE provider_message_id=$1) ORDER BY id FOR UPDATE`,[providerId]);
    const updated=await client.query<{id:string;organization_id:string;recipient:string;customer_id?:string;booking_id?:string;instalment_id?:string}>(`UPDATE ${table}
      SET delivery_status=$2,delivery_updated_at=GREATEST(delivery_updated_at,$3::timestamptz)
      WHERE provider_message_id=$1 AND ${statusRank('$2::text')}>=${statusRank('delivery_status')}
      AND (delivery_status<>$2 OR delivery_updated_at<$3::timestamptz) RETURNING *`,[providerId,status,at]);
    for(const row of updated.rows) {
      if(['bounced','complained','suppressed'].includes(status)) await client.query(`INSERT INTO email_suppressions(organization_id,recipient_hash,reason)
        VALUES($1,encode(sha256(convert_to(lower($2),'UTF8')),'hex'),$3) ON CONFLICT(organization_id,recipient_hash) DO UPDATE SET reason=EXCLUDED.reason`,[row.organization_id,row.recipient,status]);
      if(table==='reminder_email_outbox') await client.query(`INSERT INTO audit_events(organization_id,action,object_id,metadata)
        VALUES($1,$2,$3,$4)`,[row.organization_id,`reminder.${status}`,row.id,JSON.stringify({customer_id:row.customer_id,booking_id:row.booking_id,instalment_id:row.instalment_id,status})]);
    }
  }
}

@Controller('webhooks/resend')
export class ResendWebhookController {
  constructor(@Inject(EmailDeliveryService) private readonly delivery:EmailDeliveryService) {}
  @Post() @HttpCode(200)
  async receive(@Req() request:VerifiedWebhookRequest) {
    const verified=request.verifiedResendWebhook??{event:parseResendWebhook(request.body,request.headers)};
    return this.delivery.ingest(verified.event);
  }
}
