-- Quantity describes rooms and never multiplies the full voucher price.
ALTER TABLE companies ADD COLUMN quantity integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 1000000);

CREATE TABLE company_balances (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_key text NOT NULL CHECK (char_length(company_key) BETWEEN 1 AND 200 AND company_key=lower(btrim(company_key))),
  paid_minor numeric(30,0) NOT NULL DEFAULT 0 CHECK (paid_minor>=0),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,company_key)
);

-- Preserve existing paid amounts once as each company's opening paid total.
-- Thereafter this amount is independent of voucher edits, additions or deletion.
-- The legacy row-level money inputs remain stored as historical information.
INSERT INTO company_balances(organization_id,company_key,paid_minor)
SELECT organization_id,lower(company_name),coalesce(sum(paid_minor),0)
FROM companies GROUP BY organization_id,lower(company_name);
