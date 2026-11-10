import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';
import { sendTestEmail, testEmailMessage } from '../scripts/test-email';

it('uses the configured localhost browser origin and one explicit recipient',async()=>{
  const keys:string[]=[];
  for(const origin of ['http://localhost:3001','http://localhost:5173']) {
    const id=await sendTestEmail('developer@example.test',origin,{send:async(message,options)=>{
      assert.equal(message.to,'developer@example.test');
      assert.match(message.subject,/localhost email test/);
      assert.ok(message.text.includes(`\n${origin}\n`));
      const key=options?.idempotencyKey;
      assert.ok(key);
      assert.ok(key.startsWith('localhost-test/'));
      keys.push(key);
      return {providerMessageId:'test-provider-id'};
    }});
    assert.equal(id,'test-provider-id');
  }
  assert.equal(new Set(keys).size,2);
});

it('rejects missing, multiple or injected recipients and invalid browser origins before sending',async()=>{
  const mail={send:async()=>{assert.fail('invalid input must not send');}};
  for(const recipient of ['', 'invalid', 'one@example.test,two@example.test', 'one@example.test\r\nBcc: two@example.test'])
    await assert.rejects(sendTestEmail(recipient,'http://localhost:3001',mail),/valid email address/);
  for(const origin of ['file:///tmp/test','http://localhost:3001/','https://example.test/path'])
    assert.throws(()=>testEmailMessage('developer@example.test',origin),/HTTP or HTTPS origin/);
});

it('does not report a provider failure or missing receipt as successful delivery',async()=>{
  await assert.rejects(sendTestEmail('developer@example.test','http://localhost:3001',{
    send:async()=>{throw new Error('Email delivery was not accepted.');},
  }),/not accepted/);
  await assert.rejects(sendTestEmail('developer@example.test','http://localhost:3001',{
    send:async()=>undefined,
  }),/acceptance could not be confirmed/);
});

it('refuses production and requires a recipient before loading live email configuration',()=>{
  const run=(args:string[],nodeEnv:string)=>spawnSync(process.execPath,['--import','tsx','scripts/test-email.ts',...args],{
    env:{...process.env,NODE_ENV:nodeEnv},encoding:'utf8',
  });
  const missing=run([],'development');
  assert.equal(missing.status,1);assert.match(missing.stderr,/Use --to/);
  const production=run(['--to','developer@example.test'],'production');
  assert.equal(production.status,1);assert.match(production.stderr,/development only/);
});
