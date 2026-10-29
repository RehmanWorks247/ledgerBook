import { createApp } from './app';
import { config } from './config';

async function main() {
  const app=await createApp();
  app.enableShutdownHooks();
  await app.listen(config.port,'0.0.0.0');
  console.log(`LedgerBook API listening on port ${config.port}.`);
}
void main().catch(()=>{ console.error('LedgerBook failed to start. Check configuration and database connectivity.');process.exitCode=1; });
