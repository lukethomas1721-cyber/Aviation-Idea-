import { CONFIG } from './config.js';
import { apr, addDays, dateOnly, feeFor, splitEven } from './money.js';
import { bad } from './errors.js';

export function scheduleFor({ principalCents, feeCents, installments, intervalDays, startDate }) {
  const totals = splitEven(principalCents + feeCents, installments);
  const fees = splitEven(feeCents, installments);
  return totals.map((amount, i) => ({
    seq: i + 1,
    dueDate: addDays(startDate, intervalDays * (i + 1)),
    amountCents: amount,
    feeCents: fees[i],
    principalCents: amount - fees[i]
  }));
}

// Financing terms for a charter price. Anything above the per-trip cap must be covered by a down payment.
export function buildTerms({ priceCents, downPaymentCents = 0, partner, now, config = CONFIG }) {
  const cap = Math.min(partner.max_loan_cents, config.maxLoanCents);
  if (!Number.isInteger(downPaymentCents) || downPaymentCents < 0) throw bad('invalid_down_payment', 'downPaymentCents must be a non-negative integer');
  const requiredDown = Math.max(0, priceCents - cap);
  const down = Math.max(downPaymentCents, requiredDown);
  const principal = priceCents - down;
  if (principal < config.minLoanCents) {
    throw bad('below_minimum', `Financed amount must be at least ${config.minLoanCents / 100} USD`);
  }
  const fee = feeFor(principal, partner.fee_bps);
  const schedule = scheduleFor({
    principalCents: principal, feeCents: fee, installments: config.installments,
    intervalDays: config.intervalDays, startDate: dateOnly(now)
  });
  return {
    charterPriceCents: priceCents,
    downPaymentCents: down,
    downPaymentRequired: requiredDown > 0,
    principalCents: principal,
    feeBps: partner.fee_bps,
    feeCents: fee,
    totalRepaymentCents: principal + fee,
    installments: config.installments,
    intervalDays: config.intervalDays,
    apr: apr(principal, schedule.map((s) => s.amountCents)),
    schedule
  };
}

export const DISCLOSURE =
  'Flat financing charge on the amount financed, repaid in equal monthly installments. The charge is fixed and is not reduced ' +
  'by early repayment. The APR shown is an estimate for comparison purposes. Business-purpose credit only.';
