import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, goodBorrower, person, firstLeg, legAt, consents, sign, key, fundLoan, DAY } from './helpers.js';
import * as svc from '../src/services/loans.js';

const status = (db, legId) => db.prepare('SELECT status FROM legs WHERE id=?').get(legId).status;

test('quote on an $11,889 leg: non-member 25% flat, 13 weekly payments, APR disclosed', () => {
  const { ctx, db } = setup();
  const q = svc.createQuote(ctx(), { legId: legAt(db, 1_188_900).id, entityType: 'individual' });
  assert.equal(q.terms.plan.id, 'non_member');
  assert.equal(q.terms.downPaymentCents, 118_890);
  assert.equal(q.terms.principalCents, 1_070_010);
  assert.equal(q.terms.feeCents, 267_503); // 25% of financed (rounded)
  assert.equal(q.terms.installments, 13);
  assert.equal(q.terms.schedule.reduce((s, x) => s + x.amountCents, 0), q.terms.totalRepaymentCents);
  assert.equal(q.terms.schedule[0].dueDate, '2026-10-06'); // first autopay at signing
  assert.equal(q.terms.schedule[1].dueDate, '2026-10-13');
  assert.equal(q.compliance.exceedsReferenceCap, true);
  assert.equal(q.compliance.track, 'consumer');
});

test('per-seat member flights are not financeable', () => {
  const { ctx, db } = setup();
  const leg = svc.listLegs(db, ctx().partner, ctx().now).find((l) => l.pricedPerSeat);
  assert.equal(leg.financing.financeable, false);
  assert.throws(() => svc.createQuote(ctx(), { legId: leg.id }), /cannot be financed/);
});

test('operator is paid in full ONLY after down payment and first autopay clear', () => {
  const { ctx, db, calls } = setup();
  const leg = legAt(db, 575_300);
  const loan = svc.applyForLoan(ctx(), { legId: leg.id, borrower: goodBorrower(), consents });
  assert.equal(loan.status, 'approved');
  assert.equal(status(db, leg.id), 'held');

  const signed = svc.acceptLoan(ctx(), loan.id, sign);
  assert.equal(signed.status, 'signed');
  assert.equal(status(db, leg.id), 'locked');                       // flight locks at signature
  assert.equal(signed.terms.weeklyPaymentCents, signed.schedule[0].amountCents);
  assert.equal(loan.terms.weeklyPaymentCents, loan.schedule[0].amountCents); // present on the offer too, not just the quote
  assert.equal(signed.dueAtSigningCents, 57_530 + signed.schedule[0].amountCents);
  assert.equal(calls.disburse.length, 0);

  svc.recordPayment(ctx(), loan.id, { kind: 'down_payment', idempotencyKey: key() });
  assert.equal(svc.getLoan(ctx(), loan.id).status, 'signed');       // still not funded: first autopay missing
  assert.equal(calls.disburse.length, 0);

  const funded = svc.recordPayment(ctx(), loan.id, { kind: 'installment', idempotencyKey: key() });
  assert.equal(funded.status, 'funded');
  assert.equal(calls.disburse.length, 1);
  assert.equal(calls.disburse[0].amountCents, 575_300);             // operator paid the full price
  assert.equal(status(db, leg.id), 'booked');
});

test('only the first installment can be collected before funding', () => {
  const { ctx, db } = setup();
  const loan = svc.applyForLoan(ctx(), { legId: firstLeg(db).id, borrower: goodBorrower(), consents });
  svc.acceptLoan(ctx(), loan.id, sign);
  assert.throws(() => svc.recordPayment(ctx(), loan.id, { amountCents: 10_000_000, idempotencyKey: key() }), /exceeds balance/);
});

test('signing needs autopay and a backup card', () => {
  const { ctx, db } = setup();
  const loan = svc.applyForLoan(ctx(), { legId: firstLeg(db).id, borrower: goodBorrower(), consents });
  assert.throws(() => svc.acceptLoan(ctx(), loan.id, { ...sign, autopay: undefined }), /autopay/);
  assert.throws(() => svc.acceptLoan(ctx(), loan.id, { ...sign, backupCardLast4: undefined }), /backup/);
});

