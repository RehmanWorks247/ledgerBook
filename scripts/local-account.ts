import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { DatabaseService } from '../apps/api/src/database/database.service';
import { hashPassword, verifyPassword } from '../apps/api/src/auth/crypto';
import { passwordSchema } from '../apps/api/src/auth/password-policy';

const currencies:Record<string,number>={USD:2,EUR:2,GBP:2,PKR:2,AED:2,SAR:2,CAD:2,AUD:2,INR:2,JPY:0,KWD:3,BHD:3,OMR:3};
const identitySchema=z.object({
  email:z.string().trim().toLowerCase().email().max(254),
  name:z.string().trim().min(1).max(160),
  currency:z.string().refine(value=>currencies[value]!==undefined,'Unsupported currency.'),
});
const credentialSchema=identitySchema.extend({
  userId:z.uuid(),organizationId:z.uuid(),password:passwordSchema,createdAt:z.iso.datetime(),
}).strict();
type Credentials=z.infer<typeof credentialSchema>;
export type LocalAccount={email?:string;organizationId?:string;password?:string;created:boolean;credentialsPath?:string};

/** Privileged local provisioning, not an HTTP registration or authentication bypass. */
export async function ensureLocalAccount(db:DatabaseService,options:{directory?:string;email?:string;name?:string;currency?:string}={}):Promise<LocalAccount> {
  if(process.env.NODE_ENV!=='development'&&process.env.NODE_ENV!=='test') throw new Error('Local provisioning is development-only.');
  if(process.env.AUTH_PROVIDER==='clerk') throw new Error('Clerk administrators must be provisioned with admin:create; local passwords are disabled.');
  const directory=resolve(options.directory??'.local');
  await mkdir(directory,{recursive:true,mode:0o700});
  const jsonPath=resolve(directory,'admin-login.json');
  const textPath=resolve(directory,'admin-login.txt');
  let credentials:Credentials|undefined;
  try {credentials=credentialSchema.parse(JSON.parse(await readFile(jsonPath,'utf8')));}
  catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw new Error('Local credential file is invalid. It was not overwritten.',{cause:error});}
  const existing=await db.query<{count:string}>('SELECT count(*)::text AS count FROM users');
  let created=false;
  if(existing.rows[0].count==='0') {
    if(!credentials) {
      const identity=identitySchema.parse({email:options.email??'admin@ledgerbook.local',name:options.name??'LedgerBook Local',currency:options.currency??'GBP'});
      credentials={...identity,userId:randomUUID(),organizationId:randomUUID(),password:randomBytes(24).toString('base64url'),createdAt:new Date().toISOString()};
      // Save before the transaction so an interrupted first start can recover its password.
      await writeFile(jsonPath,JSON.stringify(credentials,null,2)+'\n',{flag:'wx',mode:0o600});
    }
    const saved=credentials;
    const passwordHash=await hashPassword(saved.password);
    await db.transaction(async client=>{
      const state=await client.query('SELECT (SELECT count(*) FROM users)+(SELECT count(*) FROM organizations) AS count');
      if(String(state.rows[0].count)!=='0') throw new Error('Database was already initialized. No additional default account was created.');
      await client.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',[saved.userId,saved.email,passwordHash]);
      await client.query('INSERT INTO organizations(id,name,currency,currency_exponent) VALUES($1,$2,$3,$4)',[saved.organizationId,saved.name,saved.currency,currencies[saved.currency]]);
      await client.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'admin')",[randomUUID(),saved.organizationId,saved.userId]);
      await client.query("INSERT INTO audit_events(organization_id,actor_id,action,object_id) VALUES($1,$2,'organization.created',$3)",[saved.organizationId,saved.userId,saved.organizationId]);
    });
    created=true;
  }
  if(!credentials) return {created:false};
  const account=await db.query<{email:string;password_hash:string}>(`SELECT u.email,u.password_hash FROM users u JOIN memberships m ON m.user_id=u.id
    WHERE u.id=$1 AND m.organization_id=$2 AND m.role='admin' AND m.is_active=true`,[credentials.userId,credentials.organizationId]);
  if(!account.rows[0]) return {created:false};
  const stillValid=await verifyPassword(credentials.password,account.rows[0].password_hash);
  if(stillValid) {
    await writeFile(textPath,`LEDGERBOOK LOCAL ADMIN\n\nEmail: ${account.rows[0].email}\nInitial password: ${credentials.password}\nOrganization: ${credentials.name}\nCurrency: ${credentials.currency}\n\nLocal development only. Keep this file private.\nIf you change the password, use your new password; this file is not updated.\nDo not upload this file or the .local directory.\n`,{mode:0o600});
  }
  return {created,email:account.rows[0].email,organizationId:credentials.organizationId,
    ...(stillValid?{password:credentials.password,credentialsPath:textPath}:{})};
}
