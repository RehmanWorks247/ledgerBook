-- Workspace profiles are tenant metadata. Financial currency and posted
-- accounting records remain unchanged when a workspace profile is edited.
ALTER TABLE organizations
  ADD COLUMN description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  ADD COLUMN color text NOT NULL DEFAULT '#13795b' CHECK (color ~ '^#[0-9a-f]{6}$'),
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN deleted_at timestamptz;
UPDATE organizations SET updated_at=created_at;
ALTER TABLE users ADD COLUMN workspace_creator boolean NOT NULL DEFAULT false;

-- Workspace removal grants the deleting administrator a separate capability
-- before removing tenant membership. Ordinary disabled memberships confer none.
CREATE INDEX memberships_workspace_creators ON memberships(user_id,organization_id)
  WHERE role='admin' AND is_active AND deleted_at IS NULL;

-- A durable request receipt prevents a lost HTTP response (or a retry after
-- deletion) from creating a second workspace. Scope keys to the authenticated
-- actor so another user's key cannot disclose or replay a workspace. Permanent
-- deletion clears the stored profile and organization reference, retaining only
-- the actor, opaque key and hash needed to reject a stale creation retry.
CREATE TABLE workspace_create_requests (
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key uuid NOT NULL,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response jsonb CHECK (response IS NULL OR jsonb_typeof(response)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_id,idempotency_key)
);
CREATE INDEX workspace_create_requests_organization ON workspace_create_requests(organization_id);
