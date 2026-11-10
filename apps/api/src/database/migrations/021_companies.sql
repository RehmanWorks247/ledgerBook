-- A standalone manual register. Names and amounts here never create customer,
-- booking, payment, invoice, reminder or ledger records.
CREATE TABLE companies (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_name text NOT NULL CHECK (char_length(company_name) BETWEEN 1 AND 200 AND company_name=btrim(company_name)),
  hotel_name text NOT NULL DEFAULT '' CHECK (char_length(hotel_name)<=200),
  customer_name text NOT NULL DEFAULT '' CHECK (char_length(customer_name)<=200),
  check_in date CHECK (check_in BETWEEN '1900-01-01'::date AND '9999-12-31'::date),
  check_out date CHECK (check_out BETWEEN '1900-01-01'::date AND '9999-12-31'::date),
  room_type text NOT NULL DEFAULT '' CHECK (char_length(room_type)<=200),
  booking_date date CHECK (booking_date BETWEEN '1900-01-01'::date AND '9999-12-31'::date),
  voucher_number text NOT NULL DEFAULT '' CHECK (char_length(voucher_number)<=100),
  voucher_price_minor bigint CHECK (voucher_price_minor BETWEEN 0 AND 100000000000000),
  paid_minor bigint CHECK (paid_minor BETWEEN 0 AND 100000000000000),
  unpaid_minor bigint CHECK (unpaid_minor BETWEEN 0 AND 100000000000000),
  balance_minor bigint CHECK (balance_minor BETWEEN -100000000000000 AND 100000000000000),
  remarks text NOT NULL DEFAULT '' CHECK (char_length(remarks)<=2000),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (check_out>=check_in)
);
CREATE INDEX companies_recent ON companies(organization_id,created_at DESC,id DESC);
CREATE INDEX companies_booking_date ON companies(organization_id,booking_date);
CREATE INDEX companies_check_in ON companies(organization_id,check_in);
CREATE INDEX companies_check_out ON companies(organization_id,check_out);

-- Receipts preserve exactly-once creation across response loss and after edits.
-- Deletion clears the snapshot and company reference, retaining only an opaque
-- request key/hash until the workspace itself is permanently removed.
CREATE TABLE company_create_requests (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idempotency_key uuid NOT NULL,
  company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response jsonb CHECK (response IS NULL OR jsonb_typeof(response)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,idempotency_key)
);
CREATE INDEX company_create_requests_company ON company_create_requests(company_id);
