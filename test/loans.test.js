import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, goodBorrower, firstLeg } from './helpers.js';
import * as svc from '../src/services/loans.js';

const consents = { creditCheck: true };
const accept = { acceptedTerms: true, signatureName: 'Jane CFO' };

test('quote on a $11,889 leg: 10% fee, 3 payments', () => {
  const { ctx, db } = setup();
  const leg = firstLeg(db, (l) => l.priceCents === 1_188_900);
  const q = svc.createQuote(ctx(), { legId: leg.id });
  assert.equal(q.terms.feeCents, 118_890);
  assert.equal(q.terms.totalRepaymentCents, 1_307_790);
  assert.equal(q.terms.schedule.length, 3);
  assert.equal(q.terms.schedule.reduce((s, x) => s + x.amountCents, 0), 1_307_790);
  assert.ok(q.terms.apr > 0.5);
});

test('per-seat member flights are not financeable', () => {
  const { ctx, db } = setup();
  const leg = svc.listLegs(db, ctx().partner, ctx().now).find((l) => l.pricedPerSeat);
  assert.equal(leg.financing.financeable, false);
  assert.throws(() => svc.createQuote(ctx(), { legId: leg.id }), /cannot be financed/);
});

test('full lifecycle: apply -> accept -> fund -> pay -> paid', () => {
  const { ctx, db, clock } = setup();
  const leg = firstLeg(db, (l) => l.priceCents === 575_300);
  const loan = svc.applyForLoan(ctx(), { legId: leg.id, borrower: goodBorrower(), consents });
  assert.equal(loan.status, 'approved');
  assert.equal(db.prepare('SELECT status FROM legs WHERE id=?').get(leg.id).status, 'held');

  const funded = svc.acceptLoan(ctx(), loan.id, accept);
  assert.equal(funded.status, 'funded');
  assert.equal(db.prepare('SELECT status FROM legs WHERE id=?').get(leg.id).status, 'booked');
  const payout = db.prepare('SELECT * FROM payouts WHERE loan_id=?').get(loan.id);
  assert.equal(payout.amount_cents, 575_300); // operator is paid principal

  let cur = funded;
  for (const [i, inst] of funded.schedule.entries()) {
    clock.t = new Date(clock.t.getTime() + 30 * 86400000);
    cur = svc.recordPayment(ctx(), loan.id, { amountCents: inst.amountCents, idempotencyKey: `pay-key-${i}` });
  }
  assert.equal(cur.status, 'paid');
  assert.equal(cur.balanceCents, 0);
  const p = svc.portfolio(ctx());
  assert.equal(p.feeRevenueCollectedCents, 57_530);
  assert.equal(p.outstandingReceivableCents, 0);
});

test('payments are idempotent and overpayment is rejected', () => {
  const { ctx, db } = setup();
  const leg = firstLeg(db);
  const l = svc.applyForLoan(ctx(), { legId: leg.id, borrower: goodBorrower(), consents });
  svc.acceptLoan(ctx(), l.id, accept);
  const a = svc.recordPayment(ctx(), l.id, { amountCents: 10_000, idempotencyKey: 'same-key-1' });
  const b = svc.recordPayment(ctx(), l.id, { amountCents: 10_000, idempotencyKey: 'same-key-1' });
  assert.equal(a.balanceCents, b.balanceCents);
  assert.equal(a.balanceCents, l.terms.totalRepaymentCents - 10_000);
  assert.throws(() => svc.recordPayment(ctx(), l.id, { amountCents: 99_999_999, idempotencyKey: 'big-key-001' }), /exceeds balance/);
});

test('offer expires, releases leg, and cannot be accepted', () => {
  const { ctx, db, clock } = setup();
  const leg = firstLeg(db);
  const l = svc.applyForLoan(ctx(), { legId: leg.id, borrower: goodBorrower(), consents });
  clock.t = new Date(clock.t.getTime() + 31 * 60000);
  assert.throws(() => svc.acceptLoan(ctx(), l.id, accept), (e) => e.status === 410);
  assert.equal(db.prepare('SELECT status FROM legs WHERE id=?').get(leg.id).status, 'available');
});

