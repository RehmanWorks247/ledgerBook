-- A customer-scoped revision avoids a hot organization-wide lock. Financial and
-- document writes already serialize on that customer. Bump once per statement,
-- including bulk imports, in the same transaction as the underlying mutation.
ALTER TABLE customers ADD COLUMN report_version bigint NOT NULL DEFAULT 1;
CREATE FUNCTION bump_customer_report_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.report_version := OLD.report_version + 1;
  RETURN NEW;
END; $$;
-- Run after identity validation: the tightly scoped administrator-anonymization
-- routine must see only its authorized created_by change during that validation.
CREATE TRIGGER customers_z_report_revision BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION bump_customer_report_revision();

CREATE FUNCTION invalidate_customer_reports() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    UPDATE customers SET report_version=report_version+1
      WHERE id IN (SELECT DISTINCT customer_id FROM report_new);
  ELSIF TG_OP='DELETE' THEN
    UPDATE customers SET report_version=report_version+1
      WHERE id IN (SELECT DISTINCT customer_id FROM report_old);
  ELSE
    UPDATE customers SET report_version=report_version+1
      WHERE id IN (SELECT customer_id FROM report_new UNION SELECT customer_id FROM report_old);
  END IF;
  RETURN NULL;
END; $$;
DO $$ DECLARE source text; BEGIN
  FOREACH source IN ARRAY ARRAY['ledger_entries','bookings','booking_instalments','booking_nodes'] LOOP
    EXECUTE format('CREATE TRIGGER report_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS report_new FOR EACH STATEMENT EXECUTE FUNCTION invalidate_customer_reports()',source);
    EXECUTE format('CREATE TRIGGER report_update AFTER UPDATE ON %I REFERENCING OLD TABLE AS report_old NEW TABLE AS report_new FOR EACH STATEMENT EXECUTE FUNCTION invalidate_customer_reports()',source);
    EXECUTE format('CREATE TRIGGER report_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS report_old FOR EACH STATEMENT EXECUTE FUNCTION invalidate_customer_reports()',source);
  END LOOP;
END; $$;
