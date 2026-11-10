import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { NotificationsService } from '../apps/api/src/notifications/notifications.service';
import { applyLocalEmailConfig, loadLocalEmailConfig, LocalEmailConfigError } from './local-email';

export function testEmailMessage(to:string, appUrl:string) {
  const recipient=z.email().max(254).safeParse(to);
  if(!recipient.success) throw new Error('Use --to with one valid email address you control.');
  const origin=new URL(appUrl);
  if(!['http:','https:'].includes(origin.protocol) || origin.origin!==appUrl)
    throw new Error('PUBLIC_APP_URL must be an HTTP or HTTPS origin without a trailing slash.');
  return {
    to:recipient.data,
    subject:'LedgerBook — localhost email test',
    text:`This is a development delivery test from LedgerBook using the same email adapter as booking invoices, payment notifications and reminders.\n\nOpen your development app:\n${appUrl}\n\nIf this is a localhost address, open it on the computer running LedgerBook.\n\nNo customer records or payment data are included in this test.`,
  };
}

export async function sendTestEmail(to:string, appUrl:string, mail:Pick<NotificationsService,'send'>) {
  const result=await mail.send(testEmailMessage(to,appUrl),{idempotencyKey:`localhost-test/${randomUUID()}`});
  if(!result?.providerMessageId) throw new Error('Email acceptance could not be confirmed.');
  return result.providerMessageId;
}

async function main() {
  const {values}=parseArgs({options:{to:{type:'string'},help:{type:'boolean'},'public-url':{type:'string'}}});
  if(values.help) {
    console.log('Usage: npm run email:test -- --to you@example.com [--public-url http://localhost:3001]');
    console.log('Sends one real test email using .local/email.env and the browser origin from .env.');
    return;
  }
  if(process.env.NODE_ENV==='production') throw new Error('This command is for development only.');
  const appUrl=values['public-url']??process.env.PUBLIC_APP_URL??`http://localhost:${process.env.PORT??3000}`;
  const message=testEmailMessage(values.to??'',appUrl);
  const email=await loadLocalEmailConfig(resolve('.local'));
  if(email.mode!=='resend') throw new Error('Real delivery is not enabled. Configure EMAIL_MODE=resend, EMAIL_FROM and RESEND_API_KEY in .local/email.env.');
  applyLocalEmailConfig(email);
  process.env.PUBLIC_APP_URL=appUrl;
  // Only import the email adapter; this diagnostic never starts authentication,
  // application workers or a database, and does not require Clerk credentials.
  process.env.AUTH_PROVIDER='local';
  const {NotificationsService}=await import('../apps/api/src/notifications/notifications.service');
  const id=await sendTestEmail(message.to,appUrl,new NotificationsService());
  console.log(`Resend accepted the localhost test email. Message ID: ${id}`);
  console.log(`App link: ${appUrl}`);
  console.log('Check the recipient inbox and Spam folder. Provider acceptance alone does not confirm inbox delivery.');
}

if(require.main===module) void main().catch(error=>{
  const message=error instanceof Error?error.message:'';
  const safe=error instanceof LocalEmailConfigError || /^(Use --to|PUBLIC_APP_URL must|This command is|Real delivery is not)/.test(message);
  console.error(safe?message:'Test email failed. Check the Resend key, verified sender and provider email logs.');
  process.exitCode=1;
});
