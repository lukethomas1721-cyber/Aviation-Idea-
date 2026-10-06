import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTerms } from '../src/pricing.js';
import { checkCompliance } from '../src/compliance.js';
import { CONFIG } from '../src/config.js';

const partner = { max_loan_cents: 99_000_000_00, fee_adjust_bps: 0 };
const now = new Date('2026-10-06T12:00:00Z');
const t = (priceCents, plan, termMonths, extra = {}) => buildTerms({ priceCents, plan, termMonths, partner, now, ...extra });

test('Plan B example: $8,000 operator rate -> $9,200 shown, $920 down, $828 charge, $700.62/wk x13', () => {
  const x = t(920_000, 'marketplace', 3, { operatorPriceCents: 800_000 });
  assert.equal(x.downPaymentCents, 92_000);
  assert.equal(x.feeCents, 82_800);
  assert.equal(x.installments, 13);
  assert.ok(Math.abs(x.weeklyPaymentCents - 70_062) <= 1);
  assert.equal(x.payoutCents, 800_000);
});
test('plan table: $40k at 25% / 15% / 10% flat on $36,000 financed (cap lifted)', () => {
  const big = { config: { ...CONFIG, maxLoanCents: 99e10 } }; // the plan's $40k examples need the $30k house cap lifted
  assert.equal(t(4_000_000, 'non_member', 3, big).feeCents, 900_000);
  assert.equal(t(4_000_000, 'access', 3, big).feeCents, 540_000);
  assert.equal(t(4_000_000, 'elite', 5, big).feeCents, 360_000);
  assert.equal(t(4_000_000, 'elite', 5, big).installments, 22);
  assert.equal(t(4_000_000, 'elite', 5, big).weeklyPaymentCents, 180_000);
});
test('deposit holder: no down payment, 5% flat, 52 weeks', () => {
  const x = t(2_500_000, 'deposit', 12);
  assert.equal(x.downPaymentCents, 0);
  assert.equal(x.feeCents, 125_000);
  assert.equal(x.installments, 52);
  assert.ok(x.apr > 0.09 && x.apr < 0.11);
});
test('terms are restricted per plan', () => {
  assert.throws(() => t(900_000, 'non_member', 5), /offers terms/);
  assert.throws(() => t(900_000, 'deposit', 3), /offers terms/);
});
test('member credit counts toward the down payment first, then reduces the amount financed', () => {
  const a = t(900_000, 'access', 3, { creditCents: 50_000 });     // $500 credit < $900 down
  assert.equal(a.cashDownCents, 40_000);
  assert.equal(a.principalCents, 810_000);
  const b = t(900_000, 'access', 3, { creditCents: 250_000 });    // $2,500 credit: covers $900 down + $1,600 off principal
  assert.equal(b.cashDownCents, 0);
  assert.equal(b.principalCents, 810_000 - 160_000);
});
test('per-trip cap forces the excess into the down payment', () => {
  const x = t(4_500_000, 'non_member', 3, { partner: { max_loan_cents: 3_000_000, fee_adjust_bps: 0 } });
  assert.equal(x.principalCents, 3_000_000);
  assert.equal(x.downPaymentCents, 1_500_000);
});
test('compliance flags: consumer track over the reference cap, business track has none', () => {
  assert.equal(checkCompliance({ apr: 1.5, entityType: 'individual' }).exceedsReferenceCap, true);
  assert.equal(checkCompliance({ apr: 1.5, entityType: 'llc' }).exceedsReferenceCap, false);
  assert.equal(checkCompliance({ apr: 0.05, entityType: 'individual' }).requiresLenderLicense, false);
});
