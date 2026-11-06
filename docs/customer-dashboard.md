# Customer dashboard and ledger

`GET /api/organizations/:orgId/dashboard?start=YYYY-MM-DD&end=YYYY-MM-DD`
requires an active administrator membership. The reporting period defaults to
the first day of the business's current month through today. It selects net
payment receipts and recent activity; customer balances, overdue instalments,
and upcoming departures always describe the current position.

`BUSINESS_TIME_ZONE` accepts an IANA time zone and defaults to `UTC`, preserving
the application's existing date convention. Dashboard calendar dates and
activity periods use this zone. Departures are stored as timestamps with an
offset, ordered by instant, and displayed in the business zone. Upcoming means
the next 168 hours; the urgent flag means the next 24 hours.

The overview counts customer records, not bookings. Outstanding money is the sum
of positive customer ledger balances; customer credits do not cancel another
customer's debt. Payments are net ledger payment movements in the selected
effective-date range, including reversals of payments on the reversal's date.
They can be negative when refunds/reversals exceed receipts in that period.

Instalment allocation is derived from the immutable ledger. Active payments and
negative opening balances settle receivables oldest first. Booking instalments
use their due dates; other charges and positive opening balances use their
effective dates. Existing unscheduled debt participates in this calculation so
a historical payment cannot settle both an old debt and a new booking. Reversed
payments restore unpaid amounts; reversing a booking charge removes its
instalment schedule from attention and departures. Scheduled arrears are capped
by the actual positive customer balance. A due date becomes overdue on the next
business calendar day. Current balances follow the existing ledger convention
of including all posted entries, including entries with future effective dates.

`GET /api/organizations/:orgId/customer-ledger` is the combined administrator
ledger. Supported filters are `start`, `end`, `search`, `kind=all|payment`,
`status=all|outstanding|settled|credit|overdue`, `min_balance`, `max_balance`,
`page`, and `page_size`. Dates filter displayed transactions; status and balance
filters select customers by their current position. Running balances retain
prior transactions. Totals include every matching entry, not just the page, and
current customer balances are counted once. Numeric balance limits are decimal
amounts in the workspace accounting currency.

Ledger search is case-insensitive and literal. It matches transaction IDs (with
or without a leading `#`), customer names, customer IDs and codes, email, phone,
transaction descriptions and references, type, currency, and effective dates in
`YYYY-MM-DD` or `DD Mon YYYY` form. Individual customer statements support the
same entry fields and the selected account's identity; CSV exports use the same
filters. Searching never changes the full running or current account balance.

`GET /api/organizations/:orgId/customers` supports `search`,
`status=all|active|archived`, `page`, `page_size`, and optional `start`/`end`
inclusive date-added bounds. Search matches name, customer code, UUID, email,
phone, and creation date in either date format above. Creation dates use
`BUSINESS_TIME_ZONE`; responses include `time_zone` and a `created_date` on each
customer for consistent display. Invalid or reversed date bounds return a
client error. Out-of-range pages clamp to the last available page.

The APIs preserve the workspace's accounting currency and integer minor units.
The customer-facing ledger views display GBP through the existing exact-money
currency conversion implementation; missing exchange rates display unavailable
amounts. New booking charges require a GBP accounting workspace. Existing
foreign-currency history is never relabelled or rewritten.

Document warnings count files by the service required by each booking. Empty
optional folders do not create warnings. Uploaded documents and service
issuance are separate facts. Existing audit events provide customer invitations,
bookings, payments, document uploads, and any recorded reminder history. This
change does not add reminder delivery; absence of a reminder event is reported
as no recorded reminder.

Focused coverage is in `tests/dashboard.test.ts`: customer counts, partial
payments, legacy settled debt, credit balances, reversals across reporting
periods, current-vs-period calculations, date and balance filters, pagination
totals, required document availability, departures, activity, time zones, and
administrator/tenant isolation. The ordinary HTTP suite also exercises the
dashboard route's session, administrator, and tenant authorization.
