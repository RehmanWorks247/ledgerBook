# Booking invoices

Invoice numbers use one unique increasing sequence: `Inv-up001`, `Inv-up002`,
`Inv-up003` (continuing to `Inv-up1000` and beyond). Each issued version has its
own number. Internal UUIDs remain stable for links and authorization. Failed
transactions may leave gaps; numbers are never reused.

Migration `030_sequential_invoice_numbers.sql` and its transactional data hook
renumber existing invoices in issue order and regenerate their saved PDFs from
their saved snapshots. Only the invoice number and filename change in each
snapshot; financial values, issue dates and identities are preserved. An audit
event maps each previous number to its replacement. No emails are sent.
After this explicit one-time renumbering, ordinary invoice immutability continues.

Invoice history offers **Preview** and **Download**. Preview opens the same
authenticated PDF in the in-app viewer with page and zoom controls.

Every new administrator-created booking commits an invoice PDF, a financial snapshot, and a queued customer confirmation in the same database transaction as its charge and schedule. The confirmation carries that exact PDF. Approving a customer payment creates a new invoice version and attaches it to the existing approval email. Email-provider calls run in the durable worker after commit.

## Financial behavior

- Only approved payments explicitly linked to this booking count as paid. Pending/rejected receipt evidence, reversed payments, and unallocated account-level ledger payments do not count.
- Amounts use integer minor units and `BigInt` calculations, never floating-point money. Booking accounting is GBP with two decimals, consistent with the existing booking contract.
- Booking edits, payment approvals/reversals, direct booking-charge reversals, and cancellations append versions. Retries replay their existing event and cannot create another version. Concurrent changes serialize on the account and booking locks.
- Overpayment is displayed as customer credit. Cancellation/reversal sets the collectible booking total to zero; the historical snapshot retains approved money and the original booking amount. Cancelled bookings and their linked payments are excluded from current account totals and reports.
- PDFs and snapshots are immutable. A later customer name, booking reference, payment, or template change cannot rewrite an earlier invoice. Ordinary update/delete is rejected by the database; authorized permanent account/workspace deletion purges invoices with their booking.
- A pre-existing booking receives one `legacy_snapshot` at its first invoice-history visit or immediately before its first subsequent invoice-producing mutation. This records the current state; the application does not invent historical invoice versions or email old bookings during migration.

## UI and API

Administrator booking details include an invoice-history table, latest first, with total, paid, balance, issue time, PDF preview and downloads. Approved payments and saved booking edits refresh this history. The administrator bookings list's **Booking status → Include cancelled** option opens read-only invoice history for cancelled bookings.

Both endpoints require a live organization membership and access to the exact customer/booking:

| Method and path | Response |
| --- | --- |
| `GET /api/organizations/:orgId/customers/:customerId/bookings/:bookingId/invoices` | `{invoices, has_more, next_before_version}`; `limit` defaults to 25, maximum 100; optional positive `before_version` cursor |
| `GET /api/organizations/:orgId/customers/:customerId/bookings/:bookingId/invoices/:invoiceId/pdf` | Saved `application/pdf` bytes with attachment disposition, private/no-store cache control and download concurrency limits |

Amounts in JSON are decimal strings of minor units. Invoice versions have an immutable UUID, unique invoice number, version, reason, issue timestamp, status, filename, and financial totals. The API contract is in `postman/contracts/booking-invoices.openapi.json`.

## Email and recovery

The existing `payment_email_outbox` also queues booking confirmations and references an exact `invoice_id`. The worker retains the same attachment, body and provider idempotency key across retries, even if a newer invoice exists. Recipient/account checks, workspace deletion, suppression, durable leases, exponential retry delays, and the existing retry cutoff apply. New customers can receive their booking confirmation before accepting an invitation. Local file delivery emits a multipart `.eml` containing the PDF; Resend receives its base64 content.

The invoice is persisted before email delivery. A provider outage leaves the notification queued without losing the booking or invoice. A database failure during invoice or outbox creation rolls back the complete booking/payment mutation. Email status remains visible through the existing delivery-status endpoint and webhook tracking. Provider acceptance alone does not establish inbox delivery.

## Template and deployment

The renderer is `apps/api/src/invoices/invoice-pdf.ts`. Template version 3 follows the supplied payment invoice: the original Umrah Packages UK logo and company contact details, black-and-gold angled bands, guest details, a two-column booking table, an included-services checklist and total/received/balance amounts. The company branding is fixed to the supplied PDF, as requested; it does not come from the workspace name. The issue date, customer name/email/phone, booking reference, departure, selected services and financial amounts come from the immutable snapshot. The phone is captured at issuance; blank optional contact fields are omitted.

**Included services** shows only the checkboxes selected in the create/edit booking form, using the same labels and order: Flight Tickets, Makkah Hotel, Madinah Hotel, Transfers, Visas and Extras. Each selected item has a vector-drawn ticked checkbox in a two-column panel. Unchecked services are omitted; selecting none omits the entire panel. Saving a booking edit captures the revised selection in the new invoice version while earlier PDFs retain their original selection.

