-- Signed uploads are private and invisible until the server verifies their bytes.
-- The object journal also owns cleanup of expired or interrupted attempts.
CREATE TABLE document_uploads (
  id uuid PRIMARY KEY REFERENCES document_objects(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  folder_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 240),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  UNIQUE (organization_id,idempotency_key),
  FOREIGN KEY (organization_id,customer_id,booking_id,id)
    REFERENCES document_objects(organization_id,customer_id,booking_id,id) ON DELETE CASCADE
);
REVOKE ALL ON TABLE document_uploads FROM PUBLIC;
