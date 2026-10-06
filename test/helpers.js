import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';
import { mockRails } from '../src/rails.js';
import * as svc from '../src/services/loans.js';

export const T0 = new Date('2026-10-06T12:00:00Z');
export const DAY = 86400000;
export function setup() {
  const db = openDb(':memory:');
  seed(db, T0);
  const partner = db.prepare('SELECT * FROM partners').get();
  const clock = { t: new Date(T0) };
  const calls = { disburse: [], refund: [], charge: [] };
  const rails = {
    disburse: (a) => (calls.disburse.push(a), mockRails.disburse(a)),
    refund: (a) => (calls.refund.push(a), mockRails.refund(a)),
    charge: (a) => (calls.charge.push(a), mockRails.charge(a))
  };
  const ctx = () => ({ db, now: new Date(clock.t), partner, rails });
  return { db, partner, clock, ctx, calls };
}
export const goodBorrower = (over = {}) => ({
  legalName: 'Acme Holdings LLC', email: 'cfo@acme.test', entityType: 'llc',
  annualRevenueCents: 5_000_000_00, yearsInBusiness: 8, creditScore: 740, ...over
});
export const person = (over = {}) => goodBorrower({ legalName: 'Pat Flyer', email: 'pat@example.test', entityType: 'individual', yearsInBusiness: 0, annualRevenueCents: 300_000_00, ...over });
export const legAt = (db, priceCents) =>
  svc.listLegs(db, db.prepare('SELECT * FROM partners').get(), T0, { financeableOnly: true }).find((l) => l.priceCents === priceCents);
export const firstLeg = (db) => svc.listLegs(db, db.prepare('SELECT * FROM partners').get(), T0, { financeableOnly: true })[0];
export const consents = { creditCheck: true };
export const sign = { acceptedTerms: true, signatureName: 'Jane Flyer', autopay: { method: 'ach', last4: '4242' }, backupCardLast4: '1111' };
let n = 0;
export const key = () => `idem-key-${++n}-${Math.random().toString(36).slice(2, 8)}`;

// apply -> sign -> pay down payment + first autopay (=> operator paid, flight booked)
export function fundLoan(ctx, db, legId, borrower = goodBorrower(), opts = {}) {
  const loan = svc.applyForLoan(ctx(), { legId, borrower, consents, ...opts });
  if (loan.status !== 'approved') return loan;
  svc.acceptLoan(ctx(), loan.id, sign);
  if (loan.terms.cashDownCents > 0) svc.recordPayment(ctx(), loan.id, { kind: 'down_payment', idempotencyKey: key() });
  return svc.recordPayment(ctx(), loan.id, { kind: 'installment', idempotencyKey: key() });
}
