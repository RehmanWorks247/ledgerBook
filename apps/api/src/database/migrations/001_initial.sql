-- LedgerBook's initial schema. Run with the migration runner in a transaction.
-- Login identities are global; all business data is scoped to an organization.

CREATE TABLE organizations (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
    currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    currency_exponent smallint NOT NULL CHECK (currency_exponent IN (0, 2, 3)),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, currency)
);

CREATE TABLE users (
    id uuid PRIMARY KEY,
    email text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 320)
);

CREATE TABLE customers (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
    email text NOT NULL,
    phone text NOT NULL DEFAULT '' CHECK (char_length(phone) <= 40),
    notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 4000),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    idempotency_key uuid NOT NULL,
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    CHECK (email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 320),
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, email),
    UNIQUE (organization_id, idempotency_key)
);
CREATE INDEX customers_organization_list ON customers (organization_id, status, name, id);

CREATE TABLE memberships (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    role text NOT NULL CHECK (role IN ('admin', 'customer')),
    is_active boolean NOT NULL DEFAULT true,
    customer_id uuid UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, user_id),
    FOREIGN KEY (organization_id, customer_id)
        REFERENCES customers (organization_id, id) ON DELETE RESTRICT,
    CHECK ((role = 'admin' AND customer_id IS NULL)
        OR (role = 'customer' AND customer_id IS NOT NULL))
);
CREATE INDEX memberships_user_access ON memberships (user_id, is_active, organization_id);

CREATE TABLE invitations (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    customer_id uuid NOT NULL,
    email text NOT NULL,
    token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    expires_at timestamptz NOT NULL,
    accepted_at timestamptz,
    revoked_at timestamptz,
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    delivery_status text NOT NULL DEFAULT 'pending'
        CHECK (delivery_status IN ('pending', 'sent', 'failed')),
    delivered_at timestamptz,
    FOREIGN KEY (organization_id, customer_id)
        REFERENCES customers (organization_id, id) ON DELETE RESTRICT,
    CHECK (email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 320),
    CHECK (expires_at > created_at),
    CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE UNIQUE INDEX invitations_one_outstanding_customer ON invitations (customer_id)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX invitations_customer_history ON invitations (organization_id, customer_id, created_at DESC);

CREATE TABLE sessions (
    token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expiry ON sessions (expires_at);

CREATE TABLE password_resets (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at)
);
CREATE INDEX password_resets_user ON password_resets (user_id, created_at DESC);
CREATE INDEX password_resets_expiry ON password_resets (expires_at);

CREATE TABLE rate_limits (
    key text PRIMARY KEY,
    count integer NOT NULL CHECK (count >= 0),
    expires_at timestamptz NOT NULL
);
CREATE INDEX rate_limits_expiry ON rate_limits (expires_at);

CREATE TABLE ledger_entries (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('opening', 'charge', 'payment', 'reversal')),
    amount_minor bigint NOT NULL CHECK (
        amount_minor <> 0 AND amount_minor BETWEEN -100000000000000 AND 100000000000000
    ),
    currency char(3) NOT NULL,
    effective_date date NOT NULL CHECK (effective_date BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'),
    description text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 1000),
    reference text NOT NULL DEFAULT '' CHECK (char_length(reference) <= 160),
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    reversal_of bigint UNIQUE REFERENCES ledger_entries(id) ON DELETE RESTRICT,
    idempotency_key uuid NOT NULL,
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    FOREIGN KEY (organization_id, customer_id)
        REFERENCES customers (organization_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (organization_id, currency)
        REFERENCES organizations (id, currency) ON DELETE RESTRICT,
    FOREIGN KEY (organization_id, created_by)
        REFERENCES memberships (organization_id, user_id) ON DELETE RESTRICT,
    UNIQUE (organization_id, idempotency_key),
    CHECK ((kind = 'charge' AND amount_minor > 0 AND reversal_of IS NULL)
        OR (kind = 'payment' AND amount_minor < 0 AND reversal_of IS NULL)
        OR (kind = 'opening' AND reversal_of IS NULL)
        OR (kind = 'reversal' AND reversal_of IS NOT NULL))
);
CREATE UNIQUE INDEX ledger_one_opening_per_customer ON ledger_entries (customer_id)
    WHERE kind = 'opening';
CREATE INDEX ledger_customer_statement ON ledger_entries (organization_id, customer_id, effective_date, id);
CREATE INDEX ledger_organization_activity ON ledger_entries (organization_id, created_at DESC, id DESC);

CREATE TABLE audit_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    actor_id uuid REFERENCES users(id) ON DELETE RESTRICT,
    action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 100),
    object_id text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (organization_id, actor_id)
        REFERENCES memberships (organization_id, user_id) ON DELETE RESTRICT
);
CREATE INDEX audit_organization_history ON audit_events (organization_id, created_at DESC, id DESC);

