# Production release and recovery

The repository includes a multistage Docker image, a Caddy HTTPS proxy, a read-only
release preflight, aggregate monitoring, and PostgreSQL backup/restore commands.
The API runs as the non-root `node` user with a read-only filesystem, no Linux
capabilities and a bounded connection pool. The image contains compiled runtime
code and production dependencies; `.env`, `.local`, test data and mail files are
excluded from its build context. No build-time secrets are required.
The image runs the release preflight before starting its HTTP listener. Missing
migrations, test authentication keys or incomplete delivery/storage configuration
fail startup instead of producing a healthy deployment.

`docker build -t ledgerbook:release-audit . && npm run test:release` exercises the
actual non-root production image against disposable PostgreSQL with verified TLS,
a separate restricted runtime role, and the HTTPS proxy. It applies migrations
twice, checks their hashes, serves the React app, rejects anonymous sessions and
runs the aggregate monitor. The fixture network has no Internet route, uses only
fake provider keys, publishes no host ports, and removes its containers,
certificates and data afterward. It requires Docker and OpenSSL.

## Release

1. Provision a stable DNS hostname, a PostgreSQL 15+ database with verified TLS,
   a Clerk production instance, a verified Resend sender and a private production
   document bucket. Configure the signed Resend delivery webhook as described in
   [notification delivery](notifications.md). Copy
   `deploy/production.env.example` to the private `.env.production`, replace its
   placeholders, and restrict it to mode `0600`. The same `PUBLIC_HOST` must be
   the hostname in `PUBLIC_APP_URL`. Point DNS to the server and allow inbound
   TCP 80/443 and optional UDP 443. Keep PostgreSQL private.
2. Build the reviewed source and record the resulting image digest:

   ```sh
   docker compose --env-file .env.production -f compose.production.yaml build
   docker image inspect ledgerbook:release --format '{{.Id}}'
   ```

3. Take a database and corresponding document backup before migration. Run the
   migration once as a release job, using the separate owner connection in
   `DATABASE_MIGRATION_URL`:

   ```sh
   docker compose --env-file .env.production -f compose.production.yaml run --rm --no-deps app node dist/operations/scripts/migrate.js
   ```

   For separate owner/runtime database roles, run `deploy/runtime-grants.sql`
   as the owner after every migration, with `app_schema=public` and
   `app_role=ledgerbook_app` (or the actual names). The runtime role must not own
   the schema. The script deliberately excludes the private account-purge
   authorization context and grants migration history read access only.
4. Validate the release and start it:

   ```sh
   docker compose --env-file .env.production -f compose.production.yaml run --rm --no-deps app node dist/operations/scripts/release-preflight.js
   docker compose --env-file .env.production -f compose.production.yaml up -d --wait
   docker compose --env-file .env.production -f compose.production.yaml exec app node dist/operations/scripts/release-preflight.js --origin
   ```

   Preflight requires production Clerk keys, delivery-webhook configuration,
   writable PostgreSQL, private object storage, exact migration checksums and
   accessible runtime tables. `--origin` verifies HTTPS readiness and anonymous
   session rejection through the deployed origin. It sends no email and creates
   no customer/provider data. It does not prove provider credentials, bucket CORS
   or inbox delivery; use the authenticated release workflow and delivery events
   for those checks. See [document storage verification](file-storage.md).
5. Preserve the previous application image digest. Roll back an application
   image only if it is compatible with the applied schema. For a destructive
   schema/data mistake, restore into a new empty database, verify it, then switch
   application connection settings. Never automatically reverse financial data
   migrations or overwrite the running production database.

