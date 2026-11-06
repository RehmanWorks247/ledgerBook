# Booking payment receipts

Customers can attach one to five images to a payment submission inside their own booking. A submission records the amount in GBP, the customer's payment date, an optional note, and the server upload timestamp. It starts **pending** and does not change the ledger. An active organization administrator verifies the payment externally and either approves it or rejects it with a reason. Approval atomically posts exactly one negative payment entry to the customer's ledger, records the reviewer and review time, and queues an approval email to the customer. A rejected submission keeps its evidence and reason; the customer can submit corrected evidence as a new submission.

## API contract

All paths below have `/api/organizations/:orgId` as their prefix. All require a valid session. Mutations also require the configured origin and `X-CSRF-Protection: 1`.

| Method | Path | Input / behavior |
| --- | --- | --- |
| GET | `/customers/:customerId/bookings/:bookingId/payments` | Customer owner or admin; returns `{items,time_zone}`. |
| POST | `/customers/:customerId/bookings/:bookingId/payments` | Customer owner only. Multipart fields `amount` (positive GBP decimal text), `payment_date` (`YYYY-MM-DD`, not after today in `BUSINESS_TIME_ZONE`), optional `note` (1,000 characters maximum), and `idempotency_key` (UUID). Attach one to five files in repeated `receipts` fields. |
| GET | `/customers/:customerId/bookings/:bookingId/payments/:paymentId/receipts/:receiptId` | Customer owner or admin; private image response. Optional `?download=1` forces download. |
| POST | `/customers/:customerId/bookings/:bookingId/payments/:paymentId/approve` | Admin only, empty JSON object. Approves the submitted amount/date and posts one ledger payment. Repeated approval returns the existing approval. |
| POST | `/customers/:customerId/bookings/:bookingId/payments/:paymentId/reject` | Admin only, `{reason}`. The reason is required, trimmed, and limited to 1,000 characters. An identical retry returns the existing rejection. |
| GET | `/payment-submissions?status=pending` | Admin only. Searchable, paginated queue; returns `{items,time_zone,total,page,page_size,total_pages,counts}`. See filters below. |

Review queue filters can be combined:

- `status`: `pending` (default), `approved`, `rejected`, or `all`.
- `q`: up to 200 characters. Case-insensitive words match payment/customer/booking IDs, customer name/code/email, booking reference, payment and rejection notes, status, GBP amount, ledger entry ID, receipt filenames, and payment/submission/review dates. `%` and `_` are literal characters. Dates accept ISO, `DD/MM/YYYY`, and displayed dates such as `6 Nov 2026`; timestamp searches use the returned business timezone.
- `from` / `to`: inclusive payment-date boundaries in `YYYY-MM-DD`. Reversed or invalid ranges return HTTP 400.
- `page`: positive integer (default 1, maximum 1,000,000). `page_size`: 1–100 (default 25). Pages beyond the available results resolve to the last page; an empty queue returns page 1 and `total_pages: 1`.
- `sort`: `oldest` (default), `newest`, `amount_desc`, or `amount_asc`. Ordering includes a stable payment ID tie-breaker.

`total` counts all matching submissions for the selected status, including results beyond the current page. `counts` contains `pending`, `approved`, `rejected`, and `all` totals after search/date filtering but before the status filter. Unknown or repeated query parameters return HTTP 400. Customer authorization and organization boundaries apply before any queue data is returned.

Payment responses contain `id`, `customer_id`, `customer_name`, `customer_code`, `booking_id`, `booking_reference`, `amount_minor` (integer string), `currency`, `payment_date`, `note`, `status`, `submitted_at`, `reviewed_at`, `reviewed_by`, `rejection_reason`, `ledger_entry_id`, and `receipts`. Each receipt contains `id`, `name`, `mime_type`, `size`, and an authenticated `url`. Internal request hashes and original image bytes are never returned.

Use one idempotency key per submission attempt. Retain the key and the original files for retries after timeouts; a successful retry does not create another payment or email. Reusing the key with different fields or evidence returns a conflict. The same original image cannot be attached twice, or reused in another pending/approved submission for the same booking. Evidence from a rejected submission can be resubmitted with a new key.

## Storage, security, and limits

