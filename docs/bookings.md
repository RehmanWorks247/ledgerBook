# Booking and document API

All paths below start with `/api/organizations/{organizationId}/customers/{customerId}/bookings`.
They require the configured session cookie or Clerk bearer token. Mutations also require the application's
`Origin` and `X-CSRF-Protection: 1` header. The server rechecks membership and
customer ownership in the database transaction. Administrators manage documents;
customers can read only bookings belonging to their own customer account.

The consumer **My bookings** screen shows cards with a reference and departure,
without prices or filters. Opening an active booking shows its read-only document
folders. Financial summaries, payment reminders, invoices and service management
remain in the administrator view. Cancelled bookings disappear from the consumer
list and cancellation revokes file access.

Consumers submit payments from **My account → Make a payment**. New submissions
belong to the whole customer account; approval reduces the combined outstanding
balance without assigning the payment to an individual booking. My Account also
keeps earlier payment history for active bookings available.

| Method and path | Behaviour |
| --- | --- |
| `GET /` | Lists this customer's bookings as `{items, time_zone}`. |
| `POST /` | Creates a booking, its GBP ledger charge, instalments, advance-payment records and six folders atomically. |
| `GET /payment-options?booking_id={bookingId}` | Administrator lists this customer's available whole ledger payments as `{items}`. Omit `booking_id` when creating a booking. |
| `GET /{bookingId}` | Returns a booking with instalment payment status, received/outstanding totals and business `time_zone`. |
| `PATCH /{bookingId}` | Administrator edits reference, departure, services, total and instalments with optimistic concurrency and an auditable reason. |
| `DELETE /{bookingId}` | Administrator cancels a booking, reverses its current charge and revokes document access while retaining financial history. |
| `GET /{bookingId}/files` | Returns `{items}` containing flat file/folder nodes. |
| `POST /{bookingId}/folders` | Creates a folder with `{parent_id, name, idempotency_key}`. |
| `PATCH /{bookingId}/files/{nodeId}` | Moves an item with `{parent_id}`. Cycles, cross-booking moves and moving documents outside a service folder are rejected. |
| `POST /{bookingId}/folders/{folderId}/documents` | Saves one file, then commits its association and audit atomically. |
| `GET /{bookingId}/documents/{documentId}` | Opens PDFs and supported raster images inline, and downloads other files. |
| `GET /{bookingId}/documents/{documentId}?download=1` | Downloads the authenticated file with its filename. |
| `PATCH /{bookingId}/services/{serviceKey}` | Sets the independent issuance flag using `{issued: boolean}`. Uploading never implicitly marks a service issued. |

## Simple payment reminders

The current booking form uses `schedule_basis: "reminders"`. It shows **Total**,
**Paid so far** and **Remaining**, followed by a list of reminder dates and
amounts. Payments are recorded or linked separately in **Payment history**.
Editing or removing reminders never records, links, corrects or reverses money.

Reminder amounts must be positive and their sum may be any amount up to the
remaining booking balance. An empty list is valid and means no payment reminders.
There is no full-balance requirement, rounding tolerance, automatic redistribution
or paid checkbox. Any balance not covered by reminders stays visible.

Confirmed payments already received when the reminders are saved are accounted
for once. Later confirmed payments cover the earliest outstanding reminder first,
including partial payments. For a £1,000 booking with £300 already received, two
£350 reminders become £150 and £350 after another £200 is recorded. Pending
customer submissions appear in payment history and do not reduce the confirmed
balance until approved. Fully paid bookings send no further payment reminders.

For existing bookings, the editor starts with each reminder's current outstanding
amount. Saving captures the current payment position, so reopening and saving
cannot deduct earlier payments again. A conflicting payment change requires the
editor to refresh. Payment corrections can expose a balance without a reminder;
the balance stays visible and can be scheduled explicitly. Older paid instalment
records and their payment history are preserved when switching to reminders.

