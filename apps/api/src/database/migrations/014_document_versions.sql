-- Immutable snapshots retain prior bytes while the document's public ID stays stable.
ALTER TABLE booking_nodes ADD COLUMN content_version integer NOT NULL DEFAULT 1 CHECK (content_version > 0);
CREATE TABLE document_versions (
  document_id uuid NOT NULL REFERENCES booking_nodes(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL,
  mime_type text NOT NULL,
  size integer NOT NULL CHECK (size BETWEEN 1 AND 10485760),
  content bytea,
  storage_object_id uuid REFERENCES document_objects(id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(document_id,version),
  CHECK ((content IS NOT NULL AND storage_object_id IS NULL AND octet_length(content)=size)
    OR (content IS NULL AND storage_object_id IS NOT NULL))
);
CREATE INDEX document_versions_object ON document_versions(storage_object_id) WHERE storage_object_id IS NOT NULL;
CREATE TABLE document_version_uploads (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES booking_nodes(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key uuid NOT NULL,
  filename text NOT NULL,
  size integer NOT NULL CHECK (size BETWEEN 1 AND 10485760),
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  expected_version integer NOT NULL CHECK (expected_version > 0),
  completed_version integer,
  storage_object_id uuid REFERENCES document_objects(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  UNIQUE(organization_id,idempotency_key)
);
-- Account purge already journals every cloud object. Individual document deletion
-- additionally journals historical versions. Conflict handling supports both paths.
CREATE FUNCTION purge_document_versions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE objects uuid[];
BEGIN
  SELECT array_agg(DISTINCT storage_object_id) INTO objects FROM document_versions
    WHERE document_id=OLD.id AND storage_object_id IS NOT NULL AND storage_object_id IS DISTINCT FROM OLD.storage_object_id;
  INSERT INTO document_purge_outbox(id,bucket,object_key,checksum,size)
    SELECT id,bucket,object_key,checksum,size FROM document_objects WHERE id=ANY(objects)
    ON CONFLICT(id) DO NOTHING;
  DELETE FROM document_versions WHERE document_id=OLD.id;
  DELETE FROM document_objects WHERE id=ANY(objects);
  RETURN OLD;
END; $$;
CREATE TRIGGER booking_document_versions_purge BEFORE DELETE ON booking_nodes FOR EACH ROW EXECUTE FUNCTION purge_document_versions();
REVOKE ALL ON TABLE document_versions,document_version_uploads FROM PUBLIC;
