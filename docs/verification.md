# Verification

## Combined Clerk and travel setup — 2026-11-06

Merged the saved Clerk/account-management work with GitHub revision `89c0e4a` on
`codex/merge-latest-clerk`. Existing source, private configuration and the stopped
local database were backed up before updating. The original PKR workspace was
preserved, and a separate GBP travel workspace was provisioned for the same
verified Clerk administrator.

- `npm test`: **182 backend/script tests and 52 frontend tests passed**, with no
  failures or skips. Coverage includes both prior migration histories, scoped
  deletion of travel/payment records, preserved administrator attribution,
  authenticated uploads/downloads and private attachment handling.
- `npm run lint`, `npm run typecheck`, API compilation and the production React
  build passed. Vite reported a nonblocking bundle-size warning.
- All eleven historical migration files retained their original bytes. The
  additive travel-deletion migration brought the restored local database to
  twelve migrations without replacing its records.
- The existing Postman email and S3 simulations passed against the real HTTP
  adapters. Their request logs confirmed failure/retry/replay behavior; these
  runs did not contact Resend or AWS. See the simulation context records.
- The detached local app runs on `http://localhost:3001`, with healthy liveness
  and database-readiness responses and four passing TCP startup checks. Local
  payment notifications use private files; Clerk handles authentication emails.
- Live browser sign-in initially required Clerk's emailed device-verification
  code. At the user's request, the existing administrator's documented Clerk
  `bypass_client_trust` setting was enabled through the Backend API and read back
  successfully. Password authentication remains enabled and the account has no
  enrolled MFA. A fresh browser sign-in using email and password opened the GBP
  workspace directly, without an OTP. This is a per-administrator setting;
  other accounts retain their existing authentication settings.

These checks use PGlite; the combined migration was not tested against a separate
PostgreSQL server during this setup. No production deployment was performed.

## Clerk integration — 2026-11-02–03

The local app was tested on macOS with Node.js 24, PGlite, a real Clerk development instance, Gmail, and an HTTPS Cloudflare Tunnel. Existing local database records and the original administrator were retained; a verified test administrator was added to the existing organization.

| Check | Result |
| --- | --- |
| Lint and TypeScript | Passed for API, scripts, tests, and React |
| Production build | API compilation and React production bundle passed |
| Automated tests | 72 backend/script tests and 7 frontend tests passed; zero failed or skipped |
| Local startup | Four real TCP checks passed: React sign-in page, database readiness, Clerk public configuration, anonymous API protection |
| Invitation delivery | Clerk email was received in Gmail (the first development sender message landed in Spam and was moved to Inbox) |
| Invitation landing | Browser displayed the invited name and email plus new-password and confirmation fields on the configured HTTPS app origin |
| New-user onboarding | Real Clerk invitation ticket plus chosen test password completed signup; the API granted exactly the intended customer membership |
| Customer authorization | Own statement returned successfully; user/customer administration returned 403; invalid JWT returned 401 |
| Invitation reuse and legacy credentials | Consumed invitation was rejected; legacy password-login endpoint was rejected in Clerk mode |
| Existing-user invitation | A disabled existing Clerk user received a fresh invitation; the browser offered sign-in/recovery, acceptance restored exactly one membership, the password was unchanged, and Clerk's pending invitation was closed |
| Customer password recovery | Actual Gmail code completed password reset, old session was rejected, old password failed, and the new password verified |
| Administrator recovery | Actual Gmail code completed reset and invalidated the prior administrator session |
| Administrator account profile | Brave sign-in with the reset password and Gmail device-trust code passed; changing the first name in Account settings updated the app header immediately, and the original name was restored |
| Browser sign-in and device trust | The new customer password plus Gmail device-trust code opened the customer workspace in Brave, showing only that customer's account statement |
| Disable and re-enable | Disabled customer's prior JWT was rejected and reloading the signed-in browser returned to login; enabling restored access; the customer record remained |
| Earlier access-only deletion | The test user disappeared from the app user list and Clerk returned 404 for the identity; its old session was rejected while its customer record remained available to the administrator. This behavior was subsequently replaced by permanent account deletion described below. |

