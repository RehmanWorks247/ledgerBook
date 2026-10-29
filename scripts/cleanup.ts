import 'reflect-metadata';
import { DatabaseService } from '../apps/api/src/database/database.service';
async function cleanup() {
  const db=new DatabaseService();
  try {
    await db.transaction(async client=>{
      await client.query('DELETE FROM sessions WHERE expires_at<now()');
      await client.query('DELETE FROM rate_limits WHERE expires_at<now()');
      await client.query("DELETE FROM password_resets WHERE expires_at<now()-interval '7 days'");
    });
    console.log('Expired session, recovery, and rate-limit records cleaned up.');
  }finally {await db.close();}
}
void cleanup().catch(()=>{console.error('Cleanup failed. Verify database configuration.');process.exitCode=1;});
