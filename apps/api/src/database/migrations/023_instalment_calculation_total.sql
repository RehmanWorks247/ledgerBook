-- NULL keeps existing bookings and older clients compatible: their calculation
-- total remains the booking total until an administrator sets a separate value.
-- This field never changes a ledger charge, invoice total or customer balance.
ALTER TABLE bookings ADD COLUMN instalment_total_minor bigint
  CHECK (instalment_total_minor BETWEEN 1 AND 100000000000000);
