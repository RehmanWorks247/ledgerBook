# LedgerBook

LedgerBook is a multi-tenant customer receivables application built with **NestJS, React, TypeScript, and PostgreSQL**. It is a modular monolith: one API, one database, and a React application. It does not require Redis, a message broker, an authentication SaaS, or microservices.

An organization administrator can create customer accounts, invite customers, post charges and payments, reverse mistakes, and export statements. Customers can sign in only after an organization invitation and can read only their own account. A login identity can have memberships in multiple organizations.

## Local setup

### Run immediately without Docker

Dependencies are installed in this workspace. Run `npm run local`, or double-click `Start-LedgerBook.cmd` on Windows. The command builds React, starts NestJS at **http://localhost:3000**, applies migrations, and uses a persistent local PostgreSQL engine (PGlite). It listens only on `127.0.0.1` and is explicitly blocked in production mode.

**Keep the launcher terminal open while using LedgerBook.** Closing that window stops the server; reopen the launcher before visiting the URL again. If a chat-managed process reports startup success but the browser cannot connect, stop that process and launch `Start-LedgerBook.cmd` directly from File Explorer. Restricted execution environments can block localhost connections or terminate their processes when the session ends. A running process alone does not prove browser connectivity.

The first run creates **LedgerBook Local**, using **PKR**, with email **admin@ledgerbook.local** and a unique randomly generated password. Open `.local/admin-login.txt` for the initial login; the password is never printed to logs. No customer accounts, sample financial transactions, shared demo passwords, or public registration bypasses are installed. The original password is never restored over a password you change.

For a fresh local database, choose different initial details with:

```sh
npm run local -- --name "Your Business" --email owner@example.com --currency GBP
```

Local mode does not load the production `.env`. It uses a fixed same-origin browser URL and local email files. Your database is saved in `.local/database`, and invitation/reset messages are saved in `.local/mail`. Open the latest `.eml` file to use its one-time link on this computer. These messages are **not delivered to real inboxes**. Keep the entire `.local` directory private and out of source archives. Stop the app before backing up its local database files.

From a normal terminal, `npm run local:start` starts it in the background; `npm run local:status` checks its process; `npm run local:stop` shuts it down cleanly. `Stop-LedgerBook.cmd` also stops it. Restricted execution environments may terminate detached child processes; use `npm run local` in a persistent terminal there. Data and accounts survive restarts. Two processes cannot open the same local database concurrently.

Use `npm run local -- --port 3001` if port 3000 is occupied. Add `--verify` to run the nine startup HTTP checks again; these use normal login rate limits. The first successful provisioning runs them automatically. The checks create and revoke a temporary session without adding financial data. If TCP is denied by the execution environment, the checks explicitly report native in-process HTTP verification instead.

This is a local development instance. Continue with the PostgreSQL configuration below for server deployments; PGlite local mode does not replace the production PostgreSQL adapter.

### PostgreSQL development and deployment setup

Requirements: Node.js 22.14 or newer, npm, and PostgreSQL 15 or newer. Node.js 24 LTS is recommended. Docker is optional.

```sh
npm ci
```

Copy `.env.example` to `.env`. For the supplied local PostgreSQL container, run `docker compose up -d db`; otherwise configure `DATABASE_URL` for your own empty PostgreSQL database. Then run:

```sh
npm run db:migrate
npm run admin:create -- --name "Your Business" --email owner@example.com --currency PKR
```

The bootstrap command creates the initial organization and its administrator. It prompts for a new identity's password without displaying it. For automation, `--password-stdin` reads a password from standard input; do not place passwords in command arguments or source control. If the email already has a login identity, the command reuses it without changing its password. Run this privileged command only through an authorized deployment/operations session. There is no public registration endpoint and no built-in demonstration login.

Run these commands in separate terminals:

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
| `NODE_ENV` | `development`, `test`, or `production`. Production enables secure cookies and strict startup configuration. |
| `PORT` | API port; default `3000`. |
| `PUBLIC_APP_URL` | Exact browser origin, without a trailing slash. HTTPS is mandatory in production. Used for email links and CSRF checks. |
| `DATABASE_URL` | PostgreSQL connection string. Never commit a production connection string. |
| `DATABASE_SSL` | Set to `true` when database transport requires certificate-verified TLS. |
| `DATABASE_POOL_SIZE` | Connections per API process; default `10`. Budget the total across all instances. |
| `EMAIL_MODE` | `file` for local development; `resend` for production. |
| `EMAIL_FROM` | Verified email sender address. |
| `MAIL_DIRECTORY` | Private, gitignored development email directory; default `.local/mail`. |
| `RESEND_API_KEY` | Resend API key authorized to send from the verified sender. |
| `SESSION_TTL_SECONDS` | Absolute session lifetime; default 12 hours. |
| `INVITATION_TTL_HOURS` | Invitation lifetime; default 72 hours. |
| `TRUST_PROXY_HOPS` | Known reverse-proxy hop count. Leave `0` unless the deployment topology is controlled. |
| `TEST_DATABASE_URL` | Optional disposable PostgreSQL test database. Tests create and remove isolated schemas. |

Local emails are written to private `.eml` files and are **not** printed to logs. Open the file to obtain an invitation or reset link. These files contain bearer secrets: do not share or commit them. Production email uses Resend's HTTPS API through the focused notification adapter; configure a verified sender and the provider's DNS records, then test invitation and recovery delivery before onboarding users. Replacing the email provider requires changing only that adapter.

