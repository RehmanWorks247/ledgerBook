import { resolve } from 'node:path';

function integer(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
if (process.env.NODE_ENV && !['development','test','production'].includes(process.env.NODE_ENV)) throw new Error('NODE_ENV must be development, test or production.');
const production = process.env.NODE_ENV === 'production';
const businessTimeZone = process.env.BUSINESS_TIME_ZONE ?? 'UTC';
try { new Intl.DateTimeFormat('en', { timeZone: businessTimeZone }).format(); }
catch { throw new Error('BUSINESS_TIME_ZONE must be a valid IANA time zone.'); }
const appUrl = process.env.PUBLIC_APP_URL ?? 'http://localhost:5173';
const parsedUrl = new URL(appUrl);
if (parsedUrl.origin !== appUrl || (production && parsedUrl.protocol !== 'https:')) {
  throw new Error('PUBLIC_APP_URL must be an origin with HTTPS in production (no trailing slash).');
}
if (process.env.EMAIL_MODE && !['file','resend'].includes(process.env.EMAIL_MODE)) throw new Error('EMAIL_MODE must be file or resend.');
if (production && (!process.env.DATABASE_URL || process.env.EMAIL_MODE !== 'resend' || !process.env.EMAIL_FROM || !process.env.RESEND_API_KEY)) {
  throw new Error('Production requires DATABASE_URL, EMAIL_MODE=resend, EMAIL_FROM and RESEND_API_KEY.');
}
export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development', production, appUrl, businessTimeZone,
  port: integer('PORT',3000,1,65535),
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/ledgerbook',
  databaseSsl: process.env.DATABASE_SSL === 'true',
  redisUrl: process.env.REDIS_URL,
  exchangeRateUrl: process.env.EXCHANGE_RATE_URL ?? 'https://api.frankfurter.dev/v2/rates',
  exchangeRateTtlSeconds: integer('EXCHANGE_RATE_TTL_SECONDS',3600,60,86400),
  exchangeRateMaxAgeSeconds: integer('EXCHANGE_RATE_MAX_AGE_SECONDS',604800,86400,2592000),
  poolSize: integer('DATABASE_POOL_SIZE',10,1,100),
  trustProxyHops: integer('TRUST_PROXY_HOPS',0,0,10),
  sessionCookie: production ? '__Host-ledgerbook' : 'ledgerbook_session',
  sessionTtlSeconds: integer('SESSION_TTL_SECONDS',43200,300,604800),
  invitationTtlHours: integer('INVITATION_TTL_HOURS',72,1,168),
  emailMode: process.env.EMAIL_MODE ?? 'file',
  emailFrom: process.env.EMAIL_FROM ?? 'LedgerBook <noreply@localhost>',
  resendApiKey: process.env.RESEND_API_KEY,
  mailDirectory: resolve(process.env.MAIL_DIRECTORY ?? '.local/mail'),
};
