ALTER TABLE memberships ADD COLUMN display_currency varchar(3)
  CHECK (display_currency ~ '^[A-Z]{3}$');

CREATE TABLE exchange_rate_overrides (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  rate numeric(21,12) NOT NULL CHECK (rate > 0 AND rate <= 100000000),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, currency)
);

-- Durable cache also supports the single-process local launcher without Redis.
CREATE TABLE exchange_rate_cache (
  base_currency varchar(3) PRIMARY KEY,
  snapshot jsonb NOT NULL
);
