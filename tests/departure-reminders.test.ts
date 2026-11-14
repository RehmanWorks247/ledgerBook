import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach,beforeEach,describe,it } from 'node:test';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { businessDate } from '../apps/api/src/dashboard/time';
import { EmailDeliveryService } from '../apps/api/src/notifications/email-delivery.service';
import { NotificationsService,type EmailMessage } from '../apps/api/src/notifications/notifications.service';
import { ReminderService } from '../apps/api/src/notifications/reminder.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { setupTestDatabase,type TestDatabase,type TestSeed } from './helpers';

describe('one-time departure emails',()=>{
  let database:TestDatabase,seed:TestSeed,bookings:BookingsService,worker:ReminderService,payments:PaymentsService,mail:NotificationsService;
  let messages:EmailMessage[],departure:Date;
  const beforeDeparture=(hours:number)=>new Date(departure.getTime()-hours*3600_000);
  beforeEach(async()=>{
    database=await setupTestDatabase();seed=await database.seed();await database.db.query("UPDATE organizations SET currency='GBP'");
    const access=new AccessService(database.db);seed.admin=await access.membership(seed.adminId,seed.orgId);
    bookings=new BookingsService(database.db,access);payments=new PaymentsService(database.db,access);mail=new NotificationsService();messages=[];
    mail.send=async message=>{messages.push(message);return {providerMessageId:randomUUID()};};
    worker=new ReminderService(database.db,access,mail,new EmailDeliveryService(database.db),false);
    departure=new Date(Date.now()+5*24*3600_000);
  });
  afterEach(async()=>{await worker?.beforeApplicationShutdown();await database?.close();});
  const create=()=>bookings.create(seed.admin,seed.customerId,{reference:randomUUID(),amount:'100',departure_at:departure.toISOString(),
    effective_date:businessDate(),required_services:[],schedule_basis:'reminders',instalments:[{due_date:businessDate(),amount:'100'}],idempotency_key:randomUUID()});

  it('sends at 72 hours and six hours, once each, with no further sends after departure',async()=>{
    await create();
    assert.equal(await worker.scheduleDepartures(beforeDeparture(72.001)),0);
    assert.equal(await worker.scheduleDepartures(beforeDeparture(72)),1);
    assert.equal(await worker.deliver(beforeDeparture(72)),1);assert.match(messages[0].text,/get your luggage ready/);
    assert.equal(await worker.scheduleDepartures(beforeDeparture(7)),0);
    assert.equal(await worker.scheduleDepartures(beforeDeparture(6)),1);
    assert.equal(await worker.deliver(beforeDeparture(6)),1);assert.match(messages[1].text,/taxi.*airport/);
    assert.equal(await worker.scheduleDepartures(beforeDeparture(1)),0);
    assert.equal(await worker.scheduleDepartures(departure),0);
    assert.equal(await worker.scheduleDepartures(beforeDeparture(-24)),0);
    assert.equal(await worker.deliver(beforeDeparture(-24)),0);assert.equal(messages.length,2);
  });

  it('skips missed luggage reminders and expires queued airport emails at departure',async()=>{
    await create();assert.equal(await worker.scheduleDepartures(beforeDeparture(5)),1);
    const row=(await database.db.query('SELECT * FROM reminder_email_outbox')).rows[0];assert.equal(row.kind,'departure_6_hours');
    assert.equal(await worker.deliver(departure),0);assert.equal(messages.length,0);
    assert.equal((await database.db.query('SELECT state FROM reminder_email_outbox')).rows[0].state,'cancelled');
  });

  it('cancels the old luggage stage when the six-hour window arrives and deduplicates scheduler replicas',async()=>{
    await create();assert.equal(await worker.scheduleDepartures(beforeDeparture(72)),1);
    const counts=await Promise.all([worker.scheduleDepartures(beforeDeparture(6)),worker.scheduleDepartures(beforeDeparture(6))]);
    assert.equal(counts.reduce((sum,n)=>sum+n,0),1);
    assert.equal(await worker.deliver(beforeDeparture(6)),1);assert.equal(messages.length,1);assert.match(messages[0].text,/taxi/);
  });

  it('continues travel reminders when fully paid and suppresses due reminders at send time',async()=>{
    const booking=await create();
    await worker.updateSettings(seed.admin,{enabled:true,due_soon_days:3,repeat_days:7,send_hour:0,time_zone:'UTC'});
    assert.equal(await worker.schedule(),1);
    assert.equal(await worker.scheduleDepartures(beforeDeparture(72)),1);
    const payment=await payments.record(seed.admin,seed.customerId,booking.id,{amount:'100',payment_date:businessDate(),idempotency_key:randomUUID()});
    await payments.manage(seed.admin,seed.customerId,booking.id,payment.id,'edit',{version:payment.version,reason:'Clarify transfer',note:'Settled',amount:'100',payment_date:businessDate()});
    assert.equal(await worker.deliver(beforeDeparture(72)),1);assert.match(messages[0].text,/luggage/);
    const due=(await database.db.query("SELECT state FROM reminder_email_outbox WHERE kind='payment_due'")).rows[0];assert.equal(due.state,'cancelled');
    assert.equal(await worker.schedule(beforeDeparture(48)),0);
  });

  it('rechecks rescheduled, cancelled and archived bookings before sending',async()=>{
    const booking=await create();await worker.scheduleDepartures(beforeDeparture(72));
    await database.db.query("UPDATE bookings SET departure_at=departure_at+interval '1 day' WHERE id=$1",[booking.id]);
    assert.equal(await worker.deliver(beforeDeparture(72)),0);
    departure=new Date(departure.getTime()+24*3600_000);assert.equal(await worker.scheduleDepartures(beforeDeparture(72)),1);
    await database.db.query("UPDATE customers SET status='archived' WHERE id=$1",[seed.customerId]);
    assert.equal(await worker.deliver(beforeDeparture(72)),0);
    await database.db.query("UPDATE customers SET status='active' WHERE id=$1",[seed.customerId]);
    await database.db.query('UPDATE bookings SET deleted_at=now() WHERE id=$1',[booking.id]);
    assert.equal(await worker.scheduleDepartures(beforeDeparture(6)),0);assert.equal(messages.length,0);
  });
});
