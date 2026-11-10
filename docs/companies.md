# Companies

**Companies** is a standalone register in the administrator sidebar. It has one
table with one row per company. Administrators can add, edit, delete, search and
filter these rows manually. Company rows belong to the selected workspace and
are unavailable to customer accounts.

Each row contains company name, hotel name, customer name, check-in, check-out,
room type, booking date, voucher number, voucher price, paid, unpaid, balance and
remarks. Company name is required; all other spreadsheet fields are optional.
Names and room type accept up to 200 characters, voucher number 100, and remarks
2,000. Dates use `YYYY-MM-DD` and check-out cannot precede check-in.

The four money fields are independent, manually entered values in the
workspace's currency. Blank values remain blank and zero remains zero. Balance
may be negative; voucher price, paid and unpaid cannot be negative. Saving a row
does not create or change customers, bookings, payments, invoices, reminders or
ledger entries. Names are plain text rather than account links.

## API

All paths are below `/api/organizations/:orgId/companies`. The endpoints require
an authenticated, active administrator in that workspace. Mutation requests also
require the configured `Origin` and `X-CSRF-Protection: 1` headers.

| Method | Path | Request and response |
| --- | --- | --- |
| `GET` | `/` | Returns `{ items, total, page, page_size, currency, currency_exponent }` |
| `POST` | `/` | Company fields plus UUID `idempotency_key`; returns the created row |
| `PATCH` | `/:id` | Changed fields plus `expected_version`; returns the updated row |
| `DELETE` | `/:id` | `{ expected_version }`; returns `{ id, deleted: true }` |

Optional text defaults to `""`; dates and money default to `null`. Input money
fields are decimal strings named `voucher_price`, `paid`, `unpaid` and `balance`.
Responses expose their exact minor-unit values as nullable strings named
`voucher_price_minor`, `paid_minor`, `unpaid_minor` and `balance_minor`. Precision
follows the workspace currency exponent, with a maximum absolute value of
100,000,000,000,000 minor units. All amounts are parsed with `BigInt`.

Listing accepts `search` (up to 200 characters), `date_field` (`booking_date`,
`check_in` or `check_out`), inclusive `start` and `end` dates, `page` (default 1)
and `page_size` (default 25, maximum 100). Booking date is the default filter.
Search is case-insensitive literal substring matching across company name,
hotel name, customer name, room type, voucher number and remarks; `%` and `_`
are ordinary text. Rows with blank dates are excluded when a date boundary is
applied. Newest rows appear first, with stable ID ordering for equal timestamps.

Creation uses workspace-scoped submission keys. An identical retry returns the
original creation response, even after the row is edited. Reusing a key with
different values or after deleting its company returns `409`. Edits and deletion
also return `409` when their version is stale. A no-op edit keeps the current
version. Unknown request fields, invalid dates and unsupported precision return
`400`. Reads are limited to 240/minute/user and writes to 240/hour/user.

See the [OpenAPI contract](../postman/contracts/companies.openapi.json) for the
complete request and response schemas.

## Storage and verification

Apply migration `021_companies.sql` before serving the updated application and
reapply `deploy/runtime-grants.sql` if a separate runtime role is used. The
`companies` table references only its workspace. Company deletion clears the
stored creation snapshot, retaining an opaque request receipt to reject delayed
retries. Workspace deletion cascades through company rows and their receipts.
Membership checks and writes share a transaction and coordinate with workspace
revocation and deletion using the existing organization locks.

The focused HTTP suite covers manual fields, precision, zero and blank values,
date filters, search, pagination, idempotency, version conflicts, authorization,
workspace isolation and independence from other modules:

```sh
node --require ./tests/test-environment.cjs --import tsx --test tests/companies-http.test.ts
```

It runs against isolated PGlite databases by default; set `TEST_DATABASE_URL` to
a disposable PostgreSQL database to exercise the same contract there.
