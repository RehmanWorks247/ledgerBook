# Security and operational boundaries

## Authentication and tenant access

Passwords use salted scrypt and are never logged or returned by the API. Login uses the same password derivation for unknown identities to reduce enumeration differences. Sessions use cryptographically random opaque tokens; only their SHA-256 hashes are stored. Cookies are HTTP-only, SameSite=Lax, and Secure with the `__Host-` prefix in production. Sign-out deletes the session; a successful password reset revokes every session for that identity.

All unsafe browser API requests must supply the exact configured `Origin` and the custom `X-CSRF-Protection: 1` header. Public authentication endpoints are covered too. Same-origin requests do not require a cross-origin resource-sharing configuration. Never weaken these checks to `*` to fix a deployment mismatch; configure `PUBLIC_APP_URL` correctly.

Invitation and reset tokens are sent in URL fragments, then removed from the browser address bar. Fragments are not included in HTTP requests or referrers. Do not add analytics, error reporting of form state, request-body logging, or third-party scripts to authentication pages without reviewing token/password exposure. The application deliberately avoids logging emails, passwords, session tokens, invitation tokens, and reset tokens.

An organization admin is not a platform admin. Memberships govern access independently from the login identity. A customer membership links exactly one customer account, with database-enforced organization and email consistency. Backend checks are repeated for each operation; frontend route guards are only a user-experience aid.

## Invitations and recovery

Invitation creation/revocation/acceptance lock the same customer account so concurrent requests have a defined order. Unique constraints prevent multiple outstanding invitations. Tokens expire and can be consumed only once. Changing the browser's customer or organization ID cannot grant access. Existing-user acceptance requires an authenticated identity whose normalized email matches the invited email.

Password recovery returns the same response for known and unknown addresses and performs account lookup/email delivery after the response is prepared. Reset links expire, previous requests are invalidated, and successful reset consumes all outstanding links. Admins cannot set customer passwords. The system does not expose public registration.

Database-backed rate-limit counters apply across API processes. Auth routes use both client IP and email where appropriate; invitation operations also use authenticated identity/organization scopes. If deployed behind a proxy, trust only the configured fixed number of known hops and ensure the edge overwrites incoming forwarding headers. Spoofable client-supplied proxy headers must not become a rate-limit bypass.

## Financial integrity

Ledger writes use PostgreSQL transactions and a customer row lock. Idempotency keys are tenant scoped and bound to a canonical request fingerprint including the creator. Replaying the same request returns the posted result; reusing the key for a different request is rejected. Unique reversal linkage prevents reversing the same entry twice. Foreign keys and triggers reject cross-customer/cross-tenant reversals, currency mismatches, invalid signs, inactive admin writes, and mutations of posted history.

Money uses integer minor units represented by `bigint` in TypeScript and PostgreSQL; transport uses decimal strings. Balance queries sum posted entries and statements use deterministic `(effective_date, id)` order. Consistent database snapshots keep paginated statement counts, rows, and totals aligned during concurrent writes.

Runtime queries always apply tenant access checks. PostgreSQL row-level security is not used; the application role therefore remains sensitive. Keep database credentials private, restrict direct database access, and do not expose arbitrary SQL endpoints. Database administrators and superusers can bypass application controls and must be governed separately.

## Deployment checklist

1. Configure a stable HTTPS origin and verified email sender. Check invitation, existing-user acceptance, password recovery, cookie flags, logout, and reset invalidation on that origin.
2. Run the full test suite with `TEST_DATABASE_URL` against the same PostgreSQL major version as production. PGlite does not simulate separate server connections or network failure.
3. Apply migrations using a controlled deployment process. The runtime role should not own or be able to disable financial integrity triggers where practical.
4. Restrict ingress to the API/reverse proxy and restrict database network access. Keep connection pools within the database's budget.
5. Enable encrypted backups, define retention, and test restoration. Audit history is not a substitute for backups.
6. Monitor aggregate error rates, email delivery failures, database availability, and latency without storing request bodies or secrets.
7. Run cleanup regularly for expiring authentication records. Do not truncate or remove ledger/audit tables.
8. Review dependency updates and run checks before deployment. No application-level MFA, platform support impersonation, or email-change workflow is included in this initial scope.

CSV downloads contain customer financial data. Treat them as private documents and share them only through approved business channels. Formula escaping protects common spreadsheet clients but does not replace handling exports as untrusted text.
