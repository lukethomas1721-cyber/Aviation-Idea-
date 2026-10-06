import { openDb } from '../src/db.js';
import { seed, hashKey } from '../src/seed.js';
import { mockRails } from '../src/rails.js';
import * as svc from '../src/services/loans.js';

export const T0 = new Date('2026-10-06T12:00:00Z');
export function setup() {
  const db = openDb(':memory:');
  seed(db, T0);
  const partner = db.prepare('SELECT * FROM partners').get();
  const clock = { t: new Date(T0) };
  const ctx = () => ({ db, now: new Date(clock.t), partner, rails: mockRails });
  return { db, partner, clock, ctx };
}
export const goodBorrower = (over = {}) => ({
  legalName: 'Acme Holdings LLC', email: 'cfo@acme.test', entityType: 'llc',
  annualRevenueCents: 5_000_000_00, yearsInBusiness: 8, creditScore: 740, ...over
});
export const firstLeg = (db, pred = () => true) =>
  svc.listLegs(db, db.prepare('SELECT * FROM partners').get(), T0, { financeableOnly: true }).find(pred);
export { hashKey };