test('signed loan that never clears is unwound: leg released, refund issued', () => {
  const { ctx, db, clock, calls } = setup();
  const leg = legAt(db, 575_300);
  const loan = svc.applyForLoan(ctx(), { legId: leg.id, borrower: goodBorrower(), consents });
  svc.acceptLoan(ctx(), loan.id, sign);
  svc.recordPayment(ctx(), loan.id, { kind: 'down_payment', idempotencyKey: key() });
  clock.t = new Date(clock.t.getTime() + 61 * 60000);
  assert.equal(svc.sweep(ctx()).expired, 1);
  assert.equal(svc.getLoan(ctx(), loan.id).status, 'expired');
  assert.equal(status(db, leg.id), 'available');
  assert.equal(calls.refund[0].amountCents, 57_530);
  assert.equal(calls.disburse.length, 0);
});

test('full lifecycle: 13 weekly payments -> paid, revenue split correct', () => {
  const { ctx, db, clock } = setup();
  const loan = fundLoan(ctx, db, legAt(db, 575_300).id);
  assert.equal(loan.status, 'funded');
  for (const [i, inst] of loan.schedule.entries()) {
    if (i === 0) continue;
    clock.t = new Date(Date.parse(inst.dueDate + 'T12:00:00Z'));
    svc.recordPayment(ctx(), loan.id, { idempotencyKey: key() });
  }
  const done = svc.getLoan(ctx(), loan.id);
  assert.equal(done.status, 'paid');
  assert.equal(done.balanceCents, 0);
  const p = svc.portfolio(ctx());
  assert.equal(p.feeRevenueCollectedCents, loan.terms.feeCents);
  assert.equal(p.outstandingReceivableCents, 0);
});

test('payments are idempotent and overpayment is rejected', () => {
  const { ctx, db } = setup();
  const l = fundLoan(ctx, db, firstLeg(db).id);
  const a = svc.recordPayment(ctx(), l.id, { amountCents: 10_000, idempotencyKey: 'same-key-1' });
  const b = svc.recordPayment(ctx(), l.id, { amountCents: 10_000, idempotencyKey: 'same-key-1' });
  assert.equal(a.balanceCents, b.balanceCents);
  assert.equal(a.balanceCents, l.balanceCents - 10_000);
  assert.throws(() => svc.recordPayment(ctx(), l.id, { amountCents: 99_999_999, idempotencyKey: 'big-key-001' }), /exceeds balance/);
});

test('offer expires, releases leg, and cannot be signed', () => {
  const { ctx, db, clock } = setup();
  const leg = firstLeg(db);
  const l = svc.applyForLoan(ctx(), { legId: leg.id, borrower: goodBorrower(), consents });
  clock.t = new Date(clock.t.getTime() + 31 * 60000);
  assert.throws(() => svc.acceptLoan(ctx(), l.id, sign), (e) => e.status === 410);
  assert.equal(status(db, leg.id), 'available');
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
  assert.equal(status(db, leg.id), 'available');
});

test('manual review: admin approves then borrower can sign; decline releases the leg', () => {
  const { ctx, db } = setup();
  const leg = firstLeg(db);
  const l = svc.applyForLoan(ctx(), { legId: leg.id, borrower: goodBorrower({ creditScore: 640 }), consents });
  assert.equal(l.status, 'pending_review');
  assert.throws(() => svc.acceptLoan(ctx(), l.id, sign), /pending_review/);
  assert.equal(svc.reviewLoan(ctx(), l.id, { decision: 'approve' }).status, 'approved');
  assert.equal(svc.acceptLoan(ctx(), l.id, sign).status, 'signed');

  const leg2 = svc.listLegs(db, ctx().partner, ctx().now, { financeableOnly: true })[0];
  const l2 = svc.applyForLoan(ctx(), { legId: leg2.id, borrower: goodBorrower({ creditScore: 640, email: 'b@x.test' }), consents });
  svc.reviewLoan(ctx(), l2.id, { decision: 'decline', note: 'no' });
  assert.equal(status(db, leg2.id), 'available');
});