The PDF omits internal reasons, customer codes, audit explanations, version commentary and instalment schedules. The invoice number remains in a small footer. Credits are labelled explicitly, and cancelled/reversed bookings retain a visible status. The booking table uses **Description / Details** because passenger quantities, named hotels and room details are not stored by the booking model. Those sample values and empty address fields are omitted. Long fields continue on branded pages without overwriting the footer. Existing saved PDFs remain unchanged; new invoice versions use the new template.

The original logo is bundled in `invoice-brand.json`. Licensed Poppins regular/bold fonts and the Unicode fallback travel with compiled builds through `invoice-style-fonts.json` and `invoice-font.json`; no browser process, host fonts, filesystem writes or network requests are needed for rendering. Font sources, checksums and licenses are embedded in the assets. Unsupported glyphs are written explicitly as Unicode code points, including in mixed-script names. PDF bytes are stored in PostgreSQL (maximum 2 MiB each) and included in normal database backups; invoice history queries do not load PDF bytes.

Deploy with migration `020_booking_invoices.sql` before starting this application version, and reapply `deploy/runtime-grants.sql` using the existing release process. No new secrets or email settings are required. Do not run old application instances that can mutate bookings/payments without creating invoice versions alongside this release; drain old writers during rollout. The migration does not backfill or send customer emails.

## Verification

- `tests/invoices.test.ts`: core snapshot, renderer, legacy and database-history behavior.
- `tests/invoice-workflow.test.ts`: real HTTP authorization/downloads, booking retries, partial/full/overpayments, reversals, concurrent approvals, amendments/cancellations and rollback.
- `tests/invoice-email.test.ts`: attachments, recipient checks and immutable delivery retries.
- `tests/invoice-email.simulation.ts`: real HTTP through the committed local Resend stand-in, including failure/retry and attachment identity.
- `apps/web/tests/invoices.test.ts`: pagination, stale responses, revoked access, download validation and rendering.
- `e2e/invoices.spec.ts`: actual browser downloads, approval refresh without reload, customer access, mobile layout and cancelled invoice history.
- `e2e/invoice-services.spec.ts`: create/edit checkbox selections in downloaded PDFs, automatic history refresh, clearing all services and preserving earlier PDFs.

Set `TEST_DATABASE_URL` to an isolated PostgreSQL instance when checking production row locks. The default PGlite tests exercise SQL and triggers but use a single queued connection. No live-provider or production deployment is implied by these local checks.

Verification on 10 November 2026: the full suite passed 356 backend tests against disposable PostgreSQL and 95 frontend tests, with no failures or skips. Invoice lifecycle/email tests also passed on PGlite. TypeScript, ESLint, API/web/operations production builds and the dependency audit passed. The local Resend simulations exercised exact attachment bytes through failures, retries and replays without sending real email.

All 20 Chromium browser scenarios passed, including creating a booking through the UI, downloading the actual PDF, approving a payment and seeing the next version without reload, preserving earlier bytes, customer downloads, a 390 px mobile layout, and access after cancellation. The focused invoice scenario also passed on WebKit.

A restricted PostgreSQL runtime role could create/read invoices, while invoice update/delete, direct purge-context writes, private purge-helper calls and nonadministrator purges were rejected. Authorized customer deletion removed all invoice versions and attachment outbox records. A local compiled-code sample measured invoice creation/persistence at a 22.66 ms median / 31.59 ms p95 (20 sequential samples), rendering at a 14.89 ms median (50 samples), and paginated history/download reads around 3 ms. These measurements establish local behavior, not production throughput guarantees.

## Consumer invoice payments

My Account lists the latest outstanding invoice for each active booking, newest first, with its booking reference, remaining balance, PDF preview and payment action. The payment form requires selecting a current invoice and submits to that booking's payment endpoint with `invoice_id`. Older, settled, cancelled and foreign invoice selections are rejected inside the payment transaction. Fully settled accounts have no payable invoices, including those settled by independent account credits.

`GET /organizations/:orgId/customers/:customerId/invoices/outstanding` supplies the picker. A selected invoice remains attached to payment history after approval issues a newer invoice. Retrying the original submission key returns the original payment even after a newer invoice exists. Legacy booking clients omitting the ID are bound to the latest invoice automatically; the existing independent account-payment API remains available for unallocated transfers. Payments continue to use transfer details and optional receipt uploads with administrator approval.

## Departure and acceptance emails

The reminder worker scans every 30 seconds. Active trips receive a luggage preparation email at 72 hours before their departure timestamp and a taxi/airport preparation email at six hours before departure. Each stage is deduplicated per booking and departure timestamp. Late scans send only the currently applicable stage. Delivery rechecks the current timestamp, account, recipient and cancellation status; queued reminders expire at the next stage or departure. Rescheduling creates a fresh schedule for the new departure timestamp. No travel reminders are sent after departure.

Departure reminders are automatic and independent of payment-reminder settings and paid balances. Due reminders retain their opt-in settings and recheck both the due amount and live account balance before sending. Settled accounts receive no due reminders. Payment schedule changes and payment corrections invalidate only due reminders.

Invitation acceptance atomically queues one email per active workspace administrator, including the customer's name and email and a link to their record. The existing durable email worker retries failures and rechecks administrator access before sending. Notification history distinguishes departure, payment and invitation emails.
