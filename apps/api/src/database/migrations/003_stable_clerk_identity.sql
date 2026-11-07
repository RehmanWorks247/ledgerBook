-- A verified email establishes the initial invitation binding. After joining,
-- Clerk subject -> local user UUID is the identity; changing a verified primary
-- email must not prevent administrators from disabling or deleting membership.
CREATE OR REPLACE FUNCTION validate_membership_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    identity_email text;
    account_email text;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.id IS DISTINCT FROM OLD.id
            OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
            OR NEW.user_id IS DISTINCT FROM OLD.user_id
            OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
            OR NEW.role IS DISTINCT FROM OLD.role
            OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'Membership identity and role are immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    SELECT email INTO identity_email FROM users WHERE id = NEW.user_id;
    IF NEW.role = 'customer' THEN
        SELECT email INTO account_email FROM customers
            WHERE id = NEW.customer_id AND organization_id = NEW.organization_id;
        IF account_email IS NULL OR account_email IS DISTINCT FROM identity_email THEN
            RAISE EXCEPTION 'Membership must match the customer email and organization' USING ERRCODE = '23514';
        END IF;
    ELSIF EXISTS (
        SELECT 1 FROM customers WHERE organization_id = NEW.organization_id AND email = identity_email
    ) THEN
        RAISE EXCEPTION 'An organization administrator cannot also own a customer account' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

-- Retain deleted membership rows for audit, while allowing an administrator's
-- fresh invitation to assign the customer to a different authenticated person.
ALTER TABLE memberships DROP CONSTRAINT memberships_customer_id_key;
CREATE UNIQUE INDEX memberships_one_current_customer ON memberships (customer_id) WHERE deleted_at IS NULL;