The server supplies current reminder balances for the booking page and uses the
same booking-specific allocation for dashboard and reminder delivery. Payments
for a different booking or unassigned account credit do not settle these reminders.
Use **Payment history → Use existing payment** to assign a previously recorded
customer payment to its booking without recording it again.

New booking drafts restore dates and amounts. Older, unsubmitted drafts retain
their unpaid rows and explain that any payment inputs must be entered separately.
An attempted legacy submission requires checking the customer's bookings before
discarding the draft, rather than silently replaying its old payment actions.

## Legacy installment API compatibility

The older `remaining_balance` and full-schedule contracts below remain available
for existing clients. Their payment controls and balancing rules are not used by
the current reminder form.

Legacy remaining-balance booking creation accepts:

```json
{
  "reference": "UMRAH-001",
  "departure_at": "2026-11-12T10:30:00+00:00",
  "required_services": ["flight", "makkah", "madinah", "visas"],
  "amount": "2500.00",
  "schedule_basis": "remaining_balance",
  "existing_payment_entry_ids": [],
  "effective_date": "2026-11-06",
  "instalments": [
    {"due_date": "2026-11-06", "amount": "1000.00"},
    {"due_date": "2026-11-10", "amount": "1500.00"}
  ],
  "idempotency_key": "a7ce1a32-bdc4-4f10-86b2-f509e854e765"
}
```

Older forms send `schedule_basis: "remaining_balance"`. The required upcoming
schedule is the booking `amount` minus approved, unreversed payments for that
booking, clamped at zero. Only **unpaid** rows count toward that schedule.
`existing_payment_entry_ids` explicitly selects whole available customer ledger
payments to assign to this booking. A nonempty selection requires the
remaining-balance mode. Unselected customer payments are excluded from this
booking’s paid total and plan target;
payments assigned to another booking cannot be selected. Selection links the
existing credit and never posts it again. Paid rows can also record new advance
payments in the same transaction.

For a £5,000 booking with a selected £2,000 payment, five upcoming instalments
are £600 each. The required schedule is £3,000, and the inclusive £5 tolerance
allows £2,995 through £3,005. This is one tolerance for the entire unpaid schedule,
not for each row. Entered amounts are preserved; the booking charge is not
adjusted to match the schedule. The server calculates the authoritative paid
balance and validates the schedule within the locked transaction. An empty input
schedule creates one due row for a positive remaining balance on `effective_date`,
or no due row when fully paid. A nonempty schedule containing only paid rows
still needs unpaid rows when more than £5 remains. Remaining-balance requests allow
100 input rows not marked `paid: true` and up to 1,000 input rows in total.
On edit, active paid rows may be omitted and are preserved. Preserved or generated
completed rows can make the saved schedule larger than the input limit. Legacy
requests retain the 100-row limit; legacy creation with an omitted or empty
schedule creates one row for its full calculation target, while legacy edits
require at least one row.

For older API clients that omit `schedule_basis`, the original full-schedule
contract remains supported: all paid and unpaid rows are compared with optional
`instalment_total` (or `amount` when omitted). This separate legacy calculation
target does not change the ledger charge. In remaining-balance requests,
`instalment_total` must be omitted or equal `amount`; it cannot override the
remaining target. The current form has no independent calculation-total override.
Existing records are not rewritten on deployment.

Amounts are decimal strings converted to integer pennies. Booking charges require
a GBP accounting workspace; existing foreign-currency history is never relabelled.
Repeating a submission key with the same booking returns the existing booking;
conflicting input returns a conflict.

New-booking forms save a draft automatically in this browser, scoped to the
workspace, signed-in membership and selected customer. Refreshing or returning
to that customer restores the entered fields, selected payments and
instalments. Older saved drafts remain compatible and retain their retry keys. Selecting a
customer from the general booking page moves to that customer's booking URL,
so refresh also retains the selection. The retry key is saved before submission;
a lost successful response can be retried after refresh without a duplicate.
Successful creation or **Discard draft** clears the saved draft. Drafts do not
sync between devices, and existing-booking edits are not saved as new drafts.
Paid checkboxes, payment dates, new/existing payment choices and selected ledger
entry IDs are also restored with the draft. A draft does not post a payment;
the booking must be saved successfully first.

