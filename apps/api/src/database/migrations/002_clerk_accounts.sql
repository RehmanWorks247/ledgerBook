-- Authentication is delegated to Clerk; UUIDs remain stable for ledger audit attribution.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN clerk_user_id text UNIQUE;
ALTER TABLE users ADD COLUMN name text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN clerk_banned_by_app boolean NOT NULL DEFAULT false;
ALTER TABLE memberships ADD COLUMN deleted_at timestamptz;
ALTER TABLE memberships ADD CONSTRAINT memberships_deleted_inactive CHECK (deleted_at IS NULL OR is_active = false);
ALTER TABLE invitations ADD COLUMN clerk_invitation_id text UNIQUE;
CREATE INDEX memberships_not_deleted ON memberships (user_id, organization_id) WHERE deleted_at IS NULL;
