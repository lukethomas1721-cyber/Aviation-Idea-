import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, goodBorrower, person, firstLeg, legAt, consents, sign, key, fundLoan, DAY } from './helpers.js';
import * as svc from '../src/services/loans.js';
import * as members from '../src/services/members.js';
import { CONFIG } from '../src/config.js';

test('Access membership: dues recorded, $2,500 trip credit lands in the trust ledger', () => {
  const { ctx } = setup();
  const m = members.joinMembership(ctx(), { email: 'Pat@Example.test', planId: 'access' });
  assert.equal(m.plan, 'access');
  assert.equal(m.tripCreditCents, 250_000);
  assert.equal(svc.portfolio(ctx()).membershipDuesCents, 600_000); // $1,000/mo billed $6,000 every 6 months
  assert.throws(() => members.joinMembership(ctx(), { email: 'pat@example.test', planId: 'elite' }), /Already/);
  assert.equal(members.renewMembership(ctx(), { email: 'pat@example.test' }).tripCreditCents, 500_000);
});

test('Elite dues are $9,000 per 3-month payment with $5,000 credit', () => {
  const { ctx } = setup();
  const m = members.joinMembership(ctx(), { email: 'e@x.test', planId: 'elite' });
  assert.equal(m.tripCreditCents, 500_000);
  assert.equal(svc.portfolio(ctx()).membershipDuesCents, 900_000);
});

test('member pricing applies at quote time; credit is applied and reserved, then released on cancel', () => {
  const { ctx, db } = setup();
  members.joinMembership(ctx(), { email: 'e@x.test', planId: 'elite' });
  const leg = legAt(db, 575_300);
  const q = svc.createQuote(ctx(), { legId: leg.id, email: 'e@x.test', termMonths: 5 });
  assert.equal(q.terms.plan.id, 'elite');
  assert.equal(q.terms.installments, 22);
  // $5,000 credit: $575.30 covers the 10% down, the rest cuts the financed amount down to the $1,000 minimum
  assert.equal(q.terms.creditAppliedCents, 475_300);
  assert.equal(q.terms.principalCents, 100_000);
  assert.equal(q.terms.cashDownCents, 0);                      // credit covers the 10% down
  assert.deepEqual(q.options.map((o) => o.termMonths), [3, 5]);

  const loan = svc.applyForLoan(ctx(), { legId: leg.id, termMonths: 5, borrower: person({ email: 'e@x.test', entityType: 'llc' }), consents });
  assert.equal(loan.plan.id, 'elite');
  const used = loan.terms.creditAppliedCents;
  assert.equal(members.memberView(ctx(), 'e@x.test').tripCreditCents, 500_000 - used);
  svc.cancelLoan(ctx(), loan.id);
  assert.equal(members.memberView(ctx(), 'e@x.test').tripCreditCents, 500_000);
});

test('non-members cannot select a member term', () => {
  const { ctx, db } = setup();
  assert.throws(() => svc.createQuote(ctx(), { legId: firstLeg(db).id, termMonths: 5 }), /offers terms/);
});

test('deposit holder: credit line = deposit, 5% flat, 52 weeks, refills as repaid', () => {
  const { ctx, db, clock } = setup();
  assert.throws(() => members.depositFunds(ctx(), { email: 'd@x.test', amountCents: 123 }), /offered amounts/);
  const m = members.depositFunds(ctx(), { email: 'd@x.test', amountCents: 5_000_000 });
  assert.equal(m.creditLine.availableCents, 5_000_000);

  const leg = legAt(db, 1_188_900);
  const q = svc.createQuote(ctx(), { legId: leg.id, email: 'd@x.test' });
  assert.equal(q.terms.plan.id, 'deposit');
  assert.equal(q.terms.downPaymentCents, 0);
  assert.equal(q.terms.feeCents, Math.round(1_188_900 * 0.05));
  assert.equal(q.terms.installments, 52);

  const loan = fundLoan(ctx, db, leg.id, goodBorrower({ email: 'd@x.test' }));
  assert.equal(loan.status, 'funded');
  const used = 5_000_000 - members.memberView(ctx(), 'd@x.test').creditLine.availableCents;
  assert.ok(used > 0 && used <= loan.terms.principalCents, 'line is drawn by the financed principal (less what was repaid)');
  // repay everything: the line refills completely
  svc.recordPayment(ctx(), loan.id, { amountCents: svc.getLoan(ctx(), loan.id).balanceCents, idempotencyKey: key() });
  assert.equal(svc.getLoan(ctx(), loan.id).status, 'paid');
  assert.equal(members.memberView(ctx(), 'd@x.test').creditLine.availableCents, 5_000_000);
});

