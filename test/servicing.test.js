import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, goodBorrower, person, firstLeg, legAt, consents, key, fundLoan, DAY, T0 } from './helpers.js';
import * as svc from '../src/services/loans.js';
import * as servicing from '../src/services/servicing.js';
import * as members from '../src/services/members.js';
import { CONFIG } from '../src/config.js';

const advance = (clock, days) => { clock.t = new Date(clock.t.getTime() + days * DAY); };
const withConfig = async (over, fn) => { const old = {}; for (const k of Object.keys(over)) { old[k] = CONFIG[k]; CONFIG[k] = over[k]; } try { return await fn(); } finally { Object.assign(CONFIG, old); } };

test('early payoff: individuals get the unearned charge refunded (Texas Ch. 342 per the plan)', () => {
  const { ctx, db } = setup();
  const loan = fundLoan(ctx, db, legAt(db, 575_300).id, person());
  const q = servicing.payoffQuote(ctx(), loan.id);
  const remainingPrincipal = db.prepare('SELECT SUM(principal_cents) v FROM installments WHERE loan_id=? AND seq>1').get(loan.id).v;
  assert.equal(q.rebateApplies, true);
  assert.equal(q.installmentsRemaining, 12);
  assert.equal(q.payoffCents, remainingPrincipal);                            // only principal remains: no unearned charge
  assert.equal(q.unearnedChargeRefundCents, q.scheduledBalanceCents - remainingPrincipal);

  const r = servicing.payoffLoan(ctx(), loan.id, { idempotencyKey: key(), expectedPayoffCents: q.payoffCents });
  assert.equal(r.unearnedChargeRefundCents, q.unearnedChargeRefundCents);
  const done = svc.getLoan(ctx(), loan.id);
  assert.equal(done.status, 'paid');
  assert.equal(done.balanceCents, 0);
  assert.equal(done.terms.feeCents, loan.terms.feeCents - q.unearnedChargeRefundCents);
  assert.equal(svc.portfolio(ctx()).feeRevenueCollectedCents, done.terms.feeCents); // revenue reflects only the earned charge
});

test('early payoff: business-purpose loans keep the full charge', () => {
  const { ctx, db } = setup();
  const loan = fundLoan(ctx, db, legAt(db, 575_300).id, goodBorrower());
  const q = servicing.payoffQuote(ctx(), loan.id);
  assert.equal(q.rebateApplies, false);
  assert.equal(q.payoffCents, q.scheduledBalanceCents);
  assert.equal(q.unearnedChargeRefundCents, 0);
});

test('payoff only refunds charges on installments not yet due', () => {
  const { ctx, db, clock } = setup();
  const loan = fundLoan(ctx, db, legAt(db, 575_300).id, person());
  advance(clock, 14);                                                       // installments 2 and 3 are now due (unpaid); 4..13 are future
  const q = servicing.payoffQuote(ctx(), loan.id);
  const lines = Object.fromEntries(q.lines.map((l) => [l.seq, l.unearnedChargeCents]));
  assert.equal(lines[2], 0);
  assert.equal(lines[3], 0);
  assert.ok(lines[4] > 0);
  assert.equal(q.installmentsRemaining, 12);
});

test('payoff is idempotent, rejects stale quotes, and only applies to open loans', () => {
  const { ctx, db } = setup();
  const loan = fundLoan(ctx, db, legAt(db, 575_300).id, person());
  const q = servicing.payoffQuote(ctx(), loan.id);
  assert.throws(() => servicing.payoffLoan(ctx(), loan.id, { idempotencyKey: key(), expectedPayoffCents: q.payoffCents + 1 }), (e) => e.code === 'payoff_changed');
  const k = key();
  servicing.payoffLoan(ctx(), loan.id, { idempotencyKey: k });
  assert.equal(servicing.payoffLoan(ctx(), loan.id, { idempotencyKey: k }).replay, true);
  assert.throws(() => servicing.payoffQuote(ctx(), loan.id), /nothing to pay off/);
});

test('disclosure matches the early-payoff policy', async () => {
  const { ctx, db } = setup();
  const leg = legAt(db, 575_300);
  assert.match(svc.createQuote(ctx(), { legId: leg.id, entityType: 'individual' }).disclosure, /unearned portion of the charge is refunded/);
  assert.match(svc.createQuote(ctx(), { legId: leg.id, entityType: 'llc' }).disclosure, /not reduced by early repayment/);
});

