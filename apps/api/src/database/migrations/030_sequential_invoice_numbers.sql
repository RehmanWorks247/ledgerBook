-- The migration runner also executes renumberExistingInvoices in this same
-- transaction so metadata, saved snapshots and rendered PDFs change together.
CREATE SEQUENCE invoice_number_sequence;
ALTER TABLE booking_invoices DROP CONSTRAINT booking_invoices_filename_check;
ALTER TABLE booking_invoices ADD CONSTRAINT booking_invoices_filename_check
  CHECK (filename ~ '^(inv-[a-f0-9]{32}-v[0-9]+|Inv-up[0-9]{3,})\.pdf$');
