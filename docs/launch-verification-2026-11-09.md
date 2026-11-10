# Launch verification — 9 November 2026

Follow-up: the product and operational gaps below have since been addressed in
[the implementation verification](implementation-verification-2026-11-09.md).
This document preserves the original audit and baseline measurements.

The current working tree was tested, including the existing uncommitted direct-upload changes. Four defects were reproduced and fixed. The supported workflows pass automated checks, but this is not certification of an unseen production deployment or unlimited capacity.

## Final functional results

| Check | Result | Scope |
| --- | --- | --- |
| Backend suite | 216 passed, 0 failed, 0 skipped | Disposable PostgreSQL 17; real transactions, constraints, locks and loopback HTTP |
| Frontend suite | 64 passed, 0 failed, 0 skipped | Forms, routing, money, themes, invitations, uploads, retries and permissions |
| Chromium browser workflows | 4 passed | Actual React interface and API, isolated local sessions |
| WebKit browser workflows | 4 passed | Same workflows, including 390px mobile layout checks |
| Live Clerk development smoke | Passed | Built frontend, actual password/OTP login, bearer-token verification, navigation, logout and revoked-token rejection |
| Live configured R2 development storage | Passed | Exact-origin CORS, signed upload, checksum-verified download, overwrite prevention, anonymous denial and deletion |
| Storage dependency simulation | Passed | 45 modeled storage/control requests; retries, corruption and cleanup failures |
| Resend dependency simulation | Passed | HTTP 500, retry, idempotent replay; one modeled accepted email |
| Actual local email delivery | Passed | Three expected messages delivered once, correct content/private permissions, tenant-scoped outbox status |
| Lint, TypeScript, production build | Passed | Includes the new browser harness |
| Runtime dependency audit | 0 vulnerabilities reported | `npm audit --omit=dev`, on this date |
| Migration application and replay | Passed | Disposable PostgreSQL database |

The existing baseline also passed 206 backend and 62 frontend tests on PGlite. Changed currency/dashboard semantics were checked on both PGlite and PostgreSQL. The default `npm run test:e2e` command also passed all four browser workflows against PGlite after the final changes. PostgreSQL-only concurrency regressions are intentionally skipped without `TEST_DATABASE_URL`; the final PostgreSQL run skipped nothing.

The four browser scenarios cover:

1. Customer creation/invitation, profile edits, archive/reactivation, booking creation, folder creation/rename/recreation, document upload/rename/move/download/delete, persisted data after reload, CSV export and permanent account deletion.
2. Customer receipt submission, administrator approval and rejection, confirmation controls, customer-visible status, correct balance and denial of another customer's statement.
3. Manual charge, immutable ledger correction through reversal, reload and exact resulting balance.
4. Dashboard/directory/ledger/review/access/settings navigation, directory search and empty state, persistent theme choices and mobile overflow checks.

Additional HTTP suites cover invitation acceptance/revocation, disabled/deleted accounts, cross-tenant and role restrictions, CSRF, malformed/oversized uploads, idempotency, storage cleanup, account purge and payment/outbox failure handling. They also cover capabilities that have no corresponding browser control, such as service issuance updates.

## Defects fixed

- **Dashboard query cost:** overdue reminder lookup scanned audit history before limiting results. Attention rows are now limited before lookup, with two targeted indexes. Reporting transactions also disable PostgreSQL JIT locally after profiling showed compilation dominating their latency. Existing ordering, money and reminder semantics remain covered by regression tests.
- **PostgreSQL deadlocks:** payment reads/uploads could acquire organization, customer and membership locks in the opposite order to account disable/deletion. Authorization now uses consistent organization-first locking. Four coordinated real-PostgreSQL races prove account changes complete and stale customer operations receive 404.
- **Folder creation after rename/move:** an idempotency key permanently derived from the old folder name caused a later creation to return the wrong existing folder. Keys now belong to an uncertain creation attempt; successful attempts release the name. Folder imports reuse their confirmed tree. Unit and browser regressions verify the fix.
- **Currency isolation:** concurrent organizations could mutate the same in-flight rate snapshot with their manual overrides. Each response now copies the rate map before applying organization-specific rates. A regression proves another workspace retains the provider's rate.

## Performance evidence

Benchmarks use the real services and PostgreSQL queries on a local Docker PostgreSQL 17 instance. They exclude browser rendering, HTTP, live Clerk calls, storage/email providers and WAN latency. They are bounded samples, not production capacity guarantees.

At 1,002 customers, 5,000 bookings, 10,000 instalments, 25,000 ledger entries and 50,000 audit events, the original dashboard exceeded its 15-second statement timeout. Limiting/indexing reminders reduced the warm median to 341ms before the additional JIT optimization. Customer listing/search took about 11–12ms and a single-customer statement about 5ms in that run.

