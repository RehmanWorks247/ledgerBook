# Companies

**Companies** opens three administrator cards: **Muhabiya Hotels**, **Aden
Golden**, and **Al Subaee**. Each opens its voucher table at
`/o/:orgId/companies/:companySlug`, with slugs `muhabiya-hotels`, `aden-golden`,
and `al-subaee`. The cards stack on mobile. **All companies** returns to the grid.
Customer accounts cannot access either page or the underlying API.

**Add Voucher** opens the existing customer, hotel, dates, room, voucher and
remarks form. Company name is selected automatically. Numeric **Quantity** sits
immediately before room type, defaults to 1, and accepts whole numbers from 1
through 1,000,000. Quantity is informational: the entered **Voucher total** is
for the whole voucher and is never multiplied by quantity. Other entry fields
are optional. Text limits are 200 characters for names and room type, 100 for
voucher number, and 2,000 for remarks. Check-out cannot precede check-in.

## Company totals and paid

Above the table, **Company totals** shows voucher total, total paid, unpaid and
balance. **Edit paid** opens one separate **Paid** field for the whole company.
Enter the total paid to date, not an additional payment. Paid is not allocated
to individual vouchers and is never automatically changed by adding, editing
or deleting a voucher.

- Voucher total = sum of every voucher's full price in this company.
- Total paid = the separately saved company paid amount.
- Balance = voucher total − total paid; a negative balance is credit.
- Unpaid = the greater of balance and zero.

These aggregates always cover the entire company, even when the table is
searched, date-filtered or paginated. If any voucher has an unknown price, total,
unpaid and balance stay blank with a count of vouchers awaiting prices. Paid
remains visible. An empty company has a zero voucher total and can still have
an independent paid amount. Individual voucher rows show only their voucher
price, without separate paid or balance fields.

Company amount labels are fixed to **SAR**. This is a display-label change only:
numeric values, storage and decimal precision are unchanged, with no exchange
conversion. Voucher prices
allow zero and at most 100,000,000,000,000 minor units. The company paid field
allows zero and up to 27 whole digits plus the currency's permitted decimal
places. Saving company records does not create or change customer accounts,
bookings, booking payments, invoices, reminders or ledger entries.

## Excel preview and download

Inside each company, **Preview Excel** opens a spreadsheet-style view with
column letters, row numbers, and **Records** / **Summary** sheets. Preview pages
contain up to 100 rows. **Download Excel** saves a company-named `.xlsx` file
containing every company record and the shared paid amount, total, unpaid and
balance. Both sheets use SAR labels without converting amounts. The export
always covers the whole company, regardless of table search, dates or page.

Records and aggregates are read in one database snapshot. Voucher numbers and
formula-like user text stay literal; ordinary quantities and amounts are numeric
Excel cells. Amounts beyond Excel's 15-digit precision are exact text. Unknown
amounts remain blank. An empty company can still download its summary. The
workbook has frozen headers and record filters.

## API

All paths are below `/api/organizations/:orgId/companies`. They require an
active administrator in the workspace. Mutations also require the configured
`Origin` and `X-CSRF-Protection: 1` headers. JSON requests are limited to 16 KB.

| Method | Path | Request and response |
| --- | --- | --- |
| `GET` | `/` | `{ items, total, page, page_size, currency, currency_exponent, totals }` |
| `GET` | `/export?company_name=...` | All company records and totals in one snapshot; same data as list without pagination, plus `company_name`; currency label is SAR |
| `POST` | `/` | Voucher fields and UUID `idempotency_key`; returns the new row |
| `PATCH` | `/:id` | Changed voucher fields and `expected_version`; returns the row |
| `DELETE` | `/:id` | `{ expected_version }`; returns `{ id, deleted: true }` |
| `PATCH` | `/paid` | `{ company_name, paid, expected_version }`; returns `{ company_name, paid_minor, version }` |

Voucher requests accept decimal text `voucher_price` (the full total), numeric
`quantity`, and the text/date fields. Optional text defaults to `""`; dates and
price default to `null`. Responses use exact `voucher_price_minor` strings.
Row-level `paid`, `unpaid`, `balance` and `payments` inputs are rejected.

`totals` contains nullable `total_minor`, `balance_minor` and `unpaid_minor`,
non-null `paid_minor`, `unpriced_count`, `voucher_count`, and `paid_version`.
For one selected company, use `paid_version` when saving `/paid`; it is zero
before a paid amount has been saved. For an unfiltered workspace listing,
totals span the whole workspace and `paid_version` is null.

Company names are trimmed and matched exactly, case-insensitively. Listing
accepts optional `company_name`, literal substring `search` (up to 200
characters), `date_field` (`booking_date`, `check_in`, or `check_out`), inclusive
`start`/`end` dates, `page` (default 1), and `page_size` (default 25, maximum 100).
Search matches company, hotel, customer, room, voucher number and remarks;
`%` and `_` are literal text. Null dates do not match a date boundary. Rows sort
by creation time and ID descending. Search, dates and pagination affect items
and row count only, never company aggregates.

Creation keys preserve exactly-once creation, including retries after edits.
Reusing a key for different input or after deletion returns `409`. Voucher
writes and company paid edits use versions to reject stale changes. Unchanged
inputs retain the version. Paid updates are absolute replacements and serialize
per workspace/company, including the first save. Reads are limited to
240/minute/user and writes to 240/hour/user.

See the [OpenAPI contract](../postman/contracts/companies.openapi.json).

## Storage and verification

Apply migrations through `031_company_voucher_amounts.sql` and reapply
`deploy/runtime-grants.sql` when using a separate runtime role. Migration 031
adds quantity 1 to existing rows and creates `company_balances`, keyed by
workspace and normalized company name. It sums existing row-level paid amounts
once into each company's opening paid total. Original voucher fields and legacy
money inputs remain stored for preservation; subsequent company paid edits
are independent of those historical values.

Deleting a voucher preserves company paid and clears the creation receipt's
snapshot so a delayed retry cannot restore it. Workspace deletion cascades
through vouchers, their receipts and company balances. Existing records under
other company names remain stored and accessible through the unfiltered API;
the three-card UI does not reassign or delete them.

Focused tests cover CRUD, precision, quantities, company aggregates, shared
paid updates, stale edits, authorization, filter/pagination independence,
workspace isolation and upgrade preservation:

```sh
node --require ./tests/test-environment.cjs --import tsx --test tests/companies-http.test.ts tests/company-voucher-upgrade.test.ts
npx tsx --tsconfig apps/web/tsconfig.json --test apps/web/tests/company-vouchers.test.ts apps/web/tests/company-spreadsheet.test.ts
npx playwright test e2e/companies.spec.ts
```

HTTP tests use isolated PGlite databases by default; `TEST_DATABASE_URL` can
point to a disposable PostgreSQL database to exercise the same contract there.
