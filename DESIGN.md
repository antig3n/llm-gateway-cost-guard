This is an offline demonstration using JavaScript ESM, JSDoc, and platform APIs.
Run `node --test` with Node 26. No package installation is needed.

The Worker accepts `POST /v1/completions` with a Bearer license and a JSON object
containing only `model`, `prompt`, and `max_tokens`. The two permitted models and
their limits are declared in `src/models.js`. All prices are fictional integer
units, unrelated to any currency or commercial provider.

Provision a high-entropy license outside this demo, hash it with
`hashLicenseKey`, and insert only its digest, an opaque ID, and its monthly cap
into `licenses`. No license is bundled or seeded. Setting `revoked_at` disables
new admissions. Authentication is checked on every call and revocation is
checked again in the atomic reservation statement.

The first admission creates a UTC monthly budget with a snapshot of the
license's cap. Changing `licenses.monthly_cap` affects future monthly rows;
existing rows keep their cap. The reservation is a single conditional UPDATE,
without a prior balance read. Settlement atomically replaces the maximum hold
with actual cost. A known, unbilled provider failure releases its hold.
Settlement always targets the original month, even after a calendar rollover.
SQLite constraints also enforce nonnegative counters and `spent + reserved <= cap`.

`src/provider.js` defines the trusted provider contract and implements a
deterministic fake. Its input token count is exact; its output is bounded by
`max_tokens`. A real adapter must supply a proven upper bound covering all
billable input, enforce output limits, and match the configured pricing.
The budget guarantee assumes that contract. This demo performs no network I/O.
A successful response with unusable usage is charged at the reserved maximum.

The execution context keeps accounting alive after client disconnect, within
the runtime's execution limits. An interrupted runtime or failed accounting
write leaves the reservation counted. Holds never expire automatically, because
freeing a possibly billed hold would allow overspending. Durable per-request
reconciliation and production provider adapters are outside this demo's scope.
Reservation handles allow one close operation within their owning execution.

Logs contain exactly seven metadata fields: license ID, accepted model, input
tokens, output tokens, cost units, duration, and HTTP status. Unknown values are
null. Bodies, credentials, headers, exception messages, and arbitrary upstream
fields never enter the log record. Telemetry failure does not affect accounting.
The database stores license digests and budget counters, with no content tables.

Tests run the actual SQL against an in-memory SQLite database through a small
D1 adapter. Its asynchronous methods yield between statements. The concurrency
test holds provider responses until all 25 admission attempts have completed,
and checks the invariant after every database mutation and before releasing
those responses. This exercises contention while keeping the test deterministic.
