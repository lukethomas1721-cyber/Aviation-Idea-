// Platform-wide lending rules. Partners (licensees) may tighten these
// (lower cap, different fee) but never exceed maxLoanCents.
const int = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export const CONFIG = {
  maxLoanCents: 3_000_000,          // $30,000 per trip
  minLoanCents: 100_000,            // $1,000
  feeBps: 1000,                     // flat 10% financing charge on principal
  installments: 3,                  // max 3-month term
  intervalDays: 30,
  minLeadHours: 2,                  // must depart at least this far out
  maxLeadDays: 30,                  // empty legs are short-dated
  holdMinutes: 30,                  // approved-offer / leg hold
  reviewHoldMinutes: 120,
  capitalPoolCents: int(process.env.CAPITAL_POOL_CENTS, 200_000_000), // $2M
  maxBorrowerExposureCents: 6_000_000, // $60k outstanding per borrower
  defaultAfterDaysPastDue: 30,
  lateFeeCents: 0,                  // keep 0 until counsel signs off (not applied anywhere yet)
  port: int(process.env.PORT, 3000)
};
