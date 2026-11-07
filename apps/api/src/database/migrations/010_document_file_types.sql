-- Existing files are PDFs. Keep that default for older importers and seed scripts.
ALTER TABLE booking_nodes ADD COLUMN mime_type text NOT NULL DEFAULT 'application/pdf'
  CHECK (length(mime_type) BETWEEN 1 AND 127 AND mime_type ~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$');

ALTER TABLE booking_nodes DROP CONSTRAINT booking_nodes_storage_shape;
ALTER TABLE booking_nodes ADD CONSTRAINT booking_nodes_storage_shape CHECK (
  (kind='folder' AND content IS NULL AND storage_object_id IS NULL AND size=0) OR
  (kind='file' AND parent_id IS NOT NULL AND service_key IS NOT NULL AND size BETWEEN 1 AND 10485760
    AND ((content IS NOT NULL AND storage_object_id IS NULL AND size=octet_length(content))
      OR (content IS NULL AND storage_object_id IS NOT NULL)))
);

ALTER TABLE document_objects DROP CONSTRAINT document_objects_size_check;
ALTER TABLE document_objects ADD CONSTRAINT document_objects_size_check CHECK (size BETWEEN 1 AND 10485760);
ALTER TABLE document_purge_outbox DROP CONSTRAINT document_purge_outbox_size_check;
ALTER TABLE document_purge_outbox ADD CONSTRAINT document_purge_outbox_size_check CHECK (size BETWEEN 1 AND 10485760);
