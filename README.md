# LedgerBook

LedgerBook is a multi-tenant customer receivables application built with **NestJS, React, TypeScript, and PostgreSQL**. It is a modular monolith: one API, one database, and a React application. Clerk manages sign-in, invitation delivery, passwords, and password recovery. Application memberships and financial records stay in PostgreSQL.

An organization administrator can create customer accounts, invite customers, post charges and payments, reverse mistakes, and export statements. Customers can sign in only after an organization invitation and can read only their own account. A login identity can have memberships in multiple organizations.

Administrators can create, rename, customize, and permanently delete workspaces.
Use **Workspaces** in the sidebar to switch or create, and **Settings → Workspace
details** to edit the name, description, and color. Permanent deletion requires
the exact workspace name and preserves other workspaces and sign-in identities.
See [workspace behavior, deletion, and deployment](docs/workspaces.md).

Administrators can use **Companies**, just above Settings in the sidebar, for a
grid of **Muhabiya Hotels**, **Aden Golden**, and **Al Subaee**. Open a card to
add or edit its customer records: hotel details, customer name, dates, room type,
voucher, room quantity, and remarks. **Add Voucher** records the full voucher
total; quantity is informational. Each company has one separate paid amount,
with voucher totals, unpaid and balance calculated across all its vouchers. Search within each company or filter by
booking date, check-in, or check-out. These records
do not create bookings, customer accounts, payments, or ledger entries. See
[Companies fields and API](docs/companies.md).

The sign-in, invitation and recovery screens use Umrah Packages UK branding with
light and dark logo variants. Gold is the default appearance; existing saved
color choices are preserved. Use **Customize** on the sign-in screen or
**Settings → Appearance** to choose a color and light, dark or system mode.
Appearance preferences are saved on the current browser and device.

## Local setup

### Clerk and a local database

Install Node.js 22.14 or newer (Node.js 24 LTS is recommended), then install the locked dependencies:

```sh
npm ci
```

Use a Clerk **development instance** with email/password sign-in enabled. Copy `.env.example` to the private `.env` if it does not exist, and set `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` from the same instance. Keep `AUTH_PROVIDER=clerk`. Clerk sends invitations and recovery codes to real inboxes. Booking payment notifications use the separate email adapter described below.

In Clerk's **User model → User permissions**, disable **Allow users to delete their account** and apply the setting to existing users. Administrators manage removal through LedgerBook so account deletion cannot bypass the last-administrator protection. Enable email verification and password authentication. Enable first/last name fields as optional. In **User & authentication → Password → Update password requirements**, set the minimum password length to **8** (Clerk’s lowest supported value), disable minimum-strength enforcement and compromised-password rejection, and leave lowercase, uppercase, number, and special-character rules off. This length-only policy matches invitation acceptance, password reset, account password changes, and legacy local provisioning. Sign-in accepts existing passwords without applying new-password rules. Clerk does not support the requested 6-character minimum; changing only the form cannot lower its server-side limit. Production deployments should configure Clerk's production domain and protections for that environment.

Set the local browser origin and port together in `.env`, for example:

```dotenv
PORT=3001
PUBLIC_APP_URL=http://localhost:3001
```

Run `npm run local` (or the platform launcher) to build React and start the app with a persistent PGlite database in `.local/database`. No separate PostgreSQL server or Docker is needed. The app listens only on `127.0.0.1`; `PORT` defaults to 3000, and `--port 3001` overrides it. The local runner loads `.env` and uses `--public-url`, then `PUBLIC_APP_URL`, then the local port's `http://localhost` origin, in that order. Open the configured browser origin consistently; changing only the port does not change an explicitly configured `PUBLIC_APP_URL`. Local mode refuses production configuration.

Keep the foreground launcher terminal open. For background operation, run:

```sh
npm run local:start
npm run local:status
npm run local:stop
```

`npm start` and `pnpm start` also run the local launcher; `pnpm stop` and `pnpm status` manage it. Background logs are in `.local/local.log`. Restart after source changes so the React build is refreshed. Accounts and ledger data survive restarts. Stop before backing up the database or provisioning an administrator; two processes cannot open it together.

For local payment/reminder testing without sending customer email, start with
`npm run local:start -- --file-email`. This saves application emails privately in
`.local/mail` for that run and leaves the saved email configuration unchanged.
Stop an already-running instance before switching this launch option.

