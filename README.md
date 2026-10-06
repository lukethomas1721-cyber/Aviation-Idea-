# JetReserve — fly private now, pay weekly

Code for the [JetReserve business plan](#plan-to-code-map): financing for Part 135 empty-leg charters with weekly autopay,
member plans, deposit credit lines, group pay, and a plug-in API for charter companies (Plan A) or JetReserve's own
marketplace (Plan B). Zero dependencies, Node >= 22.13.

```
npm start         # http://localhost:3000   (in-memory DB; set DB_PATH=data/jr.db to persist, delete it after schema changes)
npm test          # 60 tests
ADMIN_API_KEY=... CAPITAL_POOL_CENTS=50000000 MAX_LOAN_CENTS=4000000 ENFORCE_APR_CAP=1 npm start
```

UI tabs: **Empty Legs** (checkout with plan/term choice, group pay, sign, pay), **Membership** (Access/Elite/deposit),
**My Financing**, **Lender Portal** (admin key `dev_admin_key` in dev). Payment buttons in the demo simulate processor
confirmations; no money moves.

## Deploy a public demo (free)

1. Push is already on GitHub. On [render.com](https://render.com) (free account): **New → Blueprint**, pick this repo and the
   `claude/aviation-loan-empty-leg-ux9z57` branch. `render.yaml` does the rest and gives you a public `https://….onrender.com` URL.
2. The lender-portal key is generated for you: Render dashboard → service → **Environment → ADMIN_API_KEY**.
3. Free-tier limits: sleeps after ~15 min idle (first load takes ~30 s) and the in-memory data resets on every restart.
4. **Demo only.** The page ships a public demo partner key and uses mock payments and fake operators, so anyone with the URL can
   create test loans. Do not enter real personal data.

## Money flow (the plan's safeguards, enforced in code)

`quote → application/underwriting → approved → [group] → sign (flight LOCKS) → down payment + first autopay clear → operator paid in full → weekly autopay`

- **Approval holds the flight** (30 min; 2 h in review; 2 h for group invites). **Signing locks it** so it can't be sold twice.
- **The operator is paid only after the down payment AND the first autopay clear** (`tryFund`). If they don't clear within
  60 minutes the booking is unwound: flight released, credit released, collected money refunded.
- Signing requires autopay plus a **backup card**. First payment is charged at signing; the rest weekly.
- Idempotent payments, no overpayment, per-client exposure cap ($60k), low **first-time limit** ($15k, manual review above it until a loan is repaid), capital-pool cap.
- **Missed payment:** 3-day grace, then member perks freeze (non-member pricing) until cured; 30+ days late = defaulted.

## Pricing (`src/plans.js`)

| Plan | Down | Flat charge | Terms | Notes |
|---|---|---|---|---|
| Non-member | 10% | 25% | 3 mo (13 wks) | |
| Access | 10% | 15% | 3 or 5 mo (13/22 wks) | $1,000/mo billed $6,000 per 6 mo; $2,500 trip credit per payment |
| Elite | 10% | 10% | 3 or 5 mo | $3,000/mo billed $9,000 per 3 mo; $5,000 trip credit per payment |
| Deposit holder | none | 5% | 12 mo (52 wks) | credit line = deposit ($50k/100k/150k/200k/500k) |
| Marketplace (Plan B) | 10% | 10% | 3 mo | listing = operator rate + 15% markup |

Flat charge = % of the **amount financed**. Member **trip credit** counts toward the down payment first, then reduces the
amount financed; it sits in a **segregated trust ledger** with monthly-reconciliation endpoint (`GET /admin/trust?bankBalanceCents=`).
Plan B: the operator is paid its own rate; JetReserve keeps the markup plus the charge (the plan's $8,000 → $9,200 → $2,028 example is a test).

Deposit open questions are config: `depositRefills` (credit line refills as repaid; default **true**); the deposit is held in
trust as collateral, not drawn down. Refund terms are not implemented.

## Group pay (`src/services/group.js`)

Main customer signs and owns the whole balance; up to 8 friends. **Invite → Join** (ID verified + own autopay) **→ Lock**
(`shrink`: absent friends dropped and shares recalculated, or `main_covers`) **→ Collect** (each person pays their equal
share of the down payment and every weekly payment; the main customer absorbs rounding). The trip books only when every
share of the down payment and first payment has cleared. **Backstop:** a friend's missed share is charged to the main
customer's card after the grace period (daily `sweep`). Friends can pay off early; the main customer can buy one out. The plan's
$9,000 / 9-person / $100 down / $86.54 weekly example is a test.

## API (`/api/v1`; partner key `x-api-key`, admin `x-admin-key`)

`GET /plans` · `GET /legs?email=` · `POST /quotes` · `POST /applications` · `GET /loans[/:id]` · `POST /loans/:id/accept|cancel|payments`
· `POST /loans/:id/group` · `POST /loans/:id/group/finalize` · `POST /group/join/:token` · `POST /loans/:id/group/members/:mid/payoff`
· `POST /members/join|renew|deposit` · `GET /members/:email`
· admin: `portfolio`, `loans`, `loans/:id/review`, `sweep`, `legs` (Plan B upload), `trust`.

Licensing (Plan A): each charter company is a `partners` row with its own hashed key, `max_loan_cents`, and `fee_adjust_bps`; loans are partner-scoped.

## Plan-to-code map

| Plan section | Status |
|---|---|
| How it works, pricing, unit economics | **Built** (plans, weekly schedules, payout ordering) |
| Memberships, trip credit, trust account | **Built** (ledger + reconciliation); real bank account/CPA attestation are operational |
| Deposit credit line | **Built** (refill config; refund terms open) |
| Group pay | **Built** |
| Plan B marketplace | **Built** (admin upload API + pricing); no operator-facing upload UI yet |
| Protecting repayment (first-time limits, exposure cap, grace, perk freeze, backstop) | **Built**, except: capped **late fee** (config stub, off), **credit-bureau reporting** and **collections** hand-off |
| Affirm/Uplift/ChargeAfter referral for borderline/over-cap loans | Not built |
| ID/credit/income verification | **Stubbed** (self-reported inputs); needs real KYC + bureau providers |
| Payments / ACH autopay / operator payouts | **Mocked** (`src/rails.js` adapter) |
| Plan C investment fund | **Not software**: a securities structure (Reg D etc.) for counsel. Code tracks a capital pool only |
| DOT broker registration, operator contracts, loan agreement text, insurance/bond, patent | Legal/operational, not code |

## Read before launch

- **APR.** Computed actuarially with the first payment at signing: ≈207% (Non-member 3 mo), ≈85% (Elite 3 mo), ≈72% (Access 5 mo),
  ≈48% (Elite 5 mo), ≈10% (deposit). These are **higher than the 174% / 72% / 44% / 9.7% in the plan**, which uses a different
  convention. Have counsel confirm the Reg Z method. The plan itself says pricing exceeds Texas consumer limits; quotes show the
  APR and a review flag, and `ENFORCE_APR_CAP=1` refuses consumer-track loans above the 18% reference cap (business-purpose
  clients are not capped here; confirm that track with counsel).
- **$30,000 cap.** The plan's $40k examples need `MAX_LOAN_CENTS=4000000`+ (default stays at your original $30k per trip;
  the excess becomes extra down payment).
- **Self-reported credit/income** and mock payments mean this must not take real money yet.
- Demo operators are fake; `cert_verified` must be backed by a real FAA Part 135 check.
- Not modeled: cancellation/refund after funding, operator payout reversals, operator login.
