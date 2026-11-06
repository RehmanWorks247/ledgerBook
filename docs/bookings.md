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
| `GET /{bookingId}/files` | Returns `{items}` containing flat file/folder nodes. |
| `POST /{bookingId}/folders` | Creates a folder with `{parent_id, name, idempotency_key}`. |
| `PATCH /{bookingId}/files/{nodeId}` | Moves an item with `{parent_id}`. Cycles, cross-booking moves and moving documents outside a service folder are rejected. |
| `POST /{bookingId}/folders/{folderId}/documents` | Saves one PDF, then commits its association and audit atomically. |
| `GET /{bookingId}/documents/{documentId}` | Opens an authenticated PDF inline. |
| `GET /{bookingId}/documents/{documentId}?download=1` | Downloads the authenticated PDF with its filename. |
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

Instalments must total the booking amount. An omitted or empty schedule creates
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

PDF uploads use `Content-Type: application/pdf`, a raw binary request body,
`X-File-Name: <encodeURIComponent(filename)>`, and `Idempotency-Key: <UUID>`.
Each PDF is limited to 10 MB. The server validates the filename, PDF signature
and end marker, and resolves the complete customer/booking/service-folder
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
browser PDF viewer handles inline opening, and `Content-Disposition: attachment`
handles downloads, including browsers that do not support an HTML download attribute.

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
