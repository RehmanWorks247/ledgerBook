import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DatabaseService } from '../apps/api/src/database/database.service';
import { AccessService } from '../apps/api/src/access/access.service';
import { LedgerService } from '../apps/api/src/ledger/ledger.service';
import { config } from '../apps/api/src/config';

async function seed() {
  const host=new URL(config.databaseUrl).hostname;
  if(config.nodeEnv!=='development'||config.emailMode!=='file'||process.env.ALLOW_DEV_SEED!=='true'||!['localhost','127.0.0.1','[::1]'].includes(host)) {
    throw new Error('Seed requires NODE_ENV=development, EMAIL_MODE=file, ALLOW_DEV_SEED=true and a local database.');
  }
  const {values}=parseArgs({options:{'organization-id':{type:'string'},'admin-email':{type:'string'}}});
  const organizationId=z.uuid().parse(values['organization-id']);
  const email=z.email().trim().toLowerCase().parse(values['admin-email']);
  const db=new DatabaseService();
  try {
    const user=await db.query('SELECT id FROM users WHERE email=$1',[email]);
    if(!user.rows[0]) throw new Error('Create the administrator first.');
    const access=new AccessService(db);
    const member=await access.membership(user.rows[0].id,organizationId,true);
    const ledger=new LedgerService(db,access);
    const names=['Northstar Supplies','Willow Studio','Cedar & Co.'];
    for(const [index,name] of names.entries()) {
      const customerEmail=`sample-${index+1}@example.invalid`;
      const present=await db.query('SELECT id FROM customers WHERE organization_id=$1 AND email=$2',[organizationId,customerEmail]);
      if(present.rows[0]) continue;
      const id=randomUUID();
      await db.transaction(async client=>{
        await client.query(`INSERT INTO customers(id,organization_id,name,email,notes,created_by,idempotency_key,request_hash)
          VALUES($1,$2,$3,$4,'Development sample; no login identity or invitation',$5,$6,$7)`,
        [id,organizationId,name,customerEmail,member.user_id,randomUUID(),createHash('sha256').update(id).digest('hex')]);
        await client.query("INSERT INTO audit_events(organization_id,actor_id,action,object_id) VALUES($1,$2,'customer.seeded',$3)",[organizationId,member.user_id,id]);
      });
      const effective_date=new Date().toISOString().slice(0,10);
      await ledger.post(member,id,{kind:'opening',amount:index===2?'-150':'1200',effective_date,description:'Opening balance',idempotency_key:randomUUID()});
      if(index!==2) await ledger.post(member,id,{kind:'payment',amount:'250',effective_date,description:'Bank transfer received',reference:'Sample payment',idempotency_key:randomUUID()});
    }
    console.log('Development customers created. No login identities or passwords were added.');
  } finally {await db.close();}
}
void seed().catch(()=>{console.error('Seed failed. Check its development-only requirements and administrator membership.');process.exitCode=1;});
