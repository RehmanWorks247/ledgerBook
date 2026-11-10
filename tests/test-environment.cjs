// Test fixtures must never use the Clerk instance or delivery credentials in .env.
/* global process */
process.env.NODE_ENV='test';
process.env.AUTH_PROVIDER='local';
process.env.EMAIL_MODE='file';
process.env.DOCUMENT_STORAGE='database';
process.env.PUBLIC_APP_URL='http://localhost:5173';
delete process.env.CLERK_SECRET_KEY;
delete process.env.CLERK_PUBLISHABLE_KEY;
delete process.env.VITE_CLERK_PUBLISHABLE_KEY;
delete process.env.RESEND_API_KEY;
delete process.env.REDIS_URL;
delete process.env.S3_DOCUMENT_BUCKET;
delete process.env.AWS_REGION;
delete process.env.AWS_DEFAULT_REGION;
delete process.env.AWS_ACCESS_KEY_ID;
delete process.env.AWS_SECRET_ACCESS_KEY;
delete process.env.AWS_SESSION_TOKEN;
delete process.env.AWS_PROFILE;
// Isolated regression tests must never inherit live R2 credentials from .env.
delete process.env.R2_ACCOUNT_ID;
delete process.env.R2_DOCUMENT_BUCKET;
delete process.env.R2_ACCESS_KEY_ID;
delete process.env.R2_SECRET_ACCESS_KEY;
delete process.env.STORAGE_ENVIRONMENT;
