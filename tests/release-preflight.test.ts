import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const publishable=(mode:string)=>`pk_${mode}_${Buffer.from('clerk.example.test$').toString('base64')}`;
function check(extra:NodeJS.ProcessEnv) {
  return spawnSync(process.execPath,['--import','tsx','scripts/release-preflight.ts'],{encoding:'utf8',env:{...process.env,NODE_ENV:'production',AUTH_PROVIDER:'clerk',
    PUBLIC_APP_URL:'https://ledger.example.test',DATABASE_URL:'postgres://unused:never-print-this-password@127.0.0.1:1/unused',EMAIL_MODE:'resend',EMAIL_FROM:'test@example.test',
    RESEND_API_KEY:'never-print-this-provider-key',CLERK_PUBLISHABLE_KEY:publishable('live'),CLERK_SECRET_KEY:'sk_live_private-never-print',
    RESEND_WEBHOOK_SECRET:`whsec_${Buffer.from('fixture-only-secret').toString('base64')}`,DOCUMENT_STORAGE:'database',...extra}});
}
test('release preflight rejects test auth keys before any database or provider activity',()=>{
  const result=check({CLERK_PUBLISHABLE_KEY:publishable('test'),CLERK_SECRET_KEY:'sk_test_private'});
  assert.equal(result.status,1); assert.match(result.stderr,/Clerk production instance/);
  assert.doesNotMatch(result.stderr,/never-print|sk_test_private/);
});
test('release preflight requires delivery tracking and private production object storage',()=>{
  const webhook=check({RESEND_WEBHOOK_SECRET:''}); assert.equal(webhook.status,1); assert.match(webhook.stderr,/RESEND_WEBHOOK_SECRET/);
  const storage=check({}); assert.equal(storage.status,1); assert.match(storage.stderr,/private R2 or S3/);
  const origin=check({PUBLIC_HOST:'wrong.example.test'}); assert.equal(origin.status,1); assert.match(origin.stderr,/PUBLIC_HOST/);
});
