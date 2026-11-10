# Notifications and email delivery

Apply database migrations through `017_payment_email_queue_index.sql` before starting this version. Administrators can open **Settings → Notifications & reminders** to enable and edit automatic reminders, inspect email delivery, and turn reminders off for a selected customer. Customers can turn their own reminders off in Settings.

## Event coverage

| Event | Recipient | Delivery behavior |
| --- | --- | --- |
| Receipt submitted | Active organization administrators | Durable alert linking to the authenticated booking and its current review status. Never-attempted alerts are cancelled after review; attempted messages keep their original historical wording and idempotency key. |
| Receipt received | The customer who submitted it | Durable acknowledgment of evidence received for review. It does not confirm approval or credit the ledger. |
| Payment approved | Customer account | Durable confirmation after the ledger payment and approval commit together. |
| Payment rejected | The customer who submitted it | Durable notice with the rejection reason and booking link. Includes pending submissions rejected when a booking is cancelled. |
| Due or overdue instalment | Eligible customer | Durable reminder, only while workspace scheduling and the customer's preference permit it. |
| Account invitation | Invited account | Clerk sends invitations when Clerk authentication is selected. Local authentication uses the application's email adapter. Failed invitations remain visible and require an explicit resend; they do not use the payment outbox. |
| Password recovery | Account requesting recovery | Local authentication queues an in-memory job and drains it during graceful shutdown; it has no durable automatic retry queue. Clerk account recovery belongs to Clerk's authentication flow. |

Payment and reminder emails contain authenticated application links. Receipt images are not email attachments or public links. Repeated submissions and review requests do not duplicate notification intents. At send time the payment worker rechecks the submitting identity, current account email and active customer membership for customer messages, and current administrator access for review alerts. These checks prevent queued customer data from following revoked access or reassigned accounts.

## Automatic reminders

Automatic reminders default to **disabled** in every organization. Enabling them is an administrator action; deploying this feature does not start an email campaign. The default schedule checks once per calendar day at 09:00 in the configured business time zone, includes instalments due within three days, and repeats no sooner than seven days. Administrators can choose a time zone, send hour, 0–14 days of advance notice and a 1–30 day repeat interval. A customer receives at most one reminder during that interval, covering the earliest unpaid instalment. A stopped API catches up on the next worker pass after it resumes.

Time zone names are canonicalized to an IANA zone; bare numeric offsets are rejected to keep PostgreSQL and browser scheduling consistent. The settings form submits the version it loaded and rejects a conflicting update from another administrator while preserving unsaved input. The customer preference checkbox updates immediately and restores its previous value if saving fails.

The scheduler uses the same allocation calculation as the dashboard: payments settle receivables by due date and scheduled arrears never exceed the account balance. The worker checks the balance again immediately before sending. Settled balances, cancelled bookings, archived accounts, customer opt-outs, disabled reminder settings and suppressed addresses cancel queued reminders. Booking schedule changes preserve sent reminder history and cancel unsent notices tied to replaced instalments. Account deletion cascades reminder records and removes their audit history. The customer's lock coordinates the final check with payment settlement and account deletion. Receipt-review notification recipients are checked again at send time so a disabled administrator does not receive queued customer information.

Leases, retries, and scheduling claims live in PostgreSQL and can be used by multiple API instances. A reminder scan runs every 30 seconds, handles up to 20 due organizations, and each worker sends up to 20 queued messages per pass. Payment notifications retain their existing five-second worker. Network requests time out after ten seconds. Retries keep the same provider idempotency key and unchanged message body, with backoff up to one hour. Automatic attempts stop after 12 attempts or 23 hours from the first attempt, before Resend's documented 24-hour deduplication window ends. A failed row stays visible for investigation; the application does not blindly replay an old ambiguous send with a new key.

## Delivery tracking

