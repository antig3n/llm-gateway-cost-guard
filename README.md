# llm-gateway-cost-guard

A Cloudflare Worker that sits between a paid product and an LLM provider, and guarantees that **no customer licence can ever spend more than its monthly cap**, even under heavy concurrency.

The problem it solves: if you sell an AI feature on a subscription, every call costs you money. A naive "read balance, call model, write cost" loop overspends as soon as two requests run at the same time. This gateway reserves the worst-case cost **before** calling the model, in a single atomic SQL statement, and settles the real cost afterwards.

## How it works

```
request ──► auth (hashed licence, revocable)
        ──► validate (allow-listed model, bounded max_tokens)
        ──► reserve worst-case cost      ← one conditional UPDATE, no prior read
        ──► call provider
        ──► settle actual cost / release on known failure
        ──► log 7 metadata fields (never prompts, keys or bodies)
```

The core of the guarantee is one statement:

```sql
UPDATE monthly_budgets
SET reserved = reserved + :max_cost
WHERE license_id = :id AND month = :month
  AND spent + reserved + :max_cost <= cap
```

Either the row has room and the hold is taken, or zero rows change and the request gets `429 budget_unavailable`. SQLite `CHECK` constraints enforce `spent + reserved <= cap` as a second line of defence.

## Design choices

- **Fail closed on money, fail open on telemetry.** A successful provider call with unusable usage data is charged at the reserved maximum; a logging failure never touches accounting.
- **Holds never expire on their own.** Releasing a hold that might have been billed would allow overspending; the gateway prefers to over-reserve.
- **Revocation is checked twice:** at authentication and again inside the reservation statement.
- **Monthly cap snapshot:** each UTC month keeps the cap it started with; settlement always targets the original month, even across a month rollover.
- **Privacy by construction:** licences are stored as SHA-256 digests; logs are an allow-listed record of seven fields.

Full rationale in [DESIGN.md](DESIGN.md).

## Tests

```bash
node --test        # Node 26+, no dependencies to install
```

29 tests run the real SQL against an in-memory SQLite database through a small D1 adapter. The concurrency test fires 25 parallel requests against a cap that fits only 4, holds every provider response until all admissions are decided, and checks the invariant after each database write: 4 admitted, 21 refused, cap never exceeded.

## Scope

This is a self-contained demonstration: the provider is a deterministic fake, prices are fictional integer units, and nothing touches the network. A production adapter must supply a proven upper bound on billable tokens; the guarantee assumes that contract.

## About

Generic rewrite of a pattern I run in production for a paid AI product. Designed and reviewed by me; implementation produced through a supervised multi-agent pipeline (specification → generation → independent review → tests rerun before acceptance).

MIT licence.
