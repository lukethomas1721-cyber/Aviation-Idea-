# JetReserve — fly private now, pay weekly

Code for the JetReserve business plan: financing for Part 135 empty-leg charters with weekly autopay, member plans,
deposit credit lines, group pay, servicing, and an embeddable plug-in for charter companies' own websites.
Zero dependencies, Node >= 22.13.

```
npm start         # http://localhost:3000   (in-memory DB; DB_PATH=data/jr.db persists; delete it after schema changes)
npm test          # 92 tests
```

| Page | What it is |
|---|---|
| `/` | JetReserve's own marketplace demo: checkout, membership, My Financing (payoff), Lender Portal (`dev_admin_key` in dev) |
| `/partner-demo.html` | **A sample charter company's website using the plug-in** (one `<div>` per listing) |
| `/embed.html?token=…` | The hosted checkout the plug-in opens in an iframe |
| `/join.html?token=…` | A friend's invite page for group pay |

Payment buttons in the demo simulate processor confirmations (`DEMO_MODE`); no money moves.

## The plug-in (plan: "a plug-in that charter companies add to their own websites")

```html
<script src="https://YOUR-JETRESERVE-HOST/widget.js" defer></script>
<div data-jetreserve-leg="LEG_ID" data-session-url="/your-backend/jetreserve-session"></div>
```

1. Customer clicks the button. The widget POSTs `{legId, email?}` to **the charter company's own backend**.
2. That backend calls `POST /api/v1/checkout-sessions` with its **secret** `x-api-key` and returns the `embedUrl`.
3. The widget opens the hosted checkout in a sandboxed iframe and relays `jetreserve:funded / status / close` events
   (ids and status only) to the host page so it can mark the flight sold.

Security model: the browser only ever holds a session token (`jrs_…`, 30-min sliding, 4 h cap, stored hashed) that can
touch **one flight and the one loan created through it**. It cannot list loans, see other customers, or use any admin
or partner endpoint, and (outside `DEMO_MODE`) cannot record a payment: payments are confirmed by the processor, never
the browser. `embed.html` can be framed only by the origins in the partner's `allowed_origins`; every other page sends
`frame-ancestors 'none'`, plus a CSP. The widget refuses to open a checkout from any origin but its own, and only trusts
`postMessage` from that origin. Auth endpoints are rate-limited per IP.

## Money flow

`quote → application/underwriting → approved → [group] → sign (flight LOCKS) → down payment + first autopay clear → operator paid in full → weekly autopay`

- Approval holds the flight (30 min; 2 h in review/group invites). Signing locks it so it can't be sold twice.
- **The operator is paid only after the down payment AND first autopay clear.** If they don't clear within 60 min the booking is unwound and refunded.
- Signing requires autopay plus a backup card. First payment is charged at signing, the rest weekly.
- **Texas-only launch** (`LAUNCH_STATES=TX`) and **empty legs only** (`FINANCEABLE_LEG_TYPES=empty_leg`; add `charter` for the roadmap's phase 3).
- Terms can shift with leg type and hours to departure (`TERM_RULES`, below). Default: no shifts.

## Pricing (`src/plans.js`)

| Plan | Down | Flat charge | Terms | Notes |
|---|---|---|---|---|
| Non-member | 10% | 25% | 3 mo (13 wks) | |
| Access | 10% | 15% | 3 or 5 mo (13/22) | $1,000/mo billed $6,000 per 6 mo; $2,500 trip credit per payment |
| Elite | 10% | 10% | 3 or 5 mo | $3,000/mo billed $9,000 per 3 mo; $5,000 trip credit per payment |
| Deposit holder | none | 5% | 12 mo (52) | credit line = deposit ($50k–$500k, held in trust) |
| Marketplace | 10% | 10% | 3 mo | JetReserve's own site: operator rate + 15% markup |

`src/economics.js` reproduces the plan's **unit-economics and market-size tables** from the same pricing engine (a $40k
non-member trip earns $13,000; the typical $6,926 leg earns $2,251 / $1,628 / $1,316; 1% of empty legs grosses $7.3M–$9.4M).
The plan's "$839 of capital per flight per year" is exactly principal × 7/52 (weekly amortization over 13 payments).
Admin: `GET /admin/economics?priceCents=&plan=&termMonths=`, `GET /admin/market`.

## Servicing (plan: "collections, late fees and credit reporting")

- **Early payoff** (`GET/POST /loans/:id/payoff`): individuals get the **unearned flat charge refunded** (Texas Ch. 342, per the plan); business-purpose loans keep it. Policy: `EARLY_PAYOFF_REBATE=consumer|all|none`. Quote → pay; stale quotes are rejected.
- **Reminders**: day before, due, 1 day late, grace ending, final notice; sent once each via the notifier adapter.
- **Late fee**: capped (`LATE_FEE_CENTS`, `LATE_FEE_CAP_BPS`), once per installment, **off by default** pending counsel; a loan can't close until fees are paid.
- **Collections**: >30 days late = defaulted + `internal`; >90 days = `agency_ready`; admin can `refer_agency` or `write_off` (charge-off frees capital; losses tracked).
- **Loss reserve** = a share of collected flat charges (`LOSS_RESERVE_BPS`, **placeholder rate**); **surety bond** requirement = client trust balances.
- **Credit reporting** (`GET /admin/credit-reporting`): simplified extract with Metro 2-style status codes. **Not a certified Metro 2 file**; furnishing needs a bureau data-furnisher agreement and FCRA accuracy/dispute procedures.
- **Partner BNPL referral**: borderline clients (manual review for thin credit, ≤ $30k) get a hand-off offer from a partner lender (`src/lenders.js`; mock — the plan names Affirm / Uplift / ChargeAfter).
- Missed payment: grace → member perks and member pricing frozen → default → collections.

