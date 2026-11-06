# Hosted PostgreSQL and local data export

LedgerBook already persists customer records, bookings, folders, document metadata,
ledger entries and audit history in PostgreSQL. The desktop launcher uses PGlite
for offline development. The server uses `pg` and accepts a standard PostgreSQL
connection URL; no provider-specific database SDK or authentication migration is
needed.

For this application, Neon is a focused choice for hosted PostgreSQL alongside
private S3 document storage. Supabase PostgreSQL also works with this adapter.
Supabase does not require adopting its authentication service; it supports Clerk
as a third-party provider. This change leaves the checkout's existing authentication
implementation alone. [Supabase Clerk documentation](https://supabase.com/docs/guides/auth/third-party/clerk)

## Connection setup

Set secrets in the deployment environment, not in source control:

```dotenv
# Runtime URL from the provider's connection panel.
DATABASE_URL=postgresql://APP_ROLE:PASSWORD@POOLED_HOST/DATABASE?sslmode=verify-full
# Direct URL, using a migration role with schema privileges.
DATABASE_MIGRATION_URL=postgresql://MIGRATION_ROLE:PASSWORD@DIRECT_HOST/DATABASE?sslmode=verify-full
DATABASE_SSL=true
DATABASE_POOL_SIZE=10
# Optional: the provider's root CA when it is not trusted by Node's default CA set.
# DATABASE_SSL_CA_FILE=/run/secrets/database-ca.pem
```

Use Neon's pooled hostname for concurrent application connections and its direct
hostname for migrations and backup/restore. Its pooler uses transaction pooling;
the application keeps each transaction on one checked-out client. The server
does not use session-level locks or named prepared statements for business queries.
Keep the API and database in nearby regions. For consistently low first-request
latency, disable compute suspension where the selected plan permits it.
[Neon pooling](https://neon.com/docs/connect/connection-pooling),
[Neon production guidance](https://neon.com/blog/6-best-practices-for-running-neon-in-production)

Supabase provides direct and pooled PostgreSQL connections too. Its direct host
may require IPv6; choose the supported session-pooler option when the deployment
network requires IPv4, and use the provider's supported direct/session endpoint
for migrations. [Supabase connection documentation](https://supabase.com/docs/guides/database/connecting-to-postgres)

`DATABASE_MIGRATION_URL` is used only by `npm run db:migrate`; omit it to use
`DATABASE_URL`. An explicitly empty migration URL is rejected. Production always
uses certificate-verified TLS. URL modes `require`, `prefer` and `verify-ca` are
deliberately strengthened to verify the server certificate and hostname; `no-verify`
is rejected. Production or `DATABASE_SSL=true` combined with `sslmode=disable`
fails configuration. For local PostgreSQL without TLS, use development mode with
`DATABASE_SSL=false` and no TLS URL parameters.

The adapter removes SSL URL parameters before passing its explicit verified TLS
options to `pg`; otherwise the driver's URL parser can replace those options.
`sslrootcert`, `sslcert` and `sslkey` paths are supported, and
`DATABASE_SSL_CA_FILE` takes precedence over `sslrootcert`.
[node-postgres SSL documentation](https://node-postgres.com/features/ssl)

The API pool retains its 5-second connection timeout, 30-second idle timeout and
15-second query/idle-transaction limits. Pool size is per API process, so budget
the total across replicas. Migration SQL has a separate 5-minute statement limit
and 15-second lock-wait limit inside the migration transaction.

## A new empty hosted database

Configure the runtime and migration URLs, then run:

```sh
npm run db:migrate
npm run build
npm run start:api
```

The migration runner takes a transaction-scoped advisory lock, checks applied
migration checksums and commits all new migrations together. Existing records
are not transferred merely by changing `DATABASE_URL`.

## Transfer the existing local database

The export command uses PGlite's official WASM `pg_dump` to produce portable SQL.
It preserves schema, rows, UUIDs, sequences, large integer values, document bytes,
constraints, triggers and migration checksums. It exports the application's public
schema, including existing account rows referenced by audit and financial records.
It does not create or migrate an external authentication provider.
[PGlite dump documentation](https://pglite.dev/docs/pglite-tools)

1. Stop the local app with `pnpm stop`. Keep a separate backup of `.local/database`
   while it is stopped.
2. Run `pnpm db:export:local`. Optionally set a stable path:
   `pnpm db:export:local --output .local/exports/ledgerbook.sql`.
3. The command acquires the same process lock as the launcher, skips source
   migrations and refuses to overwrite an existing export. It never contacts a
   hosted database. Keep the SQL file private: it contains customer documents and
   all existing database records, including credential/session material.
4. Restore into a **new empty target database** with PostgreSQL's `psql`. Put its
   direct connection URL in `PGDATABASE` through the environment or use a private
   `pg_service.conf`/password file; avoid placing credentials in shell history.
   Then run:

   ```sh
   psql --no-psqlrc --set ON_ERROR_STOP=1 --single-transaction --file .local/exports/ledgerbook.sql
   ```

5. Set `DATABASE_MIGRATION_URL` for that target and run `npm run db:migrate` to
   apply migrations added after the local export. Do not initialize the target's
   application tables before restoring the full dump. Existing table conflicts
   stop restoration instead of overwriting data.
6. Before starting the target app, compare row counts and ledger totals, open
   representative uploaded documents, and review pending notification jobs so a
   copied development outbox does not unexpectedly deliver live email. Revoke
   copied development sessions and configure the intended production origin and
   email sender. Preserve any object-storage buckets referenced by exported
   metadata; external S3 bytes are not part of a SQL dump.

Use the PostgreSQL major version matching PGlite (currently PostgreSQL 17) or newer
for the lowest-risk restore. The exporter omits the PG17-only `transaction_timeout`
setting for older-server compatibility, but PostgreSQL 15/16 target restores still
need an explicit staging rehearsal. Supabase's managed `auth` and `storage` schemas
are outside this public-schema export.

The automated export test restores a fresh database and checks schema/history,
binary bytes, maximum signed 64-bit values, uniqueness and identity sequences.
Connection tests inspect the actual `pg` client's resulting TLS settings. These
checks use local PGlite and do not establish hosted connectivity, provider TLS
trust, multi-connection lock behavior or restore performance on production data.
Run the existing suite with `TEST_DATABASE_URL` against a disposable hosted test
database before switching production traffic.

On 2026-11-06 the full backend suite also passed against a disposable PostgreSQL
17 server: 149 tests, zero failures or skips. Service integration suites used
separate PostgreSQL connections; tests dedicated to the local launcher still
used PGlite. The temporary server was removed after verification. This validates
the exercised multi-connection behavior locally, while live Neon/Supabase
connectivity and provider certificate settings remain deployment checks.
