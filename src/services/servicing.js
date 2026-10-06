import { CONFIG } from '../config.js';
import { tx, newId } from '../db.js';
import { ApiError, bad } from '../errors.js';
import { dateOnly, daysBetween } from '../money.js';
import { OPEN_STATUSES, closeIfPaid, daysPastDue, loanRow, log } from './shared.js';
import { mockNotifier } from '../notify.js';

// Loan servicing: early payoff, reminders, capped late fees, collections, charge-offs, credit reporting.

// ---------- early payoff ----------
// Texas Ch. 342 (per the plan) requires refunding unearned charges on early payoff; CONFIG.earlyPayoffRebate decides who
// gets it ('consumer' = individuals, 'all', 'none'). Each installment's flat charge is earned when that installment falls due.
const rebateApplies = (entityType) => CONFIG.earlyPayoffRebate === 'all' || (CONFIG.earlyPayoffRebate === 'consumer' && entityType === 'individual');

export function payoffQuote(ctx, id) {
  const { db, now, partner } = ctx;
  const loan = loanRow(db, id, partner);
  if (!['funded', 'defaulted'].includes(loan.status)) throw new ApiError(409, 'invalid_state', `Loan is ${loan.status}; nothing to pay off`);
  const borrower = db.prepare('SELECT entity_type FROM borrowers WHERE id=?').get(loan.borrower_id);
  const rebate = rebateApplies(borrower.entity_type);
  const today = dateOnly(now);
  const unpaid = db.prepare('SELECT * FROM installments WHERE loan_id=? AND paid_cents < amount_cents ORDER BY seq').all(id);
  let owed = 0, rebated = 0;
  const lines = unpaid.map((i) => {
    const out = i.amount_cents - i.paid_cents;
    const unearned = rebate && i.due_date > today ? Math.round((i.fee_cents * out) / i.amount_cents) : 0;
    owed += out; rebated += unearned;
    return { seq: i.seq, dueDate: i.due_date, outstandingCents: out, unearnedChargeCents: unearned };
  });
  const lateFees = db.prepare('SELECT COALESCE(SUM(amount_cents - paid_cents),0) AS v FROM loan_charges WHERE loan_id=?').get(id).v;
  return {
    loanId: id, asOf: today, payoffCents: owed - rebated + lateFees, scheduledBalanceCents: owed, unearnedChargeRefundCents: rebated,
    lateFeesCents: lateFees, rebateApplies: rebate, installmentsRemaining: unpaid.length, lines
  };
}

export function payoffLoan(ctx, id, { idempotencyKey, expectedPayoffCents }) {
  const { db, now, partner } = ctx;
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) throw bad('idempotency_key_required', 'idempotencyKey (>= 8 chars) is required');
  return tx(db, () => {
    const loan = loanRow(db, id, partner);
    if (db.prepare('SELECT 1 FROM payments WHERE loan_id=? AND idempotency_key=?').get(id, idempotencyKey)) return { replay: true };
    const q = payoffQuote(ctx, id);
    if (expectedPayoffCents !== undefined && expectedPayoffCents !== q.payoffCents) {
      throw bad('payoff_changed', 'The payoff amount changed since it was quoted', { payoffCents: q.payoffCents });
    }
    // Refund the unearned charge by shrinking the schedule, then settle everything that remains.
    let totalRefund = 0;
    for (const line of q.lines) {
      if (line.unearnedChargeCents) {
        db.prepare('UPDATE installments SET amount_cents=amount_cents-?, fee_cents=fee_cents-? WHERE loan_id=? AND seq=?').run(line.unearnedChargeCents, line.unearnedChargeCents, id, line.seq);
        totalRefund += line.unearnedChargeCents;
      }
      db.prepare('UPDATE installments SET paid_cents=amount_cents, paid_at=? WHERE loan_id=? AND seq=?').run(now.toISOString(), id, line.seq);
    }
    db.prepare('UPDATE loans SET fee_cents=fee_cents-?, total_cents=total_cents-? WHERE id=?').run(totalRefund, totalRefund, id);
    db.prepare('UPDATE loan_charges SET paid_cents=amount_cents WHERE loan_id=?').run(id);
    db.prepare('INSERT INTO payments VALUES (?,?,?,?,?,?,?)').run(newId('pay'), id, 'payoff', null, q.payoffCents, idempotencyKey, now.toISOString());
    log(db, now, id, 'payoff', { payoffCents: q.payoffCents, refundCents: totalRefund });
    closeIfPaid(db, id, now);
    return { replay: false, payoffCents: q.payoffCents, unearnedChargeRefundCents: totalRefund };
  });
}

