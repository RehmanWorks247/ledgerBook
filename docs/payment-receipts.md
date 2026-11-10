# Booking payment receipts

Customers can attach one to five PDFs or images to a payment submission inside their own booking. A submission records the amount in GBP, the customer's payment date, an optional note, and the server upload timestamp. It starts **pending**, queues a customer acknowledgment and administrator review alerts, and does not change the ledger. An active organization administrator verifies the payment externally and either approves it or rejects it with a reason. Approval atomically posts exactly one negative payment entry to the customer's ledger, records the reviewer and review time, and queues an approval email to the customer. Rejection preserves the evidence and queues the reason and booking link for the submitting customer; corrected evidence can be submitted as a new submission.

## API contract

All paths below have `/api/organizations/:orgId` as their prefix. All require a valid session. Mutations also require the configured origin and `X-CSRF-Protection: 1`.

| Method | Path | Input / behavior |
| --- | --- | --- |
| GET | `/customers/:customerId/bookings/:bookingId/payments` | Customer owner or admin; returns `{items,time_zone}`. |
| POST | `/customers/:customerId/bookings/:bookingId/payments` | Customer owner only. Multipart fields `amount` (positive GBP decimal text), `payment_date` (`YYYY-MM-DD`, not after today in `BUSINESS_TIME_ZONE`), optional `note` (1,000 characters maximum), and `idempotency_key` (UUID). Attach one to five files in repeated `receipts` fields. |
| GET | `/customers/:customerId/bookings/:bookingId/payments/:paymentId/receipts/:receiptId` | Customer owner or admin; private image or PDF response. Optional `?download=1` forces download. |
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

Payment responses contain `id`, `customer_id`, `customer_name`, `customer_code`, `booking_id`, `booking_reference`, `amount_minor` (integer string), `currency`, `payment_date`, `note`, `status`, `submitted_at`, `reviewed_at`, `reviewed_by`, `rejection_reason`, `ledger_entry_id`, and `receipts`. Each receipt contains `id`, `name`, `mime_type`, `size`, and an authenticated `url`. Internal request hashes and original image bytes are never returned; PDFs retain their original bytes.

Use one idempotency key per submission attempt. Retain the key and the original files for retries after timeouts; a successful retry does not create another payment or email. Reusing the key with different fields or evidence returns a conflict. The same original receipt file cannot be attached twice, or reused in another pending/approved submission for the same booking. Evidence from a rejected submission can be resubmitted with a new key.

## Storage, security, and limits

- PDF, JPEG, PNG and WebP; maximum 5 MiB per file and five files per request. Multipart parsing rejects excess files, fields and parts. Authorization and rate limiting run before multipart buffering.
- Sharp fully decodes each image, checks its actual image format against its declared MIME type, rejects malformed and animated images, and limits input to 20 million pixels and 10,000 pixels on either dimension. Images are processed sequentially. They are auto-oriented and re-encoded to lossless WebP without metadata; normalized files must also fit 5 MiB. Original-byte SHA-256 hashes support duplicate detection.
- Receipts are private PostgreSQL `bytea` records. Submission data, images, audits and notification intents commit in one transaction. There are no public filesystem paths or unsigned storage URLs.
- A booking is limited to ten pending submissions, 100 total submissions, and 100 MiB of normalized receipt storage. Uploads are limited to 30 requests per customer login per hour; review actions to 120 per admin login per hour. A reverse proxy should additionally bound concurrent requests and slow-client upload duration for the deployment's available memory.
- Customer, booking and submission locks serialize reviews and uploads. Tenant-scoped foreign keys, immutable evidence/review triggers, and a unique ledger linkage protect financial history. Admin access and active customer status are rechecked inside the write transaction. Archived accounts cannot accept submissions or reviews. Reversed booking charges cannot accept new submissions or approvals.
- Approval is a historical decision about the evidence. A subsequent normal ledger reversal retains that decision and receipt history; it does not reopen the submission or authorize another approval. Use normal ledger correction procedures for accounting mistakes.
- This is manual verification of an externally completed payment; receipt submission never moves money at a payment provider. Administrators must compare the amount, date and recipient with their actual transaction records before approving.

## Notifications and operations

| Event | Recipient | Message |
| --- | --- | --- |
| Receipt submitted | Each active organization administrator | Customer, booking, amount, payment date, upload time and a link to check the current review status. |
| Receipt received | The customer who submitted it | Acknowledgment that the evidence was received for review; it does not confirm payment approval or account credit. |
| Payment approved | Customer account | Approved amount/date and an authenticated booking link. |
| Payment rejected | The customer who submitted it | Rejection reason and an authenticated booking link. Cancellation of a booking also notifies customers about pending submissions rejected by that cancellation. |

Emails link to the authenticated booking. Receipt images remain private in the application and are not embedded or attached to email. Notification intents commit alongside the business change and use unique event keys; replaying the same submission or decision does not create extra messages. Administrator alerts that have never been attempted are cancelled once the submission is reviewed. A previously attempted alert retains its original body and key on retry, describes the submission as a historical event, and directs the administrator to check its current status.

