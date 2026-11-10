-- Rename display references only. Customer UUIDs and all foreign keys stay intact.
-- The migration runner wraps this lock, backfill and sequence restart in one transaction.
LOCK TABLE customers IN ACCESS EXCLUSIVE MODE;

CREATE FUNCTION format_customer_code(sequence_value bigint) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT 'UK44' || lpad(sequence_value::text, greatest(3,length(sequence_value::text)), '0');
$$;

ALTER TABLE customers DISABLE TRIGGER customers_preserve_code;
ALTER TABLE customers DROP CONSTRAINT customers_code_format;
ALTER TABLE customers DROP CONSTRAINT customers_code_unique;
ALTER TABLE customers ALTER COLUMN customer_code TYPE varchar(24);
ALTER SEQUENCE customer_code_sequence MAXVALUE 9223372036854775807 NO CYCLE;
ALTER TABLE customers ALTER COLUMN customer_code SET DEFAULT format_customer_code(nextval('customer_code_sequence'));

-- Start with UK44001 for the oldest retained customer, then count upwards.
WITH numbered AS (
  SELECT id,row_number() OVER (ORDER BY created_at,id) AS number FROM customers
)
UPDATE customers c SET customer_code=format_customer_code(n.number)
FROM numbered n WHERE c.id=n.id;

ALTER TABLE customers ADD CONSTRAINT customers_code_unique UNIQUE(customer_code);
ALTER TABLE customers ADD CONSTRAINT customers_code_format CHECK(customer_code ~ '^UK44[0-9]{3,19}$');
ALTER TABLE customers ENABLE TRIGGER customers_preserve_code;

-- ALTER SEQUENCE RESTART is transactional, unlike setval, so a failed migration
-- cannot leave the live generator reset while the old references remain.
DO $$
DECLARE next_number bigint;
BEGIN
  SELECT count(*)+1 INTO next_number FROM customers;
  EXECUTE format('ALTER SEQUENCE customer_code_sequence RESTART WITH %s',next_number);
END;
$$;
