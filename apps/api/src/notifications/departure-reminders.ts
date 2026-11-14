import type { PoolClient } from 'pg';
import { config } from '../config';
import type { DatabaseService } from '../database/database.service';

// Each stage has a non-overlapping window. A late worker never sends the
// luggage reminder alongside the airport reminder, or anything after departure.
const stage = `CASE WHEN b.departure_at<=$1::timestamptz+interval '6 hours' THEN 'departure_6_hours' ELSE 'departure_3_days' END`;
const eligible = `b.deleted_at IS NULL AND c.status='active' AND o.deleted_at IS NULL
  AND b.departure_at>$1::timestamptz AND b.departure_at<=$1::timestamptz+interval '72 hours'
  AND NOT EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reversal_of=b.charge_entry_id)
  AND NOT EXISTS(SELECT 1 FROM email_suppressions s WHERE s.organization_id=b.organization_id
    AND s.recipient_hash=encode(sha256(convert_to(lower(c.email),'UTF8')),'hex'))`;
const joins = `FROM bookings b JOIN customers c ON c.id=b.customer_id JOIN organizations o ON o.id=b.organization_id`;

export async function scheduleDepartures(db:DatabaseService,now:Date) {
  const candidates=await db.query<{id:string;customer_id:string;organization_id:string}>(`SELECT b.id,b.customer_id,b.organization_id ${joins}
    WHERE ${eligible} AND NOT EXISTS(SELECT 1 FROM reminder_email_outbox e
      WHERE e.booking_id=b.id AND e.departure_at=b.departure_at AND e.kind=(${stage}))
    ORDER BY b.departure_at,b.id LIMIT 100`,[now.toISOString()]);
  let queued=0;
  for(const candidate of candidates.rows) queued+=await db.transaction(async client=>{
    // Match booking/payment writers and recheck after locking the account.
    const organization=await client.query('SELECT id FROM organizations WHERE id=$1 AND deleted_at IS NULL FOR SHARE',[candidate.organization_id]);
    if(!organization.rows.length)return 0;
    await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE',[candidate.customer_id]);
    await client.query('SELECT id FROM bookings WHERE id=$1 FOR SHARE',[candidate.id]);
    const result=await client.query<{id:string;customer_id:string;organization_id:string;reference:string;departure_at:Date;email:string;name:string;organization_name:string;kind:string}>(
      `SELECT b.id,b.customer_id,b.organization_id,b.reference,b.departure_at,c.email,c.name,o.name AS organization_name,${stage} AS kind
       ${joins} WHERE ${eligible} AND b.id=$2`,[now.toISOString(),candidate.id]);
    const booking=result.rows[0];
    if(!booking)return 0;
    const airport=booking.kind==='departure_6_hours';
    const departure=new Intl.DateTimeFormat('en-GB',{timeZone:config.businessTimeZone,dateStyle:'full',timeStyle:'short'}).format(new Date(booking.departure_at));
    const text=airport?'Get ready for your taxi and get ready for the airport. Check your pickup time, passport and travel documents.'
      :'Get ready for your trip and get your luggage ready. Check your packing, passport and travel documents.';
    const inserted=await client.query<{id:string}>(`INSERT INTO reminder_email_outbox(organization_id,customer_id,booking_id,scheduled_date,recipient,subject,body,kind,departure_at)
      VALUES($1,$2,$3,($4::timestamptz AT TIME ZONE $5)::date,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
      [booking.organization_id,booking.customer_id,booking.id,now.toISOString(),config.businessTimeZone,booking.email,
        airport?'Get ready for your taxi and the airport':'Get ready and get your luggage ready',
        `Hello ${booking.name},\n\n${text}\n\nBooking: ${booking.reference}\nDeparture: ${departure} (${config.businessTimeZone})\n\nView your account:\n${config.appUrl}/o/${booking.organization_id}\n\n${booking.organization_name}`,
        booking.kind,booking.departure_at]);
    if(!inserted.rows.length)return 0;
    await client.query(`INSERT INTO audit_events(organization_id,action,object_id,metadata) VALUES($1,'reminder.queued',$2,$3::jsonb)`,
      [booking.organization_id,inserted.rows[0].id,JSON.stringify({customer_id:booking.customer_id,booking_id:booking.id,kind:booking.kind,status:'queued'})]);
    return 1;
  });
  return queued;
}

export async function departureStillCurrent(client:PoolClient,email:{booking_id:string;organization_id:string;kind:string;departure_at:Date|string|null;recipient:string},now:Date) {
  const current=await client.query(`SELECT b.id ${joins} WHERE ${eligible} AND b.id=$2 AND b.organization_id=$3
    AND b.departure_at=$4 AND (${stage})=$5 AND lower(c.email)=lower($6::text)`,
    [now.toISOString(),email.booking_id,email.organization_id,email.departure_at,email.kind,email.recipient]);
  return current.rows.length>0;
}
