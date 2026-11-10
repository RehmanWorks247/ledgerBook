# Workspaces

Administrators use **Workspaces** in the sidebar to switch between the workspaces
available to their account. The picker supports name/description search and renders 24 cards
at a time. A signed-in administrator can create a workspace from this page, then
manage it through **Settings → Workspace details**. Customers see their account,
bookings, and personal settings without workspace labels, links, or management
controls. For customer-only accounts, both `/` and `/workspaces` open the first
available account automatically; direct links to their other accounts still work.

Each workspace has a name (1–160 characters), description (up to 1,000
characters), and six-digit color. New workspaces use GBP and receive an
administrator membership for their creator. Editing the profile does not change
accounting currency, personal appearance settings, or posted money values.
Existing workspaces receive an empty description and a default green color.

## Access and consistency

All workspace operations use the authenticated application user. Memberships
remain the authority for tenant data access; knowing a workspace UUID grants no
access. The profile endpoint is available to members, while mutations require
an active administrator membership. Creation requires administrator access in an
existing workspace or the narrow creation entitlement retained when an
administrator deletes a workspace. Initial administrator provisioning still
uses the existing bootstrap command.

Creation uses an actor-scoped UUID idempotency key. Retrying a committed creation
returns its original result; using its key for different inputs or after the
workspace was deleted returns a conflict. Edits and deletion require the current
profile version. Another session's changes produce a conflict with an explicit
reload action. A failed navigation refresh after a successful mutation offers a
refresh retry without resubmitting that mutation.

The API paths retain the database's `organizations` naming:

| Method and path | Behavior |
| --- | --- |
| `POST /api/organizations` | Create with `name`, optional `description`/`color`, and `idempotency_key` |
| `GET /api/organizations/:id` | Read the current profile and version |
| `PATCH /api/organizations/:id` | Save changed profile fields with `expected_version` |
| `DELETE /api/organizations/:id` | Permanently delete with exact `confirmation_name` and `expected_version` |

`GET /api/auth/session` includes `can_create_workspaces` and each membership's
`organization_description`, `organization_color`, and `organization_version`.
See the [OpenAPI contract](../postman/contracts/workspaces.openapi.json) for
request schemas, authentication, errors, and rate limits.

## Permanent deletion

The administrator must type the workspace's exact current name. Deletion removes
the organization, memberships, customer profiles, ledger history and reversals,
bookings, instalments, payment submissions and receipts, document versions and
database file bytes, invitations, queued notifications, correlated delivery
events, settings, overrides, and audit history in one database transaction.
Concurrent authorized writes finish before the deletion or fail after it; they
cannot recreate tenant records after deletion commits. Background delivery and
invitation operations coordinate with the same organization lock.

Shared sign-in identities and their other workspaces remain intact. The deleting
administrator retains permission to create a replacement even after deleting
their last workspace. Minimal operational receipts retain only opaque IDs,
request digests, timestamps, and the original pending file count for safe retries.
The stored creation profile is cleared. These receipts retain no names,
descriptions, financial history, or file content.

Private cloud objects immediately lose application access and enter the existing
durable deletion queue. Storage cleanup waits 24 hours so outstanding signed
upload links expire before objects are erased, then retries failures until
removal succeeds. Current files, historical versions, and unfinished uploads are
all included. `files_pending` in the deletion response is the original count
queued, not a live progress counter. Keep the storage cleanup worker running with
the correct bucket configuration; see [file storage](file-storage.md). Previously
issued storage links may remain usable until their own expiry. Previously sent
emails and independently retained backups follow the provider/backup retention
policy; workspace deletion cannot retract them.

## Deployment and verification

Apply migrations `018_workspaces.sql` and `019_workspace_purge.sql` before serving
the updated application. Reapply `deploy/runtime-grants.sql` as the schema owner
for separate runtime roles. Release preflight checks workspace table access and
execution permission for the checked purge routine. The runtime role must not
own the schema or access the private purge authorization context.

Workspace reads and writes use indexed membership lookups, and creation requests
serialize per actor rather than globally. The purge checks immutable-history
permissions through a transaction-scoped tenant context rather than materializing
every ledger ID. Deletion is synchronous and its duration grows with tenant data;
measure large workspaces on the deployment database before choosing request and
statement timeouts. API replicas share PostgreSQL authorization, request receipts,
rate limits, and cleanup leases. Size their combined connection pools to the
database budget.

Run the focused service, HTTP, lifecycle, purge, and concurrency suites with a
disposable PostgreSQL database:

```sh
TEST_DATABASE_URL=postgresql://... node --require ./tests/test-environment.cjs --import tsx --test --test-concurrency=1 tests/workspaces.test.ts tests/workspace-http.test.ts tests/workspace-lifecycle.test.ts tests/workspace-purge.test.ts tests/workspace-concurrency.test.ts
npx playwright test e2e/workspaces.spec.ts
E2E_BROWSER=webkit npx playwright test e2e/workspaces.spec.ts
```

The concurrency suite needs PostgreSQL; the remaining integration tests also run
on isolated PGlite instances. Browser tests use disposable local fixtures and
fake authentication adapters. They do not modify real workspaces or send emails.

Run `scripts/workspace-performance.ts` with the same test environment and a
disposable loopback PostgreSQL database named with `test` or `audit`. It seeds a
temporary schema with 10,000 workspaces, measures 50/100 memberships over
20 samples, checks indexed query plans, and removes the schema afterward. Its
report is written to `.local/workspace-performance.json`. The local PostgreSQL
17 verification measured session p95 at 1.58/1.46 ms, profile-read p95 at
3.38/2.68 ms, and creation p95 at 8.65/10.25 ms. Twenty concurrent mixed reads
completed without errors. These measure service/SQL work and exclude HTTP,
browser rendering, remote database latency, and production traffic.
