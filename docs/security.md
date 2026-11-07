# Security and operational boundaries

## Authentication and tenant access

Clerk owns authentication, passwords, email verification, recovery, and session revocation. The API verifies each session JWT against Clerk and restricts its authorized-party claim to `PUBLIC_APP_URL`; it then checks the live Clerk session and user, including banned/locked state and verified primary email. Only the configured instance's verified identity is linked to a local user. Global identities do not grant organization membership by themselves.

Production requires `AUTH_PROVIDER=clerk`. The explicit `local` provider is retained for isolated automated regression tests and legacy account maintenance only; it uses salted scrypt and hashed opaque session tokens. Tests clear provider delivery credentials before loading application modules. Never expose a Clerk secret key to the browser or place it in a `VITE_` variable.

All unsafe browser API requests must supply the exact configured `Origin` and the custom `X-CSRF-Protection: 1` header. Public authentication endpoints are covered too. Same-origin requests do not require a cross-origin resource-sharing configuration. Never weaken these checks to `*` to fix a deployment mismatch; configure `PUBLIC_APP_URL` correctly.

Clerk invitation redirects carry one-time invitation values in the URL query. The application retains these values during onboarding so reloading and sign-in/recovery can return to the invitation, then clears them after acceptance. It uses `Referrer-Policy: no-referrer`. Keep reverse-proxy request logs from capturing authentication URL queries; do not log request bodies, passwords, recovery codes, or tokens. Clerk recovery uses emailed verification codes rather than application reset links. The legacy provider retains fragment-based links.

An organization admin is not a platform admin. Memberships govern access independently from the login identity. A customer membership links exactly one customer account, with database-enforced organization and email consistency. Backend checks are repeated for each operation; frontend route guards are only a user-experience aid.

## Invitations and recovery

Invitation creation/revocation/acceptance lock the same customer account so concurrent requests have a defined order. Unique constraints prevent multiple outstanding invitations. Tokens expire and can be consumed only once. Changing the browser's customer or organization ID cannot grant access. Existing-user acceptance requires an authenticated identity whose normalized email matches the invited email.

Clerk sends password recovery codes and validates password policy. Successful recovery invalidates other sessions. Admins cannot set customer passwords. Public sign-up does not create an application membership; acceptance requires the invited verified identity and a valid outstanding application invitation. Existing-user acceptance preserves that identity's password.

Administrators can disable and re-enable access without removing the account's history. Permanent customer deletion requires the exact account email confirmation and removes the selected business's customer profile, contact details, notes, ledger entries/reversals, invitations, memberships, and related audit events. It applies to pending and archived accounts as well as joined users. A subsequent invitation creates a new account and ledger; it does not restore deleted history.

Deleting an administrator removes that membership and identifying attribution while preserving other customers' business records. Self-disable/self-delete and removing the last active administrator are rejected. The app bans or deletes the global Clerk identity only when no other organization's membership or valid pending invitation needs it; another organization's records are outside the deletion scope. Orphan local login identities and their sessions/recovery records are removed when no remaining references need them. Disable Clerk's **Allow users to delete their account** setting, including existing users, so the account profile cannot bypass application administrator protections.

Provider operations and PostgreSQL do not share a transaction. If Clerk fails during deletion, the database transaction rolls back and the interface reports that local account data was retained. Earlier invitation revocations or provider identity deletions may already have completed. Retrying is supported: already-revoked invitations and already-deleted provider identities are treated as completed operations. A pending invitation by itself does not authorize deleting an otherwise unassociated Clerk identity with the same email.

Database-backed rate-limit counters apply across API processes. Auth routes use both client IP and email where appropriate; invitation operations also use authenticated identity/organization scopes. If deployed behind a proxy, trust only the configured fixed number of known hops and ensure the edge overwrites incoming forwarding headers. Spoofable client-supplied proxy headers must not become a rate-limit bypass.

## Financial integrity

Ledger writes use PostgreSQL transactions and a customer row lock. Idempotency keys are tenant scoped and bound to a canonical request fingerprint including the creator. Replaying the same request returns the posted result; reusing the key for a different request is rejected. Unique reversal linkage prevents reversing the same entry twice. Foreign keys and triggers reject cross-customer/cross-tenant reversals, currency mismatches, invalid signs, inactive admin writes, and ordinary mutations of posted history. Permanent deletion is a narrow exception: authorized account deletion removes only that account's records, and administrator deletion clears creator/actor attribution without changing other customers' transactions.

Money uses integer minor units represented by `bigint` in TypeScript and PostgreSQL; transport uses decimal strings. Balance queries sum posted entries and statements use deterministic `(effective_date, id)` order. Consistent database snapshots keep paginated statement counts, rows, and totals aligned during concurrent writes.

Runtime queries always apply tenant access checks. PostgreSQL row-level security is not used; the application role therefore remains sensitive. Keep database credentials private, restrict direct database access, and do not expose arbitrary SQL endpoints. Database administrators and superusers can bypass application controls and must be governed separately.

When migration ownership and runtime access use separate PostgreSQL roles, grant the runtime role execution on the two checked deletion entry points. Substitute the actual application schema and runtime role for `public` and `ledgerbook_app`:

```sql
GRANT EXECUTE ON FUNCTION public.permanently_delete_customer(uuid, uuid, uuid, text)
  TO ledgerbook_app;
GRANT EXECUTE ON FUNCTION public.permanently_delete_administrator(uuid, uuid, uuid, text)
  TO ledgerbook_app;
REVOKE ALL ON TABLE public.account_purge_context FROM ledgerbook_app;
REVOKE ALL ON FUNCTION public.account_purge_allows(text, text, jsonb, jsonb)
  FROM ledgerbook_app;
```

The entry points recheck the active administrator, business, target, and confirmation email. The private context table and helper are owned by the migration role and must not be granted to the runtime role, directly or through an inherited role. Exclude `account_purge_context` from blanket table grants and default privileges; do not use `GRANT ... ON ALL TABLES IN SCHEMA` for runtime access. The local PGlite runner uses the schema owner and needs no additional grants. The migration pins privileged routines to the application schema and authorizes only specific rows during the deletion transaction; normal ledger/audit edits remain prohibited.

## Deployment checklist

1. Configure a stable HTTPS origin and Clerk production instance. Check invitation delivery, existing-user acceptance, password recovery, logout, session invalidation, and administrator removal protections on that origin.
2. Run the full test suite with `TEST_DATABASE_URL` against the same PostgreSQL major version as production. PGlite does not simulate separate server connections or network failure.
3. Apply migrations using a controlled deployment process. The runtime role should not own or be able to disable financial integrity triggers where practical.
4. Restrict ingress to the API/reverse proxy and restrict database network access. Keep connection pools within the database's budget.
5. Enable encrypted backups, define retention, and test restoration. Audit history is not a substitute for backups.
6. Monitor aggregate error rates, email delivery failures, database availability, and latency without storing request bodies or secrets.
7. Run cleanup regularly for expiring authentication records. Do not truncate or remove ledger/audit tables.
8. Review dependency updates and run checks before deployment. Clerk manages MFA/device-trust challenges when enabled. Platform support impersonation and moving a customer ledger to a different email identity are not included.

CSV downloads contain customer financial data. Treat them as private documents and share them only through approved business channels. Formula escaping protects common spreadsheet clients but does not replace handling exports as untrusted text.