test('a held leg cannot be double-booked', () => {
  const { ctx, db } = setup();
  const leg = firstLeg(db);
  svc.applyForLoan(ctx(), { legId: leg.id, borrower: goodBorrower(), consents });
  assert.throws(() => svc.applyForLoan(ctx(), { legId: leg.id, borrower: goodBorrower({ email: 'other@x.test' }), consents }), /leg_held/);
});

test('declined applicant gets reasons, leg stays available', () => {
  const { ctx, db } = setup();
  const leg = firstLeg(db);
  const l = svc.applyForLoan(ctx(), { legId: leg.id, borrower: goodBorrower({ creditScore: 520 }), consents });
  assert.equal(l.status, 'declined');
  assert.equal(l.decisionReasons[0].code, 'low_credit');
  assert.equal(db.prepare('SELECT status FROM legs WHERE id=?').get(leg.id).status, 'available');
});

test('manual review path: admin approves, then borrower can accept', () => {
  const { ctx, db } = setup();
  const leg = firstLeg(db);
  const l = svc.applyForLoan(ctx(), { legId: leg.id, borrower: goodBorrower({ creditScore: 640 }), consents });
  assert.equal(l.status, 'pending_review');
  assert.throws(() => svc.acceptLoan(ctx(), l.id, accept), /pending_review/);
  assert.equal(svc.reviewLoan(ctx(), l.id, { decision: 'approve' }).status, 'approved');
  assert.equal(svc.acceptLoan(ctx(), l.id, accept).status, 'funded');
});

test('trips above $30k need a down payment; financed principal is capped', () => {
  const { ctx, db } = setup();
  db.prepare("UPDATE legs SET price_cents=4500000 WHERE id=(SELECT id FROM legs WHERE aircraft='Gulfstream 550')").run();
  const leg = firstLeg(db, (l) => l.priceCents === 4_500_000);
  const q = svc.createQuote(ctx(), { legId: leg.id });
  assert.equal(q.terms.principalCents, 3_000_000);
  assert.equal(q.terms.downPaymentCents, 1_500_000);
  assert.equal(q.terms.downPaymentRequired, true);
});

test('unpaid installments > 30 days late are flagged defaulted by sweep, and cure when brought current', () => {
  const { ctx, db, clock } = setup();
  const leg = firstLeg(db);
  const l = svc.applyForLoan(ctx(), { legId: leg.id, borrower: goodBorrower(), consents });
  const f = svc.acceptLoan(ctx(), l.id, accept);
  clock.t = new Date(clock.t.getTime() + 62 * 86400000); // 32 days past first due date
  assert.equal(svc.sweep(ctx()).defaulted, 1);
  assert.equal(svc.getLoan(ctx(), l.id).status, 'defaulted');
  const cured = svc.recordPayment(ctx(), l.id, { amountCents: f.schedule[0].amountCents, idempotencyKey: 'cure-key-01' });
  assert.equal(cured.status, 'funded');
});

test('capital pool limit stops new originations', () => {
  const { ctx, db } = setup();
  const legs = svc.listLegs(db, ctx().partner, ctx().now, { financeableOnly: true });
  // Fill the pool by hand: pretend $1,999,000 is already committed.
  db.prepare("INSERT INTO borrowers VALUES ('b0','X','llc','x@x.test',1,1,700,1,1,'t')").run();
  db.prepare(`INSERT INTO loans (id,partner_id,leg_id,borrower_id,status,charter_price_cents,down_payment_cents,principal_cents,fee_bps,fee_cents,total_cents,apr,installments,interval_days,decision,decision_reasons,created_at)
    VALUES ('l0','ptr_demo',?, 'b0','funded',1,0,199900000,1000,1,1,0,3,30,'approved','[]','t')`).run(legs[0].id);
  assert.throws(() => svc.applyForLoan(ctx(), { legId: legs[1].id, borrower: goodBorrower(), consents }), (e) => e.code === 'capital_unavailable');
});

test('credit-check consent and borrower validation are enforced', () => {
  const { ctx, db } = setup();
  const leg = firstLeg(db);
  assert.throws(() => svc.applyForLoan(ctx(), { legId: leg.id, borrower: goodBorrower(), consents: {} }), /consents/);
  assert.throws(() => svc.applyForLoan(ctx(), { legId: leg.id, borrower: goodBorrower({ email: 'nope' }), consents }), /email/);
});
