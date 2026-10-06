import { CONFIG } from '../config.js';
import { tx, newId } from '../db.js';
import { ApiError, bad } from '../errors.js';
import { dateOnly } from '../money.js';
import { PLANS } from '../plans.js';
import { buildTerms, scheduleFor, disclosure } from '../pricing.js';
import { applyTermRules, allowedTerms } from '../termRules.js';
import { underwrite } from '../underwriting.js';
import { checkCompliance, assertCompliant } from '../compliance.js';
import {
  OPEN_STATUSES, log, loanRow, loadLeg, releaseLeg, daysPastDue, exposureFor, committedCapital, applyToInstallment, closeIfPaid
} from './shared.js';
import { pricingPlanFor, creditBalance, creditLine, reserveCredit, releaseCredit, memberView } from './members.js';
import { isGroup, shareOf, groupView, autopayFrom, backstop } from './group.js';
import { payLateFees, sendReminders, assessLateFees, updateCollectionsStages } from './servicing.js';
import { mockPartnerLender } from '../lenders.js';

// ---------- legs ----------
export function legEligibility(leg, now, config = CONFIG) {
  const no = (reason) => ({ financeable: false, reason });
  if (leg.per_seat || leg.member_only) return no('per_seat_or_member_flight');
  if (!config.financeableLegTypes.includes(leg.leg_type)) return no('leg_type_not_financeable'); // launch: empty legs only
  if (leg.status !== 'available') return no(`leg_${leg.status}`);
  const op = leg.operator;
  if (op && (!op.cert_verified || !op.active)) return no('operator_not_verified');
  const hours = (Date.parse(leg.departs_at) - now.getTime()) / 3600000;
  if (hours < config.minLeadHours) return no('departure_too_soon');
  if (hours > config.maxLeadDays * 24) return no('departure_too_far');
  return { financeable: true, reason: null };
}

// Terms shift with leg type and hours to departure (termRules.js). Default config has no rules, so nothing shifts.
const adjustFor = (leg, plan, now) => applyTermRules({
  rules: CONFIG.termRules, legType: leg.leg_type, planId: plan.id, hoursToDeparture: (Date.parse(leg.departs_at) - now.getTime()) / 3600000
});
const termsFor = (leg, plan, termMonths, creditCents, partner, now) =>
  buildTerms({ priceCents: leg.price_cents, operatorPriceCents: leg.operator_price_cents, plan, termMonths, creditCents, partner, now, adjust: adjustFor(leg, plan, now) });

export function legView(db, leg, partner, now, email) {
  const eligibility = legEligibility(leg, now);
  let preview = null;
  if (eligibility.financeable) {
    try {
      const { planId } = pricingPlanFor(db, email, leg);
      const credit = PLANS[planId].dues ? creditBalance(db, email) : 0;
      const t = termsFor(leg, PLANS[planId], undefined, credit, partner, now);
      preview = { plan: t.plan, weeklyPaymentCents: t.weeklyPaymentCents, installments: t.installments, termMonths: t.termMonths, downPaymentCents: t.downPaymentCents };
    } catch { eligibility.financeable = false; eligibility.reason = 'below_minimum'; }
  }
  return {
    id: leg.id, origin: { code: leg.origin_code, city: leg.origin_city }, destination: { code: leg.dest_code, city: leg.dest_city },
    durationMin: leg.duration_min, departsAt: leg.departs_at, window: leg.time_window, aircraft: leg.aircraft, seats: leg.seats,
    category: leg.category, priceCents: leg.price_cents, pricedPerSeat: !!leg.per_seat, memberOnly: !!leg.member_only,
    legType: leg.leg_type, marketplace: leg.markup_bps > 0, altAircraft: leg.alt_aircraft, status: leg.status, financing: { ...eligibility, preview }
  };
}

export function listLegs(db, partner, now, { origin, dest, financeableOnly, email } = {}) {
  return db.prepare('SELECT id FROM legs ORDER BY departs_at, id').all()
    .map((r) => legView(db, loadLeg(db, r.id), partner, now, email))
    .filter((l) => (!origin || l.origin.code === origin.toUpperCase()) && (!dest || l.destination.code === dest.toUpperCase()))
    .filter((l) => !financeableOnly || l.financing.financeable);
}

