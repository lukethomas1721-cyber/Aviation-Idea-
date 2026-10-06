import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, goodBorrower, legAt, consents, sign, key, DAY } from './helpers.js';
import * as svc from '../src/services/loans.js';
import * as group from '../src/services/group.js';

const friends = (n) => Array.from({ length: n }, (_, i) => ({ name: `Friend ${i + 1}`, email: `f${i + 1}@x.test` }));
const join = (ctx, token) => group.joinGroup(ctx(), token, { idVerified: true, autopay: { method: 'card', last4: '1234' } });

function approvedGroup(env, nFriends, leg = 900_000) {
  const { ctx, db } = env;
  db.prepare('UPDATE legs SET price_cents=?, operator_price_cents=? WHERE id=?').run(leg, leg, legAt(db, 575_300).id);
  const loan = svc.applyForLoan(ctx(), { legId: db.prepare('SELECT id FROM legs WHERE price_cents=?').get(leg).id, borrower: goodBorrower(), consents });
  assert.equal(loan.status, 'approved');
  return { loan, view: group.createGroup(ctx(), loan.id, { friends: friends(nFriends) }) };
}

test("plan's group example: $9,000 non-member, 3 months, 9 people -> $100 down, ~$86.54 weekly each", () => {
  const env = setup();
  const { loan, view } = approvedGroup(env, 8);
  view.members.filter((m) => m.role === 'friend').forEach((m) => join(env.ctx, m.inviteToken));
  const v = group.finalizeGroup(env.ctx(), loan.id);
  assert.equal(v.payers, 9);
  const friend = v.members.find((m) => m.role === 'friend');
  assert.equal(friend.downShareCents, 10_000);
  assert.ok(Math.abs(friend.weeklyShareCents - 8654) <= 2, `weekly ${friend.weeklyShareCents}`);
  const main = v.members.find((m) => m.role === 'main');
  assert.equal(main.downShareCents + 8 * friend.downShareCents, 90_000);
});

test('at most 8 friends', () => {
  const env = setup();
  const { loan } = approvedGroup(env, 1);
  assert.throws(() => group.createGroup(env.ctx(), loan.id, { friends: friends(9) }), /1 and 8/);
});

test('trip books only when EVERY share of the down payment and first payment has cleared', () => {
  const env = setup();
  const { ctx, calls } = env;
  const { loan, view } = approvedGroup(env, 2);
  view.members.filter((m) => m.role === 'friend').forEach((m) => join(ctx, m.inviteToken));
  const v = group.finalizeGroup(ctx(), loan.id);
  assert.throws(() => svc.recordPayment(ctx(), loan.id, { kind: 'down_payment', idempotencyKey: key(), memberId: v.members[0].id }), /collected after signing/);
  svc.acceptLoan(ctx(), loan.id, sign);
  const pay = (kind, m) => svc.recordPayment(ctx(), loan.id, { kind, memberId: m.id, idempotencyKey: key() });
  for (const m of v.members) { pay('down_payment', m); }
  for (const m of v.members.slice(0, 2)) pay('installment', m);
  assert.equal(svc.getLoan(ctx(), loan.id).status, 'signed');   // one first-payment share still missing
  assert.equal(calls.disburse.length, 0);
  assert.throws(() => pay('installment', v.members[0]), /first payment is collected before funding/);
  const last = pay('installment', v.members[2]);
  assert.equal(last.status, 'funded');
  assert.equal(calls.disburse.length, 1);
  assert.equal(calls.disburse[0].amountCents, 900_000);
});

test('friend who has not joined by the deadline: group shrinks and shares are recalculated', () => {
  const env = setup();
  const { loan, view } = approvedGroup(env, 3);
  join(env.ctx, view.members.find((m) => m.role === 'friend').inviteToken);   // only 1 of 3 joins
  const v = group.finalizeGroup(env.ctx(), loan.id, { mode: 'shrink' });
  assert.equal(v.payers, 2);
  assert.equal(v.members.filter((m) => m.status === 'removed').length, 2);
  assert.equal(v.members.find((m) => m.role === 'main').downShareCents, 45_000);
  assert.throws(() => join(env.ctx, view.members[2].inviteToken), /no longer accepting|invite/i);
});

test('or the main customer covers the absent friends\' shares', () => {
  const env = setup();
  const { loan, view } = approvedGroup(env, 3);
  join(env.ctx, view.members.find((m) => m.role === 'friend').inviteToken);
  const v = group.finalizeGroup(env.ctx(), loan.id, { mode: 'main_covers' });
  assert.equal(v.payers, 2);                                                  // main + 1 friend actually pay
  assert.equal(v.members.find((m) => m.role === 'main').downShareCents, 90_000 - 22_500); // 3 shares of $225
  assert.equal(v.members.find((m) => m.status === 'joined' && m.role === 'friend').downShareCents, 22_500);
});