## Application behavior

- A **positive** balance means the customer owes the business. A **negative** balance means the customer has credit. The dashboard reports debt and credits separately.
- Each organization has one currency and its minor-unit precision. Amounts are parsed from decimal strings into integers; JavaScript floating-point arithmetic is never used for ledger money. API money values and ledger IDs are strings.
- Opening balances are auditable ledger entries. An opening entry must be the first posted entry for that customer. Use a charge/payment after reversing an incorrect opening balance.
- Posted entries cannot be edited or deleted. Reversals negate an original entry exactly once and retain its link. A replacement is a separate charge/payment. Reversals cannot be backdated before their original entry.
- Running balances use effective date followed by the database-generated entry ID. Backdated entries recalculate subsequent running balances. Date/search filters do not discard earlier movements when calculating running balances.
- Statement opening and closing figures refer to date boundaries; text search selects displayed entries, without changing the account's actual balance.
- Customer accounts exist independently from login identities. Account email is immutable in this foundation to avoid reassigning financial records to a different person. Correct an incorrectly entered email by archiving the unused account and creating a replacement. Do not delete financial history.
- Archiving prevents new ledger entries; it retains history and existing read access. Revoking customer access is a separate action and immediately makes the membership inactive. An admin can issue a fresh invitation to restore access.
- Resending invalidates every previous outstanding invitation. New customers prove access to the invited mailbox through the one-time link and choose their own password. Existing users sign in with the matching email before accepting; their password is not changed.
- If invitation delivery fails, the customer and invitation state remain available and the admin can retry. Retry generates a new invitation, so any earlier link becomes invalid.
- Email status `sent` means the local email file was written or the provider accepted the send request. It is not proof of inbox delivery; bounce tracking and delivery webhooks are outside this initial implementation.
- CSV exports quote cells and neutralize spreadsheet formula prefixes in user-authored fields. Exports are limited to 10,000 matching entries; narrow the date range for larger accounts.

## Structure

```text
apps/api/src/
  access/           Authenticated organization and customer access checks
  auth/             Passwords, sessions, recovery, rate limiting
  customers/        Customer account use cases
  database/         PostgreSQL adapter and versioned SQL migrations
  invitations/      Invitation state and customer access lifecycle
  ledger/           Money rules, entries, balances, statements, CSV
  notifications/    Resend and development email adapter
apps/web/src/       React pages, forms, API client, responsive styles
scripts/            Migration, bootstrap, development seed, cleanup
tests/              Service and HTTP integration tests
```

Tenant IDs select a membership; they never confer access by themselves. Every protected operation resolves the authenticated user's active membership, and mutations recheck membership inside their database transaction. Composite foreign keys and triggers additionally prevent cross-tenant associations and modification of posted financial/audit history. See [the security and operations notes](docs/security.md).

## Verification

See [the recorded foundation verification results](docs/verification.md) for completed checks and environment limitations.

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

By default integration tests execute migrations and SQL against PGlite, a local PostgreSQL engine, with a fresh database per suite. They exercise foreign keys, constraints, triggers, service behavior, and HTTP authorization without Docker. PGlite uses one connection, and its test adapter serializes transactions. This verifies repeated/concurrent service submissions deterministically, but **does not prove PostgreSQL multi-connection locking behavior**.

The HTTP tests start a temporary local API server. If a development execution sandbox explicitly denies loopback networking (`EACCES` or `EPERM`), they report the restriction and exercise the same Nest/Express middleware using native in-process HTTP request/response objects. No endpoint assertions are skipped. TCP transport remains unverified in that mode. CI and `TEST_DATABASE_URL` runs require the real loopback path and fail if networking is denied.

For production database behavior, set `TEST_DATABASE_URL` to a disposable PostgreSQL database and run `npm test` again. Each suite uses an isolated schema and removes it afterward. The test role must be allowed to create and drop schemas. Never point tests at a database containing live customer data. Production release checks should include this PostgreSQL run, email smoke tests, and a browser check on the deployment's HTTPS origin.

## Production build and operations

```sh
npm run build
npm run db:migrate
npm start
```

Set production variables through the deployment's secret store. Serve the React build and API on the configured origin behind an HTTPS reverse proxy. Do not use Vite's development server in production. Run migrations as a controlled deployment step before serving traffic; a failed migration must stop the deployment. The migration runner records applied versions.

Use a dedicated PostgreSQL role with only required runtime privileges, a separate migration role where practical, managed backups, and tested restores. Do not grant the application role superuser privileges or permission to disable triggers. Schedule `npm run db:cleanup` to remove expired session/recovery/rate-limit records. Preserve ledger, customer, and audit records according to the business's retention policy.

Password recovery email is dispatched asynchronously in the API process so the public response does not expose whether an address exists. Graceful shutdown waits for pending work; abrupt termination may lose an in-flight email, and the user can request another link. No persistent background queue is introduced in this initial scope.

Out of scope: invoicing, inventory, payment collection, subscriptions, taxes, currency conversion, and full double-entry accounting. This code supplies a receivables foundation; deploying it still requires your database, email sender, TLS, monitoring, backup policy, and an end-to-end deployment smoke test.
