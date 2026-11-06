-- Booking documents and bytes commit together: no public file paths or orphaned uploads.
CREATE TABLE bookings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  reference text NOT NULL CHECK (char_length(btrim(reference)) BETWEEN 1 AND 160),
  departure_at timestamptz NOT NULL,
  required_services text[] NOT NULL DEFAULT '{}'
    CHECK (required_services <@ ARRAY['flight','makkah','madinah','transfers','visas','extras']::text[]),
  total_minor bigint NOT NULL CHECK (total_minor BETWEEN 1 AND 100000000000000),
  currency char(3) NOT NULL DEFAULT 'GBP' CHECK (currency = 'GBP'),
  charge_entry_id bigint NOT NULL UNIQUE REFERENCES ledger_entries(id),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers(organization_id,id),
  UNIQUE (organization_id,customer_id,id),
  UNIQUE (organization_id,idempotency_key),
  UNIQUE (organization_id,reference)
);
CREATE INDEX bookings_departures ON bookings(organization_id,departure_at);
CREATE TABLE booking_instalments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  due_date date NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 100000000000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,customer_id,booking_id) REFERENCES bookings(organization_id,customer_id,id)
);
CREATE INDEX booking_instalments_due ON booking_instalments(organization_id,customer_id,due_date,id);
CREATE TABLE booking_nodes (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  parent_id uuid,
  kind text NOT NULL CHECK (kind IN ('file','folder')),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 240 AND name NOT IN ('.','..') AND name !~ '[/\\\\]'),
  service_key text CHECK (service_key IN ('flight','makkah','madinah','transfers','visas','extras')),
  default_folder boolean NOT NULL DEFAULT false,
  issued_at timestamptz,
  content bytea,
  size integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  FOREIGN KEY (organization_id,customer_id,booking_id) REFERENCES bookings(organization_id,customer_id,id),
  UNIQUE (organization_id,customer_id,booking_id,id),
  FOREIGN KEY (organization_id,customer_id,booking_id,parent_id) REFERENCES booking_nodes(organization_id,customer_id,booking_id,id),
  UNIQUE (organization_id,idempotency_key),
  CHECK ((kind='folder' AND content IS NULL AND size=0) OR
    (kind='file' AND parent_id IS NOT NULL AND service_key IS NOT NULL AND content IS NOT NULL
      AND size=octet_length(content) AND size BETWEEN 12 AND 10485760)),
  CHECK (NOT default_folder OR (kind='folder' AND parent_id IS NULL AND service_key IS NOT NULL)),
  CHECK (issued_at IS NULL OR default_folder)
);
CREATE UNIQUE INDEX booking_nodes_default ON booking_nodes(booking_id,service_key) WHERE default_folder;
CREATE UNIQUE INDEX booking_nodes_names ON booking_nodes(booking_id,coalesce(parent_id,'00000000-0000-0000-0000-000000000000'::uuid),lower(name));
CREATE INDEX booking_nodes_booking ON booking_nodes(organization_id,customer_id,booking_id);

-- Safe to rerun for old bookings. Never replaces a folder or changes associations.
CREATE FUNCTION ensure_booking_folders(target_booking uuid) RETURNS void LANGUAGE sql AS $$
  -- Adopt a legacy folder with the same service name before inserting anything.
  -- Its ID, name, files and parent associations remain unchanged.
  UPDATE booking_nodes n SET service_key=s.key,default_folder=true
  FROM (VALUES ('flight','Flight Tickets'),('makkah','Makkah Hotel'),('madinah','Madinah Hotel'),
    ('transfers','Transfers'),('visas','Visas'),('extras','Extras')) s(key,name)
  WHERE n.booking_id=target_booking AND n.parent_id IS NULL AND n.kind='folder'
    AND NOT n.default_folder AND lower(n.name)=lower(s.name)
    AND NOT EXISTS (SELECT 1 FROM booking_nodes existing WHERE existing.booking_id=target_booking
      AND existing.service_key=s.key AND existing.default_folder);
  INSERT INTO booking_nodes(id,organization_id,customer_id,booking_id,kind,name,service_key,default_folder,created_by,idempotency_key,request_hash)
  SELECT gen_random_uuid(),b.organization_id,b.customer_id,b.id,'folder',s.name,s.key,true,b.created_by,gen_random_uuid(),'default-folder'
  FROM bookings b CROSS JOIN (VALUES
    ('flight','Flight Tickets'),('makkah','Makkah Hotel'),('madinah','Madinah Hotel'),
    ('transfers','Transfers'),('visas','Visas'),('extras','Extras')) s(key,name)
  WHERE b.id=target_booking
  ON CONFLICT DO NOTHING;
  WITH RECURSIVE service_tree AS (
    SELECT id,service_key FROM booking_nodes WHERE booking_id=target_booking AND default_folder
    UNION ALL SELECT n.id,t.service_key FROM booking_nodes n JOIN service_tree t ON n.parent_id=t.id
      WHERE n.booking_id=target_booking
  ) UPDATE booking_nodes n SET service_key=t.service_key FROM service_tree t
    WHERE n.id=t.id AND n.service_key IS DISTINCT FROM t.service_key;
$$;
SELECT ensure_booking_folders(id) FROM bookings;