-- Defense in depth: callers cannot move an account between tenants or replace its
-- email identity. A different email requires a separately provisioned account.
CREATE FUNCTION protect_customer_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.created_by IS DISTINCT FROM OLD.created_by
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.email IS DISTINCT FROM OLD.email
        OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
        OR NEW.request_hash IS DISTINCT FROM OLD.request_hash THEN
        RAISE EXCEPTION 'Customer identity and creation history are immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER customers_preserve_identity BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION protect_customer_identity();

CREATE FUNCTION validate_membership_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    identity_email text;
    account_email text;
BEGIN
    IF TG_OP = 'UPDATE' AND (
        NEW.id IS DISTINCT FROM OLD.id
        OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
        OR NEW.role IS DISTINCT FROM OLD.role
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    ) THEN
        RAISE EXCEPTION 'Membership identity and role are immutable'
            USING ERRCODE = '23514';
    END IF;
    SELECT email INTO identity_email FROM users WHERE id = NEW.user_id;
    IF NEW.role = 'customer' THEN
        SELECT email INTO account_email FROM customers
            WHERE id = NEW.customer_id AND organization_id = NEW.organization_id;
        IF account_email IS NULL OR account_email IS DISTINCT FROM identity_email THEN
            RAISE EXCEPTION 'Membership must match the customer email and organization'
                USING ERRCODE = '23514';
        END IF;
    ELSIF EXISTS (
        SELECT 1 FROM customers WHERE organization_id = NEW.organization_id AND email = identity_email
    ) THEN
        RAISE EXCEPTION 'An organization administrator cannot also own a customer account'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER memberships_validate_identity BEFORE INSERT OR UPDATE ON memberships
    FOR EACH ROW EXECUTE FUNCTION validate_membership_identity();

CREATE FUNCTION validate_customer_email() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = NEW.organization_id AND u.email = NEW.email AND m.role = 'admin'
    ) THEN
        RAISE EXCEPTION 'An organization administrator cannot also own a customer account'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER customers_validate_email BEFORE INSERT ON customers
    FOR EACH ROW EXECUTE FUNCTION validate_customer_email();

CREATE FUNCTION validate_invitation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM customers c
        WHERE c.id = NEW.customer_id AND c.organization_id = NEW.organization_id AND c.email = NEW.email
    ) THEN
        RAISE EXCEPTION 'Invitation must match its customer email and organization'
            USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND (
        NEW.id IS DISTINCT FROM OLD.id
        OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
        OR NEW.email IS DISTINCT FROM OLD.email
        OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
        OR NEW.created_by IS DISTINCT FROM OLD.created_by
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR (OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS DISTINCT FROM OLD.accepted_at)
        OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
    ) THEN
        RAISE EXCEPTION 'Invitation identity and consumed status are immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER invitations_validate_identity BEFORE INSERT OR UPDATE ON invitations
    FOR EACH ROW EXECUTE FUNCTION validate_invitation_identity();

CREATE FUNCTION validate_ledger_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    original ledger_entries%ROWTYPE;
BEGIN
    -- Lock access and account status so concurrent revocation/archive has a
    -- well-defined order relative to a financial write.
    PERFORM 1 FROM memberships
        WHERE organization_id = NEW.organization_id AND user_id = NEW.created_by
            AND role = 'admin' AND is_active = true FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Ledger entries require an active organization administrator'
            USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM customers
        WHERE organization_id = NEW.organization_id AND id = NEW.customer_id
            AND status = 'active' FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Ledger entries require an active customer account'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.kind = 'opening' AND EXISTS (
        SELECT 1 FROM ledger_entries
        WHERE organization_id = NEW.organization_id AND customer_id = NEW.customer_id
    ) THEN
        RAISE EXCEPTION 'Opening balance must be the first entry in the customer account'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.kind = 'reversal' THEN
        SELECT * INTO original FROM ledger_entries WHERE id = NEW.reversal_of;
        IF NOT FOUND
            OR original.kind = 'reversal'
            OR original.organization_id IS DISTINCT FROM NEW.organization_id
            OR original.customer_id IS DISTINCT FROM NEW.customer_id
            OR original.currency IS DISTINCT FROM NEW.currency
            OR NEW.amount_minor <> -original.amount_minor
            OR NEW.effective_date < original.effective_date THEN
            RAISE EXCEPTION 'Reversal must negate an original entry in the same customer account'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_validate_entry BEFORE INSERT ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION validate_ledger_entry();

CREATE FUNCTION reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Posted financial and audit history cannot be edited or deleted'
        USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION protect_organization_currency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.currency IS DISTINCT FROM OLD.currency
        OR NEW.currency_exponent IS DISTINCT FROM OLD.currency_exponent)
        AND EXISTS (SELECT 1 FROM ledger_entries WHERE organization_id = OLD.id) THEN
        RAISE EXCEPTION 'Organization currency cannot change after ledger entries are posted'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER organizations_protect_currency BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION protect_organization_currency();