// Plan B: an operator uploads an empty leg with its rate; the system lists it at rate + markup (default 15%).
export function createMarketplaceLeg(ctx, b) {
  const { db } = ctx;
  const op = db.prepare('SELECT * FROM operators WHERE id=?').get(b?.operatorId);
  if (!op) throw bad('operator_not_found', 'Unknown operatorId');
  const need = ['originCode', 'originCity', 'destCode', 'destCity', 'aircraft'];
  if (need.some((k) => typeof b[k] !== 'string' || !b[k]) || !Number.isInteger(b.operatorPriceCents) || b.operatorPriceCents <= 0 ||
      !Number.isInteger(b.durationMin) || !Number.isFinite(Date.parse(b.departsAt)) || !b.window) {
    throw bad('invalid_leg', 'originCode, originCity, destCode, destCity, aircraft, operatorPriceCents, durationMin, departsAt and window are required');
  }
  const markup = b.markupBps ?? 1500;
  if (!Number.isInteger(markup) || markup < 0 || markup > 5000) throw bad('invalid_markup', 'markupBps must be 0-5000');
  const id = newId('leg');
  db.prepare(`INSERT INTO legs (id,operator_id,origin_code,origin_city,dest_code,dest_city,duration_min,departs_at,time_window,aircraft,seats,category,
    price_cents,operator_price_cents,markup_bps) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, op.id, b.originCode.toUpperCase(), b.originCity, b.destCode.toUpperCase(), b.destCity, b.durationMin, new Date(b.departsAt).toISOString(), b.window,
      b.aircraft, b.seats ?? null, b.category ?? null, Math.round(b.operatorPriceCents * (1 + markup / 10000)), b.operatorPriceCents, markup);
  return legView(db, loadLeg(db, id), ctx.partner ?? { max_loan_cents: CONFIG.maxLoanCents }, ctx.now);
}

// ---------- quote ----------
function planContext(db, partner, leg, email, termMonths, now) {
  const { planId } = pricingPlanFor(db, email, leg);
  const plan = PLANS[planId];
  const credit = plan.dues ? creditBalance(db, email) : 0;
  const terms = termsFor(leg, plan, termMonths, credit, partner, now);
  if (plan.id === 'deposit') {
    const line = creditLine(db, email);
    if (!line || line.availableCents < terms.principalCents) throw bad('insufficient_credit_line', 'The trip exceeds your available credit line', { availableCents: line?.availableCents ?? 0 });
  }
  return { plan, credit, terms };
}

export function createQuote(ctx, { legId, email, termMonths, entityType }) {
  const { db, now, partner } = ctx;
  expireStale(ctx);
  const leg = loadLeg(db, legId);
  const e = legEligibility(leg, now);
  if (!e.financeable) throw bad('leg_not_financeable', `This leg cannot be financed (${e.reason})`, { reason: e.reason });
  const { plan, credit, terms } = planContext(db, partner, leg, email, termMonths, now);
  const options = allowedTerms(plan, adjustFor(leg, plan, now)).map((tm) => {
    const t = termsFor(leg, plan, tm, credit, partner, now);
    return { termMonths: tm, installments: t.installments, weeklyPaymentCents: t.weeklyPaymentCents, totalRepaymentCents: t.totalRepaymentCents, apr: t.apr };
  });
  return {
    leg: legView(db, leg, partner, now, email), member: email ? memberView(ctx, email) : null, terms, options,
    compliance: checkCompliance({ apr: terms.apr, entityType }), disclosure: disclosure(entityType)
  };
}

// ---------- application ----------
function validateBorrower(b) {
  if (!b || typeof b !== 'object') throw bad('invalid_borrower', 'borrower is required');
  const errs = [];
  if (typeof b.legalName !== 'string' || b.legalName.trim().length < 2) errs.push('legalName');
  if (typeof b.email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) errs.push('email');
  if (!['individual', 'llc', 'corporation', 'partnership', 'sole_proprietor', 'other'].includes(b.entityType)) errs.push('entityType');
  if (!Number.isInteger(b.annualRevenueCents) || b.annualRevenueCents < 0) errs.push('annualRevenueCents');
  if (typeof b.yearsInBusiness !== 'number' || b.yearsInBusiness < 0) errs.push('yearsInBusiness');
  if (!Number.isInteger(b.creditScore) || b.creditScore < 300 || b.creditScore > 850) errs.push('creditScore');
  if (typeof b.state !== 'string' || !/^[A-Za-z]{2}$/.test(b.state)) errs.push('state');
  if (errs.length) throw bad('invalid_borrower', 'Invalid borrower fields: ' + errs.join(', '), { fields: errs });
}

export function applyForLoan(ctx, { legId, termMonths, borrower, consents }) {
  const { db, now, partner } = ctx;
  if (!consents?.creditCheck) throw bad('consent_required', 'consents.creditCheck must be true to run underwriting');
  validateBorrower(borrower);
  borrower = { ...borrower, state: borrower.state.toUpperCase() };
  expireStale(ctx);
  return tx(db, () => {
    const leg = loadLeg(db, legId);
    const e = legEligibility(leg, now);
    if (!e.financeable) throw bad('leg_not_financeable', `This leg cannot be financed (${e.reason})`, { reason: e.reason });
    const email = borrower.email.trim().toLowerCase();
    const { plan, terms } = planContext(db, partner, leg, email, termMonths, now);
    assertCompliant(checkCompliance({ apr: terms.apr, entityType: borrower.entityType }));

    if (committedCapital(db) + terms.principalCents > CONFIG.capitalPoolCents) {
      throw new ApiError(503, 'capital_unavailable', 'Financing capacity is temporarily unavailable');
    }

    let row = db.prepare('SELECT * FROM borrowers WHERE email=?').get(email);
    const fields = [borrower.legalName.trim(), borrower.entityType, borrower.annualRevenueCents, borrower.yearsInBusiness, borrower.creditScore];
    // kyc/ofac come from providers in production. Here the caller's result is accepted, defaulting to pass.
    const kyc = borrower.kycPassed === false ? 0 : 1;
    const ofac = borrower.ofacClear === false ? 0 : 1;
    if (row) {
      db.prepare('UPDATE borrowers SET legal_name=?, entity_type=?, annual_revenue_cents=?, years_in_business=?, credit_score=?, kyc_passed=?, ofac_clear=?, state=? WHERE id=?')
        .run(...fields, kyc, ofac, borrower.state, row.id);
    } else {
      row = { id: newId('bor') };
      db.prepare('INSERT INTO borrowers (id,legal_name,entity_type,email,annual_revenue_cents,years_in_business,credit_score,kyc_passed,ofac_clear,created_at,state) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(row.id, fields[0], fields[1], email, fields[2], fields[3], fields[4], kyc, ofac, now.toISOString(), borrower.state);
    }
    const b = db.prepare('SELECT * FROM borrowers WHERE id=?').get(row.id);

    const result = underwrite({
      borrower: b, principalCents: terms.principalCents, existingExposureCents: exposureFor(db, b.id),
      priorDefaults: db.prepare("SELECT COUNT(*) AS n FROM loans WHERE borrower_id=? AND status='defaulted'").get(b.id).n,
      maxExposureCents: CONFIG.maxBorrowerExposureCents, firstTimeMaxCents: CONFIG.firstTimeMaxCents, launchStates: CONFIG.launchStates,
      repaidLoans: db.prepare("SELECT COUNT(*) AS n FROM loans WHERE borrower_id=? AND status='paid'").get(b.id).n
    });

    // Borderline clients go to a partner BNPL lender, which carries the default risk (plan: Affirm/Uplift/ChargeAfter).
    const referral = result.decision === 'review' && result.reasons.some((r) => r.code === 'thin_credit') && terms.principalCents <= CONFIG.partnerLenderMaxCents
      ? (ctx.lenders ?? mockPartnerLender).refer({ borrower: b, amountCents: terms.principalCents, loanId: null }) : null;
    const status = { approved: 'approved', review: 'pending_review', declined: 'declined' }[result.decision];
    const holdMin = result.decision === 'review' ? CONFIG.reviewHoldMinutes : CONFIG.holdMinutes;
    const expiresAt = status === 'declined' ? null : new Date(now.getTime() + holdMin * 60000).toISOString();
    const id = newId('loan');
    db.prepare(`INSERT INTO loans (id,partner_id,leg_id,borrower_id,status,plan_id,term_months,charter_price_cents,payout_cents,down_payment_cents,credit_applied_cents,
      cash_down_cents,principal_cents,fee_bps,fee_cents,total_cents,apr,installments,interval_days,decision,decision_reasons,risk_tier,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, partner.id, leg.id, b.id, status, plan.id, terms.termMonths, terms.charterPriceCents, terms.payoutCents, terms.downPaymentCents,
        terms.creditAppliedCents, terms.cashDownCents, terms.principalCents, terms.flatBps, terms.feeCents, terms.totalRepaymentCents, terms.apr,
        terms.installments, terms.intervalDays, result.decision, JSON.stringify(result.reasons), result.riskTier, now.toISOString(), expiresAt);
    if (referral) db.prepare('UPDATE loans SET referral=? WHERE id=?').run(JSON.stringify(referral), id);
    if (status !== 'declined') {
      db.prepare("UPDATE legs SET status='held' WHERE id=?").run(leg.id);
      reserveCredit(db, email, id, terms.creditAppliedCents, now);
    }
    log(db, now, id, 'application', { decision: result.decision, plan: plan.id, reasons: result.reasons.map((r) => r.code) });
    return getLoan(ctx, id);
  });
}

