import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DatabaseService } from '../apps/api/src/database/database.service';
import { hashPassword, validatePassword } from '../apps/api/src/auth/crypto';

const currencies:Record<string,number>={USD:2,EUR:2,GBP:2,PKR:2,AED:2,SAR:2,CAD:2,AUD:2,INR:2,JPY:0,KWD:3,BHD:3,OMR:3};
async function readSecret(fromStdin:boolean):Promise<string> {
  if(fromStdin) {
    let value='';
    for await(const chunk of process.stdin) {
      value+=chunk.toString();
      if(value.length>256) throw new Error('Password input is too long.');
    }
    return value.replace(/\r?\n$/,'');
  }
  if(!process.stdin.isTTY) throw new Error('Use an interactive terminal or explicitly supply --password-stdin.');
  process.stdout.write('Choose the initial admin password (12–128 characters, hidden): ');
  process.stdin.setRawMode(true);process.stdin.resume();process.stdin.setEncoding('utf8');
  return new Promise((resolve,reject)=>{
    let value='';
    const finish=()=>{process.stdin.setRawMode(false);process.stdin.pause();process.stdin.off('data',receive);process.stdout.write('\n');};
    const receive=(chunk:string)=>{
      for(const char of chunk) {
        if(char==='\u0003') {finish();reject(new Error('Cancelled.'));return;}
        if(char==='\r'||char==='\n') {finish();resolve(value);return;}
        if(char==='\u007f'||char==='\b') value=value.slice(0,-1);
        else if(char>=' ' && value.length<129) value+=char;
      }
    };
    process.stdin.on('data',receive);
  });
}
async function bootstrap() {
  const {values}=parseArgs({options:{name:{type:'string'},email:{type:'string'},currency:{type:'string'},'password-stdin':{type:'boolean'}}});
  const name=z.string().trim().min(1).max(160).parse(values.name);
  const email=z.string().trim().toLowerCase().email().max(254).parse(values.email);
  const currency=z.string().length(3).parse(values.currency?.toUpperCase());
  if(currencies[currency]===undefined) throw new Error('Unsupported currency. Choose USD, EUR, GBP, PKR, AED, SAR, CAD, AUD, INR, JPY, KWD, BHD or OMR.');
  const db=new DatabaseService();
  try {
    const existing=await db.query('SELECT id FROM users WHERE email=$1',[email]);
    let passwordHash:string|undefined;
    if(!existing.rows[0]) {
      const password=await readSecret(values['password-stdin']===true);
      validatePassword(password,email);passwordHash=await hashPassword(password);
    }
    const organizationId=await db.transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[email]);
      const prior=await client.query('SELECT id FROM users WHERE email=$1 FOR UPDATE',[email]);
      let userId=prior.rows[0]?.id;
      if(!userId) {
        if(!passwordHash) throw new Error('Identity changed. Run the command again.');
        userId=randomUUID();
        await client.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',[userId,email,passwordHash]);
      }
      const duplicate=await client.query(`SELECT 1 FROM memberships m JOIN organizations o ON o.id=m.organization_id
        WHERE m.user_id=$1 AND lower(o.name)=lower($2)`,[userId,name]);
      if(duplicate.rowCount) throw new Error('This administrator already belongs to an organization with that name.');
      const id=randomUUID();
      await client.query('INSERT INTO organizations(id,name,currency,currency_exponent) VALUES($1,$2,$3,$4)',[id,name,currency,currencies[currency]]);
      await client.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'admin')",[randomUUID(),id,userId]);
      await client.query("INSERT INTO audit_events(organization_id,actor_id,action,object_id) VALUES($1,$2,'organization.created',$3)",[id,userId,id]);
      return id;
    });
    console.log(`Organization created: ${organizationId}. Sign in with the administrator email.`);
  } finally {await db.close();}
}
void bootstrap().catch(error=>{
  // Validation messages are safe; database details may contain private data.
  const safe=error instanceof z.ZodError?'Provide valid --name, --email and --currency values.':
    error instanceof Error && !('code' in error)?error.message:'Provisioning failed. Verify configuration and database migrations.';
  console.error(safe);process.exitCode=1;
});
