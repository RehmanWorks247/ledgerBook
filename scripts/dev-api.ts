import { resolve } from 'node:path';
import { applyDevelopmentEmailConfig, LocalEmailConfigError } from './local-email';

async function main() {
  if(process.env.NODE_ENV==='production') throw new Error('Use start:api for production. dev:api is for local development only.');
  await applyDevelopmentEmailConfig(resolve('.local'));
  // Apply the opt-in before config.ts or any worker is imported.
  await import('../apps/api/src/main');
}

void main().catch(error=>{
  console.error(error instanceof LocalEmailConfigError || process.env.NODE_ENV==='production'
    ? error.message : 'Development API startup failed. Check .env and .local/email.env.');
  process.exitCode=1;
});
