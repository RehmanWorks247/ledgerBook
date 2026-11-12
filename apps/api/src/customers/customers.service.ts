import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessService, type Membership } from '../access/access.service';
import { DatabaseService } from '../database/database.service';
import { InvitationService } from '../invitations/invitation.service';
import { config } from '../config';
import { validDate } from '../ledger/money';

const profile = z.object({
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: z.string().trim().max(40).default(''),
  notes: z.string().trim().max(4000).default(''),
});
const createSchema = profile.extend({ idempotency_key: z.uuid() }).strict();
const updateSchema = profile.extend({ status: z.enum(['active','archived']) }).strict();
const listSchema = z.object({
  page:z.coerce.number().int().min(1).max(100000).default(1),
  page_size:z.coerce.number().int().min(1).max(100).default(25),
  search:z.string().trim().max(160).default(''),
  status:z.enum(['active','archived','all']).default('all'),
  start:z.string().refine(value=>!value || validDate(value),'Use a valid date in YYYY-MM-DD format.').optional(),
  end:z.string().refine(value=>!value || validDate(value),'Use a valid date in YYYY-MM-DD format.').optional(),
}).strict();
function parse<T>(schema:z.ZodType<T>, value:unknown):T {
  const parsed=schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`));
  return parsed.data;
}
const decoratedCustomer = (extraColumns = '') => `SELECT c.*${extraColumns}, COALESCE(b.balance_minor,0)::text AS balance_minor,
  CASE WHEN m.is_active THEN 'accepted'
       WHEN i.revoked_at IS NOT NULL THEN 'revoked'
       WHEN i.accepted_at IS NOT NULL THEN 'access_revoked'
       WHEN i.expires_at <= now() THEN 'expired'
       WHEN i.id IS NOT NULL THEN 'pending' ELSE 'not_invited' END AS invitation_status,
  i.delivery_status
  FROM customers c
  LEFT JOIN LATERAL (SELECT SUM(amount_minor) AS balance_minor FROM account_ledger_entries e
    WHERE e.organization_id=c.organization_id AND e.customer_id=c.id) b ON true
  LEFT JOIN memberships m ON m.organization_id=c.organization_id AND m.customer_id=c.id AND m.deleted_at IS NULL
  LEFT JOIN LATERAL (SELECT id,revoked_at,accepted_at,expires_at,delivery_status FROM invitations
    WHERE organization_id=c.organization_id AND customer_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1) i ON true`;

@Injectable()
export class CustomersService {
  constructor(@Inject(DatabaseService) private readonly db:DatabaseService,
    @Inject(AccessService) private readonly access:AccessService,
    @Inject(InvitationService) private readonly invitations:InvitationService) {}

  async list(member:Membership, raw:unknown) {
    const active=await this.access.membership(member.user_id,member.organization_id,true);
    const filter=parse(listSchema,raw);
    if(filter.start && filter.end && filter.start>filter.end) throw new BadRequestException('Start date must be on or before end date.');
    const search=`%${filter.search.replace(/[\\%_]/g,'\\$&')}%`;
    const where=`c.organization_id=$1 AND ($2='all' OR c.status=$2)
      AND ($3='%%' OR c.customer_code ILIKE $3 OR c.id::text ILIKE $3 OR c.name ILIKE $3 OR c.email ILIKE $3 OR c.phone ILIKE $3
        OR to_char(c.created_at AT TIME ZONE $6,'YYYY-MM-DD') ILIKE $3
        OR to_char(c.created_at AT TIME ZONE $6,'DD Mon YYYY') ILIKE $3)
      AND ($4::date IS NULL OR (c.created_at AT TIME ZONE $6)::date >= $4::date)
      AND ($5::date IS NULL OR (c.created_at AT TIME ZONE $6)::date <= $5::date)`;
    const params=[active.organization_id,filter.status,search,filter.start||null,filter.end||null,config.businessTimeZone];
    const count=await this.db.query(`SELECT COUNT(*)::int AS total FROM customers c WHERE ${where}`,params);
    const total=count.rows[0].total;
    const page=Math.min(filter.page,Math.max(1,Math.ceil(total/filter.page_size)));
    const result=await this.db.query(`${decoratedCustomer(", to_char(c.created_at AT TIME ZONE $6,'YYYY-MM-DD') AS created_date")} WHERE ${where} ORDER BY c.name,c.id LIMIT $7 OFFSET $8`,
      [...params,filter.page_size,(page-1)*filter.page_size]);
    return {items:result.rows,total,page,page_size:filter.page_size,time_zone:config.businessTimeZone};
  }

  async get(member:Membership, customerId:string) {
    const active=await this.access.membership(member.user_id,member.organization_id);
    await this.access.customer(active,customerId);
    const result=await this.db.query(`${decoratedCustomer()} WHERE c.organization_id=$1 AND c.id=$2`,[active.organization_id,customerId]);
    const customer=result.rows[0];
    if(active.role==='customer') {
      // Internal account notes and delivery/access metadata are administrator-only.
      const {notes:_notes,created_by:_creator,idempotency_key:_key,request_hash:_hash,
        delivery_status:_delivery,invitation_status:_invitation,...visible}=customer;
      return visible;
    }
    return customer;
  }

  async create(member:Membership, raw:unknown) {
    const data=parse(createSchema,raw);
    const hash=createHash('sha256').update(JSON.stringify({...data,user_id:member.user_id})).digest('hex');
    const result=await this.db.transaction(async client=>{
      // Serializing account creation per organization makes retries and email conflicts deterministic.
      // Take the exclusive organization lock before membership's shared organization lock.
      await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[member.organization_id]);
      const active=await this.access.membership(member.user_id,member.organization_id,true,client);
      const duplicate=await client.query('SELECT * FROM customers WHERE organization_id=$1 AND idempotency_key=$2',[active.organization_id,data.idempotency_key]);
      if(duplicate.rows[0]) {
        if(duplicate.rows[0].request_hash!==hash) throw new ConflictException('This submission key has already been used for a different customer.');
        return {customer:duplicate.rows[0],created:false};
      }
      const conflict=await client.query(`SELECT id FROM customers WHERE organization_id=$1 AND email=$2
        UNION ALL SELECT m.id FROM memberships m JOIN users u ON m.user_id=u.id
        WHERE m.organization_id=$1 AND u.email=$2 AND m.role='admin'`,[active.organization_id,data.email]);
      if(conflict.rowCount) throw new ConflictException('This email is already associated with an account in this organization.');
      const id=randomUUID();
      const saved=await client.query(`INSERT INTO customers(id,organization_id,name,email,phone,notes,created_by,idempotency_key,request_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[id,active.organization_id,data.name,data.email,data.phone,data.notes,active.user_id,data.idempotency_key,hash]);
      await client.query(`INSERT INTO audit_events(organization_id,actor_id,action,object_id)
        VALUES($1,$2,'customer.created',$3)`,[active.organization_id,active.user_id,id]);
      return {customer:saved.rows[0],created:true};
    });
    if(result.created) await this.invitations.invite(member,result.customer.id);
    return this.get(member,result.customer.id);
  }

  async update(member:Membership, customerId:string, raw:unknown) {
    const data=parse(updateSchema,raw);
    await this.db.transaction(async client=>{
      const active=await this.access.membership(member.user_id,member.organization_id,true,client);
      const customer=await this.access.customer(active,customerId,client,true);
      if(customer.email!==data.email) throw new BadRequestException('The access email cannot be changed. Revoke access and create a new account for a different email.');
      await client.query(`UPDATE customers SET name=$1,phone=$2,notes=$3,status=$4,updated_at=now()
        WHERE id=$5 AND organization_id=$6`,[data.name,data.phone,data.notes,data.status,customerId,active.organization_id]);
      if(data.status==='archived') {
        await this.invitations.revokeProviderInvitations(customerId,client);
        await client.query(`UPDATE invitations SET revoked_at=now() WHERE customer_id=$1
          AND organization_id=$2 AND revoked_at IS NULL AND accepted_at IS NULL`,[customerId,active.organization_id]);
      }
      await client.query(`INSERT INTO audit_events(organization_id,actor_id,action,object_id,metadata)
        VALUES($1,$2,'customer.updated',$3,$4::jsonb)`,[active.organization_id,active.user_id,customerId,
        JSON.stringify({changed_fields:['name','phone','notes','status'].filter(k=>customer[k]!==data[k as keyof typeof data]),status:data.status})]);
    });
    return this.get(member,customerId);
  }
}
