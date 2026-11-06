# Currency contract and operations

Every endpoint requires an active session and membership in the requested organization. Writes use existing origin/CSRF verification. Customer members may select their display currency. Only administrators may edit shared rates; writes recheck membership in a database transaction and append an audit event.

| Endpoint | Contract |
| --- | --- |
| `GET /api/organizations/:orgId/currencies` | Returns `base_currency`, `base_exponent`, saved `display_currency`, `fetched_at`, provider `unavailable`, and `currencies`. Each currency contains code, name, accounting exponent, availability and (when available) a decimal-string rate, observation date, source and stale flag. |
| `PATCH /api/organizations/:orgId/currencies/preference` | `{ "currency": "PKR" }` saves this membership's preference. A usable rate is required. Returns the complete settings response. |
| `PATCH /api/organizations/:orgId/currencies/rates/:currency` | Admin only. `{ "rate": "280" }` means one accounting-currency unit equals 280 target-currency units. Positive decimal text, up to 12 fractional digits, maximum 100,000,000. `{ "rate": null }` restores automatic rates. Base currency cannot be overridden. Returns complete settings. |
| `GET /api/organizations/:orgId/customers/:id/statement.csv?currency=PKR` | Optional display currency plus existing statement filters. Missing currency preserves the original accounting-currency CSV contract. Converted CSVs also contain accounting currency/amount, rate, date, source and stale flag. Account authorization occurs before conversion. |

The ledger read and write APIs retain their original accounting-currency amounts. The web app converts them centrally using a React currency context and shared integer conversion code. Transaction input explicitly stays in the accounting currency. Changing rates affects displayed historical entries, not their stored principal or reversals; this is current-value display conversion, not historical FX accounting.

## Cache behavior

`RatesService` fetches `GET https://api.frankfurter.dev/v2/rates?base=USD&quotes=...` with a five-second timeout, validates the response, and stores rates as decimal strings. The provider contract was checked against its official documentation, Orbit integration guidance and a live response. Only currency codes are sent to the provider, never ledger amounts or customer details.

| Environment variable | Default |
| --- | --- |
| `REDIS_URL` | Unset; durable database cache only |
| `EXCHANGE_RATE_URL` | `https://api.frankfurter.dev/v2/rates` |
| `EXCHANGE_RATE_TTL_SECONDS` | `3600` |
| `EXCHANGE_RATE_MAX_AGE_SECONDS` | `604800` |

Redis keys are versioned and separated by accounting currency. Snapshots include their own freshness timestamp; Redis retention is the maximum stale age, not the refresh interval. Reads check Redis first, then the durable database cache. Expired snapshots refresh on demand. Concurrent refreshes within one process share a single promise. Multiple API instances can each refresh an expired snapshot, so this is not a distributed refresh lock.

Redis failures fall back to the durable cache, with one-second connection/command timeouts and a reconnect cooldown. Provider failures back off for one minute per process. Usable cached observations are flagged stale; the accounting currency always retains rate 1. Observations or snapshots beyond the maximum age cannot be used. Missing currencies remain disabled until rates recover or an administrator supplies a manual rate. Reference dates over three days old are visibly stale even if just fetched. Manual overrides are tenant-specific and durable, independent of the provider cache.

## Verification

`tests/currency.test.ts` exercises the real provider HTTP client against a loopback fixture, validating request shape, refresh coalescing, durable cache reuse after service restart, malformed responses, 503 fallback, backoff, maximum age, manual overrides, permissions, preferences, exact rounding and CSV provenance. `apps/web/tests/currency.test.ts` checks shared formatting and context updates, including missing rates and accounting precision.

The installed Postman CLI lacks `status` and the simulation commands required by its bundled skill, so provider failure tests use a local HTTP fixture. No Postman workspace resources were accessed or published. Redis integration additionally needs a running Redis service; Docker was unavailable during initial local verification. Real PostgreSQL multi-connection locking remains covered by the repository's optional `TEST_DATABASE_URL` workflow.
