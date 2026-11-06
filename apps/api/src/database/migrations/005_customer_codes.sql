-- Public customer references stay short; UUIDs retain all existing relationships.
-- A non-cycling sequence and a unique constraint prevent concurrent collisions.
CREATE SEQUENCE customer_code_sequence MINVALUE 1 MAXVALUE 999999 NO CYCLE;
ALTER TABLE customers ADD COLUMN customer_code varchar(8)
  DEFAULT ('UK' || lpad(nextval('customer_code_sequence')::text, 6, '0'));
ALTER TABLE customers ALTER COLUMN customer_code SET NOT NULL;
ALTER TABLE customers ADD CONSTRAINT customers_code_unique UNIQUE (customer_code);
ALTER TABLE customers ADD CONSTRAINT customers_code_format CHECK (customer_code ~ '^UK[0-9]{6}$');

CREATE FUNCTION preserve_customer_code() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_code IS DISTINCT FROM OLD.customer_code THEN
    RAISE EXCEPTION 'Customer IDs cannot be changed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER customers_preserve_code BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION preserve_customer_code();
