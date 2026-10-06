import { ApiError } from '../errors.js';
import { dateOnly, daysBetween } from '../money.js';

export const OPEN_STATUSES = ['pending_review', 'approved', 'signed', 'funded', 'defaulted']; // count against exposure/capital
const inList = (a) => a.map(() => '?').join(',');

export const log = (db, now, loanId, type, data) =>
  db.prepare('INSERT INTO events (loan_id,type,data,created_at) VALUES (?,?,?,?)').run(loanId, type, JSON.stringify(data ?? {}), now.toISOString());

export function loanRow(db, id, partner) {
  const l = db.prepare('SELECT * FROM loans WHERE id=?').get(id);
  if (!l || (partner && l.partner_id !== partner.id)) throw new ApiError(404, 'loan_not_found', 'Loan not found');
  return l;
}

export function loadLeg(db, legId) {
  const leg = db.prepare('SELECT * FROM legs WHERE id=?').get(legId);
  if (!leg) throw new ApiError(404, 'leg_not_found', 'Leg not found');
  leg.operator = db.prepare('SELECT * FROM operators WHERE id=?').get(leg.operator_id);
  return leg;
}

export const releaseLeg = (db, legId) =>
  db.prepare("UPDATE legs SET status='available' WHERE id=? AND status IN ('held','locked')").run(legId);

export function daysPastDue(db, loanId, now) {
  const r = db.prepare('SELECT MIN(due_date) AS d FROM installments WHERE loan_id=? AND paid_cents < amount_cents').get(loanId);
  return r?.d ? Math.max(0, daysBetween(r.d, dateOnly(now))) : 0;
}

// Principal still outstanding (open loans), pro-rating repayments between principal and fee.
export function exposureFor(db, borrowerId) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(l.principal_cents),0) AS principal,
           COALESCE(SUM((SELECT COALESCE(SUM(i.paid_cents * i.principal_cents / i.amount_cents),0) FROM installments i WHERE i.loan_id=l.id)),0) AS repaid
    FROM loans l WHERE l.borrower_id=? AND l.status IN (${inList(OPEN_STATUSES)})`).get(borrowerId, ...OPEN_STATUSES);
  return Math.max(0, r.principal - Math.round(r.repaid));
}

export function committedCapital(db) {
  const p = db.prepare(`SELECT COALESCE(SUM(principal_cents),0) AS v FROM loans WHERE status IN (${inList(OPEN_STATUSES)})`).get(...OPEN_STATUSES).v;
  const r = db.prepare("SELECT COALESCE(SUM(i.paid_cents * i.principal_cents / i.amount_cents),0) AS v FROM installments i JOIN loans l ON l.id=i.loan_id WHERE l.status IN ('signed','funded','defaulted')").get().v;
  return p - r;
}

export function applyToInstallment(db, loanId, seq, amountCents, now) {
  const r = db.prepare('SELECT * FROM installments WHERE loan_id=? AND seq=?').get(loanId, seq);
  const paid = r.paid_cents + amountCents;
  db.prepare('UPDATE installments SET paid_cents=?, paid_at=? WHERE id=?').run(paid, paid === r.amount_cents ? now.toISOString() : r.paid_at, r.id);
}

// Marks a funded/defaulted loan paid once every installment is covered. Returns true if it closed.
export function closeIfPaid(db, loanId, now) {
  const owed = db.prepare('SELECT COALESCE(SUM(amount_cents - paid_cents),0) AS v FROM installments WHERE loan_id=?').get(loanId).v
    + db.prepare('SELECT COALESCE(SUM(amount_cents - paid_cents),0) AS v FROM loan_charges WHERE loan_id=?').get(loanId).v;
  if (owed > 0) return false;
  db.prepare("UPDATE loans SET status='paid', closed_at=? WHERE id=? AND status IN ('funded','defaulted')").run(now.toISOString(), loanId);
  log(db, now, loanId, 'paid_off', {});
  return true;
}
