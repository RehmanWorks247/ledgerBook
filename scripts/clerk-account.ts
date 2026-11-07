import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseService } from '../apps/api/src/database/database.service';

const currencies:Record<string,number>={USD:2,EUR:2,GBP:2,PKR:2,AED:2,SAR:2,CAD:2,AUD:2,INR:2,JPY:0,KWD:3,BHD:3,OMR:3};
const inputSchema=z.object({
  clerkUserId:z.string().regex(/^user_[A-Za-z0-9]+$/),
  email:z.string().trim().toLowerCase().email().max(254),
  displayName:z.string().trim().max(160),
  organizationId:z.uuid().optional(),
  name:z.string().trim().min(1).max(160),
  currency:z.string().refine(value=>currencies[value]!==undefined,'Unsupported currency.'),
});

/** Operations-only helper. Call only after verifying the Clerk user and email. */
export async function provisionClerkAdministrator(db:DatabaseService,input:z.input<typeof inputSchema>) {
  const identity=inputSchema.parse(input);
  return db.transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[identity.email]);
    const prior=await client.query<{id:string;clerk_user_id:string|null}>('SELECT id,clerk_user_id FROM users WHERE email=$1 FOR UPDATE',[identity.email]);
    const existing=prior.rows[0];
    if(existing?.clerk_user_id&&existing.clerk_user_id!==identity.clerkUserId)
      throw new Error('This email is already linked to another Clerk user. No administrator was changed.');
    const userId=existing?.id??randomUUID();
    if(existing) await client.query('UPDATE users SET clerk_user_id=$1,name=$2,password_hash=NULL WHERE id=$3',[identity.clerkUserId,identity.displayName,userId]);
    else await client.query('INSERT INTO users(id,email,name,password_hash,clerk_user_id) VALUES($1,$2,$3,NULL,$4)',[userId,identity.email,identity.displayName,identity.clerkUserId]);

    let organizationId=identity.organizationId;
    let createdOrganization=false;
    if(organizationId) {
      if(!(await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[organizationId])).rowCount)
        throw new Error('The requested organization does not exist. No administrator was changed.');
    } else {
      const owned=await client.query<{id:string}>(`SELECT DISTINCT o.id FROM memberships m JOIN organizations o ON o.id=m.organization_id
        WHERE m.user_id=$1 AND m.role='admin' AND lower(o.name)=lower($2)`,[userId,identity.name]);
      if((owned.rowCount??0)>1) throw new Error('Several organizations match this name. Choose an explicit --organization-id.');
      organizationId=owned.rows[0]?.id;
      if(!organizationId) {
        organizationId=randomUUID();createdOrganization=true;
        await client.query('INSERT INTO organizations(id,name,currency,currency_exponent) VALUES($1,$2,$3,$4)',[organizationId,identity.name,identity.currency,currencies[identity.currency]]);
      }
    }
    const membership=await client.query<{id:string;role:string;is_active:boolean;deleted_at:Date|null}>(
      'SELECT id,role,is_active,deleted_at FROM memberships WHERE organization_id=$1 AND user_id=$2 FOR UPDATE',[organizationId,userId]);
    const existingMembership=membership.rows[0];
    if(existingMembership&&existingMembership.role!=='admin')
      throw new Error('This user already has a customer membership in the organization. It cannot be promoted by bootstrap.');
    if(existingMembership) {
      if(!existingMembership.is_active||existingMembership.deleted_at)
        throw new Error('This administrator membership is disabled or deleted. Restore access through account management.');
    } else {
      await client.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'admin')",[randomUUID(),organizationId,userId]);
      await client.query('INSERT INTO audit_events(organization_id,actor_id,action,object_id) VALUES($1,$2,$3,$4)',
        [organizationId,userId,createdOrganization?'organization.created':'administrator.provisioned',createdOrganization?organizationId:userId]);
    }
    return {organizationId,userId,createdOrganization,createdMembership:!existingMembership};
  });
}
