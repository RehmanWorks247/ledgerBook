# Launch limitations implemented — 9 November 2026

This follow-up implements the product and operational gaps identified in the
[original verification](launch-verification-2026-11-09.md). It documents the
working tree, not an already deployed production release.

## Product changes

- **Booking editing and cancellation:** admin controls edit references, departure,
  required services, totals and instalments. Optimistic versions reject competing
  edits; idempotent retries return the original committed result. Amount changes
  post a reversal and replacement charge. Cancellation reverses the active charge,
  retains approved payments as customer credit, rejects pending submissions and
  revokes document access. Financial/audit history stays intact. Queued reminders
  and obsolete payment-review emails are cancelled; delivered history is retained.
- **Document editing and versions:** edit bounded UTF-8 TXT/CSV/JSON/Markdown in
  the application; replace supported binary documents while retaining their ID.
  Prior versions can be downloaded or restored. Stale writes fail safely, including
  R2 direct uploads. Immutable object keys prevent overwriting history. Deleting a
  document/account also journals historical object cleanup. Limits are 10 MiB per
  file, 256 KiB for the text editor, and 100 prior snapshots per document.
- **Service issuance:** admins can mark each service issued or not issued from
  the booking page; customers see its status.
- **Notifications:** per-workspace due/overdue schedules, customer opt-out,
  durable leases/retries, settlement and access rechecks, signed Resend delivery
  events, replay protection, bounce/complaint suppression and a delivery activity
  view. Reminders start disabled. The Settings page controls activation and timing.
  Provider acceptance and mail-server delivery are distinct; neither confirms
  that the recipient has read the message.

See [bookings](bookings.md), [file storage](file-storage.md) and
[notifications](notifications.md) for contracts and operation details.

## Performance and security changes

Reports use a bounded process-local cache and coalesce simultaneous calculations.
Every request rechecks authorization and a database fingerprint. Customer-scoped
revisions invalidate financial/document/customer changes across application
instances; append-only audit counts detect newly committed reminder events.
Time-sensitive results live for at most five seconds in the cache. Results are
copied so one caller cannot mutate another caller's response.

On the same 5,002-customer / 25,000-booking / 50,000-instalment /
125,000-ledger-entry / 250,000-audit-event local PostgreSQL fixture:

| Operation | Warm median |
| --- | ---: |
| Customer page | 59 ms |
| Customer search | 46 ms |
| Customer statement | 5 ms |
| Combined ledger | 29 ms |
| Combined ledger search | 29 ms |
| Dashboard | 33 ms |
| Create booking | 16 ms |
| Edit booking and correct charge | 25 ms |
| Cancel booking and reverse charge | 15 ms |

Ten simultaneous warm dashboards finished with **zero failures**, median
**176 ms**, maximum **191 ms**, compared with the prior maximum of 6,455 ms.
A cold dashboard took 1,051 ms; one sample crossing cache expiry took 1,095 ms.
Ten simultaneous booking creations for the same customer all committed successfully,
median 92 ms and maximum 145 ms, while preserving the customer lock order.
These are service/database measurements, excluding WAN, external identity,
storage and email latency. They establish this bounded workload, not unlimited
production capacity. Raw results are `.local/launch-audit/performance-final-with-writes.json`.

Concurrent requests with the same Clerk token share only their in-flight live
verification. Ten simultaneous requests make two live provider checks instead of
twenty. Completed checks are discarded, so a subsequent revoked session is still
rejected. Unchanged profiles avoid redundant database updates.

Route-level frontend loading reduced the largest JavaScript chunk from about
510 kB to about 348 kB (103 kB gzip), with no bundle-size warning. The minimatch
development dependency was patched and the full dependency audit reports zero
vulnerabilities. API authorization, private files and immutable financial history
remain enforced; production test adapters are excluded from the release build.

## Deployment and recovery

