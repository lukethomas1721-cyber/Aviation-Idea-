// Platform-wide rules. Pricing lives in plans.js; these are limits and operating parameters.
const int = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export const CONFIG = {
  maxLoanCents: int(process.env.MAX_LOAN_CENTS, 3_000_000), // $30,000 per trip financed on our book (excess needs extra down payment)
  minLoanCents: 100_000,
  intervalDays: 7,                  // weekly autopay
  minLeadHours: 2,
  maxLeadDays: 30,
  holdMinutes: 30,                  // approved offer hold
  reviewHoldMinutes: 120,
  groupInviteMinutes: 120,          // time for friends to join a group trip
  signedWindowMinutes: 60,          // after signing: time for down payment + first autopay to clear
  capitalPoolCents: int(process.env.CAPITAL_POOL_CENTS, 200_000_000),
  maxBorrowerExposureCents: 6_000_000, // cap on total open balances per client
  firstTimeMaxCents: 1_500_000,     // low limit for clients with no repaid history; manual review above this
  graceDays: 3,                     // short grace period before perks freeze / group backstop
  defaultAfterDaysPastDue: 30,
  lateFeeCents: 0,                  // plan calls for a capped late fee: set after counsel signs off (not applied yet)
  maxGroupFriends: 8,
  depositRefills: true,             // open question in the plan: does the credit line refill as it is repaid?
  // Reference values taken from the business plan (Texas consumer-loan tiers). NOT legal advice: confirm with counsel.
  compliance: { consumerAprCap: 0.18, licenseAprThreshold: 0.10, enforce: process.env.ENFORCE_APR_CAP === '1' },
  port: int(process.env.PORT, 3000)
};