Use `EMAIL_MODE=resend`, `RESEND_API_KEY`, and a verified `EMAIL_FROM` sender for production. In the Resend dashboard, create a webhook targeting `https://YOUR_APP_HOST/api/webhooks/resend` and subscribe to `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, and `email.suppressed`. Save its `whsec_...` signing secret as the server-only `RESEND_WEBHOOK_SECRET` and restart the API. Settings indicates whether this secret is configured; it does not claim that a provider endpoint was registered or a live event received.

The endpoint verifies the exact raw request body with HMAC-SHA256 and constant-time comparison, validates timestamps within five minutes, and deduplicates the signed `svix-id` durably. Only signature-verified webhook requests bypass browser CSRF protection. The provider message ID connects events to their payment or reminder message. Early events are retained and reconciled when the send response commits. Out-of-order events cannot downgrade a delivered, bounced or complained status to “sent.” Unknown valid event types receive a success response without changing business data. Invalid signatures, stale signatures and malformed supported events are rejected. Raw webhook bodies and provider error text are never stored or logged.

**Sent** means the provider accepted the request. **Delivered** means the recipient's mail server accepted it; this does not establish inbox placement or that the customer read it. **Delivery delayed** records a temporary provider delivery issue. Bounces, complaints and provider suppression events suppress subsequent payment/reminder sends to that address in the same organization. Suppressions store a SHA-256 address fingerprint rather than an extra email-address copy. They cannot be bypassed by toggling reminder preferences. Resolve sender/recipient problems with the provider before restoring delivery.

Local `EMAIL_MODE=file` writes application-owned email to private `.eml` files and reports acceptance without pretending that delivery occurred. These files are not sent externally. Clerk sends account emails separately: `EMAIL_MODE=file` does not disable Clerk invitations or recovery, and their existing invitation status is not a Resend delivery report.

### Sender name and Gmail spam diagnosis

Use `Umrah Packages Ltd <your-existing-verified-address>` in `EMAIL_FROM` to set
the name on invoices, payment notifications and reminders without changing the
address. Clerk account email uses the application name in **Configure →
Application → Settings**, independently of `EMAIL_FROM`. On 2026-11-11 this was
saved as **Umrah Packages Ltd** and verified in the verification-email preview.

The local Clerk instance is a development instance. Its authentication emails
use `notifications@accounts.dev`; Resend DNS settings and subscription changes
do not affect them. The live app at `https://crm.umrahpackagesuk.com` already
uses a separate production Clerk instance on `umrahpackagesuk.com`. Its
application name was also saved as **Umrah Packages Ltd** and confirmed through
the production frontend API on 2026-11-11. Keep production and development
users and credentials separate.

Clerk's Hobby plan includes a custom domain, but the attempted production
template sender customization was rejected with HTTP 402 and the feature
`app:custom_email_template`. The user declined the $25/month Pro upgrade.
Clerk remains on Hobby; the authentication templates were not changed. A
shared `noreply` address is therefore not recorded as completed. The production
notification sender retains its verified address with the new company name:
`Umrah Packages Ltd <notifications@mail.umrahpackagesuk.com>`.

Gmail inbox placement must be checked separately; a paid plan, a successful
API call or a provider delivery event does not guarantee it.

During the 2026-11-11 Gmail inspection, the most recent Clerk invitation was
already in the inbox and two older invitations were in Spam. Gmail attributed
the older message to similarity with previously classified spam; its original
message summary showed SPF, DKIM and DMARC all passing for `accounts.dev`.
Both legitimate older invitations were marked **Not spam** and Gmail confirmed
they moved to the inbox. This is recipient-specific feedback, not proof of
future inbox placement for other recipients. No broad bypass filter was added
and no paid plan was purchased.

