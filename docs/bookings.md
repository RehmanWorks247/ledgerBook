# Booking and document API

All paths below start with `/api/organizations/{organizationId}/customers/{customerId}/bookings`.
They require the normal session cookie. Mutations also require the application's
`Origin` and `X-CSRF-Protection: 1` header. The server rechecks membership and
customer ownership in the database transaction. Administrators manage documents;
customers can read only bookings belonging to their own customer account.

| Method and path | Behaviour |
| --- | --- |
| `GET /` | Lists this customer's bookings as `{items, time_zone}`. |
| `POST /` | Creates a booking, its GBP ledger charge, instalments and six folders atomically. |
| `GET /{bookingId}` | Returns a booking with its instalments and business `time_zone`. |
| `PATCH /{bookingId}` | Administrator edits reference, departure, services, total and instalments with optimistic concurrency and an auditable reason. |
| `DELETE /{bookingId}` | Administrator cancels a booking, reverses its current charge and revokes document access while retaining financial history. |
| `GET /{bookingId}/files` | Returns `{items}` containing flat file/folder nodes. |
| `POST /{bookingId}/folders` | Creates a folder with `{parent_id, name, idempotency_key}`. |
| `PATCH /{bookingId}/files/{nodeId}` | Moves an item with `{parent_id}`. Cycles, cross-booking moves and moving documents outside a service folder are rejected. |
| `POST /{bookingId}/folders/{folderId}/documents` | Saves one file, then commits its association and audit atomically. |
| `GET /{bookingId}/documents/{documentId}` | Opens PDFs and supported raster images inline, and downloads other files. |
| `GET /{bookingId}/documents/{documentId}?download=1` | Downloads the authenticated file with its filename. |
| `PATCH /{bookingId}/services/{serviceKey}` | Sets the independent issuance flag using `{issued: boolean}`. Uploading never implicitly marks a service issued. |

Booking creation accepts:

```json
{
  "reference": "UMRAH-001",
  "departure_at": "2026-11-12T10:30:00+00:00",
  "required_services": ["flight", "makkah", "madinah", "visas"],
  "amount": "2500.00",
  "effective_date": "2026-11-06",
  "instalments": [
    {"due_date": "2026-11-06", "amount": "1000.00"},
    {"due_date": "2026-11-10", "amount": "1500.00"}
  ],
  "idempotency_key": "a7ce1a32-bdc4-4f10-86b2-f509e854e765"
}
```

The combined instalment total may be up to £5.00 (500 pennies) above or below
the booking amount, inclusive. A difference of £5.01 is rejected. This is one
tolerance for the whole schedule, not for each instalment. Entered instalment
amounts are preserved; the booking total and ledger charge are not adjusted.
An omitted or empty schedule creates
one instalment for the full total on the effective date. Amounts are decimal
strings converted to integer pennies with the existing money parser. Booking
charges require a GBP accounting workspace; existing foreign-currency history
is never relabelled. Repeating a submission key with the same booking returns
the existing booking; conflicting input returns a conflict.

Default service keys are `flight`, `makkah`, `madinah`, `transfers`, `visas` and
`extras`, labelled Flight Tickets, Makkah Hotel, Madinah Hotel, Transfers, Visas
and Extras. Optional folders are still created. Only `required_services` drives
missing-document indicators. Train tickets belong in Extras. Folder roots are
fixed; subfolders can be created and moved using the existing explorer controls.

File uploads use `Content-Type: application/octet-stream`, a raw binary request body,
`X-File-Name: <encodeURIComponent(filename)>`, and `Idempotency-Key: <UUID>`.
All file extensions are accepted, including PDF, DOC/DOCX, images, spreadsheets,
archives and extensionless files. Each file must contain 1–10,485,760 bytes
(10 MiB, displayed as 10 MB). Existing `application/pdf` requests remain supported.
The server derives MIME metadata from the filename, screens PDF signatures
and end markers, and resolves the complete customer/booking/service-folder
context before storing anything. An absent or mismatched destination is rejected.
Local database mode stores file metadata and bytes together in a PostgreSQL
`bytea` row, with the audit event in the same transaction. Production S3 mode
uploads private bytes outside the database transaction, then atomically commits
their reference and audit. Existing `bytea` documents remain readable. See
[storage configuration and recovery](file-storage.md). An interrupted response can safely be
retried using the same submission key; a changed payload with that key is rejected.
File bytes never have a public filesystem path or unauthenticated static URL.
Back up the database and, when using S3, the document bucket together.