// ---------- lifecycle ----------
// Expire stale offers. A signed loan whose down payment / first autopay never cleared is unwound and refunded.
export function expireStale(ctx) {
  const { db, now, rails } = ctx;
  const stale = db.prepare("SELECT id, leg_id, status FROM loans WHERE status IN ('approved','pending_review','signed') AND expires_at <= ?").all(now.toISOString());
  for (const s of stale) unwind(db, now, rails, s, 'expired');
  return stale.length;
}

function unwind(db, now, rails, loan, newStatus) {
  const collected = db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS v FROM payments WHERE loan_id=?').get(loan.id).v;
  if (collected > 0) {
    const r = rails.refund({ loanId: loan.id, amountCents: collected });
    log(db, now, loan.id, 'refund', { amountCents: collected, reference: r.reference });
  }
  db.prepare('UPDATE loans SET status=?, closed_at=? WHERE id=?').run(newStatus, now.toISOString(), loan.id);
  releaseLeg(db, loan.leg_id);
  releaseCredit(db, loan.id, now);
  log(db, now, loan.id, newStatus, {});
}

export function acceptLoan(ctx, id, { acceptedTerms, signatureName, autopay, backupCardLast4 }) {
  const { db, now, partner } = ctx;
  if (acceptedTerms !== true) throw bad('terms_not_accepted', 'acceptedTerms must be true');
  if (typeof signatureName !== 'string' || signatureName.trim().length < 2) throw bad('signature_required', 'signatureName is required');
  const ap = autopayFrom(autopay);
  if (!/^\d{4}$/.test(String(backupCardLast4 ?? ''))) throw bad('backup_card_required', 'A backup card (backupCardLast4) is required');
  expireStale(ctx); // outside the tx so an expiry persists when we reject below
  return tx(db, () => {
    const loan = loanRow(db, id, partner);
    if (loan.status === 'expired') throw new ApiError(410, 'offer_expired', 'This offer has expired; please re-apply');
    if (loan.status !== 'approved') throw new ApiError(409, 'invalid_state', `Loan is ${loan.status}; only approved loans can be signed`);
    if (isGroup(db, id) && !loan.group_finalized) throw new ApiError(409, 'group_not_finalized', 'Finalize the group before signing');
    const leg = loadLeg(db, loan.leg_id);
    if (leg.status !== 'held') throw new ApiError(409, 'leg_unavailable', 'Leg is no longer held for this loan');
    if (Date.parse(leg.departs_at) - now.getTime() < CONFIG.minLeadHours * 3600000) throw new ApiError(409, 'departure_too_soon', 'Departure is too close to fund this trip');

    const schedule = scheduleFor({ principalCents: loan.principal_cents, feeCents: loan.fee_cents, installments: loan.installments, intervalDays: loan.interval_days, startDate: dateOnly(now) });
    const ins = db.prepare('INSERT INTO installments (loan_id,seq,due_date,amount_cents,principal_cents,fee_cents) VALUES (?,?,?,?,?,?)');
    for (const s of schedule) ins.run(id, s.seq, s.dueDate, s.amountCents, s.principalCents, s.feeCents);

    // The flight locks the moment the loan is signed so it cannot be sold twice. The operator is paid only
    // after the down payment and first autopay clear (see tryFund).
    const exp = new Date(now.getTime() + CONFIG.signedWindowMinutes * 60000).toISOString();
    db.prepare("UPDATE loans SET status='signed', signed_at=?, signed_by=?, expires_at=?, autopay_method=?, autopay_last4=?, backup_last4=? WHERE id=?")
      .run(now.toISOString(), signatureName.trim(), exp, ap.method, ap.last4, String(backupCardLast4), id);
    db.prepare("UPDATE legs SET status='locked' WHERE id=?").run(leg.id);
    log(db, now, id, 'signed', {});
    return getLoan(ctx, id);
  });
}