Caddy obtains and renews certificates for the configured hostname and overwrites
forwarded client headers. Only the proxy publishes a host port; the application
trusts exactly that single proxy. Do not place another proxy in front without
reviewing this topology and trusted-hop count. Access logging is disabled so
invitation query tokens are not logged. Certificate state lives in named volumes.
See the official [Caddy HTTPS documentation](https://caddyserver.com/docs/automatic-https)
and [Docker build guidance](https://docs.docker.com/build/building/best-practices/).

## Backups and verified restoration

Run these from a checkout with `npm ci`. The commands use environment variables
for PostgreSQL credentials, never command-line URL arguments. Install `pg_dump`
and `pg_restore` matching or newer than the server major version, or set `PG_TOOLS_MODE=docker`
to use the PostgreSQL 17 container tools. Set `PG_TOOLS_IMAGE` when using another
server major. A backup role needs read access to all application tables and
permission to export a snapshot. Backups use the owner/direct connection when
`DATABASE_MIGRATION_URL` is present.
Verified TLS uses the operating system CA store (`sslrootcert=system`, requiring
PostgreSQL client 16+) or the private CA in `DATABASE_SSL_CA_FILE`. It never
downgrades a configured TLS connection to unverified certificate mode.

```sh
mkdir -p .local/backups
PG_TOOLS_MODE=docker npm run db:backup -- .local/backups/pre-release.dump
```

The custom-format archive and adjacent JSON manifest use file mode `0600` and
refuse to overwrite an existing backup. The exported PostgreSQL snapshot gives
the archive and manifest matching table counts and ledger totals, even while
writes continue. The manifest records an archive SHA-256 and the number of cloud
objects. It contains no database credentials. Backups contain private financial
data: store them on encrypted storage, copy them off the application host, define
retention in the hosting platform, and alert if a scheduled backup fails.

Database archives contain database-backed file bytes and the exact current and
historical cloud object references captured in the same database snapshot.
Complete a cloud-document backup with:

```sh
node --env-file=.env.production --import tsx scripts/document-backup.ts backup .local/backups/pre-release.dump .local/backups/pre-release-documents
```

This copies only referenced objects into private files and verifies their sizes
and SHA-256 checksums. Preserve the archive, its manifest and this document
directory together on encrypted storage outside the application host. Complete
the object copy before application cleanup can purge any referenced object; pause
cleanup for long backup operations. A database archive by itself cannot recover
R2/S3 bytes. See [document backup details](file-storage.md).

Create a new empty recovery database, set `RESTORE_DATABASE_URL` privately to its
connection string, and confirm its exact database name:

```sh
PG_TOOLS_MODE=docker npm run db:restore -- .local/backups/pre-release.dump --confirm-empty-database ledgerbook_recovery
node --env-file=.env.production --import tsx scripts/document-backup.ts restore .local/backups/pre-release.dump .local/backups/pre-release-documents --confirm-bucket ledgerbook-production
```

Restore refuses the configured source database, any nonempty target, the wrong
confirmation, or a corrupted archive/manifest. It restores in one transaction
and checks every application table count, ledger sum and referenced object against
the snapshot. It preserves financial integrity triggers. Document restore uses
the original private bucket and keys with create-only writes: identical existing
bytes are accepted, differing existing bytes cause a failure. Confirm the exact
original bucket name; restoration never rewrites database object references. Reapply runtime-role grants,
and verify authenticated downloads and customer
balances before switching traffic. Never start application workers against a
restored database with live email credentials during a drill: queued emails may
be replayed. See [PostgreSQL restore documentation](https://www.postgresql.org/docs/current/app-pgrestore.html).

`tests/database-backup.test.ts`, when `TEST_DATABASE_URL` is set, creates a fresh
database and verifies real custom-archive restoration, booking totals, private
document bytes, immutable ledger protection, target refusal and corruption
detection. The test removes its restored database and archive afterward. It does
not restore the live database or send messages. Its disposable test database role
needs `CREATEDB`; this privilege is not needed by the application runtime role.

## Monitoring and capacity

`/api/health` reports process liveness. `/api/ready` performs a database query;
the Docker healthcheck uses readiness. Run the aggregate check from your existing
operations scheduler or monitoring platform:

```sh
docker compose --env-file .env.production -f compose.production.yaml exec -T app node dist/operations/scripts/release-monitor.js
```

Exit 0 means healthy, 2 means attention (slow readiness, stalled mail queue,
delivery failures/unconfirmed webhooks, or a stale reminder scheduler), and 1
means the check failed. JSON output contains counts and issue codes, without
recipients, message bodies, credentials or document names. Configure the external
monitor to notify only when these checks change to actionable states. Docker
does not restart a merely unhealthy container; connect readiness failure to the
host's alert/recovery policy. No host schedule or notification destination is
installed automatically by these source changes.

The supplied Compose profile runs one API process with a 1 GiB memory bound and
ten database connections. Scale replicas only after measuring on the deployed
database: total API connection pools plus migration/operations connections must
fit its budget. Document uploads stream directly to R2 where configured;
PostgreSQL remains the authority for authorization, financial transactions,
idempotency and background-job leases. Keep database latency, memory, queue age,
provider delivery events and backup age visible in the hosting platform.