test('cannot sign a group loan until the group is finalized; friends need ID + autopay', () => {
  const env = setup();
  const { loan, view } = approvedGroup(env, 1);
  assert.throws(() => svc.acceptLoan(env.ctx(), loan.id, sign), /Finalize the group/);
  const token = view.members.find((m) => m.role === 'friend').inviteToken;
  assert.throws(() => group.joinGroup(env.ctx(), token, { idVerified: false, autopay: { method: 'card', last4: '1234' } }), /verify their ID/);
  assert.throws(() => group.joinGroup(env.ctx(), token, { idVerified: true }), /autopay/);
});

test('backstop: a friend\'s missed weekly share is charged to the main customer after the grace period', () => {
  const env = setup();
  const { ctx, clock, calls } = env;
  const { loan, view } = approvedGroup(env, 1);
  join(ctx, view.members.find((m) => m.role === 'friend').inviteToken);
  const v = group.finalizeGroup(ctx(), loan.id);
  svc.acceptLoan(ctx(), loan.id, sign);
  for (const m of v.members) svc.recordPayment(ctx(), loan.id, { kind: 'down_payment', memberId: m.id, idempotencyKey: key() });
  for (const m of v.members) svc.recordPayment(ctx(), loan.id, { memberId: m.id, idempotencyKey: key() });
  assert.equal(svc.getLoan(ctx(), loan.id).status, 'funded');

  const [main, friend] = [v.members.find((m) => m.role === 'main'), v.members.find((m) => m.role === 'friend')];
  clock.t = new Date(clock.t.getTime() + 7 * DAY + 1 * DAY);                 // week-2 due, inside the grace period
  assert.equal(svc.sweep(ctx()).backstopped, 0);
  svc.recordPayment(ctx(), loan.id, { memberId: main.id, idempotencyKey: key() }); // main pays their share on time
  clock.t = new Date(clock.t.getTime() + 3 * DAY);                           // now past the 3-day grace
  assert.equal(svc.sweep(ctx()).backstopped, 1);
  assert.equal(calls.charge.length, 1);
  assert.equal(calls.charge[0].memberId, main.id);
  assert.equal(calls.charge[0].amountCents, friend.weeklyShareCents);
  const l = svc.getLoan(ctx(), loan.id);
  assert.equal(l.schedule[1].paidCents, l.schedule[1].amountCents);            // JetReserve was paid in full
  assert.equal(svc.sweep(ctx()).backstopped, 0);                             // idempotent
});

test('a friend can pay off their remaining share early; the main customer can buy out a friend', () => {
  const env = setup();
  const { ctx } = env;
  const { loan, view } = approvedGroup(env, 2);
  view.members.filter((m) => m.role === 'friend').forEach((m) => join(ctx, m.inviteToken));
  const v = group.finalizeGroup(ctx(), loan.id);
  svc.acceptLoan(ctx(), loan.id, sign);
  for (const m of v.members) svc.recordPayment(ctx(), loan.id, { kind: 'down_payment', memberId: m.id, idempotencyKey: key() });
  for (const m of v.members) svc.recordPayment(ctx(), loan.id, { memberId: m.id, idempotencyKey: key() });
  const [main, f1, f2] = [v.members.find((m) => m.role === 'main'), ...v.members.filter((m) => m.role === 'friend')];
  const before = svc.getLoan(ctx(), loan.id).balanceCents;

  group.payoffMember(ctx(), loan.id, f1.id, { payerMemberId: f1.id });
  const after1 = svc.getLoan(ctx(), loan.id).balanceCents;
  assert.ok(before - after1 > 0);
  assert.throws(() => group.payoffMember(ctx(), loan.id, f2.id, { payerMemberId: f1.id }), /Only the friend or the main/);
  group.payoffMember(ctx(), loan.id, f2.id, { payerMemberId: main.id });   // main buys out friend 2
  assert.ok(svc.getLoan(ctx(), loan.id).balanceCents < after1);
  assert.throws(() => group.payoffMember(ctx(), loan.id, f1.id, { payerMemberId: f1.id }), /No active friend/);
});

test('group view reports which shares are paid so the UI can show progress', () => {
  const env = setup();
  const { ctx } = env;
  const { loan, view } = approvedGroup(env, 1);
  join(ctx, view.members.find((m) => m.role === 'friend').inviteToken);
  const v = group.finalizeGroup(ctx(), loan.id);
  svc.acceptLoan(ctx(), loan.id, sign);
  const main = v.members.find((m) => m.role === 'main');
  svc.recordPayment(ctx(), loan.id, { kind: 'down_payment', memberId: main.id, idempotencyKey: key() });
  svc.recordPayment(ctx(), loan.id, { memberId: main.id, idempotencyKey: key() });
  const after = svc.getLoan(ctx(), loan.id).group.members.find((m) => m.role === 'main');
  assert.equal(after.downPaid, true);
  assert.equal(after.firstPaid, true);
  assert.equal(svc.getLoan(ctx(), loan.id).group.members.find((m) => m.role === 'friend').firstPaid, false);
});