export function cancelLoan(ctx, id) {
  const { db, now, partner, rails } = ctx;
  return tx(db, () => {
    const loan = loanRow(db, id, partner);
    if (!['approved', 'pending_review', 'signed'].includes(loan.status)) throw new ApiError(409, 'invalid_state', `Loan is ${loan.status}; only unfunded offers can be cancelled`);
    unwind(db, now, rails, loan, 'cancelled');
    return getLoan(ctx, id);
  });
}

export function reviewLoan(ctx, id, { decision, note }) {
  const { db, now, rails } = ctx;
  if (!['approve', 'decline'].includes(decision)) throw bad('invalid_decision', "decision must be 'approve' or 'decline'");
  expireStale(ctx);
  return tx(db, () => {
    const loan = loanRow(db, id);
    if (loan.status === 'expired') throw new ApiError(410, 'offer_expired', 'Review hold expired; applicant must re-apply');
    if (loan.status !== 'pending_review') throw new ApiError(409, 'invalid_state', `Loan is ${loan.status}, not pending_review`);
    if (decision === 'approve') {
      const exp = new Date(now.getTime() + CONFIG.holdMinutes * 60000).toISOString();
      db.prepare("UPDATE loans SET status='approved', review_note=?, expires_at=? WHERE id=?").run(note ?? null, exp, id);
    } else {
      db.prepare('UPDATE loans SET review_note=? WHERE id=?').run(note ?? null, id);
      unwind(db, now, rails, loan, 'declined');
    }
    log(db, now, id, 'review', { decision, note });
    return getLoan(ctx, id, true);
  });
}