test('reminders go out once each: upcoming, due, late, grace ending, final notice', () => {
  const { ctx, db, clock } = setup();
  const sent = [];
  const c = () => ({ ...ctx(), notify: { send: (m) => (sent.push(m.template), { status: 'queued' }) } });
  fundLoan(ctx, db, legAt(db, 575_300).id, goodBorrower());
  advance(clock, 6);                                                        // day before installment 2 is due
  assert.equal(svc.sweep(c()).reminders, 1);
  assert.equal(svc.sweep(c()).reminders, 0);                                // not sent twice
  for (const d of [1, 1, 2, 1]) { advance(clock, d); svc.sweep(c()); }      // due, +1 late, +3 grace ending, +4 final
  assert.deepEqual(sent, ['payment_upcoming', 'payment_due', 'payment_late', 'payment_grace_ending', 'payment_final_notice']);
});

test('late fees are off by default, then capped and assessed once per installment', async () => {
  const { ctx, db, clock } = setup();
  const loan = fundLoan(ctx, db, legAt(db, 575_300).id, goodBorrower());
  advance(clock, 7 + 5);                                                    // installment 2 is 5 days late (> 3-day grace)
  assert.equal(svc.sweep(ctx()).lateFees, 0);                               // default: no late fees

  await withConfig({ lateFeeCents: 5_000, lateFeeCapBps: 100 }, () => {     // $50 fee but capped at 1% of the installment
    assert.equal(svc.sweep(ctx()).lateFees, 1);
    assert.equal(svc.sweep(ctx()).lateFees, 0);                             // once per installment
    const l = svc.getLoan(ctx(), loan.id);
    assert.equal(l.lateFeesDueCents, Math.floor(loan.schedule[1].amountCents * 0.01));
    assert.ok(l.lateFeesDueCents < 5_000);
  });
});

test('a loan is not paid off until late fees are paid too', async () => {
  const { ctx, db, clock } = setup();
  const loan = fundLoan(ctx, db, legAt(db, 575_300).id, goodBorrower());
  await withConfig({ lateFeeCents: 1_000, lateFeeCapBps: 500 }, () => {
    advance(clock, 7 + 5);
    svc.sweep(ctx());
    let l = svc.getLoan(ctx(), loan.id);
    assert.equal(l.lateFeesDueCents, 1_000);
    svc.recordPayment(ctx(), loan.id, { amountCents: l.balanceCents, idempotencyKey: key() });   // pay every installment
    l = svc.getLoan(ctx(), loan.id);
    assert.equal(l.balanceCents, 0);
    assert.notEqual(l.status, 'paid');                                      // fee still owed
    l = svc.recordPayment(ctx(), loan.id, { kind: 'late_fee', idempotencyKey: key() });
    assert.equal(l.status, 'paid');
    assert.equal(l.lateFeesDueCents, 0);
    assert.throws(() => svc.recordPayment(ctx(), loan.id, { kind: 'late_fee', idempotencyKey: key() }), /Loan is paid/);
  });
});

test('collections: internal at >30 days, agency-ready at >90, referral and charge-off free the capital', () => {
  const { ctx, db, clock } = setup();
  const loan = fundLoan(ctx, db, legAt(db, 575_300).id, goodBorrower());
  advance(clock, 7 + 35);
  assert.equal(svc.sweep(ctx()).collections, 1);
  assert.equal(svc.getLoan(ctx(), loan.id).collectionsStage, 'internal');
  assert.equal(svc.getLoan(ctx(), loan.id).status, 'defaulted');
  advance(clock, 60);
  svc.sweep(ctx());
  assert.equal(svc.getLoan(ctx(), loan.id).collectionsStage, 'agency_ready');

  servicing.collectionsAction(ctx(), loan.id, { action: 'refer_agency' });
  advance(clock, 1); svc.sweep(ctx());
  assert.equal(svc.getLoan(ctx(), loan.id).collectionsStage, 'agency');     // sweep does not pull it back

  const before = svc.portfolio(ctx());
  assert.ok(before.committedPrincipalCents > 0);
  servicing.collectionsAction(ctx(), loan.id, { action: 'write_off', note: 'uncollectable' });
  const after = svc.portfolio(ctx());
  assert.equal(svc.getLoan(ctx(), loan.id).status, 'charged_off');
  assert.equal(after.committedPrincipalCents, 0);                           // capital is released
  assert.ok(after.chargedOffCents > 0);
  assert.throws(() => servicing.collectionsAction(ctx(), loan.id, { action: 'write_off' }), /only defaulted/);
});

