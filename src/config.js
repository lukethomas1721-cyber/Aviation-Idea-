// Platform-wide rules. Pricing lives in plans.js; these are limits and operating parameters.
const int = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const list = (v, d) => (v ?? d).split(',').map((s) => s.trim()).filter(Boolean);
const json = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

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
  lateFeeCents: int(process.env.LATE_FEE_CENTS, 0), // plan calls for a CAPPED late fee; 0 = off until counsel signs off
  lateFeeCapBps: int(process.env.LATE_FEE_CAP_BPS, 500), // cap: % of the missed installment
  lossReserveBps: int(process.env.LOSS_RESERVE_BPS, 2000), // PLACEHOLDER: share of collected flat charges set aside as the loss reserve
  collectionsAgencyAfterDays: 90,
  partnerLenderMaxCents: 3_000_000, // borderline clients up to this size are referred to a partner BNPL lender
  operatorCommissionBps: int(process.env.OPERATOR_COMMISSION_BPS, 0), // plan assumes ~10% broker margin; set per contract
  launchStates: list(process.env.LAUNCH_STATES, 'TX'),             // plan: Texas clients only at launch
  financeableLegTypes: list(process.env.FINANCEABLE_LEG_TYPES, 'empty_leg'), // plan: empty legs first; add 'charter' later
  // Terms shift with leg type and hours to departure. Rules are additive; see termRules.js. Default: no shifts.
  termRules: json(process.env.TERM_RULES, []),
  // Texas Ch. 342 requires refunding unearned charges on early payoff. 'consumer' | 'all' | 'none'
  earlyPayoffRebate: process.env.EARLY_PAYOFF_REBATE ?? 'consumer',
  sessionMinutes: 30,               // embedded-checkout session lifetime
  demoMode: process.env.DEMO_MODE ? process.env.DEMO_MODE === '1' : process.env.NODE_ENV !== 'production', // enables simulated processor buttons
  maxGroupFriends: 8,
  depositRefills: true,             // open question in the plan: does the credit line refill as it is repaid?
  // Reference values taken from the business plan (Texas consumer-loan tiers). NOT legal advice: confirm with counsel.
  compliance: { consumerAprCap: 0.18, licenseAprThreshold: 0.10, enforce: process.env.ENFORCE_APR_CAP === '1' },
  port: int(process.env.PORT, 3000)
};