Provider references checked on 2026-11-11: [Clerk email delivery](https://clerk.com/docs/guides/development/troubleshooting/email-deliverability),
[environment differences](https://clerk.com/docs/guides/development/managing-environments),
[production setup](https://clerk.com/docs/guides/development/deployment/production),
and [Clerk pricing](https://clerk.com/pricing).

Real inbox delivery also works from localhost. For `npm run local` / `npm start`, set `EMAIL_MODE=resend`, a verified `EMAIL_FROM` and `RESEND_API_KEY` in the private `.local/email.env`, then restart. Keep `PUBLIC_APP_URL` set to the browser's localhost origin. Run `npm run email:test -- --to you@example.com` to send one diagnostic message using that configuration without starting a database or notification worker. `npm run dev:api` uses the same private email file when present, falling back to `.env` email settings when absent; the split browser origin is normally `http://localhost:5173`. Both launchers use Clerk for invitations and password recovery. A tunnel is only needed for incoming webhook events or links opened from another device. Without incoming events, local status remains accepted even after actual inbox delivery.

## Local and production activation

For fully offline verification, use `tests/test-environment.cjs`: it selects local authentication, file email and isolated test storage, and removes live delivery credentials before loading application configuration. The provider simulations below inject a loopback URL and synthetic credentials; they do not start the deployed application workers or send real messages.

Payment submission/review notifications run automatically with the API's payment worker. They have no separate workspace enable switch. Automatic reminders remain disabled until an administrator enables the workspace schedule; customer opt-outs still apply. Enabling the schedule in file mode produces local files only.

For live application email, configure `EMAIL_MODE=resend`, a verified `EMAIL_FROM`, server-only `RESEND_API_KEY` and the production HTTPS `PUBLIC_APP_URL`, then restart the API. Apply migrations first. Configure and verify the webhook described above to receive delivery outcomes; setting a signing secret alone neither registers the provider webhook nor proves connectivity. A controlled test to an authorized recipient must separately establish provider acceptance, a signed delivery event, and the message's actual arrival. Live Clerk account email requires its own correctly configured Clerk instance. Local simulation results do not establish either provider's live sender setup.

## Verification

`tests/reminder-delivery.test.ts` exercises scheduler timing, interval limits, duplicate workers, retries, settlement, cancellation, opt-out, account removal, signature forgery/replay and early/out-of-order provider events. `tests/reminder-review.test.ts` covers stale settings, recipient consistency and PostgreSQL interleavings between sends, settlement, deletion and early signed webhooks. `tests/notification-http.test.ts` exercises real HTTP settings authorization, CSRF, raw-body verification, payload limits and payment delivery/suppression. The signature implementation matches the published Svix vector. `apps/web/tests/notification-settings.test.ts` checks delivery wording and safe rendering. Run with `npm test`; use `TEST_DATABASE_URL` for PostgreSQL connection/locking coverage in an isolated test schema.

The committed Postman simulation exercises the real HTTP provider adapter without sending email:

```sh
postman simulation run postman/simulations/payment-email.sim.yaml --port 4017 --output ndjson --no-history
# In another terminal:
node --require ./tests/test-environment.cjs --import tsx tests/payment-provider.simulation.ts
node --require ./tests/test-environment.cjs --import tsx tests/reminder-provider.simulation.ts
```

On 2026-11-10, the payment simulation passed for six messages generated by genuine submission/review calls: two administrator alerts, two customer acknowledgments, one approval and one rejection. Each event independently produced HTTP 500, 200, 200, with one modeled acceptance after retry/replay; repeated business requests created no extra notification intent. The reminder simulation also passed its retry and signed synthetic delivery-event correlation checks.

These tests establish application behavior against the local provider contract stand-in and signed synthetic webhook requests. A production webhook connection and actual inbox delivery still require a deployed HTTPS endpoint, configured provider credentials and a controlled delivery to a real authorized address.

Provider references checked on 2026-11-09: [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys), [webhook verification](https://resend.com/docs/webhooks/verify-webhooks-requests), [delivered event](https://resend.com/docs/webhooks/emails/delivered), [bounced event](https://resend.com/docs/webhooks/emails/bounced), [Svix manual signature contract and test vector](https://docs.svix.com/receiving/verifying-payloads/how-manual).
