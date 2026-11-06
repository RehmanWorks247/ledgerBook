-- Match the ledger's tenant-scoped identity guarantees for imports and future
-- callers as well as the current booking API.
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_booking_identity
  UNIQUE (organization_id,customer_id,id);
ALTER TABLE bookings ADD CONSTRAINT booking_charge_customer
  FOREIGN KEY (organization_id,customer_id,charge_entry_id)
  REFERENCES ledger_entries(organization_id,customer_id,id);
ALTER TABLE bookings ADD CONSTRAINT booking_creator_membership
  FOREIGN KEY (organization_id,created_by)
  REFERENCES memberships(organization_id,user_id);
ALTER TABLE booking_nodes ADD CONSTRAINT booking_node_creator_membership
  FOREIGN KEY (organization_id,created_by)
  REFERENCES memberships(organization_id,user_id);

CREATE FUNCTION validate_booking_charge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ledger_entries e WHERE e.id=NEW.charge_entry_id
      AND e.organization_id=NEW.organization_id AND e.customer_id=NEW.customer_id
      AND e.kind='charge' AND e.currency=NEW.currency AND e.amount_minor=NEW.total_minor
  ) THEN
    RAISE EXCEPTION 'Booking must match its customer GBP ledger charge and total'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bookings_validate_charge BEFORE INSERT OR UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION validate_booking_charge();