Create the first administrator in the Clerk dashboard with an email address you control, then provision its application membership. Stop LedgerBook before opening its local database with this command:

```sh
npm run admin:create -- --local --clerk-user-id user_YOUR_CLERK_ID --email owner@example.com --name "Your Business" --currency GBP
```

The command verifies the Clerk user's primary email and requires it to match `--email`. It neither chooses nor changes the user's password. To add that administrator to an existing organization while preserving its data, also pass `--organization-id YOUR_ORGANIZATION_UUID`. Repeating provisioning reuses an active administrator membership. Disabled/deleted memberships are not silently restored. Sign in through Clerk after restarting the app. New travel workspaces should use GBP. Existing organizations keep their accounting currency and financial history; provisioning does not convert their balances.

### Booking, payment and reminder email on localhost

Clerk handles invitations and password recovery. Booking confirmations (with PDF invoices), payment notifications and enabled reminders use the application's email adapter. The local launcher writes these messages to private `.eml` files in `.local/mail` by default; they are **not delivered to real inboxes**.

To enable real inbox delivery from localhost, create the private, gitignored `.local/email.env` with exactly these three settings, using a verified Resend sender and key:

```dotenv
EMAIL_MODE=resend
EMAIL_FROM="Umrah Packages Ltd <your-verified-sender@example.com>"
RESEND_API_KEY=your-resend-api-key
```

Restart the app after changing the file. An invalid or incomplete file stops startup. Remove the file, or replace its contents with only `EMAIL_MODE=file`, to restore local email files. The local launcher deliberately ignores `.env` email delivery settings; `.local/email.env` controls application email delivery and does not change Clerk, the database, or the browser origin. Server deployments instead use `EMAIL_MODE`, `EMAIL_FROM`, and `RESEND_API_KEY` from their deployment environment. See [payment receipts and delivery operations](docs/payment-receipts.md) for outbox retries and status checks.