// ---------- reminders ----------
// Reminders before/after each due date; sent once each. Delivery goes through the notifier adapter.
export function sendReminders(ctx) {
  const { db, now } = ctx;
  const notify = ctx.notify ?? mockNotifier;
  const today = dateOnly(now);
  let sent = 0;
  const loans = db.prepare("SELECT l.id, b.email, b.legal_name FROM loans l JOIN borrowers b ON b.id=l.borrower_id WHERE l.status IN ('funded','defaulted')").all();
  for (const l of loans) {
    for (const i of db.prepare('SELECT * FROM installments WHERE loan_id=? AND paid_cents < amount_cents').all(l.id)) {
      const d = daysBetween(today, i.due_date); // >0 days until due, <0 days past due
      const kind = d === 1 ? 'upcoming' : d === 0 ? 'due' : d === -1 ? 'late' : d === -CONFIG.graceDays ? 'grace_ending' : d === -(CONFIG.graceDays + 1) ? 'final_notice' : null;
      if (!kind) continue;
      if (db.prepare('INSERT OR IGNORE INTO reminders (loan_id,seq,kind,created_at) VALUES (?,?,?,?)').run(l.id, i.seq, kind, now.toISOString()).changes) {
        notify.send({ to: l.email, template: `payment_${kind}`, data: { loanId: l.id, seq: i.seq, dueDate: i.due_date, amountCents: i.amount_cents - i.paid_cents } });
        log(db, now, l.id, 'reminder', { kind, seq: i.seq });
        sent++;
      }
    }
  }
  return sent;
}

// ---------- late fees (capped; off unless LATE_FEE_CENTS > 0) ----------
export function assessLateFees(ctx) {
  const { db, now } = ctx;
  if (CONFIG.lateFeeCents <= 0) return 0;
  const today = dateOnly(now);
  let n = 0;
  for (const l of db.prepare("SELECT id FROM loans WHERE status IN ('funded','defaulted')").all()) {
    for (const i of db.prepare('SELECT * FROM installments WHERE loan_id=? AND paid_cents < amount_cents').all(l.id)) {
      if (daysBetween(i.due_date, today) <= CONFIG.graceDays) continue;
      const fee = Math.min(CONFIG.lateFeeCents, Math.floor((i.amount_cents * CONFIG.lateFeeCapBps) / 10000)); // never more than the cap
      if (fee > 0 && db.prepare("INSERT OR IGNORE INTO loan_charges (loan_id,kind,seq,amount_cents,created_at) VALUES (?,'late_fee',?,?,?)").run(l.id, i.seq, fee, now.toISOString()).changes) {
        log(db, now, l.id, 'late_fee', { seq: i.seq, amountCents: fee });
        n++;
      }
    }
  }
  return n;
}

export function payLateFees(db, now, loanId, amountCents) {
  const rows = db.prepare('SELECT * FROM loan_charges WHERE loan_id=? AND paid_cents < amount_cents ORDER BY seq').all(loanId);
  const owed = rows.reduce((s, r) => s + r.amount_cents - r.paid_cents, 0);
  if (owed === 0) throw new ApiError(409, 'already_paid', 'No late fees are due');
  const amount = amountCents ?? owed;
  if (amount > owed) throw bad('overpayment', `Late fees due are ${owed} cents`, { dueCents: owed });
  let left = amount;
  for (const r of rows) {
    if (left === 0) break;
    const apply = Math.min(left, r.amount_cents - r.paid_cents);
    db.prepare('UPDATE loan_charges SET paid_cents=paid_cents+? WHERE id=?').run(apply, r.id);
    left -= apply;
  }
  return amount;
}

