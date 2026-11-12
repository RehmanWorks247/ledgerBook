-- Reminder schedules never create or correct money. Existing schedules and
-- payment links remain unchanged until an administrator explicitly replaces a plan.
ALTER TABLE bookings ADD COLUMN schedule_basis text NOT NULL DEFAULT 'legacy'
  CHECK (schedule_basis IN ('legacy','remaining_balance','reminders'));
ALTER TABLE bookings ADD COLUMN reminder_paid_baseline_minor bigint NOT NULL DEFAULT 0
  CHECK (reminder_paid_baseline_minor>=0);
ALTER TABLE bookings ADD COLUMN reminder_payment_baseline jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(reminder_payment_baseline)='object');
ALTER TABLE booking_instalments ADD COLUMN is_reminder boolean NOT NULL DEFAULT false;
ALTER TABLE booking_instalments ADD CONSTRAINT reminder_has_no_payment CHECK (NOT is_reminder OR payment_id IS NULL);