// Funding: operator is paid in full only after the down payment AND the first autopay have cleared.
function tryFund(ctx, loan) {
  const { db, now, rails } = ctx;
  const fresh = loanRow(db, loan.id);
  const first = db.prepare('SELECT * FROM installments WHERE loan_id=? AND seq=1').get(loan.id);
  if (fresh.status !== 'signed' || fresh.down_paid_cents < fresh.cash_down_cents || first.paid_cents < first.amount_cents) return false;
  const leg = loadLeg(db, fresh.leg_id);
  const payout = rails.disburse({ loanId: fresh.id, operator: leg.operator, amountCents: fresh.payout_cents });
  db.prepare('INSERT INTO payouts VALUES (?,?,?,?,?,?,?)').run(newId('po'), fresh.id, leg.operator.id, fresh.payout_cents, payout.status, payout.reference, now.toISOString());
  db.prepare("UPDATE loans SET status='funded', funded_at=?, expires_at=NULL WHERE id=?").run(now.toISOString(), fresh.id);
  db.prepare("UPDATE legs SET status='booked' WHERE id=?").run(leg.id);
  log(db, now, fresh.id, 'funded', { payout: payout.reference, amountCents: fresh.payout_cents });
  return true;
}

function resolveMember(db, loan, memberId) {
  if (!isGroup(db, loan.id)) return null;
  if (!loan.group_finalized) throw new ApiError(409, 'group_not_finalized', 'Group is not finalized');
  const m = db.prepare('SELECT * FROM loan_members WHERE id=? AND loan_id=?').get(memberId ?? '', loan.id);
  if (!m || !(m.role === 'main' || m.status === 'joined')) throw bad('invalid_member', 'memberId must be the main customer or a joined friend');
  return m;
}