File nodes retain the existing explorer shape (`id`, `parentId`, `name`, `kind`,
`size`, numeric `modifiedAt`) and add `serviceKey`, `defaultFolder`, `issuedAt`.
Files also include `mimeType`, `url`, `openUrl`, `downloadUrl`; both URLs enforce
current authorization and return private, non-cacheable responses. The built-in
browser viewer handles PDFs and supported raster images. Other file types,
including HTML and SVG, download as attachments. Unknown types use
`application/octet-stream`. Authenticated blob links apply the same preview
restriction. Migration `010_document_file_types.sql` retains PDF metadata for
existing documents and allows small non-empty files in both storage modes.

Migration `003_bookings.sql` introduces durable booking storage because the
previous explorer stored files only in the current browser tab. Such old tab-only
files were never persisted server-side and cannot be recovered by a migration.
`ensure_booking_folders(booking_id)` repairs missing default folders on booking
creation/retry and document listing. It is safe to call repeatedly, adopts existing
matching root folders, and preserves their IDs, files and parent associations.
Migration `004_booking_integrity.sql` additionally enforces that each booking
references its own customer's GBP charge with the same total, and that booking
and document creators belong to the same organization. These constraints also
protect direct database imports and future API callers.

`tests/bookings.test.ts` exercises the real migrated PostgreSQL-compatible engine
and real HTTP API: separate vouchers for two trips, owner-only reads, staff-only
writes, CSRF, revoked access, retries/conflicts, invalid destinations, failed-upload
rollback, folder repair, folder moves/cycles, issuance separation and atomic ledger
charges. The HTTP test compares the bytes returned by inline and attachment routes.
The default suite uses PGlite; set `TEST_DATABASE_URL` for production PostgreSQL
connection/locking verification. Native desktop/mobile PDF viewer behaviour still
requires a browser check on the deployment origin.

## Editing and cancellation

The booking page exposes **Edit booking**, **Cancel booking** and per-service
**Mark issued / Mark not issued** controls to administrators. Customers see the
current booking and issuance status without management controls. Editing uses the
business time zone and exact penny amounts. Both lifecycle mutations require
`expected_version` from the latest booking response, an `idempotency_key` UUID,
a nonblank `reason` (at most 1,000 characters), and a valid `effective_date`.

`PATCH /{bookingId}` accepts the same editable fields as creation: `reference`,
`departure_at`, `required_services`, `amount`, and a nonempty `instalments` array.
Amounts must be positive GBP decimal strings, with at most 100 instalments that
sum to within £5.00 above or below the total, using the same inclusive tolerance
as creation. Changing the total atomically reverses the existing
active charge and posts a replacement; the correction date cannot precede the
current charge. The date is used only when a financial correction is needed.
Previously posted entries and approved payments remain unchanged. Metadata-only
changes do not post new financial entries. Before/after booking and schedule
snapshots, reason and actor are retained in the audit. The response includes the
new booking `version`, current charge `effective_date`, and updated schedule.

`DELETE /{bookingId}` additionally requires `confirmation` equal to the current
booking reference exactly. It hides the booking from active lists, dashboard
calculations and document access; cancels pending file uploads; clears issuance;
and rejects pending payment submissions with an audit reason. It reverses the
current charge once, and preserves approved payments as customer credit. A charge
already reversed manually is not reversed a second time. Receipts, documents,
booking snapshots and the ledger remain stored for audit. Authorized payment
history/receipt reads remain available, while submissions and reviews are blocked.
The response is `{id,cancelled:true,version,reversal_entry_id,retained_payments_minor}`.
Cancellation does not perform a refund or remove the entire customer account.

Concurrent changes using the same old version return HTTP 409 without partial
writes. A lost-response retry with the same key and body returns the exact original
committed response, even after another edit; changing a reused key's input returns
409. Stale forms must be refreshed before resubmission. Cross-customer and
cross-organization paths return 404, and customer writes return 403. The existing
CSRF and active administrator checks apply to both methods.

Migration `013_booking_management.sql` introduces lifecycle version/cancellation
fields, an operation replay journal, and a database guard preventing new or
approved payments against cancelled bookings. `tests/booking-management.test.ts`
verifies real HTTP boundaries, concurrent edits, transactional audit rollback,
immutable ledger correction, exact retries, cancellation, and retained receipts.
