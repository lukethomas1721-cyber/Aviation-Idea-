import { CONFIG } from './config.js';
import { PLANS } from './plans.js';
import { buildTerms } from './pricing.js';

// The plan's unit-economics and market-size tables as code, so investor numbers come from the same pricing engine as
// production loans. Gross figures: before cost of capital, processing, staff and defaults (the plan says so too).
const NO_CAP = { ...CONFIG, maxLoanCents: 1e15 };
const PARTNER = { max_loan_cents: 1e15, fee_adjust_bps: 0 };

export function unitEconomics({ priceCents, planId, termMonths, brokerMarginBps = 1000, now = new Date() }) {
  const t = buildTerms({ priceCents, plan: PLANS[planId], termMonths, partner: PARTNER, config: NO_CAP, now });
  const brokerMarginCents = Math.round((priceCents * brokerMarginBps) / 10000); // plan: operator's cost ~90% of listed price
  return {
    plan: planId, termMonths: t.termMonths, priceCents,
    downCents: t.downPaymentCents, financedCents: t.principalCents, flatChargeCents: t.feeCents,
    weeklyPaymentCents: Math.round(t.totalRepaymentCents / t.installments),
    clientPaysCents: t.downPaymentCents + t.totalRepaymentCents,
    brokerMarginCents, jetreserveEarnsCents: brokerMarginCents + t.feeCents,
    // capital out per year: weekly-amortizing principal averages (n+1)/2 payments' worth outstanding over n weeks
    capitalYearsCents: Math.round((t.principalCents * (t.installments + 1)) / 2 / 52)
  };
}

// "Financing 1% of U.S. empty legs would gross about $7.3M-$9.4M a year and need about $3.5M-$4.5M lent out at any time."
// Per-flight figures use the plan's $6,926 example on a 3-month plan, averaged over Non-member, Access and Elite.
export function marketModel({ sharesPct = [0.1, 0.5, 1, 2], flightsPerYear = [420_000, 540_000], examplePriceCents = 692_600, termMonths = 3 } = {}) {
  const per = ['non_member', 'access', 'elite'].map((p) => unitEconomics({ priceCents: examplePriceCents, planId: p, termMonths }));
  const avgEarnCents = Math.round(per.reduce((s, e) => s + Math.round(e.jetreserveEarnsCents / 100), 0) / per.length) * 100; // whole dollars, as in the plan
  const capitalCents = per[0].capitalYearsCents;
  return {
    example: { priceCents: examplePriceCents, earnsByPlanCents: Object.fromEntries(per.map((e) => [e.plan, e.jetreserveEarnsCents])), avgEarnCents, capitalPerFlightYearCents: capitalCents },
    rows: sharesPct.map((pct) => {
      const flights = flightsPerYear.map((f) => Math.round((f * pct) / 100));
      return {
        sharePct: pct, flightsPerYear: flights, flightsPerWeek: flights.map((f) => Math.round(f / 52)),
        grossPerYearCents: flights.map((f) => f * avgEarnCents), capitalAtOnceCents: flights.map((f) => f * capitalCents)
      };
    })
  };
}