export function recordPayment(ctx, id, { kind = 'installment', amountCents, idempotencyKey, memberId, seq }) {
  const { db, now, partner } = ctx;
  if (!['down_payment', 'installment', 'late_fee'].includes(kind)) throw bad('invalid_kind', "kind must be 'down_payment', 'installment' or 'late_fee'");
  if (amountCents !== undefined && (!Number.isInteger(amountCents) || amountCents <= 0)) throw bad('invalid_amount', 'amountCents must be a positive integer');
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) throw bad('idempotency_key_required', 'idempotencyKey (>= 8 chars) is required');
  return tx(db, () => {
    const loan = loanRow(db, id, partner);
    if (db.prepare('SELECT 1 FROM payments WHERE loan_id=? AND idempotency_key=?').get(id, idempotencyKey)) return getLoan(ctx, id); // replay
    if (kind === 'late_fee') { // late fees are owed by the main customer, never split
      if (!['funded', 'defaulted'].includes(loan.status)) throw new ApiError(409, 'invalid_state', `Loan is ${loan.status}`);
      const amount = payLateFees(db, now, id, amountCents);
      db.prepare('INSERT INTO payments VALUES (?,?,?,?,?,?,?)').run(newId('pay'), id, 'late_fee', null, amount, idempotencyKey, now.toISOString());
      log(db, now, id, 'payment', { kind, amountCents: amount });
      closeIfPaid(db, id, now);
      return getLoan(ctx, id);
    }
    const member = resolveMember(db, loan, memberId);
    const paidShare = (k, s) => db.prepare('SELECT 1 FROM member_payments WHERE loan_id=? AND member_id=? AND kind=? AND seq=?').get(id, member?.id, k, s);
    let amount;

    if (kind === 'down_payment') {
      if (loan.status !== 'signed') throw new ApiError(409, 'invalid_state', `Loan is ${loan.status}; down payment is collected after signing`);
      if (member) {
        if (paidShare('down', 0)) throw new ApiError(409, 'already_paid', 'This share of the down payment is already paid');
        amount = shareOf(loan, member, loan.cash_down_cents);
      } else {
        amount = loan.cash_down_cents - loan.down_paid_cents;
        if (amount <= 0) throw new ApiError(409, 'already_paid', 'No down payment is due');
      }
      if (amountCents !== undefined && amountCents !== amount) throw bad('amount_mismatch', `Down payment due is ${amount} cents`, { dueCents: amount });
      db.prepare('UPDATE loans SET down_paid_cents=down_paid_cents+? WHERE id=?').run(amount, id);
      if (member) db.prepare("INSERT INTO member_payments (loan_id,member_id,kind,seq,amount_cents,status,paid_by,created_at) VALUES (?,?,'down',0,?,'paid',?,?)").run(id, member.id, amount, member.id, now.toISOString());
    } else {
      if (!['signed', 'funded', 'defaulted'].includes(loan.status)) throw new ApiError(409, 'invalid_state', `Loan is ${loan.status}; no payments due`);
      if (member) {
        const unpaid = db.prepare('SELECT * FROM installments WHERE loan_id=? ORDER BY seq').all(id).find((i) => !paidShare('installment', i.seq) && (seq === undefined || i.seq === seq));
        if (!unpaid) throw new ApiError(409, 'already_paid', 'Nothing left to pay for this member');
        if (loan.status === 'signed' && unpaid.seq !== 1) throw new ApiError(409, 'invalid_state', 'Only the first payment is collected before funding');
        amount = shareOf(loan, member, unpaid.amount_cents);
        if (amountCents !== undefined && amountCents !== amount) throw bad('amount_mismatch', `Share due is ${amount} cents`, { dueCents: amount });
        applyToInstallment(db, id, unpaid.seq, amount, now);
        db.prepare("INSERT INTO member_payments (loan_id,member_id,kind,seq,amount_cents,status,paid_by,created_at) VALUES (?,?,'installment',?,?,'paid',?,?)").run(id, member.id, unpaid.seq, amount, member.id, now.toISOString());
      } else {
        let rows = db.prepare('SELECT * FROM installments WHERE loan_id=? AND paid_cents < amount_cents ORDER BY seq').all(id);
        if (loan.status === 'signed') rows = rows.filter((r) => r.seq === 1);
        const owed = rows.reduce((s, r) => s + r.amount_cents - r.paid_cents, 0);
        if (owed === 0) throw new ApiError(409, 'already_paid', 'Nothing is due');
        amount = amountCents ?? rows[0].amount_cents - rows[0].paid_cents;
        if (amount > owed) throw bad('overpayment', `Payment exceeds balance of ${owed} cents`, { balanceCents: owed });
        let left = amount;
        for (const r of rows) {
          if (left === 0) break;
          const apply = Math.min(left, r.amount_cents - r.paid_cents);
          applyToInstallment(db, id, r.seq, apply, now);
          left -= apply;
        }
      }
    }
    db.prepare('INSERT INTO payments VALUES (?,?,?,?,?,?,?)').run(newId('pay'), id, kind, member?.id ?? null, amount, idempotencyKey, now.toISOString());
    log(db, now, id, 'payment', { kind, amountCents: amount, member: member?.id });

    if (loan.status === 'signed') tryFund(ctx, loan);
    else if (!closeIfPaid(db, id, now) && loan.status === 'defaulted' && daysPastDue(db, id, now) <= CONFIG.defaultAfterDaysPastDue) {
      db.prepare("UPDATE loans SET status='funded' WHERE id=?").run(id); // cured
      log(db, now, id, 'cured', {});
    }
    return getLoan(ctx, id);
  });
}

// Daily job: expire stale offers, backstop missed group shares, flag defaults, freeze/unfreeze member perks.
export function sweep(ctx) {
  const { db, now } = ctx;
  const expired = expireStale(ctx);
  const backstopped = backstop(ctx);
  const lateFees = assessLateFees(ctx);
  const reminders = sendReminders(ctx);
  let defaulted = 0;
  for (const l of db.prepare("SELECT id FROM loans WHERE status='funded'").all()) {
    if (daysPastDue(db, l.id, now) > CONFIG.defaultAfterDaysPastDue) {
      db.prepare("UPDATE loans SET status='defaulted' WHERE id=?").run(l.id);
      log(db, now, l.id, 'defaulted', {});
      defaulted++;
    }
  }
  const collections = updateCollectionsStages(ctx);
  let frozen = 0;
  for (const m of db.prepare("SELECT email, perks_frozen FROM memberships WHERE status='active'").all()) {
    const late = db.prepare("SELECT l.id FROM loans l JOIN borrowers b ON b.id=l.borrower_id WHERE b.email=? AND l.status IN ('funded','defaulted')").all(m.email)
      .some((l) => daysPastDue(db, l.id, now) > CONFIG.graceDays);
    if (late !== !!m.perks_frozen) db.prepare('UPDATE memberships SET perks_frozen=? WHERE email=?').run(late ? 1 : 0, m.email);
    if (late) frozen++;
  }
  return { expired, defaulted, backstopped, lateFees, reminders, collections, perksFrozen: frozen };
}

