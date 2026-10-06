# SkyFinance — buy-now-pay-later for Part 135 empty-leg charters

Lending platform that finances charter flights (empty legs first) for corporate customers, built to be
**licensed to Part 135 charter marketplaces** as their embedded financing provider.

**Terms (all configurable in `src/config.js`):** up to **$30,000 financed per trip**, **10% flat financing charge**,
**3 equal monthly installments** (max 3-month term). Trips over $30k require a down payment for the excess.
The operator is paid the financed principal at funding; the customer repays SkyFinance.

```
npm start         # http://localhost:3000  (Node >= 22.13, zero dependencies, in-memory DB by default)
npm test          # 26 tests: money math, underwriting rules, loan lifecycle, HTTP/auth
DB_PATH=data/sky.db ADMIN_API_KEY=... CAPITAL_POOL_CENTS=200000000 npm start
```

The UI at `/` has three tabs: **Empty Legs** (marketplace with "Finance this trip" checkout), **My Financing**
(repayment view) and **Lender Portal** (portfolio, manual review queue; dev admin key `dev_admin_key`).
Seed data is the 18 empty legs you provided; the two per-seat "members only" flights are shown but not financeable.
The truncated final LAX→UAO listing had no price/date, so it was not seeded.

## Loan flow

`quote → application (underwriting) → approved | pending_review | declined → accept (e-sign) → funded → paid | defaulted`

- Approval **holds the leg** for 30 minutes (2 h in manual review) so it can't be double-booked; holds expire automatically.
- Funding creates the schedule (due every 30 days), records the operator payout via the rails adapter.
- Payments apply oldest-installment-first, are idempotent (`idempotencyKey`), and reject overpayment.
- Daily `sweep` expires stale offers and marks loans defaulted at >30 days past due (cures back to `funded` if brought current).
- Controls: capital-pool cap, per-borrower exposure cap ($60k), min/max lead time before departure, verified-operator check.

## API (`/api/v1`, partner key in `x-api-key`; admin routes use `x-admin-key`)

| | |
|---|---|
| `GET /legs?financeable=1` | listings with financing eligibility + monthly payment preview |
| `POST /quotes` `{legId, downPaymentCents?}` | terms, APR, schedule |
| `POST /applications` `{legId, borrower{...}, consents:{creditCheck:true}}` | underwriting decision + offer |
| `POST /loans/:id/accept` `{acceptedTerms:true, signatureName}` | fund + book |
| `POST /loans/:id/cancel` · `GET /loans/:id` · `GET /loans?email=` | |
| `POST /loans/:id/payments` `{amountCents, idempotencyKey}` | record repayment |
| `GET /admin/portfolio` · `GET /admin/loans` · `POST /admin/loans/:id/review` · `POST /admin/sweep` | lender back office |

## Licensing model

Each licensee is a row in `partners` with its own hashed API key, `fee_bps` and `max_loan_cents` (can only tighten the
platform cap). All loans are partner-scoped. Natural next steps: per-partner webhooks, revenue share, white-label widget,
partner onboarding endpoint.

## Not production-ready yet — replace before real money moves

- **Underwriting inputs are self-reported.** `underwriting.js` is a pure scorecard; wire `creditScore`, KYC/KYB and OFAC to real providers (business bureau, Persona/Middesk, etc.).
- **`rails.js` is a mock.** Implement ACH/wire disbursement to operators and ACH/card collection from borrowers, with a ledger.
- **Auth:** the browser demo embeds a demo partner key. Real partners call from their backend; add borrower login for "My Financing".
- **Operator verification:** `cert_verified` must be backed by an actual FAA Part 135 certificate check.
- **Cancellations/refunds after funding**, charter no-shows, and operator payout reversals are not modeled.
- Postgres + migrations instead of SQLite, rate limiting, audit exports, PII encryption.

## Legal — needs counsel before launch

- A 10% flat charge over 3 monthly payments is **≈59% APR** (computed and shown to the borrower). Business-purpose
  credit avoids many consumer rules (TILA/Reg Z), but **state usury limits, lender licensing, and commercial-financing
  disclosure laws (e.g. CA, NY, and others require APR-style disclosures)** still apply, and rules differ by state and by
  borrower type (sole proprietors are often treated differently). Fee, term, and disclosure text are all configurable.
- Decline responses return reason codes for adverse-action notices (ECOA/FCRA); the notice itself is not generated.
- Late fees are intentionally off (`lateFeeCents: 0`) pending legal sign-off.
