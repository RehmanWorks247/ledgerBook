# Booking document storage

Administrators can drag files/folders into a booking's service folder or use the
file picker, create folders, rename, move and delete documents. Built-in service
folders are protected; custom folders must be empty before deletion. Customers
can only list, open and download files belonging to their own bookings. Customer
payment receipt submission remains a separate, unchanged workflow.

Uploads accept up to 100 files / 100 MiB per batch, 10 MiB per file, and three
parallel transfers. The UI shows preparation, byte progress, verification, saved,
failed and cancelled states. Success toasts appear only after verification and
commit. Failure toasts and individual file errors retain the reason and offer
safe retry. Cancellation after transfer may still leave a saved file; retries
reconcile the existing submission instead of creating duplicates.

## Development and production

Cloudflare R2 stores private document bytes; PostgreSQL stores booking ownership,
folders, metadata, audit history and the cleanup journal. No AWS account is needed.
Use two independent private Standard buckets and two **Object Read & Write**
credentials, each restricted to its own bucket. Do not grant the app bucket
administration permissions. Keep public access and public development URLs off.

Development `.env`:

```dotenv
NODE_ENV=development
DOCUMENT_STORAGE=r2
STORAGE_ENVIRONMENT=development
R2_ACCOUNT_ID=YOUR_CLOUDFLARE_ACCOUNT_ID
R2_DOCUMENT_BUCKET=ledgerbook-documents-development
R2_ACCESS_KEY_ID=YOUR_DEVELOPMENT_ACCESS_KEY
R2_SECRET_ACCESS_KEY=YOUR_DEVELOPMENT_SECRET
```

Production storage settings (private `.env.production` or deployment secrets):

```dotenv
NODE_ENV=production
DOCUMENT_STORAGE=r2
STORAGE_ENVIRONMENT=production
R2_ACCOUNT_ID=YOUR_CLOUDFLARE_ACCOUNT_ID
R2_DOCUMENT_BUCKET=ledgerbook-documents-production
R2_ACCESS_KEY_ID=YOUR_PRODUCTION_ACCESS_KEY
R2_SECRET_ACCESS_KEY=YOUR_PRODUCTION_SECRET
```

Configuration fails startup if the storage environment disagrees with `NODE_ENV`,
credentials are missing, or the bucket does not end with the corresponding
`-development` / `-production` suffix. Bucket-scoped credentials enforce the
provider-side separation. The local launcher refuses production configuration.
Regression tests clear R2 credentials and use isolated databases/HTTP stand-ins.

Both environment files are gitignored and must remain server-only. Never use a
`VITE_` prefix for storage credentials. The production storage file is not a full
application deployment: the deployment must also supply its HTTPS `PUBLIC_APP_URL`,
production Clerk credentials, database and email settings. Production must not
inherit the development `.env`.

Run `npm run db:migrate` before deployment. The local launcher applies migrations
automatically. Migration 011 adds the direct-upload journal. Existing database
files remain readable; new R2 uploads do not store bytes in SQL.
`DOCUMENT_STORAGE=database` remains available for offline development. Legacy
AWS deployments can retain `DOCUMENT_STORAGE=s3` and their existing S3 settings.

## Browser CORS

Set this policy on each bucket with that environment's exact browser origins:

```json
[
  {
    "AllowedOrigins": ["http://localhost:3001"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type", "if-none-match", "content-length", "content-md5"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Development may additionally allow its local Vite/preview ports. Production must
use the actual HTTPS `PUBLIC_APP_URL`, never a wildcard or development origin.
Until that production origin exists, leaving production CORS unset keeps browser
access denied. CORS does not make a bucket public; object operations still
require signed requests. The API Content Security Policy allows only the
configured R2 account endpoint alongside its existing application origins.

## Upload contract and integrity

Routes are scoped under
`/api/organizations/:orgId/customers/:customerId/bookings/:bookingId`:

1. `POST /folders/:folderId/uploads` accepts `{name,size,sha256,idempotency_key}`.
   It authenticates the administrator, checks the destination and reserves an
   invisible pending object. The response selects `direct`, `proxy`, or an
   already `complete` upload. Direct uploads include a URL valid for up to ten
   minutes and the exact headers to send.
2. The browser sends bytes directly to R2, without application cookies or session
   headers. The signature binds size, content type and `If-None-Match: *`. R2
   atomically rejects overwrites, including replay after validation.
3. `POST /folders/:folderId/uploads/:uploadId/complete` checks the uploader,
   organization, customer, booking and folder, retrieves the object, verifies
   its size and SHA-256, screens PDF signatures, then rechecks current access
   before committing metadata and audit history together.

Verification reads bytes through the API once; browser upload bytes bypass it.
Network operations do not hold database transactions. Only verified documents
appear in customer listings. Failed/expired attempts remain private for cleanup.
The authenticated raw upload route remains for database mode and older clients.

`PATCH /files/:nodeId` accepts `{name}` or `{parent_id}`; file renames preserve
extension/MIME type. `DELETE /files/:nodeId` removes access immediately and queues
cloud removal. Downloads remain authenticated, non-cacheable API responses, so
revocation applies on the next request. Active/HTML files download as attachments
instead of executing in the application origin. Format screening is not antivirus.

## Cleanup and operation

The API runs a bounded cleanup worker when cloud storage is enabled. It starts
after one minute, normally runs hourly, drains full batches every minute, and
retries failures after five minutes. Shutdown cancels cloud work before resources
close. Replicas may repeat an idempotent deletion; the database journal is
canonical. Cleanup waits 24 hours before removing abandoned uploads or purged
files, longer than signed-URL expiry. It never removes referenced documents.
Do not apply blanket expiration rules to the `documents/` prefix.

The one-shot `npm run storage:cleanup` command remains available with the same
storage environment/database as the API. Monitor retry logs and journal backlog.
Back up PostgreSQL and private object storage together; database dumps contain
references, not R2 bytes.

### Snapshot-bound document backup and restore

The database backup writes a private adjacent JSON manifest containing the exact
current **and historical** object references from the same exported PostgreSQL
snapshot as the dump. Copy those bytes immediately after creating the dump:

```sh
npm run db:backup -- /private/backups/ledger.dump
npm run storage:backup -- /private/backups/ledger.dump /private/backups/ledger-documents
```

Both commands load `.env.production` if present. Use an explicit
`node --env-file=PATH --import tsx scripts/document-backup.ts backup DATABASE.dump DIRECTORY`
when selecting a different environment. The configured bucket must match every
reference in the snapshot. The command never consults later database state or
lists unrelated objects. It verifies the dump hash, downloads at most three
objects concurrently, checks each size and SHA-256, and writes private files
(`0700` directories, `0600` files). Missing or corrupt provider bytes fail the
backup. Run the same command again to resume the same snapshot; already verified
files are reused. A completion marker appears only after every object verifies.

Keep the dump, its adjacent `.json` manifest, and the entire document directory
together. These are private **unencrypted** files: use encrypted backup storage
and an independent off-host copy under your retention policy. Copy objects before
the 24-hour cleanup grace expires; cleanup can remove objects no longer referenced
by the live database, even though an older dump still references them. Only a
completed, checksum-verified object copy makes that dump's cloud files recoverable.

For recovery, stop application writers/cleanup, configure the same private bucket,
and restore its bytes before bringing the restored database online:

```sh
npm run storage:restore -- /private/backups/ledger.dump /private/backups/ledger-documents --confirm-bucket ledgerbook-documents-production
```

The restore validates **all local files before its first cloud write**, then uses
the snapshot's exact keys with signed `If-None-Match: *` writes. Existing identical
objects are accepted after checksum verification; conflicting objects cause an
error and are never overwritten or deleted. Interrupted restores can be safely
replayed. The command does not modify database rows or migrate objects to a
different bucket. Restore the matching database using the procedure in
[deployment.md](deployment.md), verify the application, then resume writers.
Database-only installations already include document bytes in their dump and do
not need the cloud copy step. Conditional writes follow the documented
[S3 contract](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
and [R2 compatibility contract](https://developers.cloudflare.com/r2/api/s3/api/).

`tests/document-backup.test.ts` covers binary current/history bytes, incomplete
backup recovery, snapshot isolation, private filesystem boundaries, corruption,
idempotent restore and conflicting destinations through the real SDK and a local
HTTP stand-in. All ten S3/R2 cases passed on 2026-11-09. The additional Postman
`tests/document-backup.simulation.ts` run passed for both providers using ASCII
fixtures: each observed eight PUTs, eight GETs and four DELETEs, including 412
replay/conflict responses, with zero synthetic objects left. These checks do not
copy real customer data or establish live bucket permissions.

Uploads/finalization have per-user rate limits. Raw uploads, downloads and upload
verification have per-process concurrency bounds and timeouts. Provider requests
have bounded retries and deadlines. Capacity planning must account for API
verification/download traffic, database connections and real file sizes.

## Verification

Run `npm test`, `npm run typecheck`, `npm run lint` and `npm run build`.
Storage/HTTP/security suites cover tenant/customer isolation, signed headers,
replay, interrupted uploads, access revocation, checksum/format rejection,
deletion and retry. Frontend tests cover credential isolation and upload states.
The Postman simulation exercises the real SDK, including corrupted downloads
and failed deletes:

```sh
postman simulation run postman/simulations/document-storage.sim.yaml --port 4018 --no-history
node --import tsx tests/document-storage.simulation.ts
```

Explicit live checks use the intended environment only:

```sh
node --env-file=.env --import tsx scripts/storage-verify.ts
node --env-file=.env.production --import tsx scripts/storage-verify.ts
```

The script creates a unique synthetic `verification/` object, verifies signed
upload, download integrity, replay rejection and anonymous denial, and deletes
that exact object. With `PUBLIC_APP_URL`, it also verifies CORS. It never prints
credentials or signed URLs. On 2026-11-09 both provisioned buckets passed these
live object checks; development CORS also passed. Production browser CORS and
hosted application verification require an actual production HTTPS deployment.
Each credential was also checked against the opposite bucket: both returned
403. The signed-in Brave browser passed upload, authenticated file access,
rename, invalid-PDF error toast and deletion using a synthetic file in the demo
workspace. The browser test file was removed afterward. The regression run
passed 198 backend and 62 frontend tests, plus seven additional cleanup-worker
tests. Typecheck, lint and production build passed. Production dependency audit
reported zero vulnerabilities; Vite was updated to a patched development-server
release. Remaining moderate audit reports concern a development-only lint
dependency, not the production runtime.

References: [presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/),
[S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/),
[CORS](https://developers.cloudflare.com/r2/buckets/cors/),
[API tokens](https://developers.cloudflare.com/r2/api/tokens/).

## Document editing and version history

Migration `014_document_versions.sql` adds optimistic content versions and durable
history. Each file keeps the same document ID and customer-facing URL when its
content changes. Administrators open **Edit file and versions** to edit UTF-8 TXT,
CSV, JSON or Markdown (up to 256 KiB), or replace any other format using a file
with the same extension (up to 10 MiB). Replacement preserves the current display
name. The text editor validates JSON syntax, rejects binary control characters,
keeps unsaved text after an error, and asks before discarding changes. PDF, Word,
image and other binary files use download, edit in the appropriate application,
and **Save replacement**. The app does not claim to provide a rich editor for
those formats.

A verified save archives the prior bytes, increments `version`, and records a
`document.replaced` audit event in the same transaction. A stale `expected_version`
returns 409 without changing the saved document. Stable submission keys make a
lost response safe to retry. **Restore** copies an earlier version into a new
current version and records `document.restored`; it retains the version being
replaced. The history includes up to 100 saved revisions plus the current file.
At that bound the administrator must download a copy and add a new document.
Customers can view history and download versions for their own booking; only an
administrator can read editable text, replace content or restore a version.
Archived customers and cancelled bookings reject edits; cancelled bookings also
revoke all version reads. Deleted files lose access immediately, including every
historical download.

Additional routes under the booking API:

- `GET /documents/:id/versions` returns `{version,items}` without document bytes.
- `GET /documents/:id/versions/:version` downloads an authenticated, non-cacheable
  attachment with the version's original name and MIME type.
- `GET /documents/:id/text` returns `{name,version,text}` after strict UTF-8 and
  text-format/size checks. It is administrator-only.
- `POST /documents/:id/versions/:version/restore` accepts `{expected_version}`.
- `POST /folders/:folderId/documents/:id/uploads` accepts
  `{name,size,sha256,idempotency_key,expected_version}`. R2 returns the existing
  create-only signed upload contract with a **new** object key. The browser sends
  no application cookies or authorization to that URL.
- `POST /folders/:folderId/documents/:id/uploads/:uploadId/complete` verifies bytes,
  then rechecks live membership, booking status, folder and content version before
  committing. No temporary replacement appears in customer listings.
- Database/S3 fallback uses `POST /folders/:folderId/documents/:id/content` with
  raw bytes and `X-File-Name`, `Idempotency-Key`, `X-Document-Version`. It shares the
  existing authorized, bounded raw-upload interceptor.

Network operations stay outside database transactions. Metadata/history listings
do not load binary contents from SQL. Prior cloud objects remain referenced and
protected from cleanup; restore reuses an immutable historical object. Document
or customer deletion journals all historical cloud objects before removing their
relational references. Cancelled, failed, corrupt and abandoned replacement
uploads remain private and are reconciled after the existing 24-hour grace
period. A failed cloud deletion retains its outbox row for retry.

Added verification commands:

```sh
node --require ./tests/test-environment.cjs --import tsx --test --test-concurrency=1 tests/document-versions.test.ts
postman simulation run postman/simulations/document-storage.sim.yaml --port 4018 --no-history
node --require ./tests/test-environment.cjs --import tsx tests/document-versions.simulation.ts
```

On 2026-11-09, eight new integration cases passed for version save/retry, exact
binary history, restore, stale writers, transaction rollback, customer/admin/tenant
boundaries, archived-account denial, text bounds, HTTP sessions/CSRF/download
headers and document/account cleanup. The raw HTTP R2 simulation executes the
production SDK, signed create-only uploads, replay rejection and failed deletion
recovery using synthetic bytes. The Postman version simulation executes the real
booking/version services with ASCII files against its existing S3 contract:
7 PUTs, 4 GETs and 8 DELETEs were observed, including upload outages, transient
retry and failed deletion; zero objects remained after recovery. It does not
establish live Cloudflare credentials, real signature verification or deployed
browser CORS. Frontend regression coverage verifies guarded replacement/restore,
authentication isolation, interrupted-save retry and safe editor controls.
Two additional real PostgreSQL concurrency tests pause a version reader while a
replacement commits; requested historical downloads and history listings retain
consistent versions and bytes from one SQL snapshot.

## Private file previews

Opening a booking file or receipt opens a responsive modal. It includes download,
Escape/close, keyboard focus containment, loading and retry states. Closing a
preview aborts its fetch and releases object URLs and renderer workers; document
bytes are not retained in a browser cache or sent to a public viewing service.
Unsupported formats still open the modal with an original-file download action.

| Format | Preview behavior |
| --- | --- |
| PDF | Local PDF.js worker, one page at a time, page navigation and bounded zoom canvas. Password-protected or damaged PDFs offer download. |
| DOCX | Local worker produces sanitized headings, text, tables and embedded raster images. External links/resources, scripts, macros and embedded HTML are not displayed. Layout can differ from Word. |
| Legacy DOC | Server extracts text, including available footnotes and headers; download retains original layout and images. |
| PNG, JPEG, GIF, WebP, AVIF, BMP, SVG, ICO | Browser image preview with fit and zoom. SVG is used only as an image, never as an inline document. |
| TIFF | Server converts the first page to PNG; maximum 16 million input pixels, output fits within 2400 × 2400. |
| HEIC / HEIF | Native browser decoding where available; otherwise download. No additional HEVC decoder is deployed. |
| TXT, CSV, JSON, Markdown | Inert text; show up to the first 1 MiB, with a truncation notice. |
| MP3, WAV, OGG, M4A, FLAC, MP4, WebM, MOV | Native media controls when the browser supports the codec. |
| Other formats, including XLS/XLSX, PPT/PPTX, ODT, RTF and archives | Original-file download fallback. |

Renderers are loaded on demand. PDF fonts, international character maps and
decoders are bundled with the matching PDF.js version and served locally.
DOCX extraction has a 15-second worker deadline, bounded decompressed archives,
a 6 MiB HTML output limit and a 20,000-tag complexity limit before sanitization.
The 10 MiB upload limit also bounds client previews; large local files can still
be downloaded without rendering.

`GET /api/organizations/:orgId/customers/:customerId/bookings/:bookingId/documents/:documentId/preview`
is the authenticated derived-preview endpoint for DOC and TIFF only. It uses the
same booking ownership checks and download concurrency limiter as original-file
reads, plus 120 preview attempts per user per hour. It always reads the current
version, returns `Cache-Control: private, no-store`, and never persists a derived
copy. DOC returns `text/plain; charset=utf-8` with `X-Document-Preview: text-only`;
TIFF returns `image/png` with `X-Document-Preview: first-page`.

Conversion runs in at most two disposable workers per API process, each with an
8-second deadline, a 64 MiB JavaScript heap cap, input/header validation and
output bounds. The heap cap is not a total process/native-memory limit; retain
the production container's memory limit. Busy/interrupted conversions return
503 with `Retry-After: 5`; unsupported conversions return 415; invalid, encrypted,
oversized or timed-out input returns 422. Downloading the original remains
available when conversion fails. No LibreOffice installation is required.
