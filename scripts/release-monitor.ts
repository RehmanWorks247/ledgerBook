import { DatabaseService } from '../apps/api/src/database/database.service';
import { releasePreflight } from './release-preflight';

/** Intended for an existing monitor/scheduler; emits aggregate metrics, no recipients or message bodies. */
export async function releaseMonitor() {
  const start=performance.now();
  const readiness=await releasePreflight(true),readyMs=Math.round(performance.now()-start);
  const db=new DatabaseService();
  try {
    const delivery=await db.query<{failed:number;stalled:number;unconfirmed:number}>(`WITH mail AS (
      SELECT state,delivery_status,created_at,sent_at FROM payment_email_outbox
      UNION ALL SELECT state,delivery_status,created_at,sent_at FROM reminder_email_outbox
    ) SELECT count(*) FILTER(WHERE created_at>now()-interval '24 hours' AND (state='failed' OR delivery_status IN ('bounced','complained','failed')))::integer AS failed,
      count(*) FILTER(WHERE state IN ('pending','processing') AND created_at<now()-interval '15 minutes')::integer AS stalled,
      count(*) FILTER(WHERE delivery_status='accepted' AND sent_at<now()-interval '1 hour' AND sent_at>now()-interval '24 hours')::integer AS unconfirmed FROM mail`);
    const reminders=await db.query<{stale:number}>(`SELECT count(*)::integer AS stale FROM reminder_settings WHERE enabled
      AND extract(hour FROM now() AT TIME ZONE time_zone)>send_hour
      AND last_scheduled_date IS DISTINCT FROM (now() AT TIME ZONE time_zone)::date`);
    const mail=delivery.rows[0],issues:string[]=[];
    if(readyMs>5000) issues.push('readiness_slow');
    if(mail.failed) issues.push('email_failures');
    if(mail.stalled) issues.push('email_queue_stalled');
    if(mail.unconfirmed) issues.push('delivery_webhooks_unconfirmed');
    if(reminders.rows[0].stale) issues.push('reminder_scheduler_stale');
    return {status:issues.length?'attention':'ok',ready_ms:readyMs,migrations:readiness.migrations,email:mail,stale_reminder_schedules:reminders.rows[0].stale,issues};
  } finally {await db.close();}
}
if(require.main===module) void releaseMonitor().then(result=>{console.log(JSON.stringify(result));if(result.status!=='ok') process.exitCode=2;})
  .catch(()=>{console.error(JSON.stringify({status:'failed',issues:['readiness_or_monitor_query_failed']}));process.exitCode=1;});