The repository now supplies a non-root production image, a Caddy TLS proxy,
separate migration/runtime database grants, production preflight, aggregate
monitoring, PostgreSQL custom-archive backup and empty-target restore verification.
Cloud file backup copies the exact current and historical objects referenced by
the database snapshot, verifies their checksums, supports resuming incomplete
copies, and restores immutable keys without overwriting existing objects. Restore
validates all local bytes before uploading; conflicting destination bytes cause
failure. Archive, manifests and file copies remain private on disk.
Backup files and their directory entries are flushed before reporting success;
the final durability rerun passed all 12 database/cloud recovery cases.
The default image refuses startup when release preflight fails. Exact migration
checksums, production Clerk keys, delivery webhook configuration, private object
storage and verified database TLS are checked before serving the application.

`npm run test:release` exercises the actual image with PostgreSQL TLS, owner
migrations and replay, restricted runtime privileges, an HTTPS reverse proxy,
readiness, anonymous access rejection and the built React frontend. Its Docker
network has no external route and its provider keys are synthetic. No customer
email is sent. See [deployment and recovery](deployment.md).

## Verification

| Check | Final result |
| --- | --- |
| Complete backend suite with disposable PostgreSQL 17 | 267 passed; zero failures or skips |
| Additional cloud backup/restore suite | 10 passed |
| Frontend suite | 73 passed |
| Chromium workflows | 6 passed; final affected workflows also rechecked |
| WebKit workflows | 6 passed; final affected workflows also rechecked |
| New-feature PGlite compatibility checks | 38 passed |
| Lint, typecheck, web/API and operations builds | Passed |
| Full dependency audit | Zero vulnerabilities |
| Actual production container/TLS/recovery fixture | Passed |
| Live development Clerk frontend/session smoke | Passed; synthetic user removed |

The backend and cloud suites together cover 277 tests; with the frontend suite,
350 automated tests passed. The targeted recovery/webhook run adds independent
confirmation of 16 cases, including byte integrity and concurrent version reads.

The expanded Chromium and WebKit suites each pass six workflows, including all
new editing, versioning, cancellation, issuance and notification settings controls.
The notification browser test also injects a failed preference save and checks
rollback before successfully saving. Independent PostgreSQL regressions exercise
folder repair versus writes, provider sends versus settlement/deletion, concurrent
settings edits, early delivery webhooks and administrator anonymization.

The updated production frontend also passed live **development Clerk** login,
session validation, navigation, logout and immediate revoked-token rejection.
The synthetic identity was deleted afterward. Resend and storage failure cases
use real HTTP simulators; these establish client behavior, retries and cleanup,
not real inbox delivery.

Private evidence is under `.local/launch-audit/`: `final-implementation-tests.log`,
`final-recovery-and-webhook-tests.log`, `implementation-chromium.log`,
`implementation-webkit.log`, `final-chromium-regressions.log`,
`final-webkit-regressions.log`, `implementation-live-clerk-result.json`,
`final-dependencies.json`, `final-backup-durability-tests.log`,
`final-image-build.log`, `final-release-smoke.log` and the performance JSON named above. CI now repeats
both browser engines, dependency auditing, image build and the production TLS
fixture after its PostgreSQL suite. Provider simulations leave no synthetic cloud
objects behind and do not deliver customer mail.

## External launch configuration still required

No production deployment, GitHub deployment environment, production domain or
complete production database/Clerk/Resend configuration was present. Existing
private settings were preserved. Production DNS/TLS issuance, real provider
credentials, sender-domain verification, webhook registration and recipient inbox
placement cannot be established with invented settings. The deployment template,
startup guards and verification commands are ready for that environment.

The existing local application was stopped cleanly, exported to the private
`.local/backups/pre-launch-improvements-2026-11-09.sql`, migrated and restarted at
`http://localhost:3001`. Readiness, the built frontend and anonymous rejection pass.
Existing accounts, financial records and provider configuration were retained.

Automatic reminders remain opt-in. Production scheduling, off-host backup
retention and external alert routing must be activated in the chosen hosting
platform. No production deployment, customer mail, commit or push was performed.