test('loss reserve is a share of collected flat charges', async () => {
  const { ctx, db } = setup();
  fundLoan(ctx, db, legAt(db, 575_300).id, goodBorrower());
  await withConfig({ lossReserveBps: 2000 }, () => {
    const p = svc.portfolio(ctx());
    assert.equal(p.lossReserveCents, Math.floor(p.feeRevenueCollectedCents * 0.2));
  });
});

test('credit reporting extract: status codes for current, 30+ days late, paid, charged off', () => {
  const { ctx, db, clock } = setup();
  const a = fundLoan(ctx, db, legAt(db, 575_300).id, goodBorrower({ email: 'a@x.test' }));
  const b = fundLoan(ctx, db, legAt(db, 450_000).id, person({ email: 'b@x.test' }));
  servicing.payoffLoan(ctx(), b.id, { idempotencyKey: key() });
  const code = (id) => servicing.creditReporting(ctx()).rows.find((r) => r.accountId === id).statusCode;
  assert.equal(code(a.id), '11');
  assert.equal(code(b.id), '13');
  advance(clock, 7 + 40);
  svc.sweep(ctx());
  assert.equal(code(a.id), '71');
  advance(clock, 60); svc.sweep(ctx());
  assert.equal(code(a.id), '80');
  servicing.collectionsAction(ctx(), a.id, { action: 'write_off' });
  assert.equal(code(a.id), '97');
  const out = servicing.creditReporting(ctx());
  assert.match(out.csv.split('\n')[0], /^account_id,type,name,state/);
  assert.equal(out.rows.find((r) => r.accountId === b.id).consumer, true);
  assert.match(out.disclaimer, /not a certified Metro 2/);
});

test('borderline clients are referred to a partner BNPL lender; approved clients are not', () => {
  const { ctx, db } = setup();
  const legs = svc.listLegs(db, ctx().partner, ctx().now, { financeableOnly: true });
  const refs = [];
  const c = () => ({ ...ctx(), lenders: { refer: (a) => (refs.push(a), { partner: 'Affirm (demo)', offerUrl: 'https://x.example/o/1', status: 'invited' }) } });
  const ok = svc.applyForLoan(c(), { legId: legs[0].id, borrower: goodBorrower(), consents });
  assert.equal(ok.referral, null);
  const border = svc.applyForLoan(c(), { legId: legs[1].id, borrower: goodBorrower({ creditScore: 640, email: 'b@x.test' }), consents });
  assert.equal(border.status, 'pending_review');
  assert.equal(border.referral.partner, 'Affirm (demo)');
  assert.equal(refs.length, 1);
  assert.ok(refs[0].amountCents <= CONFIG.partnerLenderMaxCents);
  const declined = svc.applyForLoan(c(), { legId: legs[2].id, borrower: goodBorrower({ creditScore: 520, email: 'c@x.test' }), consents });
  assert.equal(declined.referral, null);                                    // declines are not referred
  assert.equal(refs.length, 1);
});

test('surety bond requirement equals client balances held in trust', () => {
  const { ctx } = setup();
  members.depositFunds(ctx(), { email: 'd@x.test', amountCents: 5_000_000 });
  members.joinMembership(ctx(), { email: 'a@x.test', planId: 'access' });
  assert.equal(members.trustReconciliation(ctx()).suretyBondRequiredCents, 5_250_000);
});

test('portfolio report keeps its full shape (guards against fields silently dropping out)', () => {
  const { ctx, db } = setup();
  fundLoan(ctx, db, legAt(db, 575_300).id, goodBorrower());
  const p = svc.portfolio(ctx());
  for (const k of ['asOf', 'capitalPoolCents', 'committedPrincipalCents', 'availableCapitalCents', 'utilization', 'originatedCents', 'collectedCents',
    'feeRevenueCollectedCents', 'marketplaceMarkupCents', 'membershipDuesCents', 'trustAccountCents', 'outstandingReceivableCents', 'defaultedBalanceCents',
    'chargedOffCents', 'lossReserveCents', 'loansByStatus', 'delinquency']) assert.ok(k in p, `portfolio is missing ${k}`);
  assert.deepEqual(p.delinquency, { current: 1, d1_30: 0, d31_plus: 0 });
  assert.equal(p.loansByStatus.funded, 1);
});
