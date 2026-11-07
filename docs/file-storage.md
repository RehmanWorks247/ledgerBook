# Customer document storage

Administrators can drop files or folders into a booking's service folder, or use
the file picker. All file types are supported, including PDF, Word documents,
images, spreadsheets and archives. The explorer accepts up to 100 files / 100 MiB per batch, with
10 MiB per file, and transfers three files concurrently. Each file has progress,
an explicit saving state, and retry/cancel controls. A small accessible toast
reports confirmed saves; failures remain individually visible. Cancelling after
transmission may leave a committed file: retry uses the same submission key to
retrieve it without creating a duplicate. PDF signature/end-marker checks are
format screening, not malware scanning. Payment receipt images retain their
existing separate workflow.

## Storage and database choice

Use **Neon PostgreSQL plus private AWS S3** for this application: PostgreSQL keeps
customer records, folders, ownership, audit history and file metadata; S3 keeps
new document bytes. Clerk manages browser sign-in. Supabase PostgreSQL and Storage are also a reasonable combined
service; the S3 adapter delivered here targets AWS S3, not Supabase's API.

- [Neon connection pooling](https://neon.com/docs/connect/connection-pooling)
- [AWS S3 PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html)
- [Supabase Storage](https://supabase.com/docs/guides/storage)
- [Supabase and Clerk](https://supabase.com/docs/guides/auth/third-party/clerk)

See [hosted PostgreSQL setup and local-data export](hosted-postgres.md) for the
database connection and migration procedure. Neither a cloud database nor a
bucket is provisioned by application startup.

## Configure AWS

`infra/document-storage.yaml` is a CloudFormation template for a private,
encrypted, versioned bucket and a narrowly scoped IAM managed policy. Deploy it
in the API's region, attach its output policy to the API and cleanup job roles,
and configure server secrets:

```dotenv
DOCUMENT_STORAGE=s3
AWS_REGION=your-aws-region
S3_DOCUMENT_BUCKET=the-stack-bucket-output
```

Use the AWS SDK's standard IAM role credentials in production. Local AWS
profiles or server-side `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optional
`AWS_SESSION_TOKEN` also work. Credentials and object keys never go to the
browser. No public ACL, browser CORS, or public bucket URL is required. Keep the
API, database and bucket geographically close. Cloud resources, IAM policies,
and latency must be verified in the chosen deployment before release.

Run `npm run db:migrate` before starting the API. Migration 008 preserves all
existing database-backed documents. New S3 uploads contain no `bytea` data in
`booking_nodes`; existing documents keep their original bytes and authenticated
URLs. Local development defaults to `DOCUMENT_STORAGE=database`. Production
defaults to S3 and fails startup without bucket/region settings; an explicit
`DOCUMENT_STORAGE=database` remains available for compatible deployments.

## Request and failure behavior

The raw-file API uses `application/octet-stream` and also accepts existing
`application/pdf` requests. See [bookings.md](bookings.md).
Session and destination authorization run before body buffering. Uploads are
rate limited, have a 60-second receive deadline, reject compressed bodies, and
allow at most eight active uploads per API process. Downloads also have eight
slots, held until the response drains. Each S3 operation has bounded
timeouts and retries. Apply corresponding request limits at the deployment proxy.

S3 requests run outside database transactions. A durable pending-object record
precedes the upload; a second transaction rechecks authorization, checks retries,
and commits the document reference and audit together. Unique object names
prevent parallel attempts overwriting one another. SHA-256 is sent with uploads
and checked on downloads. An error after an ambiguous database commit never
triggers immediate object deletion.

Downloads pass through the authenticated API so access revocation takes effect
on the next request. They are private and non-cacheable. Transfers currently
pass through the API to preserve upload validation; this implementation
does not claim direct browser-to-S3 or resumable multipart transfers. File lists
select metadata only and normally avoid booking write locks.

Run `npm run storage:cleanup` hourly with the API's database and S3 environment.
Each run processes at most 100 pending/deleting objects older than 24 hours;
monitor failures and backlog, and repeat batches when necessary. A row is marked
deleting before contacting S3, preventing late finalization. Referenced objects
are excluded; failed deletes remain recoverable on the next run. Versioned
buckets retain previous versions after deletion, so configure retention and
noncurrent-version lifecycle rules to match your document retention policy.
Do not add blanket object-expiration rules to the `documents/` prefix.

Back up PostgreSQL **and** S3; a database dump contains only references to cloud
files. The CloudFormation stack retains its bucket on deletion. Rehearse restore
of both datasets together before relying on backups.

## Verification

`tests/bookings.test.ts` covers legacy documents and pre-buffer HTTP rejection.
`tests/document-storage.test.ts` exercises the AWS SDK over real local HTTP with
success, retry, storage/database failure, authorization changes, and cleanup.
On 2026-11-06 the complete suite passed: 149 backend tests against both PGlite
and an isolated PostgreSQL 17 server, plus 41 frontend tests. The PostgreSQL run
uses independent connections for service transactions; the temporary container
was removed afterward. Lint, typecheck and production build passed, and the
restarted local application returned ready. Browser visual verification could
not complete because the browser-control connection timed out.

These checks do not establish production AWS IAM, hosted certificate/network
settings, deployment capacity, or malware scanning. Perform an HTTPS deployment
upload/download smoke check and verify the chosen hosted database before release.

The reusable local Postman simulation also exercises the actual SDK's success,
retry, persistent-outage, and delete paths:

```sh
postman simulation run postman/simulations/document-storage.sim.yaml --port 4018 --no-history
# In another terminal:
node --import tsx tests/document-storage.simulation.ts
```

Postman CLI 1.75 converts arbitrary binary bodies through UTF-8, so that smoke
uses ASCII PDF bytes. The independent HTTP integration suite checks binary PDF
transport, including non-UTF-8 bytes. See the simulation context for evidence
and scope. Postman's `status` command was unavailable in this CLI; no workspace
binding or cloud publishing was performed.