// ---------- reads ----------
export function getLoan(ctx, id, admin = false) {
  const { db, now, partner } = ctx;
  const l = loanRow(db, id, admin ? null : partner);
  const b = db.prepare('SELECT * FROM borrowers WHERE id=?').get(l.borrower_id);
  const leg = db.prepare('SELECT * FROM legs WHERE id=?').get(l.leg_id);
  const inst = db.prepare('SELECT * FROM installments WHERE loan_id=? ORDER BY seq').all(id);
  const paid = inst.reduce((s, i) => s + i.paid_cents, 0);
  const schedule = inst.length
    ? inst.map((i) => ({ seq: i.seq, dueDate: i.due_date, amountCents: i.amount_cents, paidCents: i.paid_cents, paidAt: i.paid_at }))
    : scheduleFor({ principalCents: l.principal_cents, feeCents: l.fee_cents, installments: l.installments, intervalDays: l.interval_days, startDate: dateOnly(now) })
        .map((s) => ({ seq: s.seq, dueDate: s.dueDate, amountCents: s.amountCents, paidCents: 0, paidAt: null, preview: true }));
  return {
    id: l.id, status: l.status, decision: l.decision, riskTier: l.risk_tier,
    // Adverse-action style reasons are returned only when credit was not granted outright.
    decisionReasons: l.decision === 'approved' ? [] : JSON.parse(l.decision_reasons), reviewNote: l.review_note,
    borrower: { id: b.id, legalName: b.legal_name, email: b.email, entityType: b.entity_type },
    trip: { legId: leg.id, route: `${leg.origin_code} → ${leg.dest_code}`, departsAt: leg.departs_at, aircraft: leg.aircraft },
    plan: { id: l.plan_id, name: PLANS[l.plan_id].name, termMonths: l.term_months },
    terms: {
      charterPriceCents: l.charter_price_cents, operatorPayoutCents: l.payout_cents, downPaymentCents: l.down_payment_cents,
      creditAppliedCents: l.credit_applied_cents, cashDownCents: l.cash_down_cents, principalCents: l.principal_cents,
      flatBps: l.fee_bps, feeCents: l.fee_cents, totalRepaymentCents: l.total_cents, apr: l.apr,
      installments: l.installments, intervalDays: l.interval_days, weeklyPaymentCents: schedule[0].amountCents
    },
    disclosure: disclosure(b.entity_type),
    referral: l.referral ? JSON.parse(l.referral) : null,
    collectionsStage: l.collections_stage,
    lateFeesDueCents: db.prepare('SELECT COALESCE(SUM(amount_cents - paid_cents),0) AS v FROM loan_charges WHERE loan_id=?').get(id).v,
    dueAtSigningCents: l.status === 'signed' ? (l.cash_down_cents - l.down_paid_cents) + (inst[0].amount_cents - inst[0].paid_cents) : null,
    group: groupView(db, l),
    schedule,
    balanceCents: inst.length ? l.total_cents - paid : null,
    daysPastDue: ['funded', 'defaulted'].includes(l.status) ? daysPastDue(db, id, now) : 0,
    createdAt: l.created_at, expiresAt: l.expires_at, signedAt: l.signed_at, fundedAt: l.funded_at
  };
}

export function listLoans(ctx, { email, status, admin = false } = {}) {
  const { db, partner } = ctx;
  const where = [], args = [];
  if (!admin) { where.push('l.partner_id=?'); args.push(partner.id); }
  if (email) { where.push('b.email=?'); args.push(email.toLowerCase()); }
  if (status) { where.push('l.status=?'); args.push(status); }
  const rows = db.prepare(`SELECT l.id FROM loans l JOIN borrowers b ON b.id=l.borrower_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.created_at DESC LIMIT 200`).all(...args);
  return rows.map((r) => getLoan(ctx, r.id, admin));
}