The instalment planner defaults to **Auto-balance later instalments** for new
bookings. The count is the number of upcoming **unpaid** instalments; completed
payments are separate from that count. Leaving an edited amount field (or pressing
Enter) preserves that row and earlier amounts, then divides the remaining unpaid
balance across later unpaid rows. Paid rows retain their amounts. Calculations use
integer pennies, with rounding pennies assigned to the final unpaid row. Dates
remain editable and are never changed by redistribution.

**Suggestions only** keeps amounts unchanged until the user applies a suggestion
or spreads the remainder. Existing bookings and older drafts without an assistance
setting open in this mode. Switching modes does not change amounts. The selected
mode and last edited row are saved in new booking drafts; they are UI preferences,
not API fields. **Undo redistribution** restores the prior schedule while
preserving a just-entered amount. Fully paid or overpaid bookings need no upcoming
instalments; the form does not invent zero or negative payments.

Validation updates while an amount field still has focus. It shows the required
**remaining balance**, unpaid **total so far**, inclusive allowed range, and amount
left or scheduled above the target. Paid so far updates as payments are selected
or recorded. Blank, partial and invalid amounts remain editable but cannot be
saved. The form focuses the validation summary and sends no booking request when
the schedule is invalid. The API independently applies the same rule and returns
`INSTALMENT_TOTAL_MISMATCH` with `required_minor`, `scheduled_minor`, signed
`difference_minor` (scheduled minus required), `minimum_minor`, `maximum_minor`
and `adjustment_minor`, all integer-penny strings. For the £3,000 remaining-balance
example, £2,994.99 requires at least £0.01 more.

Each instalment has a **Paid** checkbox. Unchecked rows are due; unpaid rows
dated before the business date are overdue. Marking a row paid offers two choices:

- **Record a new advance payment** records money not previously entered in the
  customer ledger. Saving atomically posts a GBP payment and links it to the
  booking and instalment. Enter the actual date received, which cannot be in the future.
- **Use an existing ledger payment** links the selected whole customer payment
  without posting the money again. Its full amount must match the instalment
  exactly; partial allocations and splitting one payment between instalments are
  unsupported. The selected payment supplies its amount and date in the form.

The payment summary separates **Paid so far**, **Remaining to pay** and
**Overdue** from the schedule difference. Remaining to pay and the upcoming schedule both use the booking
charge less received money. For a £5,000 booking with five
£1,000 instalments, marking the first two paid shows £2,000 received and £3,000
remaining. If just one unpaid instalment is past due, £1,000 is overdue.
Already-approved payments outside the marked rows are included once and reduce
unpaid overdue amounts. Overdue is capped by the remaining booking balance,
including legacy bookings with a different calculation target. The booking detail
retains Paid/Due/Overdue badges, payment dates and each row's remaining amount
after reload. Unlinked rows covered by other approved payments or by the booking
balance cap show **Settled**; other payments are allocated in due-date order.
On an explicit edit, the form starts with each unpaid row's current remaining
amount. The server retains paid rows and creates completed payment rows for
approved booking payments that have not yet been linked to a row. This preserves
payment history and prevents those payments from being deducted again from the
new remaining-balance schedule. Newly approved payments continue to settle due
rows in date order; reversing a payment makes its outstanding amount visible again.
Dashboard receivables also respect explicitly paid rows.

API instalment inputs accept `paid`, `paid_date` and `payment_entry_id`; PATCH
also accepts the persisted instalment `id`. New paid rows require `paid_date`
unless they link an existing entry, whose date is derived on the server. If an
explicit date accompanies an existing entry, it must match. Dates and entry IDs
must be omitted for unpaid inputs. `payment_entry_id` is a positive signed-bigint
decimal string, not a JavaScript number. The server permits only unreversed
payments owned by the same customer and organization, either unassigned or
approved for this booking and not yet assigned to an instalment. An entry can be
used by only one instalment. `payment-options` returns `id`, `amount_minor`,
`payment_date`, `description`, `reference` and `already_recorded_for_booking` for
each option; the latter prevents counting an existing booking payment twice in
the form preview. All options are checked again when saving.