## Group pay, memberships, trust

Main customer signs and owns the balance; up to 8 friends invite → join (`/join.html`: ID + autopay) → lock (`shrink` or
`main_covers`) → collect equal shares; a friend's missed share is charged to the main customer after the grace period;
friends can pay off early. Member trip credit counts toward the down payment first, then reduces the amount financed,
and lives in a segregated trust ledger (`GET /admin/trust?bankBalanceCents=` reconciles it). Deposit config:
`depositRefills` (default true). Refund terms for deposits and membership dues remain open questions in the plan.

## API (`/api/v1`)

Partner (`x-api-key`): `GET /plans` · `GET /legs?email=` · `POST /quotes` · `POST /applications` · `GET /loans[/:id]` ·
`POST /loans/:id/accept|cancel|payments` · `GET|POST /loans/:id/payoff` · `POST /loans/:id/group[/finalize]` ·
`POST /group/join/:token` · `POST /loans/:id/group/members/:mid/payoff` · `POST /members/join|renew|deposit` ·
`GET /members/:email` · **`POST /checkout-sessions`**.
Operator (`x-operator-key`): **`POST /operator/legs`** — each uploaded leg returns its flight-specific financing offers at listing time.
Session (`x-session-token`): `/embed/*`. Public (invite token is the credential): `GET|POST /join/:token`.
Admin (`x-admin-key`): `portfolio`, `loans`, `loans/:id/review|collections`, `sweep`, `legs`, `trust`, `credit-reporting`, `economics`, `market`.
Licensing: each charter company is a `partners` row (own hashed key, `max_loan_cents`, `fee_adjust_bps`, `allowed_origins`).

## Configuration (env)

`PORT`, `DB_PATH`, `ADMIN_API_KEY`, `PUBLIC_URL`, `DEMO_MODE`, `CAPITAL_POOL_CENTS`, `MAX_LOAN_CENTS` (default $30,000 per trip),
`LAUNCH_STATES`, `FINANCEABLE_LEG_TYPES`, `OPERATOR_COMMISSION_BPS` (plan assumes ~10% broker margin), `EARLY_PAYOFF_REBATE`,
`LATE_FEE_CENTS`, `LATE_FEE_CAP_BPS`, `LOSS_RESERVE_BPS`, `ENFORCE_APR_CAP`, `RATE_LIMIT_PER_MIN`, and:

`TERM_RULES` (JSON) — terms shift with leg type and hours to departure; matching rules add up. Example:
`[{"maxHours":24,"downBpsAdd":1000},{"maxHours":72,"maxTermMonths":3},{"legType":"charter","flatBpsAdd":-200}]`
(+10 points of down payment inside 24 h; 3-month terms only inside 72 h; 2 points off the charge on regular charters).
**The plan gives no numbers for this, so none are on by default.**

## Deploy a free public demo

`render.yaml` is a Render blueprint (New → Blueprint → this repo/branch). It sets `DEMO_MODE=1`, so the simulated
payment buttons and sample partner site work. Free tier sleeps when idle and resets data on restart. **Demo only**: public demo
keys, mock payments, fake operators. Do not enter real personal data. **Never set `DEMO_MODE` on a real deployment.**

## Still mock / not built

- **ID, credit, income checks** are self-reported inputs; **payments / ACH autopay / operator payouts** are mocked (`src/rails.js`); notifications are a no-op (`src/notify.js`). Needs real providers before real money.
- Demo operators are fake; `cert_verified` must be backed by a real FAA Part 135 check. No operator login UI.
- Not code: Plan C investment fund (securities structure), DOT broker registration, operator contracts, loan agreement text, insurance/bond, patent filing.
- Not modeled: cancellation/refund after funding, operator payout reversals, optional credit checks for group friends, settlement offers in collections.

## Read before launch

- **APR** is computed actuarially with the first payment at signing: ≈207% (Non-member 3 mo), ≈85% (Elite 3 mo), ≈72% (Access 5 mo),
  ≈48% (Elite 5 mo), ≈10% (deposit). These are **higher than the plan's 174% / 72% / 44% / 9.7%**, which uses a different convention; have
  counsel confirm the Reg Z method. The plan itself says pricing exceeds Texas consumer limits. Quotes show the APR and a flag;
  `ENFORCE_APR_CAP=1` refuses consumer-track loans above the 18% reference cap. Business-purpose clients are not capped here (confirm that track with counsel).
- **$30,000 cap**: the plan's $40k examples need `MAX_LOAN_CENTS=4000000`+; excess over the cap becomes extra down payment.
- Friends' early payoff pays their scheduled shares without refunding unearned charge (only the main borrower's payoff does); confirm with counsel.