Scripted signup uses Clerk's official development Testing Token after bot protection rejected a plain scripted request. The token is confined to the private verification helper; the application does not bypass Clerk protections. Real emails and real provider identities were used. Password/session/ticket data is kept only in ignored private local files. The browser invitation form was visually checked; submitting a newly chosen password through computer control requires the user to enter it.

These initial Clerk checks did not establish independent PostgreSQL-server locking behavior or a production deployment; the later PostgreSQL verification is recorded below. A temporary Cloudflare URL is valid only while its tunnel runs. See the setup and production notes in [README](../README.md).

### Missing-invitation investigation — 2026-11-03

A recipient reported not receiving an invitation. Three actual Clerk invitation messages, timestamped 00:07, 00:08, and 00:09 in Gmail, were found in that recipient's Spam folder using the browser. The latest Clerk invitation remained pending and the application's email status was `sent`. This established that Gmail received these messages and classified them as spam; it did not indicate an application send failure or an exhausted development quota. Gmail's **Report as not spam** action moved the latest message to Inbox. Following that actual email link returned to the HTTPS app and displayed the invited name, matching email, and password/confirmation fields. Signup was not submitted for this recipient. Only the newest invitation link remains valid after resending.

A later report concerned invitations sent from **Users & access** to a different Gmail mailbox. Three messages at 00:19, 00:20, and 00:22 were found in that mailbox's Spam folder; Clerk's latest invitation was pending at 19:22:34 UTC on November 2 (00:22:34 local time on November 3). This confirmed the same inbox-placement issue for a second recipient. Those messages were delivered despite the report, so neither a failed application request nor the development email quota explains these two incidents. Recent local logs contained no recorded Clerk invitation failure. No further emails were sent as part of the read-only follow-up investigation. The latest message was subsequently marked **Not spam**; Gmail confirmed it had moved to Inbox, and the message displayed the Inbox label. Optional content sharing was declined.

The application's `sent` value means Clerk accepted the invitation request, not that the message reached Inbox. The interface now reports **Email request accepted** and asks recipients to check Spam or Junk; a failed delivery response displays an error even when the HTTP request itself succeeded. Failed provider requests also record a safe diagnostic containing the operation, HTTP status, and allowlisted provider codes, without email addresses, credentials, tokens, or raw provider errors. The final full suite passed all 82 tests (73 backend/script and 9 frontend), with none failed or skipped, including sensitive-data exclusion and the HTTP 201/failed-delivery error display. TypeScript, lint, the full production build, and diff checks passed. Restarting the detached local server on port 3001 passed its four local startup checks; the existing tunnel URL was retained. The [README](../README.md) documents development email limits, delivery-log troubleshooting, and production sender-domain setup. Inbox placement remains controlled by receiving mail providers.

### Permanent account deletion — 2026-11-03

Permanent deletion replaces the earlier access-only deletion behavior. Customer deletion removes the selected business's account, financial entries/reversals, invitations, memberships, and related audit events. Administrator deletion anonymizes attribution in surviving business records. Shared identities and records belonging to another business remain protected.

The full suite passed all **92 tests** (81 backend/script and 11 frontend) on both PGlite and an isolated PostgreSQL 17.11 server, with none failed or skipped. TypeScript, lint, the full production build, and diff checks passed. Checks cover archived and pending accounts, accepted/revoked/pending invitations, former membership rows, orphan sessions/recovery data, fresh same-email accounts, tenant isolation, administrator attribution, exact confirmation, and retry after a partial provider failure. The 12 HTTP tests include real Nest/Express requests that reject unauthorized or unconfirmed deletion without changing the balance, delete through both customer and user routes, invalidate the old invitation, accept a fresh same-email invitation into an empty ledger, and invalidate the deleted user's session. The frontend tests include confirmation-body handling, failed deletion responses, and the irreversible-operation warning.

An independent restricted-role check ran against an isolated PostgreSQL 17 database. Direct writes to the private deletion context and calls to its helper failed with `42501`; ordinary ledger deletion remained blocked with `23514`. A temporary table could not replace the protected context. Wrong-actor and wrong-confirmation calls failed, while the authorized scoped deletion succeeded and left the private context empty. The temporary schema and role were cleaned up. Deployment grants for a separate runtime role are documented in [security notes](security.md).