Booking responses include `paid_minor`, `remaining_minor` and `overpaid_minor`
for all approved, unreversed payments linked to that booking. Remaining and
overpaid values are clamped at zero independently. Each returned instalment has
`paid`, nullable `paid_date`, nullable `payment_entry_id`, and nullable
`payment_source` (`booking_instalment` or `customer_receipt`). A reversed payment
does not leave an instalment marked paid. Request, response and error examples
are maintained locally in the [booking instalment OpenAPI contract](../postman/contracts/booking-instalments.openapi.json).

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
`departure_at`, `required_services`, `amount`, `schedule_basis`, optional
`existing_payment_entry_ids`, and `instalments`. The remaining-balance contract
uses the same unpaid-schedule validation as creation, and allows no upcoming rows
when fully paid. Paid rows retain their persisted IDs. Legacy callers can still
send optional `instalment_total` with the original full-schedule validation.
Changing only a legacy calculation total does not change the charge, invoice total
or customer balance. Changing the booking amount atomically reverses the existing
active charge and posts a replacement; the correction date cannot precede the
current charge. The date is used for any charge correction and for the implicit
remaining-balance row when an empty schedule is submitted.
Previously posted entries remain immutable. Changing a stored staff-recorded
instalment's paid amount or payment date posts a reversal of the old payment and
a replacement for the corrected amount/date. Marking it due posts only the
reversal. The reversal uses the current business date, never a date before the
original payment; a replacement uses the corrected date actually received.
This also applies when that staff-recorded instalment originally linked an
existing ledger payment. Unchanged paid rows keep their payment and do not post
another credit. Editing reference, departure, services or due dates alone does
not post new financial entries. Before/after booking and schedule
snapshots, reason and actor are retained in the audit. The response includes the
new booking `version`, current charge `effective_date`, and updated schedule.

To remove a persisted paid instalment, first mark it due and save its correction,
then remove it in a subsequent edit. In remaining-balance mode, omitting a paid
row that is still actively paid preserves it as payment history. Legacy requests
reject such omissions. Include persisted `id` values when editing; legacy callers
that omit IDs can retain unchanged matching rows, but cannot silently alter or
remove paid ones. An instalment linked to an approved customer submission keeps
its payment protected in the schedule: correct it in payment history before
changing its paid flag, amount or received date. Its due date remains editable.
Migration `025_booking_paid_instalments.sql` adds scoped unique payment links and
validates that a paid row matches its approved, unreversed booking payment.

`DELETE /{bookingId}` additionally requires `confirmation` equal to the current
booking reference exactly. It hides the booking from active lists, dashboard
calculations and document access; cancels pending file uploads; clears issuance;
and rejects pending payment submissions with an audit reason. It reverses the
current charge once. All entries belonging to the cancelled booking (including
earlier charge/payment revisions and their reversals) are excluded from account
totals, outstanding balances, paid totals, statements/exports, dashboard reports
and reminder calculations. This also applies to bookings cancelled before this
change. Independent account payments remain included. Migration
`029_cancelled_booking_aggregates.sql` provides the shared `account_ledger_entries`
reporting view; the underlying ledger is unchanged. A charge
already reversed manually is not reversed a second time. Receipts, documents,
booking snapshots and the ledger remain stored for audit. Authorized payment
history/receipt reads remain available, while submissions and reviews are blocked.
The response is `{id,cancelled:true,version,reversal_entry_id,retained_payments_minor:"0",excluded_payments_minor}`.
The excluded amount reports the booking's unreversed payments, now omitted from
account aggregates. Historical invoices remain audit snapshots.
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