- JPEG, PNG and WebP only; maximum 5 MiB per file and five files per request. Multipart parsing rejects excess files, fields and parts. Authorization and rate limiting run before multipart buffering.
- Sharp fully decodes each file, checks its actual image format against its declared MIME type, rejects malformed and animated images, and limits input to 20 million pixels and 10,000 pixels on either dimension. Images are processed sequentially. They are auto-oriented and re-encoded to lossless WebP without metadata; normalized files must also fit 5 MiB. Original-byte SHA-256 hashes support duplicate detection.
- Receipts are private PostgreSQL `bytea` records. Submission data, images, audits and notification intents commit in one transaction. There are no public filesystem paths or unsigned storage URLs.
- A booking is limited to ten pending submissions, 100 total submissions, and 100 MiB of normalized receipt storage. Uploads are limited to 30 requests per customer login per hour; review actions to 120 per admin login per hour. A reverse proxy should additionally bound concurrent requests and slow-client upload duration for the deployment's available memory.
- Customer, booking and submission locks serialize reviews and uploads. Tenant-scoped foreign keys, immutable evidence/review triggers, and a unique ledger linkage protect financial history. Admin access and active customer status are rechecked inside the write transaction. Archived accounts cannot accept submissions or reviews. Reversed booking charges cannot accept new submissions or approvals.
- Approval is a historical decision about the evidence. A subsequent normal ledger reversal retains that decision and receipt history; it does not reopen the submission or authorize another approval. Use normal ledger correction procedures for accounting mistakes.
- This is manual verification of an externally completed payment; receipt submission never moves money at a payment provider. Administrators must compare the amount, date and recipient with their actual transaction records before approving.

## Notifications and operations

Submission queues an email for each currently active organization administrator, including the customer, booking reference, amount, reported payment date, UTC upload timestamp and authenticated booking link. Approval queues one email to the customer's account email. The outbox records are committed alongside the business change and use unique event keys. The application background worker polls every five seconds and delivers up to ten due messages per batch. Each claim holds a two-minute durable lease; another instance can reclaim work after that lease expires if a process stops. A failed delivery retries after 30 seconds, doubling the delay up to one hour. Retries continue indefinitely until the provider accepts the message, so operators should investigate persistent failures instead of assuming the event was discarded.

The admin-only `GET /api/organizations/:orgId/payment-email-status` returns `queued`, `retrying`, `sent` and `oldest_queued_at` for that organization. Use these counts to detect an email backlog. `retrying` includes claimed/in-flight work with at least one delivery attempt, as well as failed attempts awaiting their next due time. Message bodies, recipient addresses and provider errors are not exposed by this endpoint or written to logs.

Production uses the existing verified Resend sender and a stable `Idempotency-Key` per outbox event on every attempt. Resend retains idempotency keys for 24 hours. A rare ambiguous provider acknowledgement followed by an outage longer than that window can therefore produce a duplicate email; database approval and ledger posting still occur only once. Provider acceptance is not proof that the message reached the recipient's inbox. In local mode, emails are private `.eml` files in `.local/mail` (or `MAIL_DIRECTORY`), with deterministic payment filenames preventing repeated writes for the same event. These local messages are **not sent to real inboxes**.

Run `npm run db:migrate` before starting a deployed API with this feature. Migrations apply in filename order: `006_booking_payments.sql` creates evidence/review storage and `007_payment_email_outbox.sql` creates durable delivery storage. Both must be present before enabling the new API; the migration runner applies the set transactionally. Local startup applies migrations automatically. Include receipt bytes and outbox records in PostgreSQL backup, retention, disk-capacity and restore plans. Evidence and terminal review history are intentionally retained rather than offering an unaudited delete operation; the per-booking 100 MiB receipt quota does not replace monitoring total database storage across all customers.

## Verification

To exercise the actual email HTTP adapter without sending real messages, start the committed local provider simulation in one terminal:

```sh
postman simulation run postman/simulations/payment-email.sim.yaml --port 4017 --output ndjson --no-history
```

Then run `node --import tsx tests/payment-provider.simulation.ts` in another terminal. It verifies a provider error, durable retry and an idempotent replay. The mock was generated from the documented Resend send contract and extended with test-only controls. The installed Postman CLI 1.75.0 does not implement `postman status`, so no signed-in provider-owner mock search was available; no cloud workspace or mock was created. See `postman/simulations/payment-email.context.yaml` for the evidence and remaining live-delivery limitation.

`npm test` exercises genuine SQL constraints and transactions using isolated PGlite databases by default, together with multipart HTTP requests and real image decoding. Set `TEST_DATABASE_URL` to a disposable PostgreSQL database to run the same tests with independent production PostgreSQL connections and row locks. PGlite serializes transactions on one connection; its concurrency tests establish application idempotency but cannot by themselves prove PostgreSQL lock scheduling. No live production provider delivery is implied by local or simulated-provider tests.

Verified on 2026-11-06: all 101 API/database tests and 31 web tests passed, along with TypeScript checks, API/web builds, and lint. The 23 payment, multipart HTTP, and notification-worker tests also passed against disposable PostgreSQL 17 with independent connections, including concurrent approvals and worker claims. The provider simulation passed over real HTTP, and the production dependency audit reported zero known vulnerabilities. Browser visual verification could not run because computer use could not establish the active browser URL safely; actual Resend inbox delivery remains a deployment check.