export function portfolio(ctx) {
  const { db, now } = ctx;
  const sum = (sql, ...a) => db.prepare(sql).get(...a).v;
  const funded = "('funded','defaulted','paid','charged_off')";
  const originated = sum(`SELECT COALESCE(SUM(principal_cents),0) v FROM loans WHERE status IN ${funded}`);
  const markup = sum(`SELECT COALESCE(SUM(charter_price_cents - payout_cents),0) v FROM loans WHERE status IN ${funded}`);
  const dues = sum('SELECT COALESCE(SUM(amount_cents),0) v FROM membership_payments');
  const collected = sum('SELECT COALESCE(SUM(paid_cents),0) v FROM installments');
  const feesCollected = sum('SELECT COALESCE(SUM(MIN(paid_cents, amount_cents) * fee_cents / amount_cents),0) v FROM installments');
  const outstanding = sum("SELECT COALESCE(SUM(i.amount_cents - i.paid_cents),0) v FROM installments i JOIN loans l ON l.id=i.loan_id WHERE l.status IN ('funded','defaulted')");
  const defaultedBal = sum("SELECT COALESCE(SUM(i.amount_cents - i.paid_cents),0) v FROM installments i JOIN loans l ON l.id=i.loan_id WHERE l.status='defaulted'");
  const trust = sum('SELECT COALESCE(SUM(amount_cents),0) v FROM trust_ledger');
  const chargedOff = sum("SELECT COALESCE(SUM(i.amount_cents - i.paid_cents),0) v FROM installments i JOIN loans l ON l.id=i.loan_id WHERE l.status='charged_off'");
  const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM loans GROUP BY status').all().map((r) => [r.status, r.n]));
  const buckets = { current: 0, d1_30: 0, d31_plus: 0 };
  for (const l of db.prepare("SELECT id FROM loans WHERE status IN ('funded','defaulted')").all()) {
    const d = daysPastDue(db, l.id, now);
    buckets[d === 0 ? 'current' : d <= 30 ? 'd1_30' : 'd31_plus']++;
  }
  const committed = committedCapital(db);
  return {
    asOf: dateOnly(now), capitalPoolCents: CONFIG.capitalPoolCents, committedPrincipalCents: committed,
    availableCapitalCents: CONFIG.capitalPoolCents - committed, utilization: committed / CONFIG.capitalPoolCents,
    originatedCents: originated, collectedCents: collected, feeRevenueCollectedCents: feesCollected,
    marketplaceMarkupCents: markup, membershipDuesCents: dues, trustAccountCents: trust,
    outstandingReceivableCents: outstanding, defaultedBalanceCents: defaultedBal, chargedOffCents: chargedOff,
    // PLACEHOLDER rate: the plan says the loss reserve is funded from flat charges
    lossReserveCents: Math.floor((feesCollected * CONFIG.lossReserveBps) / 10000),
    loansByStatus: byStatus, delinquency: buckets
  };
}

// ---------- operator listings (Plan A: partner-listed legs) ----------
// "Each uploaded Part 135 leg becomes a flight-specific loan offer at listing time": the operator uploads a leg at the
// price shown to customers and immediately gets back the financing offers it will carry (per plan), computed from
// that leg's price, type and hours to departure. Operator is paid (price - broker commission) at funding.
export function offersForLeg(db, leg, partner, now) {
  const offers = [];
  for (const plan of Object.values(PLANS)) {
    if (plan.id === 'marketplace' && leg.markup_bps === 0) continue;
    if (plan.id === 'non_member' && leg.markup_bps > 0) continue;
    const adjust = adjustFor(leg, plan, now);
    for (const tm of allowedTerms(plan, adjust)) {
      try {
        const t = termsFor(leg, plan, tm, 0, partner, now);
        offers.push({ plan: plan.id, termMonths: tm, installments: t.installments, downPaymentCents: t.downPaymentCents, flatBps: t.flatBps,
          weeklyPaymentCents: t.weeklyPaymentCents, apr: t.apr, termRulesApplied: t.termRulesApplied });
      } catch { /* plan not applicable to this leg (e.g. below minimum) */ }
    }
  }
  return offers;
}

export function createOperatorLeg(ctx, operator, b) {
  const { db, now } = ctx;
  const need = ['originCode', 'originCity', 'destCode', 'destCity', 'aircraft', 'window'];
  if (need.some((k) => typeof b?.[k] !== 'string' || !b[k]) || !Number.isInteger(b.priceCents) || b.priceCents <= 0 ||
      !Number.isInteger(b.durationMin) || !Number.isFinite(Date.parse(b.departsAt))) {
    throw bad('invalid_leg', 'originCode, originCity, destCode, destCity, aircraft, window, priceCents, durationMin and departsAt are required');
  }
  const legType = b.legType ?? 'empty_leg';
  if (!['empty_leg', 'charter'].includes(legType)) throw bad('invalid_leg_type', "legType must be 'empty_leg' or 'charter'");
  if (Date.parse(b.departsAt) <= now.getTime()) throw bad('invalid_leg', 'departsAt must be in the future');
  const id = newId('leg');
  db.prepare(`INSERT INTO legs (id,operator_id,origin_code,origin_city,dest_code,dest_city,duration_min,departs_at,time_window,aircraft,seats,category,
    price_cents,operator_price_cents,markup_bps,leg_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`)
    .run(id, operator.id, b.originCode.toUpperCase(), b.originCity, b.destCode.toUpperCase(), b.destCity, b.durationMin, new Date(b.departsAt).toISOString(),
      b.window, b.aircraft, b.seats ?? null, b.category ?? null, b.priceCents, Math.round(b.priceCents * (1 - operator.commission_bps / 10000)), legType);
  const leg = loadLeg(db, id);
  const partner = db.prepare('SELECT * FROM partners WHERE active=1 ORDER BY created_at LIMIT 1').get() ?? { max_loan_cents: CONFIG.maxLoanCents, fee_adjust_bps: 0 };
  return { leg: legView(db, leg, partner, now), operatorPayoutCents: leg.operator_price_cents, financingOffers: offersForLeg(db, leg, partner, now) };
}
