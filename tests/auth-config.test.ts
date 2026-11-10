import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';

function loadConfig(overrides:Record<string,string|undefined>={}) {
  const env:NodeJS.ProcessEnv={...process.env,NODE_ENV:'production',AUTH_PROVIDER:'clerk',
    CLERK_SECRET_KEY:'sk_test_fixture',
    CLERK_PUBLISHABLE_KEY:`pk_test_${Buffer.from('fixture.clerk.accounts.dev$').toString('base64')}`,
    DATABASE_URL:'postgresql://localhost/fixture',PUBLIC_APP_URL:'https://ledger.example.test',
    EMAIL_MODE:'resend',EMAIL_FROM:'LedgerBook <payments@example.test>',RESEND_API_KEY:'re_test_fixture',...overrides};
  for(const [name,value] of Object.entries(env)) if(value===undefined) delete env[name];
  return spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',
    "await import('./apps/api/src/config.ts');"],{env,encoding:'utf8'});
}

it('requires configured payment email delivery in production even when Clerk handles authentication',() => {
  const valid=loadConfig();
  assert.equal(valid.status,0,valid.stderr);
  for(const overrides of [{EMAIL_MODE:'file'},{EMAIL_FROM:undefined},{RESEND_API_KEY:undefined}]) {
    const result=loadConfig(overrides);
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/Production requires DATABASE_URL, EMAIL_MODE=resend, EMAIL_FROM and RESEND_API_KEY for payment notifications/);
  }
});

it('allows explicit local development file delivery without weakening production Clerk authentication',() => {
  const development=loadConfig({NODE_ENV:'development',AUTH_PROVIDER:'local',PUBLIC_APP_URL:'http://localhost:3000',
    EMAIL_MODE:'file',EMAIL_FROM:undefined,RESEND_API_KEY:undefined,CLERK_SECRET_KEY:undefined,CLERK_PUBLISHABLE_KEY:undefined});
  assert.equal(development.status,0,development.stderr);
  const production=loadConfig({AUTH_PROVIDER:'local'});
  assert.notEqual(production.status,0);
  assert.match(production.stderr,/Production requires AUTH_PROVIDER=clerk/);
});

it('rejects malformed or undersized delivery webhook signing keys at startup',()=>{
  for(const secret of ['placeholder','whsec_YQ==']) {
    const result=loadConfig({RESEND_WEBHOOK_SECRET:secret});
    assert.notEqual(result.status,0);assert.match(result.stderr,/RESEND_WEBHOOK_SECRET is invalid/);
  }
  const result=loadConfig({RESEND_WEBHOOK_SECRET:`whsec_${Buffer.alloc(32,7).toString('base64')}`});
  assert.equal(result.status,0,result.stderr);
});