// ---------- collections & charge-off ----------
// internal: > default threshold past due. agency_ready: > 90 days (a human refers it out). Charge-off is an explicit admin action.
export function updateCollectionsStages(ctx) {
  const { db, now } = ctx;
  let moved = 0;
  for (const l of db.prepare("SELECT id, collections_stage FROM loans WHERE status IN ('funded','defaulted')").all()) {
    const d = daysPastDue(db, l.id, now);
    const stage = d > CONFIG.collectionsAgencyAfterDays ? 'agency_ready' : d > CONFIG.defaultAfterDaysPastDue ? 'internal' : null;
    if (l.collections_stage === 'agency') continue; // already placed with an agency
    if (stage !== l.collections_stage) {
      db.prepare('UPDATE loans SET collections_stage=? WHERE id=?').run(stage, l.id);
      log(db, now, l.id, 'collections_stage', { stage });
      moved++;
    }
  }
  return moved;
}

export function collectionsAction(ctx, id, { action, note }) {
  const { db, now } = ctx;
  return tx(db, () => {
    const loan = loanRow(db, id);
    if (!['refer_agency', 'write_off'].includes(action)) throw bad('invalid_action', "action must be 'refer_agency' or 'write_off'");
    if (loan.status !== 'defaulted') throw new ApiError(409, 'invalid_state', `Loan is ${loan.status}; only defaulted loans can go to collections`);
    if (action === 'refer_agency') db.prepare("UPDATE loans SET collections_stage='agency' WHERE id=?").run(id);
    else db.prepare("UPDATE loans SET status='charged_off', collections_stage='charged_off', closed_at=? WHERE id=?").run(now.toISOString(), id); // frees capital; loss is tracked in the portfolio
    log(db, now, id, action, { note });
    return { id, action, status: db.prepare('SELECT status FROM loans WHERE id=?').get(id).status };
  });
}

// ---------- credit reporting ----------
// A simplified furnishing extract (account status codes follow Metro 2 conventions). This is NOT a certified Metro 2 file:
// furnishing to the bureaus needs a data-furnisher agreement and FCRA accuracy/dispute procedures.
const statusCode = (loan, dpd, balance) => {
  if (loan.status === 'charged_off') return '97';
  if (loan.status === 'paid' || balance === 0) return '13';
  if (dpd <= CONFIG.graceDays) return '11';
  return dpd < 60 ? '71' : dpd < 90 ? '78' : dpd < 120 ? '80' : dpd < 150 ? '82' : dpd < 180 ? '83' : '84';
};
export function creditReporting(ctx) {
  const { db, now } = ctx;
  const rows = db.prepare(`SELECT l.*, b.legal_name, b.email, b.entity_type, b.state FROM loans l JOIN borrowers b ON b.id=l.borrower_id
    WHERE l.status IN ('funded','defaulted','paid','charged_off') ORDER BY l.created_at`).all().map((l) => {
    const inst = db.prepare('SELECT amount_cents, paid_cents, due_date FROM installments WHERE loan_id=?').all(l.id);
    const balance = inst.reduce((s, i) => s + i.amount_cents - i.paid_cents, 0);
    const dpd = ['funded', 'defaulted'].includes(l.status) ? daysPastDue(db, l.id, now) : 0;
    const pastDue = inst.filter((i) => i.paid_cents < i.amount_cents && i.due_date < dateOnly(now)).reduce((s, i) => s + i.amount_cents - i.paid_cents, 0);
    return { accountId: l.id, consumer: l.entity_type === 'individual', name: l.legal_name, state: l.state, opened: (l.funded_at ?? l.created_at).slice(0, 10),
      originalAmountCents: l.principal_cents, balanceCents: balance, pastDueCents: pastDue, daysPastDue: dpd, statusCode: statusCode(l, dpd, balance), asOf: dateOnly(now) };
  });
  const head = 'account_id,type,name,state,opened,original_amount,balance,past_due,days_past_due,status_code,as_of';
  const csv = [head, ...rows.map((r) => [r.accountId, r.consumer ? 'consumer' : 'commercial', JSON.stringify(r.name), r.state, r.opened, (r.originalAmountCents / 100).toFixed(2),
    (r.balanceCents / 100).toFixed(2), (r.pastDueCents / 100).toFixed(2), r.daysPastDue, r.statusCode, r.asOf].join(','))].join('\n');
  return { disclaimer: 'Simplified extract, not a certified Metro 2 file.', rows, csv };
}
