# Travel workspace verification — 6 November 2026

Implemented and verified in the existing local checkout. Existing uncommitted work
was retained. No deployment or migration of the user's live data was performed.

## Automated checks

| Check | Result |
| --- | --- |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm test` | 76 backend tests and 24 frontend tests passed; no skipped tests |
| `npm run build` | API and production web builds passed |

The database tests run migrations 001–004 against PGlite and exercise real SQL,
foreign keys, triggers, transactions and HTTP authentication. Coverage includes:

- Two bookings for one customer retain distinct vouchers and download bytes.
- File selection and dropped-file parsing use the same validated upload adapter.
- Missing, cross-customer, cross-booking and cross-folder destinations are rejected.
- Failed storage/audit writes roll back PDF bytes and metadata together.
- Lost-response retries do not duplicate files; moving a file does not let a retry
  silently report the old destination as successful.
- Customers can read only their own booking documents; management requires an
  active administrator membership. Revocation, cross-tenant requests and CSRF fail.
- Default-folder repair preserves folder IDs and existing documents.
- Partial payments, credits, payment reversals and older unscheduled debt produce
  consistent individual, combined-ledger and dashboard balances.
- Reporting dates affect receipts/activity, while outstanding and overdue totals
  reflect the current ledger position. Totals cover all filtered pages.
- Required services drive missing-document warnings. Upload and issuance are separate.
- Business date and departure conversion handle time zones and daylight-saving gaps.
- Late refresh responses cannot overwrite newer documents or mask upload errors.

## Browser checks

Used an isolated, disposable QA database with fictional customers on localhost,
without modifying the user's local database or delivering invitation emails.

- Inspected the dashboard at wide and narrow responsive layouts.
- Clicked Outstanding Customer Balance and confirmed the combined ledger selected
  Outstanding and showed matching totals.
- Opened the existing payment form through Record Payment; Payment was preselected.
  Recording GBP 50.00 changed the individual balance from GBP 2,250.00 to
  GBP 2,200.00. The overview then showed GBP 2,200.00 outstanding, GBP 200.00
  payments received and GBP 600.00 overdue.
- Opened both bookings and their Makkah Hotel folders. Downloaded the same-named
  vouchers through Download copy; their bytes and embedded trip labels differed.
- Uploaded a PDF through Add files into Flight Tickets, observed the success
  state and refreshed contents, and downloaded the saved PDF.
- Inspected existing folder art, buttons, details dialog and download controls.
  `apps/web/src/user-files/explorer.css` was unchanged, with SHA-256
  `BE2CD1F7BC41583E6AC654264BAC3EBA97CE00F189D44CBD824342A49495173E`.
  Storage-status text now reflects persistent data instead of the old tab preview.
- A dashboard screenshot is saved locally at
  `.local/customer-dashboard-verified.png` (fictional QA data).

## Integration limits

- The in-app browser did not render a native PDF preview, including after the
  narrowly scoped PDF CSP compatibility fix. Authenticated inline HTTP bytes,
  headers, open links and actual downloads passed. Native desktop/mobile PDF
  rendering still needs checking in the deployment browsers; no physical phone
  was used. Drag/drop transport is covered by automated tests, not an OS drag gesture.
- Production PostgreSQL multi-connection locking was not exercised. Set
  `TEST_DATABASE_URL` to a disposable PostgreSQL database for that verification.
- Fresh local workspaces use GBP. Existing non-GBP history is not silently
  converted; new travel posting requires a GBP workspace or an agreed accounting
  migration. Available GBP reference rates display legacy balances accurately;
  missing rates display unavailable amounts.
- No reminder sender previously existed. The dashboard consumes recorded reminder
  events and otherwise reports that no reminder is recorded.
- Old file-explorer samples lived only in browser memory. There were no persisted
  booking records or server files to migrate from that preview implementation.

Restart the local application to apply migrations automatically, or run
`npm run db:migrate` before starting the updated API in a server deployment.