Keep `PUBLIC_APP_URL=http://localhost:3001` and `PORT=3001` in `.env` when that is where you open the app. Outbound Resend email does not need a tunnel; its links point to this configured browser origin. Open localhost links on the same computer running LedgerBook. Clerk development invitations also support a [localhost redirect with its port](https://clerk.com/docs/guides/users/inviting).

Send one diagnostic email to an inbox you control without creating customer or booking records:

```sh
npm run email:test -- --to you@example.com
```

This command uses `.local/email.env`, requires real delivery mode, and prints the provider message ID after acceptance. Check the actual inbox and Spam folder to confirm arrival. If the launcher uses `--public-url`, pass the same override to `email:test`. The split `dev:api`/`dev:web` workflow also reads `.local/email.env`; set `PUBLIC_APP_URL=http://localhost:5173` for its browser origin. When the private email file is absent, `dev:api` retains the email settings from `.env`. Restart either API launcher after changing email settings. Invitations and recovery use the configured Clerk instance in both workflows.

A public HTTPS tunnel is needed for Resend to call the local delivery-status webhook, or to open app links on another device. It is not required to send email from localhost. Without a local webhook, the local outbox reports **Accepted**; inspect delivery in Resend and the recipient's inbox. Do not point the production webhook at a temporary dev tunnel.

### Email testing through Cloudflare Tunnel

Start a tunnel to the port used by LedgerBook:

```sh
cloudflared tunnel --url http://127.0.0.1:3001
```

Set `PORT=3001` and `PUBLIC_APP_URL=https://YOUR-TUNNEL.trycloudflare.com` in `.env`, then start or restart `npm run local`. Open the **tunnel URL** consistently for the browser test. Clerk invitations use this HTTPS origin and return to the app's invitation page, which identifies the invited name/email and asks a new user to choose a password. A returning user signs in with the invited email before joining. Recovery uses Clerk's emailed code and returns the user to the app after setting a new password.

Keep both app and tunnel running while following email links. A temporary Cloudflare URL changes when the tunnel is recreated, so update `PUBLIC_APP_URL`, restart the app, and resend invitations after a change. Configure any Clerk redirect-origin restrictions to allow the testing origin. These checks use the real Clerk instance and real email delivery; use test recipients you control.

Development emails come from `@accounts.dev` and can land in Spam. Clerk limits development instances to 100 Clerk-delivered emails per calendar month, with exceptions including paid apps. After the limit, OTP requests fail and other notifications may produce a webhook without sending an email. Use a real address without `+clerk_test` to test inbox delivery; Clerk does not send mail to that reserved test subaddress. See [Clerk's development email limits](https://clerk.com/docs/guides/development/testing/test-emails-and-phones). For a missing message, inspect the recipient's Spam folder and [Clerk Email Logs](https://clerk.com/docs/guides/dashboard/logs/email-logs) before retrying; each resend invalidates older invitation links.

Startup checks verify the served React sign-in page, database readiness, Clerk configuration, and anonymous API protection. Full email delivery and password flows require the browser/inbox checks described under Verification. The local startup checks do not create provider users or authenticate as an administrator.

The retained `AUTH_PROVIDER=local` backend exists for isolated regression tests and maintenance of legacy accounts. The browser interface requires Clerk. Legacy backend provisioning can write generated credentials to `.local/admin-login.txt`. Legacy invitation/recovery messages use the same email adapter as payment notifications; in file mode they are private `.eml` files and are not delivered to an inbox. Clerk does not use these legacy credentials or messages. Keep `.env` and the whole `.local` directory private.

### PostgreSQL development and deployment setup

Requirements: Node.js 22.14 or newer, npm, and PostgreSQL 15 or newer. Node.js 24 LTS is recommended. Docker is optional.

```sh
npm ci
```

Copy `.env.example` to `.env` if it does not exist, and configure the Clerk instance as above. For the supplied local PostgreSQL container, run `docker compose up -d db`; otherwise configure `DATABASE_URL` for your own empty PostgreSQL database. Then run:

```sh
npm run db:migrate
npm run admin:create -- --clerk-user-id user_YOUR_CLERK_ID --name "Your Business" --email owner@example.com --currency GBP
```

The bootstrap command verifies an existing Clerk identity and creates its initial organization and administrator membership. Use `--organization-id` to join an existing organization. Run this privileged command only through an authorized deployment/operations session. Public sign-up does not grant an application membership. In explicit `AUTH_PROVIDER=local` mode only, the command prompts for a hidden password or reads `--password-stdin`.

For this split-server workflow, set `PORT=3000` and `PUBLIC_APP_URL=http://localhost:5173` in `.env` first; the browser runs on Vite's port while `/api` is proxied to NestJS. Run these commands in separate terminals:

```sh
npm run dev:api
npm run dev:web
```

Open `http://localhost:5173`. Vite proxies `/api` to the NestJS server on port 3000. Use the hostname configured in `PUBLIC_APP_URL` consistently: `localhost` and `127.0.0.1` are different origins.

For optional local data after creating an administrator, set `ALLOW_DEV_SEED=true`, `NODE_ENV=development`, and `EMAIL_MODE=file`, then use the IDs printed by the bootstrap command:

```sh
npm run seed -- --organization-id YOUR_ORGANIZATION_UUID --admin-email owner@example.com
```

Seeding requires a database on a local host and is disabled otherwise. It adds fictitious customer accounts and ledger entries to the existing organization. It creates no login identities, passwords, or invitations, and does not install production credentials or create a bypass around authentication. Use a separate customer account with an email address you control to test invitation onboarding.

## Configuration

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | `development`, `test`, or `production`. Production requires Clerk, HTTPS, and explicit database configuration. |
| `PORT` | API port; default `3000`. |
| `PUBLIC_APP_URL` | Exact browser origin, without a trailing slash. HTTPS is mandatory in production. Used for email links and CSRF checks. |
| `DATABASE_URL` | PostgreSQL connection string. Never commit a production connection string. |
| `DATABASE_SSL` | Set to `true` when database transport requires certificate-verified TLS. Production database connections always verify TLS. |
| `DATABASE_MIGRATION_URL` | Optional direct PostgreSQL connection for migrations; defaults to `DATABASE_URL`. |
| `DATABASE_SSL_CA_FILE` | Optional private CA certificate path for database TLS verification. |
| `DATABASE_POOL_SIZE` | Connections per API process; default `10`. Budget the total across all instances. |
| `AUTH_PROVIDER` | `clerk` by default. `local` enables the legacy backend for isolated tests/maintenance; the browser UI requires Clerk. |
| `CLERK_PUBLISHABLE_KEY` | Browser-safe key for the configured Clerk instance. Served by `/api/auth/config`; no rebuild is needed when it changes. |
| `CLERK_SECRET_KEY` | Server-only key for the same Clerk instance. Never expose it to the browser or commit it. |
| `EMAIL_MODE` | Payment notifications and legacy authentication email: `file` writes private messages; `resend` sends through Resend. The local launcher uses `.local/email.env`. |
| `EMAIL_FROM` | Verified email sender address. |
| `MAIL_DIRECTORY` | Private, gitignored development email directory; default `.local/mail`. |
| `RESEND_API_KEY` | Resend API key authorized to send from the verified sender. |
| `SESSION_TTL_SECONDS` | Absolute session lifetime; default 12 hours. |
| `INVITATION_TTL_HOURS` | Invitation lifetime; default 72 hours. |
| `TRUST_PROXY_HOPS` | Known reverse-proxy hop count. Leave `0` unless the deployment topology is controlled. |
| `DOCUMENT_STORAGE` | `r2` enables private Cloudflare R2 and direct browser uploads; `database` is available for offline tests; `s3` retains legacy AWS support. Set `r2` explicitly for both cloud environments. |
| `STORAGE_ENVIRONMENT` | `development` or `production`; must agree with `NODE_ENV` and the bucket's environment suffix. |
| `R2_ACCOUNT_ID`, `R2_DOCUMENT_BUCKET` | Cloudflare account and private environment-specific bucket. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Server-only Object Read & Write credentials scoped to that environment's bucket. Never expose in browser configuration. |
| `REDIS_URL` | Optional shared exchange-rate cache; the local launcher works without it. |
| `EXCHANGE_RATE_URL` | Reference-rate provider endpoint; defaults to Frankfurter's v2 rates API. |
| `EXCHANGE_RATE_TTL_SECONDS` | Fresh rate cache lifetime; default one hour. |
| `EXCHANGE_RATE_MAX_AGE_SECONDS` | Maximum age for durable fallback rates; default seven days. |
| `BUSINESS_TIME_ZONE` | IANA time zone for dashboard dates, instalments, and departures; default `UTC`. |
| `TEST_DATABASE_URL` | Optional disposable PostgreSQL test database. Tests create and remove isolated schemas. |

Clerk manages invitation and recovery delivery. Payment notifications use Resend or private local files independently of the authentication provider. The retained `AUTH_PROVIDER=local` backend also uses that adapter for invitation and recovery messages. File-mode messages are not sent to an inbox or printed to logs; legacy authentication files contain bearer secrets. Keep `.env`, `.local/email.env`, and the whole `.local` directory private. Production authentication requires Clerk, and production payment notification delivery requires a verified Resend sender.

## Application behavior

- Customers can submit one to five receipt images inside a booking. Administrators review them under **Payment reviews** or in the booking itself. Submissions stay pending until approval; approval posts one ledger payment and queues the customer's confirmation email. Admins receive an email when a customer submits receipts. See [payment receipts and delivery operations](docs/payment-receipts.md) for upload limits, migrations, security, and retry behavior.
- Administrator-created bookings generate a PDF invoice and queue it with the booking confirmation. Approved payments, reversals, amendments and cancellations preserve new invoice versions; customers and administrators can download the full history, including for cancelled bookings. See [booking invoices](docs/invoices.md) for accounting rules, the replaceable generic template and deployment requirements.

- A **positive** balance means the customer owes the business. A **negative** balance means the customer has credit. The dashboard reports debt and credits separately.
- Each organization has one currency and its minor-unit precision. Amounts are parsed from decimal strings into integers; JavaScript floating-point arithmetic is never used for ledger money. API money values and ledger IDs are strings.
- Opening balances are auditable ledger entries. An opening entry must be the first posted entry for that customer. Use a charge/payment after reversing an incorrect opening balance.
- Individual posted entries cannot be edited or deleted. Reversals negate an original entry exactly once and retain its link. A replacement is a separate charge/payment. Reversals cannot be backdated before their original entry. The explicit permanent account deletion described below removes that customer's entire ledger.
- Running balances use effective date followed by the database-generated entry ID. Backdated entries recalculate subsequent running balances. Date/search filters do not discard earlier movements when calculating running balances.
- Statement opening and closing figures refer to date boundaries; text search selects displayed entries, without changing the account's actual balance.
- Customer accounts exist independently from login identities. Account email is immutable to avoid reassigning financial records to a different person. Archive an account to retain its history, or permanently delete it before creating a replacement when the old account and its records should be removed.
- Customer display IDs use `UK44001`, `UK44002`, and so on, with a three-digit minimum suffix that expands after 999. Migration `022_uk44_customer_codes.sql` renumbers retained customers by creation date and resumes the global sequence afterward. Customer UUIDs and their booking/payment relationships remain intact; issued invoice snapshots retain their original historical references.
- Changing a verified primary email in Clerk keeps the same user and existing ledger access. The customer record's original email and membership remain fixed. A different person cannot inherit that access merely by registering the old email. If a mailbox is released before its former identity signs in with the new primary email, the app reports an identity conflict; the former user must sign in once or an administrator must reconcile the account. It never silently transfers the previous user's access.
- Archiving prevents new ledger entries while retaining history and existing read access. Disabling access immediately makes the membership inactive and keeps the account available to re-enable.
- **Permanent customer account deletion** requires an administrator to type the account's email address. It removes the selected business's customer profile/contact details/notes, ledger entries and reversals, bookings, instalments, document records and database-stored bytes, payment submissions and receipts, associated queued emails, invitations, memberships, and related audit records. Private S3 bytes are queued for removal by storage cleanup after a 24-hour grace period. Pending invitations and archived accounts can also be deleted. The same email can then receive a fresh invitation for a new account with an empty ledger; previous account IDs and invitation links no longer grant access.
- **Administrator deletion** removes that administrator's access and identifying attribution in the selected business. Other customers' accounts, transactions, bookings, documents, payment reviews, and manual exchange rates remain; their former administrator attribution is cleared. Self-deletion and removal of the last active administrator are blocked. Shared Clerk identities and another business's records are preserved when that identity is still needed there.
- Resending invalidates every previous outstanding invitation. New customers prove access to the invited mailbox through the one-time link and choose their own password. Existing users sign in with the matching email before accepting; their password is not changed.
- If invitation delivery fails, the customer and invitation state remain available and the admin can retry. Retry generates a new invitation, so any earlier link becomes invalid.
- Email status `sent` means Clerk accepted the invitation, or in legacy mode the local email file was written/the provider accepted the send request. It is not proof of inbox delivery; bounce tracking and delivery webhooks are outside this initial implementation.
- CSV exports quote cells and neutralize spreadsheet formula prefixes in user-authored fields. Exports are limited to 10,000 matching entries; narrow the date range for larger accounts.

## Structure

```text
apps/api/src/
  access/           Authenticated organization and customer access checks
  auth/             Clerk identity verification, legacy auth, rate limiting
  bookings/         Travel bookings, instalments, and PostgreSQL/S3 documents
  currency/         Reference rates and display conversion
  customers/        Customer account use cases
  companies/        Standalone company table and date filters
  dashboard/        Travel overview, dates, and activity
  database/         PostgreSQL adapter and versioned SQL migrations
  invitations/      Invitation state and customer access lifecycle
  users/            Administrator user list, disable/enable, and deletion
  ledger/           Money rules, entries, balances, statements, CSV
  notifications/    Resend and development email adapter
  payments/         Payment receipt submission, review, and email outbox
apps/web/src/       React pages, forms, API client, responsive styles
scripts/            Migration, bootstrap, development seed, cleanup
tests/              Service and HTTP integration tests
```

Tenant IDs select a membership; they never confer access by themselves. Every protected operation resolves the authenticated user's active membership, and mutations recheck membership inside their database transaction. Composite foreign keys and triggers additionally prevent cross-tenant associations and ordinary modification of posted financial/audit history. Permanent deletion uses a separately authorized operation limited to the selected account and business. See [the security and operations notes](docs/security.md).

## Verification

See [the recorded foundation verification results](docs/verification.md) for completed checks and environment limitations.

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

Repeatable browser workflows are also available:

```sh
npx playwright install chromium webkit
npm run test:e2e
E2E_BROWSER=webkit npm run test:e2e
```

These tests exercise the React interface and real HTTP API with disposable data,
private file email, and database-backed documents. They cover customer edits and
deletion, bookings, folder/file operations, receipt approval/rejection, ledger
reversals, directory search, themes, and mobile layouts. Set `TEST_DATABASE_URL`
to a disposable loopback PostgreSQL database to include real multi-connection
behavior; otherwise they use PGlite. Ports 4311 and 4312 must be free. Reports and
failure traces are saved under `.local/e2e/`. A Clerk UI adapter is resolved only
by this test server; live Clerk sign-in, cloud storage, and inbox delivery need
separate checks. CI runs Chromium and WebKit against its PostgreSQL service,
audits dependencies, and builds the production container.

See [the implemented launch improvements](docs/implementation-verification-2026-11-09.md)
for booking editing/cancellation, document versions, reminders, verification and
performance measurements, and [deployment and recovery](docs/deployment.md) for
the production image, preflight, monitoring and verified backups.
The [original audit](docs/launch-verification-2026-11-09.md) preserves baseline results.

The test runner forces the isolated local authentication provider and clears delivery credentials so `.env` cannot send test emails or modify the configured Clerk instance. Clerk gateway integration tests exercise provider outcomes with controlled test doubles; live browser/email checks establish actual provider behavior.

By default integration tests execute migrations and SQL against PGlite, a local PostgreSQL engine, with a fresh database per suite. They exercise foreign keys, constraints, triggers, service behavior, and HTTP authorization without Docker. PGlite uses one connection, and its test adapter serializes transactions. This verifies repeated/concurrent service submissions deterministically, but **does not prove PostgreSQL multi-connection locking behavior**.

The HTTP tests start a temporary local API server. If a development execution sandbox explicitly denies loopback networking (`EACCES` or `EPERM`), they report the restriction and exercise the same Nest/Express middleware using native in-process HTTP request/response objects. No endpoint assertions are skipped. TCP transport remains unverified in that mode. CI and `TEST_DATABASE_URL` runs require the real loopback path and fail if networking is denied.

For production database behavior, set `TEST_DATABASE_URL` to a disposable PostgreSQL database and run `npm test` again. Each suite uses an isolated schema and removes it afterward. The test role must be allowed to create and drop schemas. Never point tests at a database containing live customer data. Production release checks should include this PostgreSQL run, email smoke tests, and a browser check on the deployment's HTTPS origin.

## Production build and operations

```sh
npm run build
npm run db:migrate
npm run start:api
```

Set production variables through the deployment's secret store. Serve the React build and API on the configured origin behind an HTTPS reverse proxy. Do not use Vite's development server in production. Run migrations as a controlled deployment step before serving traffic; a failed migration must stop the deployment. The migration runner records applied versions.

Configure a [Clerk production instance](https://clerk.com/docs/guides/development/deployment/production) on a domain you own and verify the DNS records shown in Clerk's Domains page. Production email uses that domain with SPF/DKIM authentication; add DMARC and a working mailbox for each active template's sender address. Keep Clerk delivery enabled for invitation and recovery templates. Domain authentication improves deliverability but cannot guarantee Inbox placement: recipient filtering and domain reputation still matter. See [Clerk's email guidance](https://clerk.com/docs/guides/development/troubleshooting/email-deliverability) and [new-domain reputation guidance](https://clerk.com/docs/guides/development/troubleshooting/email-domain-name-warmup).

Use a dedicated PostgreSQL role with only required runtime privileges, a separate migration role where practical, managed backups, and tested restores. Do not grant the application role superuser privileges or permission to disable triggers. Schedule `npm run db:cleanup` to remove expired session/recovery/rate-limit records. Preserve ledger, customer, and audit records according to the business's retention policy.

For R2 deployments, use separate development and production buckets, credentials and exact-origin CORS rules; see [booking document storage](docs/file-storage.md). The API runs storage cleanup automatically; `npm run storage:cleanup` is also available with the matching database and bucket configuration. Deletion immediately removes application access, while a private removal journal retains object coordinates until cloud deletion succeeds. Cleanup waits 24 hours to avoid racing uploads already in progress and retains failed removals for the next run.

Payment notification intents are stored in the durable database outbox and retried by the application worker. Configure `EMAIL_MODE=resend`, `EMAIL_FROM`, and `RESEND_API_KEY` for production delivery, and monitor the payment-email status endpoint for a backlog. In explicit legacy authentication mode, password recovery email is dispatched asynchronously in the API process without a persistent recovery queue; graceful shutdown waits for pending work, but abrupt termination may require the user to request another link.

Out of scope: invoicing, inventory, payment collection, subscriptions, taxes, and full double-entry accounting. This code supplies a receivables foundation; deploying it still requires your database, Clerk configuration, TLS, monitoring, backup policy, and an end-to-end deployment smoke test.

## Currencies and exchange rates

Travel dashboards, customer records, statements and CSV exports display GBP. New bookings and the travel transaction form require a GBP accounting workspace. Existing non-GBP history is preserved and displayed using the existing GBP rate; unavailable conversion is shown explicitly. Settings retains administrator-managed reference rates. Currency APIs and stored preferences remain compatible, but travel ledger screens use GBP regardless of the saved preference. Other open currency views refresh on focus and every minute.

Amounts remain stored and entered in the workspace's accounting currency. Changing display currency or a rate does not rewrite posted transactions. Converted values use current reference rates, not historical settlement rates. CSV exports include accounting amounts and rate provenance when converted. Integer arithmetic preserves precision and rounds half away from zero to the target currency's accounting precision.

Automatic rates come from [Frankfurter's daily reference-rate API](https://frankfurter.dev/), without an API key. The server caches snapshots for one hour, retains a durable database fallback for up to seven days, and labels stale rates during provider failures. Observations older than seven days become unavailable. Manual rates remain in effect until an administrator removes them. No invented fallback rates are used.

For Redis, start `docker compose up -d redis` and set `REDIS_URL=redis://127.0.0.1:6379` in the API environment. Redis has bounded connection/command timeouts and falls back to the database cache if unavailable. The local launcher works without Redis; to enable it for that launcher, set `REDIS_URL` in `.env` or the shell environment before starting it. Production migrations must run before starting the updated API; the local launcher applies them on startup.

See [currency API and cache behavior](docs/currencies.md) for endpoints, configuration and verification.

## Customer travel workspace

The overview connects Customer Data, the combined Customer Ledger, booking creation,
payment entry, instalment attention, departures and dated activity. Each booking has
its own six service folders and authenticated file storage for all file types up to 10 MB each. Existing explorer styling
and controls are retained. Local file bytes, associations and upload audit events
commit together in PostgreSQL. Production can keep new document bytes in private
AWS S3 with metadata and audit in PostgreSQL. Drag-and-drop uploads show per-file
progress, safe retries and a compact success toast. See
[file storage](docs/file-storage.md) and [hosted PostgreSQL setup](docs/hosted-postgres.md).

Restart the local launcher to apply pending migrations automatically. Server
deployments should run `npm run db:migrate` before starting the new API. Provision new travel workspaces in GBP; existing non-GBP accounts are preserved
and require an agreed accounting migration before new GBP bookings or travel transactions.
`BUSINESS_TIME_ZONE` defaults to UTC and can be set to the agency's IANA time zone.

See [dashboard calculations and filters](docs/customer-dashboard.md),
[booking/document contracts](docs/bookings.md), and
[travel workspace verification](docs/travel-verification.md).

## Local travel demo data

The repeatable fixture creates a separate **LedgerBook Demo — 200 Customers, Aug–Nov 2026**
workspace with 200 fictional customers and booking activity across the rolling three
months August 7–November 6, 2026. It includes family groups, couples and solo travellers,
instalments, paid/partial/unpaid balances, pending and reviewed payments, actual
downloadable flight itineraries, hotel vouchers and service PDFs, and individual
payment screenshot images from three fictional banking interfaces. It uses your
existing provisioned administrator and preserves other workspaces, including the
earlier 50-customer Autumn fixture if already imported.

```sh
npm run local:stop
npm run seed:demo
npm run local:start
```

The importer uses the sole active administrator. If there are several, select the
owner with `npm run seed:demo -- --admin-email owner@example.com`. It does not read
or create login credentials. Use `npm run seed:demo -- --verify` while the app is
stopped to inspect the imported counts and balances without importing again.
Stop the app before importing: the local PGlite database permits one process at a
time. The command only opens this project's `.local/database`; it does not load
production `.env` or Resend credentials. All fixture rows commit atomically, all
database constraints remain enabled, and another run returns the existing data
without resetting later edits. Its report is saved to `.local/demo-seed-report.json`.
Select the demo workspace after signing in through Clerk with that administrator.

No invitations or email notifications are queued during import. Synthetic customer
logins are disabled and their addresses use `example.test`. Documents are visibly
marked **SAMPLE / NOT VALID FOR TRAVEL**; receipt images say **SAMPLE SCREEN / NO MONEY
MOVED**. Routes, flight numbers, hotels, and prices are illustrative fixtures, not
real reservations or current offers. Normal manual actions in the app still use
the configured delivery providers: Clerk for invitations/recovery and the payment email adapter for payment notifications.