The background worker polls every five seconds and sends up to ten due messages per batch. Each claim holds a two-minute durable lease; another instance can reclaim work after that lease expires if a process stops. A failed request retries after 30 seconds, doubling the delay up to one hour. Automatic provider attempts stop after 12 sends or 23 hours from the first attempt, whichever limit is reached first. Failed records remain visible for investigation. Disabled administrator access, unavailable customer accounts and organization-scoped recipient suppressions can cancel queued sends; see [notification behavior and activation](notifications.md).

The admin-only `GET /api/organizations/:orgId/payment-email-status` returns `queued`, `retrying`, `sent`, `delivered`, `bounced`, `complained`, `failed`, `suppressed` and `oldest_queued_at` for that organization. Use these counts to detect an email backlog. `retrying` includes claimed/in-flight work with at least one delivery attempt, as well as failed attempts awaiting their next due time. Message bodies, recipient addresses and provider errors are not exposed by this endpoint or written to logs.

Production uses a configured verified Resend sender and a stable `Idempotency-Key` per outbox event on every attempt. The worker stops automatic retries before the provider's documented 24-hour deduplication window expires. Investigate the provider's acceptance record before manually replaying an ambiguous failed send; the application does not reset its key automatically. Database approval and ledger posting still occur only once. **Sent** means provider acceptance. **Delivered** requires a verified delivery event and still does not prove inbox placement or that the message was read. In local `EMAIL_MODE=file`, application emails are private `.eml` files in `.local/mail` (or `MAIL_DIRECTORY`), with deterministic filenames preventing repeated writes for the same event. These files are **not sent to real inboxes**; Clerk account emails use a separate provider setting.

Run `npm run db:migrate` before starting a deployed API with this feature. Apply all current migrations in filename order through `017_payment_email_queue_index.sql`, including `006_booking_payments.sql` for evidence/reviews, `007_payment_email_outbox.sql` for durable notification intents and `015_reminders_delivery.sql` for delivery tracking and suppression. Migration 017 keeps terminal failed/cancelled rows out of the active queue index. The migration runner applies the set transactionally. Local startup applies migrations automatically. Include receipt bytes and outbox records in PostgreSQL backup, retention, disk-capacity and restore plans. Evidence and terminal review history are intentionally retained rather than offering an unaudited delete operation; the per-booking 100 MiB receipt quota does not replace monitoring total database storage across all customers.

## Verification

To exercise the actual email HTTP adapter without sending real messages, start the committed local provider simulation in one terminal:

```sh
postman simulation run postman/simulations/payment-email.sim.yaml --port 4017 --output ndjson --no-history
```

Then run `node --require ./tests/test-environment.cjs --import tsx tests/payment-provider.simulation.ts` in another terminal. It creates real payment submissions, approvals and rejections in an isolated test database, checks event deduplication, and sends each event through the actual HTTP adapter against a modeled provider error, retry and idempotent replay. It uses synthetic sender/recipient data and the loopback endpoint only. The mock was generated from the documented Resend send contract and extended with test-only controls. The installed Postman CLI 1.75.0 does not implement `postman status`, so no signed-in provider-owner mock search was available; no cloud workspace or mock was created. See `postman/simulations/payment-email.context.yaml` for the evidence and remaining live-delivery limitation.

`npm test` exercises genuine SQL constraints and transactions using isolated PGlite databases by default, together with multipart HTTP requests and real image decoding. Set `TEST_DATABASE_URL` to a disposable PostgreSQL database to run the same tests with independent production PostgreSQL connections and row locks. PGlite serializes transactions on one connection; its concurrency tests establish application idempotency but cannot by themselves prove PostgreSQL lock scheduling. No live production provider delivery is implied by local or simulated-provider tests.

Verified on 2026-11-10: the expanded provider simulation passed all six submission/review messages, with each independently surviving HTTP 500 and producing one modeled acceptance after retry and replay. It also verified submission/review business deduplication, customer acknowledgment wording, and rejection reasons with authenticated booking links. These results do not establish actual Resend delivery.

Historical baseline on 2026-11-06: all 101 API/database tests and 31 web tests passed, along with TypeScript checks, API/web builds, and lint. The 23 payment, multipart HTTP, and notification-worker tests also passed against disposable PostgreSQL 17 with independent connections, including concurrent approvals and worker claims. The provider simulation passed over real HTTP, and the production dependency audit reported zero known vulnerabilities. Browser visual verification could not run in that check because computer use could not establish the active browser URL safely; actual Resend inbox delivery remains a deployment check.

PDF receipts require the PDF MIME type, a `.pdf` filename, a PDF header and an end-of-file marker. Original PDF bytes are preserved, served only after the same customer/admin authorization, and rendered by the existing PDF viewer with page navigation and original-file download. PDF and image files can be mixed within the five-file limit. Migration 024 extends the stored receipt MIME constraint without changing existing evidence or approvals.