The final larger fixture used 5,002 customers, 25,000 bookings, 50,000 instalments, 125,000 ledger entries and 250,000 audit events. PostgreSQL 17.11 ran in Docker with 2 CPUs, about 4GB RAM and 256MiB shared memory. Five warm samples followed a cold request:

| Operation | Warm median |
| --- | ---: |
| Customer page | 58ms |
| Customer search | 42ms |
| Customer statement | 5ms |
| Combined ledger | 522ms |
| Combined ledger search | 873ms |
| Dashboard overview | 869ms |

Ten simultaneous dashboards completed with **0 failures**, median **6,302ms**, maximum **6,455ms**. Large concurrent reports remain a capacity constraint; these results do not support calling every workload "super fast."

An earlier run with Docker's default 64MiB shared-memory allocation failed one concurrent request. An instrumented repeat identified PostgreSQL error `53100`: shared memory exhausted. The local Compose database now explicitly requests `shm_size: 256mb`, and the final run used that allocation. Production database memory/concurrency sizing still needs to match the intended workload. Query timeouts were not increased to hide failures. An earlier uninstrumented shared-load failure was retained in the private evidence; its cause cannot be independently attributed.

## Product and deployment limitations

- **Booking details cannot currently be edited or independently deleted.** There is no booking PATCH/DELETE route or browser control. Permanent customer deletion removes all of that customer's bookings.
- **Files have rename, move, download and delete operations, but no content editor or replacement/versioning action.** Content changes require a new upload; document uploads belong inside a booking's service folder or its descendants.
- **Service issuance has an API but no editable browser control.** The booking page displays issuance state.
- **Automatic due-date reminder delivery is not implemented.** The dashboard displays reminder audit history. Payment submission/approval notifications are implemented; rejection reasons are displayed in the app.
- The reusable browser suite substitutes only the Clerk UI boundary and reference-rate source. It uses real local-session authorization, database state and HTTP. The separate live Clerk smoke verifies the configured **development** instance, not production Clerk/DNS configuration.
- Live R2 verification used the configured **development** bucket/origin and a uniquely named synthetic object, removed in `finally`. This does not verify a production bucket's CORS, credentials or capacity.
- Real Resend recipient inbox delivery, bounces and spam placement were not established. Simulations and private local mail verify application behavior, not final delivery.
- No deployed production HTTPS origin, production database sizing/TLS, reverse proxy, monitoring, backup/restore process or production provider configuration was available for full deployment verification. Local production builds and configuration guards passed. No deployment was performed.
- Each authenticated Clerk API request performs two live provider checks. SQL/local-auth timings do not establish production authentication throughput or Clerk rate-limit capacity.
- The frontend build emits an approximately 510kB JavaScript chunk (144kB gzip) and a bundle-size warning. Development-tool dependency audit findings remain; the runtime audit is clean.

## Reproduction and release use

```sh
npm run lint
npm run typecheck
npm run build
# Use only a disposable PostgreSQL database:
TEST_DATABASE_URL=postgresql://.../ledgerbook_test npm test
npx playwright install chromium webkit
TEST_DATABASE_URL=postgresql://.../ledgerbook_test npm run test:e2e
E2E_BROWSER=webkit TEST_DATABASE_URL=postgresql://.../ledgerbook_test npm run test:e2e

# Local-only service/database benchmark, with a test/audit database name:
TEST_DATABASE_URL=postgresql://.../ledger_audit \
  node --require ./tests/test-environment.cjs --import tsx scripts/performance-audit.ts
```

The browser server binds only loopback ports 4311/4312 and refuses production mode, live email/document storage or a remote test database. The test-only Clerk adapter is absent from the production build configuration and was verified absent from the built JavaScript. CI now runs Chromium browser tests after the existing PostgreSQL suite and retains failure artifacts.

Apply all pending migrations through the normal release process, including `011_direct_document_uploads.sql` from the existing storage work and the new `012_dashboard_reminders.sql`, before serving the updated code. For the supplied Docker database, use the updated shared-memory allocation. Existing private configuration and user data were preserved. Changes remain in the working tree.

Private local evidence is under `.local/launch-audit/`, including `final-tests.log`, browser logs, `live-clerk-result.json` and `performance-5000-256mb-shm.json`. Browser reports are under `.local/e2e/`. Synthetic Clerk identities and R2 objects were deleted; temporary API/browser servers and both disposable PostgreSQL containers were stopped. Provider simulations used fake credentials and never sent mail to a real inbox.
