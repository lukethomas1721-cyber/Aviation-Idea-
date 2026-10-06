import { test } from 'node:test';
import assert from 'node:assert/strict';
import { underwrite } from '../src/underwriting.js';

const base = { annual_revenue_cents: 10_000_000_00, years_in_business: 5, credit_score: 750, kyc_passed: 1, ofac_clear: 1, entity_type: 'llc', state: 'TX' };
const run = (b = {}, o = {}) => underwrite({ borrower: { ...base, ...b }, principalCents: 3_000_000, existingExposureCents: 0, priorDefaults: 0, maxExposureCents: 6_000_000, repaidLoans: 1, launchStates: ['TX'], ...o });

test('strong borrower approved tier A', () => { const r = run(); assert.equal(r.decision, 'approved'); assert.equal(r.riskTier, 'A'); });
test('failed KYC / OFAC decline', () => {
  assert.equal(run({ kyc_passed: 0 }).decision, 'declined');
  assert.equal(run({ ofac_clear: 0 }).reasons[0].code, 'ofac_hit');
});
test('low credit declines, borderline goes to review', () => {
  assert.equal(run({ credit_score: 580 }).decision, 'declined');
  assert.equal(run({ credit_score: 640 }).decision, 'review');
});
test('revenue ratio: >25% declines, >10% reviews', () => {
  assert.equal(run({ annual_revenue_cents: 10_000_000 }).decision, 'declined');
  assert.equal(run({ annual_revenue_cents: 20_000_000 }).decision, 'review');
});
test('prior default and exposure limit decline', () => {
  assert.equal(run({}, { priorDefaults: 1 }).decision, 'declined');
  assert.equal(run({}, { existingExposureCents: 4_000_000 }).reasons[0].code, 'exposure_limit');
});
test('new business reviewed, but individuals are exempt from that test', () => {
  assert.equal(run({ years_in_business: 0.5 }).decision, 'review');
  assert.equal(run({ years_in_business: 0, entity_type: 'individual' }).decision, 'approved');
});
test('first-time clients have a low starting limit', () => {
  const r = run({}, { repaidLoans: 0, firstTimeMaxCents: 1_500_000 });
  assert.equal(r.decision, 'review');
  assert.equal(r.reasons[0].code, 'first_time_limit');
  assert.equal(run({}, { repaidLoans: 1, firstTimeMaxCents: 1_500_000 }).decision, 'approved');
});

test('launch phase: only clients in launch states (Texas) are served', () => {
  const r = run({ state: 'CA' });
  assert.equal(r.decision, 'declined');
  assert.equal(r.reasons[0].code, 'state_not_available');
  assert.equal(run({ state: 'CA' }, { launchStates: ['TX', 'CA'] }).decision, 'approved');
  assert.equal(run({ state: 'CA' }, { launchStates: null }).decision, 'approved'); // no restriction configured
});
