ALTER TABLE booking_payment_receipts DROP CONSTRAINT booking_payment_receipts_mime_type_check;
ALTER TABLE booking_payment_receipts ADD CONSTRAINT booking_payment_receipts_mime_type_check
  CHECK (mime_type IN ('image/webp','application/pdf'));