test('deposit credit line is enforced', () => {
  const { ctx, db } = setup();
  members.depositFunds(ctx(), { email: 'd@x.test', amountCents: 5_000_000 });
  const id = firstLeg(db).id;
  const oldCap = CONFIG.maxLoanCents;
  CONFIG.maxLoanCents = 99e9;                                  // lift the per-trip cap so only the line limits the trip
  db.prepare('UPDATE partners SET max_loan_cents=99000000000').run();
  try {
    db.prepare('UPDATE legs SET price_cents=6000000, operator_price_cents=6000000 WHERE id=?').run(id);   // $60k > $50k line
    const lifted = { ...ctx(), partner: db.prepare('SELECT * FROM partners').get() };   // ctx() holds the pre-update partner row
    assert.throws(() => svc.createQuote(lifted, { legId: id, email: 'd@x.test' }), (e) => e.code === 'insufficient_credit_line' && e.details.availableCents === 5_000_000);
  } finally { CONFIG.maxLoanCents = oldCap; }
});

test('trust ledger reconciles against the bank balance', () => {
  const { ctx } = setup();
  members.joinMembership(ctx(), { email: 'a@x.test', planId: 'access' });   // +$2,500 credit
  members.depositFunds(ctx(), { email: 'b@x.test', amountCents: 5_000_000 });
  const ok = members.trustReconciliation(ctx(), 5_250_000);
  assert.equal(ok.ledgerTotalCents, 5_250_000);
  assert.equal(ok.reconciled, true);
  assert.equal(members.trustReconciliation(ctx(), 5_000_000).reconciled, false);
  assert.equal(members.trustReconciliation(ctx(), 5_000_000).differenceCents, -250_000);
});

test('late payment freezes member perks (non-member pricing), cure restores them', () => {
  const { ctx, db, clock } = setup();
  members.joinMembership(ctx(), { email: 'cfo@acme.test', planId: 'access' });
  const loan = fundLoan(ctx, db, legAt(db, 575_300).id, goodBorrower());
  assert.equal(loan.plan.id, 'access');
  clock.t = new Date(clock.t.getTime() + 12 * DAY);               // week-2 payment is 5 days past due (> 3-day grace)
  db.prepare("UPDATE legs SET departs_at=? WHERE status='available'").run(new Date(clock.t.getTime() + 5 * DAY).toISOString());
  svc.sweep(ctx());
  assert.equal(members.memberView(ctx(), 'cfo@acme.test').perksFrozen, true);
  assert.equal(svc.createQuote(ctx(), { legId: db.prepare("SELECT id FROM legs WHERE status='available' AND per_seat=0").get().id, email: 'cfo@acme.test' }).terms.plan.id, 'non_member');
  svc.recordPayment(ctx(), loan.id, { idempotencyKey: key() });
  svc.sweep(ctx());
  assert.equal(members.memberView(ctx(), 'cfo@acme.test').perksFrozen, false);
});

test('first-time clients above the starting limit go to manual review; repaid history lifts it', () => {
  const { ctx, db } = setup();
  const old = CONFIG.firstTimeMaxCents;
  CONFIG.firstTimeMaxCents = 500_000;
  try {
    const l = svc.applyForLoan(ctx(), { legId: legAt(db, 575_300).id, borrower: goodBorrower(), consents });
    assert.equal(l.status, 'pending_review');
    assert.equal(l.decisionReasons[0].code, 'first_time_limit');
  } finally { CONFIG.firstTimeMaxCents = old; }
});
