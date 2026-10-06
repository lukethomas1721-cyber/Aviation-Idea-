import { CONFIG } from './config.js';
import { PLANS, WEEKS } from './plans.js';
import { apr, addDays, dateOnly, feeFor, splitEven } from './money.js';
import { bad } from './errors.js';
import { allowedTerms } from './termRules.js';

// First installment is due (autopay-charged) at signing, then weekly.
export function scheduleFor({ principalCents, feeCents, installments, intervalDays, startDate }) {
  const totals = splitEven(principalCents + feeCents, installments);
  const fees = splitEven(feeCents, installments);
  return totals.map((amount, i) => ({
    seq: i + 1,
    dueDate: addDays(startDate, intervalDays * i),
    amountCents: amount,
    feeCents: fees[i],
    principalCents: amount - fees[i]
  }));
}

/**
 * Terms for one flight under one plan.
 *  priceCents          customer-facing price (operator rate + any marketplace markup)
 *  operatorPriceCents  what the operator is paid in full at funding
 *  creditCents         member trip credit available; counts toward the down payment first, then reduces the amount financed
 */
export function buildTerms({ priceCents, operatorPriceCents = priceCents, plan, termMonths, creditCents = 0, partner, now, config = CONFIG, adjust = null }) {
  if (typeof plan === 'string') plan = PLANS[plan];
  if (!plan) throw bad('unknown_plan', 'Unknown plan');
  const terms = allowedTerms(plan, adjust);
  termMonths = termMonths ?? terms[0];
  if (!terms.includes(termMonths)) {
    throw bad('invalid_term', `${plan.name} offers terms of ${terms.join(' or ')} months`, { allowed: terms });
  }
  const cap = Math.min(partner.max_loan_cents, config.maxLoanCents);
  const downBps = plan.downBps > 0 ? Math.max(0, plan.downBps + (adjust?.downBpsAdd ?? 0)) : 0; // deposit holders never owe a down payment
  const downBase = Math.round((priceCents * downBps) / 10000);
  const creditToDown = Math.min(creditCents, downBase);
  const creditToPrincipal = Math.max(0, Math.min(creditCents - creditToDown, priceCents - downBase - config.minLoanCents));
  let principal = priceCents - downBase - creditToPrincipal;
  const extraDown = Math.max(0, principal - cap); // anything over the per-trip cap must be paid up front
  principal -= extraDown;
  if (principal < config.minLoanCents) throw bad('below_minimum', `Financed amount must be at least ${config.minLoanCents / 100} USD`);

  const flatBps = Math.max(0, plan.flatBps + (partner.fee_adjust_bps || 0) + (adjust?.flatBpsAdd ?? 0));
  const fee = feeFor(principal, flatBps);
  const installments = WEEKS[termMonths];
  const schedule = scheduleFor({ principalCents: principal, feeCents: fee, installments, intervalDays: config.intervalDays, startDate: dateOnly(now) });
  return {
    plan: { id: plan.id, name: plan.name },
    termMonths,
    termRulesApplied: adjust?.applied ?? [],
    charterPriceCents: priceCents,
    payoutCents: operatorPriceCents,
    downPaymentCents: downBase + extraDown,
    downPaymentRequired: downBase + extraDown > 0,
    creditAppliedCents: creditToDown + creditToPrincipal,
    cashDownCents: downBase - creditToDown + extraDown,
    principalCents: principal,
    flatBps,
    feeCents: fee,
    totalRepaymentCents: principal + fee,
    installments,
    intervalDays: config.intervalDays,
    weeklyPaymentCents: schedule[0].amountCents,
    apr: apr(principal, schedule.map((s) => s.amountCents), 52, 0),
    schedule
  };
}

const BASE_DISCLOSURE = 'Flat financing charge on the amount financed, repaid by weekly autopay. The first payment is charged at signing. The APR shown is an estimate for comparison purposes.';
// Early repayment wording follows CONFIG.earlyPayoffRebate (Texas Ch. 342 refund of unearned charges for consumer loans).
export function disclosure(entityType, config = CONFIG) {
  const refunds = config.earlyPayoffRebate === 'all' || (config.earlyPayoffRebate === 'consumer' && entityType === 'individual');
  return `${BASE_DISCLOSURE} ${refunds ? 'If you pay off early, the unearned portion of the charge is refunded.' : 'The charge is fixed and is not reduced by early repayment.'}`;
}
export const DISCLOSURE = disclosure('llc');
