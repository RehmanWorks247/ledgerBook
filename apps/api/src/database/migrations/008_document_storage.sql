-- Keep legacy bytea documents readable; new cloud objects have a durable journal.
CREATE TABLE document_objects (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  bucket text NOT NULL CHECK (length(bucket) BETWEEN 3 AND 63),
  object_key text NOT NULL UNIQUE,
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  size integer NOT NULL CHECK (size BETWEEN 12 AND 10485760),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready','deleting')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,customer_id,booking_id) REFERENCES bookings(organization_id,customer_id,id),
  UNIQUE (organization_id,customer_id,booking_id,id)
);
CREATE INDEX document_objects_cleanup ON document_objects(created_at,id) WHERE state IN ('pending','deleting');

ALTER TABLE booking_nodes ADD COLUMN storage_object_id uuid UNIQUE;
ALTER TABLE booking_nodes ADD CONSTRAINT booking_nodes_storage_object
  FOREIGN KEY (organization_id,customer_id,booking_id,storage_object_id)
  REFERENCES document_objects(organization_id,customer_id,booking_id,id);
-- The initial unnamed check is generated as booking_nodes_check by PostgreSQL.
ALTER TABLE booking_nodes DROP CONSTRAINT booking_nodes_check;
ALTER TABLE booking_nodes ADD CONSTRAINT booking_nodes_storage_shape CHECK (
  (kind='folder' AND content IS NULL AND storage_object_id IS NULL AND size=0) OR
  (kind='file' AND parent_id IS NOT NULL AND service_key IS NOT NULL AND size BETWEEN 12 AND 10485760
    AND ((content IS NOT NULL AND storage_object_id IS NULL AND size=octet_length(content))
      OR (content IS NULL AND storage_object_id IS NOT NULL)))
);

-- Protect journal state from cleanup races and invalid direct database imports.
CREATE FUNCTION validate_document_storage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.storage_object_id IS NOT NULL THEN
    PERFORM 1 FROM document_objects o WHERE o.id=NEW.storage_object_id AND o.state='ready'
      AND o.organization_id=NEW.organization_id AND o.customer_id=NEW.customer_id
      AND o.booking_id=NEW.booking_id AND o.size=NEW.size FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Document storage must be ready and match its booking and size' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER booking_document_storage BEFORE INSERT OR UPDATE ON booking_nodes
  FOR EACH ROW EXECUTE FUNCTION validate_document_storage();

CREATE FUNCTION protect_document_object() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.organization_id,NEW.customer_id,NEW.booking_id,NEW.bucket,NEW.object_key,NEW.checksum,NEW.size)
    IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.customer_id,OLD.booking_id,OLD.bucket,OLD.object_key,OLD.checksum,OLD.size)
    OR (NEW.state IS DISTINCT FROM OLD.state AND NOT (OLD.state='pending' AND NEW.state IN ('ready','deleting')))
  THEN RAISE EXCEPTION 'Document storage identity and finalized state are immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER document_object_immutable BEFORE UPDATE ON document_objects
  FOR EACH ROW EXECUTE FUNCTION protect_document_object();