The live API flow also passed after applying the migration to local development. A disposable customer with four ledger entries was permanently deleted: customer and statement requests returned 404, its old session returned 401, its previous invitation became invalid, and Clerk no longer contained the identity. The four other existing customer accounts remained. Reinviting the same email completed joining with new customer, local-user, and Clerk-user IDs and an empty ledger with zero balance. This exercised the complete API routes and real Clerk operations; the final irreversible deletion was not submitted through the browser interface. Only the disposable verification account was deleted.

In Brave over the HTTPS tunnel, the replacement account showed an empty ledger. Its deletion dialog kept **Delete permanently** disabled for an empty or incorrect confirmation email and enabled it for the exact account email. **Cancel** closed the dialog and left the account intact. The final browser deletion button was not submitted. API cleanup subsequently removed the fresh disposable account and its identity/access while retaining the four other accounts. The temporary PostgreSQL test container was also removed.

## Earlier foundation verification

The following checks passed in the Windows development workspace using Node.js 24:

| Check | Result |
| --- | --- |
| `npm run lint` | Passed |
| `npm run typecheck` | API, scripts, tests, and React passed |
| `npm test` | 54 tests passed, zero failed, zero skipped |
| `npm run build` | NestJS compilation and React production bundle passed |
| Dependency lock validation | Required dependency/peer edges resolved; package integrity matched original sources |
| `npm ci --dry-run --offline` | Dependency planning passed for Windows and Linux x64/glibc and arm64/musl |
| Persistent local startup | Migrations applied; unique administrator provisioned; local server bound to 127.0.0.1:3000 |
| Local stop and restart | Clean shutdown passed; the same administrator and organization were retained |
| Running-instance smoke | Nine checks passed against the actual local app, including built assets, sign-in, dashboard, CSRF, and logout |

The test suite includes 16 authentication/invitation/recovery tests, 6 customer lifecycle tests, 10 HTTP authentication/authorization/CSRF tests, 13 money/ledger tests, 2 frontend money/routing tests, and 7 local database/provisioning/startup tests. SQL migrations, constraints, and triggers ran against a fresh PGlite PostgreSQL engine. HTTP assertions ran through the actual NestJS/Express pipeline using native in-process request/response objects after this environment denied loopback TCP connections. The persistent local instance also completed its nine startup checks before and after a clean restart.

Follow-up on 2026-10-29: the previous server process had stopped, leaving stale status metadata. Restarting passed all nine internal smoke checks, but the browser timed out and a direct TCP probe returned `EACCES`. Browser connectivity from the restricted runner remains unverified. The restricted terminal process has exited; start `Start-LedgerBook.cmd` directly from Windows and keep that terminal open while using the app. Local startup recovers a stale database lock only after verifying its previous process has exited. The launcher now rejects malformed status records and distinguishes dead processes from processes it cannot inspect; two regression tests cover these cases. Initial login details and database files remain only under the ignored `.local` directory and are excluded from the source archive.

The 2026-10-29 launcher follow-up passed `npm run lint`, `npm run typecheck`, and its two targeted regression tests. The earlier 54-test full suite was not rerun for this launcher-only change.

The following were **not** verified during the earlier Windows foundation run:

- A separate PostgreSQL server and its independent connection locking behavior. The supplied CI job runs the same tests against PostgreSQL 17, but that CI job has not been executed in this workspace.
- Live TCP transport and a deployed HTTPS/reverse-proxy configuration.
- Live invitation/password-reset email delivery or verified sender DNS. The Resend request contract and provider failure behavior were tested with a mock transport.
- Visual browser and mobile-device smoke tests. No browser automation surface was available.
- A fresh network-backed dependency installation, vulnerability audit, or clean Linux production build. Dependencies were reused from available local packages; the portable lockfile retains canonical public-registry URLs and original integrity values.
- The migration/bootstrap/seed/cleanup CLIs against an independently running database. Their code typechecks; migration SQL and relevant domain operations execute in integration tests.

Before release, configure the database and verified email sender, run the real PostgreSQL CI checks, apply migrations, provision the organization admin, and perform the HTTPS/browser/email smoke checks described in [README](../README.md) and [security notes](security.md). No production deployment or external email sending was performed during that earlier run.
