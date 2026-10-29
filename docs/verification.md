# Foundation verification

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

The following were **not** verified here:

- A separate PostgreSQL server and its independent connection locking behavior. The supplied CI job runs the same tests against PostgreSQL 17, but that CI job has not been executed in this workspace.
- Live TCP transport and a deployed HTTPS/reverse-proxy configuration.
- Live invitation/password-reset email delivery or verified sender DNS. The Resend request contract and provider failure behavior were tested with a mock transport.
- Visual browser and mobile-device smoke tests. No browser automation surface was available.
- A fresh network-backed dependency installation, vulnerability audit, or clean Linux production build. Dependencies were reused from available local packages; the portable lockfile retains canonical public-registry URLs and original integrity values.
- The migration/bootstrap/seed/cleanup CLIs against an independently running database. Their code typechecks; migration SQL and relevant domain operations execute in integration tests.

Before release, configure the database and verified email sender, run the real PostgreSQL CI checks, apply migrations, provision the organization admin, and perform the HTTPS/browser/email smoke checks described in [README](../README.md) and [security notes](security.md). No production deployment or external email sending was performed.
