import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { it } from 'node:test';
import { applyDevelopmentEmailConfig, applyLocalEmailConfig, loadLocalEmailConfig, LocalEmailConfigError, parseLocalEmailConfig } from '../scripts/local-email';

const fakeKey='re_TEST_ONLY_1234567890abcdefgh';
const valid=`EMAIL_MODE=resend\nEMAIL_FROM="LedgerBook <payments@example.test>"\nRESEND_API_KEY=${fakeKey}\n`;

it('loads only explicit email settings and preserves unrelated local settings',()=>{
  const config=parseLocalEmailConfig(`# Private local email configuration\n${valid}`);
  assert.deepEqual(config,{mode:'resend',from:'LedgerBook <payments@example.test>',apiKey:fakeKey});
  const environment:NodeJS.ProcessEnv={DATABASE_URL:'unchanged-test-database',PUBLIC_APP_URL:'http://localhost:3000',EMAIL_MODE:'file'};
  applyLocalEmailConfig(config,environment);
  assert.equal(environment.EMAIL_MODE,'resend');
  assert.equal(environment.EMAIL_FROM,'LedgerBook <payments@example.test>');
  assert.equal(environment.RESEND_API_KEY,fakeKey);
  assert.equal(environment.DATABASE_URL,'unchanged-test-database');
  assert.equal(environment.PUBLIC_APP_URL,'http://localhost:3000');
  applyLocalEmailConfig({mode:'file'},environment);
  assert.equal(environment.EMAIL_MODE,'file');
  assert.equal(environment.EMAIL_FROM,undefined);
  assert.equal(environment.RESEND_API_KEY,undefined);
  assert.deepEqual(parseLocalEmailConfig('EMAIL_MODE=file\n'),{mode:'file'});
});

it('supports ordinary quoted dotenv values and comments without expanding variables',()=>{
  assert.equal(parseLocalEmailConfig(valid.replace('EMAIL_MODE=resend','EMAIL_MODE = "resend" # send email')).mode,'resend');
  assert.equal(parseLocalEmailConfig(valid.replace('"LedgerBook <payments@example.test>"',"'LedgerBook <payments@example.test>'")).mode,'resend');
  assert.equal(parseLocalEmailConfig(valid.replace('"LedgerBook <payments@example.test>"','payments@example.test')).mode,'resend');
  assert.throws(()=>parseLocalEmailConfig(valid.replace(fakeKey,'${RESEND_API_KEY}')),LocalEmailConfigError);
});

it('rejects malformed, incomplete, unexpected or unsafe settings without leaking their values',()=>{
  for(const source of [
    '', '# comments only', 'EMAIL_MODE=resend', valid.replace('EMAIL_MODE=resend','EMAIL_MODE=unknown'),
    `${valid}DATABASE_URL=do-not-load\n`,`${valid}PUBLIC_APP_URL=https://untrusted.test\n`,
    `${valid}RESEND_API_KEY=re_DUPLICATE_1234567890\n`,`${valid}not-an-assignment\n`,
    valid.replace(fakeKey,'invalid-secret'),valid.replace(fakeKey,'re_key with spaces'),
    valid.replace('payments@example.test','not-an-address'),valid.replace('payments@example.test','noreply@localhost'),
    valid.replace('LedgerBook <payments@example.test>','LedgerBook\rHeader: injected <payments@example.test>'),
    valid.replace('"LedgerBook <payments@example.test>"','"unterminated'),
    valid.replace('"LedgerBook <payments@example.test>"','"LedgerBook <payments@example.test>" ignored'),
    valid.replace('EMAIL_MODE=resend','EMAIL_MODE=file'),`${valid}\0`,`${valid}${' '.repeat(8192)}`,
  ]) {
    assert.throws(()=>parseLocalEmailConfig(source),(error:unknown)=>{
      assert.ok(error instanceof LocalEmailConfigError);
      assert.ok(!error.message.includes(fakeKey));
      assert.ok(!error.message.includes('invalid-secret'));
      assert.ok(!error.message.includes('do-not-load'));
      return true;
    });
  }
});

it('defaults to file mode only when the opt-in file is absent and fails closed for an invalid existing file',async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),'ledgerbook-local-email-'));
  try {
    assert.deepEqual(await loadLocalEmailConfig(directory),{mode:'file'});
    await writeFile(resolve(directory,'email.env'),valid,{mode:0o600});
    assert.equal((await loadLocalEmailConfig(directory)).mode,'resend');
    await writeFile(resolve(directory,'email.env'),'EMAIL_MODE=resend\n',{mode:0o600});
    await assert.rejects(loadLocalEmailConfig(directory),LocalEmailConfigError);
  } finally {
    assert.ok(directory.startsWith(resolve(tmpdir(),'ledgerbook-local-email-')));
    await rm(directory,{recursive:true,force:true});
  }
});

it('shares the local delivery opt-in with dev:api while preserving explicit environment settings when absent',async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),'ledgerbook-dev-email-'));
  const environment:NodeJS.ProcessEnv={EMAIL_MODE:'resend',EMAIL_FROM:'Existing <sender@example.test>',RESEND_API_KEY:fakeKey,
    PUBLIC_APP_URL:'http://localhost:5173',DATABASE_URL:'unchanged-local-database'};
  try {
    const original={...environment};
    await applyDevelopmentEmailConfig(directory,environment);
    assert.deepEqual(environment,original);
    await writeFile(resolve(directory,'email.env'),valid,{mode:0o600});
    await applyDevelopmentEmailConfig(directory,environment);
    assert.equal(environment.EMAIL_MODE,'resend');
    assert.equal(environment.EMAIL_FROM,'LedgerBook <payments@example.test>');
    assert.equal(environment.RESEND_API_KEY,fakeKey);
    assert.equal(environment.PUBLIC_APP_URL,'http://localhost:5173');
    assert.equal(environment.DATABASE_URL,'unchanged-local-database');
    await writeFile(resolve(directory,'email.env'),'EMAIL_MODE=file\n',{mode:0o600});
    await applyDevelopmentEmailConfig(directory,environment);
    assert.equal(environment.EMAIL_MODE,'file');
    assert.equal(environment.RESEND_API_KEY,undefined);
    await writeFile(resolve(directory,'email.env'),'EMAIL_MODE=resend\n',{mode:0o600});
    await assert.rejects(applyDevelopmentEmailConfig(directory,environment),LocalEmailConfigError);
    assert.equal(environment.EMAIL_MODE,'file');
  } finally {await rm(directory,{recursive:true,force:true});}
});