test('unpaid weekly installments > 30 days late default via sweep, and cure when brought current', () => {
  const { ctx, db, clock } = setup();
  const l = fundLoan(ctx, db, firstLeg(db).id);
  clock.t = new Date(clock.t.getTime() + (7 + 31) * DAY); // installment 2 is 31 days late
  assert.equal(svc.sweep(ctx()).defaulted, 1);
  assert.equal(svc.getLoan(ctx(), l.id).status, 'defaulted');
  const owedNow = l.schedule.filter((s) => s.dueDate <= '2026-11-13').slice(1);
  let cur;
  for (const s of owedNow) cur = svc.recordPayment(ctx(), l.id, { amountCents: s.amountCents, idempotencyKey: key() });
  assert.equal(cur.status, 'funded');
});

test('capital pool limit stops new originations', () => {
  const { ctx, db } = setup();
  const legs = svc.listLegs(db, ctx().partner, ctx().now, { financeableOnly: true });
  db.prepare("INSERT INTO borrowers VALUES ('b0','X','llc','x@x.test',1,1,700,1,1,'t')").run();
  db.prepare(`INSERT INTO loans (id,partner_id,leg_id,borrower_id,status,plan_id,term_months,charter_price_cents,payout_cents,down_payment_cents,credit_applied_cents,cash_down_cents,
    principal_cents,fee_bps,fee_cents,total_cents,apr,installments,interval_days,decision,decision_reasons,created_at)
    VALUES ('l0','ptr_demo',?, 'b0','funded','non_member',3,1,1,0,0,0,199900000,2500,1,1,0,13,7,'approved','[]','t')`).run(legs[0].id);
  assert.throws(() => svc.applyForLoan(ctx(), { legId: legs[1].id, borrower: goodBorrower(), consents }), (e) => e.code === 'capital_unavailable');
});

test('consent and borrower validation', () => {
  const { ctx, db } = setup();
  const leg = firstLeg(db);
  assert.throws(() => svc.applyForLoan(ctx(), { legId: leg.id, borrower: goodBorrower(), consents: {} }), /consents/);
  assert.throws(() => svc.applyForLoan(ctx(), { legId: leg.id, borrower: goodBorrower({ email: 'nope' }), consents }), /email/);
});

test('ENFORCE_APR_CAP style enforcement refuses consumer loans above the reference cap', async () => {
  const { CONFIG } = await import('../src/config.js');
  const { ctx, db } = setup();
  CONFIG.compliance.enforce = true;
  try {
    assert.throws(() => svc.applyForLoan(ctx(), { legId: firstLeg(db).id, borrower: person(), consents }), (e) => e.code === 'pricing_not_permitted');
    assert.equal(svc.applyForLoan(ctx(), { legId: firstLeg(db).id, borrower: goodBorrower(), consents }).status, 'approved'); // business track
  } finally { CONFIG.compliance.enforce = false; }
});

test('Plan B: marketplace listing adds 15% to the operator rate; operator gets its own rate, JetReserve keeps markup + charge', () => {
  const { ctx, db, calls } = setup();
  const op = db.prepare('SELECT id FROM operators').get().id;
  const leg = svc.createMarketplaceLeg(ctx(), {
    operatorId: op, originCode: 'dal', originCity: 'Dallas', destCode: 'hou', destCity: 'Houston', aircraft: 'Citation CJ3', seats: 6,
    category: 'Light jet', operatorPriceCents: 800_000, durationMin: 50, departsAt: new Date(Date.now() + 3 * DAY).toISOString(), window: 'Afternoon'
  });
  assert.equal(leg.priceCents, 920_000);
  assert.equal(leg.marketplace, true);
  const loan = svc.applyForLoan(ctx(), { legId: leg.id, borrower: goodBorrower(), consents });
  assert.equal(loan.plan.id, 'marketplace');
  assert.equal(loan.terms.feeCents, 82_800);
  svc.acceptLoan(ctx(), loan.id, sign);
  svc.recordPayment(ctx(), loan.id, { kind: 'down_payment', idempotencyKey: key() });
  svc.recordPayment(ctx(), loan.id, { idempotencyKey: key() });
  assert.equal(calls.disburse[0].amountCents, 800_000);
  assert.equal(svc.portfolio(ctx()).marketplaceMarkupCents, 120_000);
});
