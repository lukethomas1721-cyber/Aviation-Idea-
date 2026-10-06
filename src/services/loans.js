import { CONFIG } from '../config.js';
import { tx, newId } from '../db.js';
import { ApiError, bad } from '../errors.js';
import { addDays, dateOnly, daysBetween } from '../money.js';
import { buildTerms, scheduleFor, DISCLOSURE } from '../pricing.js';
import { underwrite } from '../underwriting.js';

const OPEN_STATUSES = ['pending_review', 'approved', 'funded', 'defaulted']; // count against exposure/capital

const log = (db, now, loanId, type, data) =>
  db.prepare('INSERT INTO events (loan_id,type,data,created_at) VALUES (?,?,?,?)').run(loanId, type, JSON.stringify(data ?? {}), now.toISOString());

// ---------- legs ----------
export function legView(leg, partner, now, config = CONFIG) {
  const eligibility = legEligibility(leg, now, config);
  let preview = null;
  if (eligibility.financeable) {
    try {
      const t = buildTerms({ priceCents: leg.price_cents, partner, now, config });
      preview = { monthlyPaymentCents: t.schedule[0].amountCents, installments: t.installments, downPaymentRequiredCents: t.downPaymentCents };
    } catch { /* below minimum etc. -> not financeable */ eligibility.financeable = false; eligibility.reason = 'below_minimum'; }
  }
  return {
    id: leg.id, origin: { code: leg.origin_code, city: leg.origin_city }, destination: { code: leg.dest_code, city: leg.dest_city },
    durationMin: leg.duration_min, departsAt: leg.departs_at, window: leg.time_window, aircraft: leg.aircraft, seats: leg.seats,
    category: leg.category, priceCents: leg.price_cents, pricedPerSeat: !!leg.per_seat, memberOnly: !!leg.member_only,
    altAircraft: leg.alt_aircraft, status: leg.status, financing: { ...eligibility, preview }
  };
}

export function legEligibility(leg, now, config = CONFIG) {
  const no = (reason) => ({ financeable: false, reason });
  if (leg.per_seat || leg.member_only) return no('per_seat_or_member_flight');
  if (leg.status !== 'available') return no(`leg_${leg.status}`);
  const op = leg.operator;
  if (op && (!op.cert_verified || !op.active)) return no('operator_not_verified');
  const hours = (Date.parse(leg.departs_at) - now.getTime()) / 3600000;
  if (hours < config.minLeadHours) return no('departure_too_soon');
  if (hours > config.maxLeadDays * 24) return no('departure_too_far');
  return { financeable: true, reason: null };
}

function loadLeg(db, legId) {
  const leg = db.prepare('SELECT * FROM legs WHERE id=?').get(legId);
  if (!leg) throw new ApiError(404, 'leg_not_found', 'Leg not found');
  leg.operator = db.prepare('SELECT * FROM operators WHERE id=?').get(leg.operator_id);
  return leg;
}

export function listLegs(db, partner, now, { origin, dest, financeableOnly } = {}) {
  const rows = db.prepare('SELECT id FROM legs ORDER BY departs_at, id').all();
  return rows
    .map((r) => legView(loadLeg(db, r.id), partner, now))
    .filter((l) => (!origin || l.origin.code === origin.toUpperCase()) && (!dest || l.destination.code === dest.toUpperCase()))
    .filter((l) => !financeableOnly || l.financing.financeable);
}

// ---------- quote ----------
export function createQuote(ctx, { legId, downPaymentCents = 0 }) {
  const { db, now, partner } = ctx;
  expireStale(ctx);
  const leg = loadLeg(db, legId);
  const e = legEligibility(leg, now);
  if (!e.financeable) throw bad('leg_not_financeable', `This leg cannot be financed (${e.reason})`, { reason: e.reason });
  const terms = buildTerms({ priceCents: leg.price_cents, downPaymentCents, partner, now });
  return { leg: legView(leg, partner, now), terms, disclosure: DISCLOSURE };
}

// ---------- application ----------
function validateBorrower(b) {
  if (!b || typeof b !== 'object') throw bad('invalid_borrower', 'borrower is required');
  const errs = [];
  if (typeof b.legalName !== 'string' || b.legalName.trim().length < 2) errs.push('legalName');
  if (typeof b.email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) errs.push('email');
  if (!['llc', 'corporation', 'partnership', 'sole_proprietor', 'other'].includes(b.entityType)) errs.push('entityType');
  if (!Number.isInteger(b.annualRevenueCents) || b.annualRevenueCents < 0) errs.push('annualRevenueCents');
  if (typeof b.yearsInBusiness !== 'number' || b.yearsInBusiness < 0) errs.push('yearsInBusiness');
  if (!Number.isInteger(b.creditScore) || b.creditScore < 300 || b.creditScore > 850) errs.push('creditScore');
  if (errs.length) throw bad('invalid_borrower', 'Invalid borrower fields: ' + errs.join(', '), { fields: errs });
}

function exposureFor(db, borrowerId) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(l.principal_cents),0) AS principal,
           COALESCE(SUM((SELECT COALESCE(SUM(i.paid_cents * i.principal_cents / i.amount_cents),0) FROM installments i WHERE i.loan_id=l.id)),0) AS repaid
    FROM loans l WHERE l.borrower_id=? AND l.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`).get(borrowerId, ...OPEN_STATUSES);
  return Math.max(0, r.principal - Math.round(r.repaid));
}

function committedCapital(db) {
  return db.prepare(`SELECT COALESCE(SUM(principal_cents),0) AS p FROM loans WHERE status IN (${OPEN_STATUSES.map(() => '?').join(',')})`)
    .get(...OPEN_STATUSES).p - db.prepare(`SELECT COALESCE(SUM(i.paid_cents * i.principal_cents / i.amount_cents),0) AS r FROM installments i JOIN loans l ON l.id=i.loan_id WHERE l.status IN ('funded','defaulted')`).get().r;
}

export function applyForLoan(ctx, { legId, downPaymentCents = 0, borrower, consents }) {
  const { db, now, partner } = ctx;
  if (!consents?.creditCheck) throw bad('consent_required', 'consents.creditCheck must be true to run underwriting');
  validateBorrower(borrower);
  expireStale(ctx);
  return tx(db, () => {
    const leg = loadLeg(db, legId);
    const e = legEligibility(leg, now);
    if (!e.financeable) throw bad('leg_not_financeable', `This leg cannot be financed (${e.reason})`, { reason: e.reason });
    const terms = buildTerms({ priceCents: leg.price_cents, downPaymentCents, partner, now });

    if (committedCapital(db) + terms.principalCents > CONFIG.capitalPoolCents) {
      throw new ApiError(503, 'capital_unavailable', 'Financing capacity is temporarily unavailable');
    }

    const email = borrower.email.trim().toLowerCase();
    let row = db.prepare('SELECT * FROM borrowers WHERE email=?').get(email);
    const fields = [borrower.legalName.trim(), borrower.entityType, borrower.annualRevenueCents, borrower.yearsInBusiness, borrower.creditScore];
    // kyc/ofac come from providers in production. Here the caller's partner-side result is accepted, defaulting to pass.
    const kyc = borrower.kycPassed === false ? 0 : 1;
    const ofac = borrower.ofacClear === false ? 0 : 1;
    if (row) {
      db.prepare('UPDATE borrowers SET legal_name=?, entity_type=?, annual_revenue_cents=?, years_in_business=?, credit_score=?, kyc_passed=?, ofac_clear=? WHERE id=?')
        .run(...fields, kyc, ofac, row.id);
    } else {
      row = { id: newId('bor') };
      db.prepare('INSERT INTO borrowers VALUES (?,?,?,?,?,?,?,?,?,?)').run(row.id, fields[0], fields[1], email, fields[2], fields[3], fields[4], kyc, ofac, now.toISOString());
    }
    const b = db.prepare('SELECT * FROM borrowers WHERE id=?').get(row.id);

    const priorDefaults = db.prepare("SELECT COUNT(*) AS n FROM loans WHERE borrower_id=? AND status='defaulted'").get(b.id).n;
    const result = underwrite({
      borrower: b, principalCents: terms.principalCents, existingExposureCents: exposureFor(db, b.id),
      priorDefaults, maxExposureCents: CONFIG.maxBorrowerExposureCents
    });

    const status = { approved: 'approved', review: 'pending_review', declined: 'declined' }[result.decision];
    const holdMin = result.decision === 'review' ? CONFIG.reviewHoldMinutes : CONFIG.holdMinutes;
    const expiresAt = status === 'declined' ? null : new Date(now.getTime() + holdMin * 60000).toISOString();
    const id = newId('loan');
    db.prepare(`INSERT INTO loans (id,partner_id,leg_id,borrower_id,status,charter_price_cents,down_payment_cents,principal_cents,fee_bps,fee_cents,
      total_cents,apr,installments,interval_days,decision,decision_reasons,risk_tier,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, partner.id, leg.id, b.id, status, terms.charterPriceCents, terms.downPaymentCents, terms.principalCents, terms.feeBps, terms.feeCents,
        terms.totalRepaymentCents, terms.apr, terms.installments, terms.intervalDays, result.decision, JSON.stringify(result.reasons), result.riskTier,
        now.toISOString(), expiresAt);
    if (status !== 'declined') db.prepare("UPDATE legs SET status='held' WHERE id=?").run(leg.id);
    log(db, now, id, 'application', { decision: result.decision, reasons: result.reasons.map((r) => r.code) });
    return getLoan(ctx, id);
  });
}

// ---------- lifecycle ----------
function loanRow(db, id, partner) {
  const l = db.prepare('SELECT * FROM loans WHERE id=?').get(id);
  if (!l || (partner && l.partner_id !== partner.id)) throw new ApiError(404, 'loan_not_found', 'Loan not found');
  return l;
}

function releaseLeg(db, legId) {
  db.prepare("UPDATE legs SET status='available' WHERE id=? AND status='held'").run(legId);
}

export function expireStale(ctx) {
  const { db, now } = ctx;
  const stale = db.prepare("SELECT id, leg_id FROM loans WHERE status IN ('approved','pending_review') AND expires_at <= ?").all(now.toISOString());
  for (const s of stale) {
    db.prepare("UPDATE loans SET status='expired', closed_at=? WHERE id=?").run(now.toISOString(), s.id);
    releaseLeg(db, s.leg_id);
    log(db, now, s.id, 'expired', {});
  }
  return stale.length;
}

export function acceptLoan(ctx, id, { acceptedTerms, signatureName }) {
  const { db, now, partner, rails } = ctx;
  if (acceptedTerms !== true) throw bad('terms_not_accepted', 'acceptedTerms must be true');
  if (typeof signatureName !== 'string' || signatureName.trim().length < 2) throw bad('signature_required', 'signatureName is required');
  expireStale(ctx); // outside the tx so the expiry persists when we reject below
  return tx(db, () => {
    const loan = loanRow(db, id, partner);
    if (loan.status === 'expired') throw new ApiError(410, 'offer_expired', 'This offer has expired; please re-apply');
    if (loan.status !== 'approved') throw new ApiError(409, 'invalid_state', `Loan is ${loan.status}; only approved loans can be accepted`);
    const leg = loadLeg(db, loan.leg_id);
    if (leg.status !== 'held') throw new ApiError(409, 'leg_unavailable', 'Leg is no longer held for this loan');
    if (Date.parse(leg.departs_at) - now.getTime() < CONFIG.minLeadHours * 3600000) throw new ApiError(409, 'departure_too_soon', 'Departure is too close to fund this trip');

    const schedule = scheduleFor({
      principalCents: loan.principal_cents, feeCents: loan.fee_cents, installments: loan.installments,
      intervalDays: loan.interval_days, startDate: dateOnly(now)
    });
    const ins = db.prepare('INSERT INTO installments (loan_id,seq,due_date,amount_cents,principal_cents,fee_cents) VALUES (?,?,?,?,?,?)');
    for (const s of schedule) ins.run(id, s.seq, s.dueDate, s.amountCents, s.principalCents, s.feeCents);

    // Pay the operator the financed principal. Down payment (if any) is settled between customer and operator.
    const payout = rails.disburse({ loanId: id, operator: leg.operator, amountCents: loan.principal_cents });
    db.prepare('INSERT INTO payouts VALUES (?,?,?,?,?,?,?)').run(newId('po'), id, leg.operator.id, loan.principal_cents, payout.status, payout.reference, now.toISOString());

    db.prepare("UPDATE loans SET status='funded', funded_at=?, signed_by=?, expires_at=NULL WHERE id=?").run(now.toISOString(), signatureName.trim(), id);
    db.prepare("UPDATE legs SET status='booked' WHERE id=?").run(leg.id);
    log(db, now, id, 'funded', { payout: payout.reference });
    return getLoan(ctx, id);
  });
}

export function cancelLoan(ctx, id) {
  const { db, now, partner } = ctx;
  return tx(db, () => {
    const loan = loanRow(db, id, partner);
    if (!['approved', 'pending_review'].includes(loan.status)) throw new ApiError(409, 'invalid_state', `Loan is ${loan.status}; only unfunded offers can be cancelled`);
    db.prepare("UPDATE loans SET status='cancelled', closed_at=? WHERE id=?").run(now.toISOString(), id);
    releaseLeg(db, loan.leg_id);
    log(db, now, id, 'cancelled', {});
    return getLoan(ctx, id);
  });
}

export function reviewLoan(ctx, id, { decision, note }) {
  const { db, now } = ctx;
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
      db.prepare("UPDATE loans SET status='declined', review_note=?, closed_at=? WHERE id=?").run(note ?? null, now.toISOString(), id);
      releaseLeg(db, loan.leg_id);
    }
    log(db, now, id, 'review', { decision, note });
    return getLoan(ctx, id, true);
  });
}

export function recordPayment(ctx, id, { amountCents, idempotencyKey }) {
  const { db, now, partner } = ctx;
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw bad('invalid_amount', 'amountCents must be a positive integer');
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) throw bad('idempotency_key_required', 'idempotencyKey (>= 8 chars) is required');
  return tx(db, () => {
    const loan = loanRow(db, id, partner);
    if (db.prepare('SELECT 1 FROM payments WHERE loan_id=? AND idempotency_key=?').get(id, idempotencyKey)) return getLoan(ctx, id); // replay
    if (!['funded', 'defaulted'].includes(loan.status)) throw new ApiError(409, 'invalid_state', `Loan is ${loan.status}; no payments due`);
    const rows = db.prepare('SELECT * FROM installments WHERE loan_id=? AND paid_cents < amount_cents ORDER BY seq').all(id);
    const owed = rows.reduce((s, r) => s + r.amount_cents - r.paid_cents, 0);
    if (amountCents > owed) throw bad('overpayment', `Payment exceeds balance of ${owed} cents`, { balanceCents: owed });
    let left = amountCents;
    for (const r of rows) {
      if (left === 0) break;
      const apply = Math.min(left, r.amount_cents - r.paid_cents);
      const paid = r.paid_cents + apply;
      db.prepare('UPDATE installments SET paid_cents=?, paid_at=? WHERE id=?').run(paid, paid === r.amount_cents ? now.toISOString() : r.paid_at, r.id);
      left -= apply;
    }
    db.prepare('INSERT INTO payments VALUES (?,?,?,?,?)').run(newId('pay'), id, amountCents, idempotencyKey, now.toISOString());
    if (owed - amountCents === 0) {
      db.prepare("UPDATE loans SET status='paid', closed_at=? WHERE id=?").run(now.toISOString(), id);
      log(db, now, id, 'paid_off', {});
    } else if (loan.status === 'defaulted' && daysPastDue(db, id, now) <= CONFIG.defaultAfterDaysPastDue) {
      db.prepare("UPDATE loans SET status='funded' WHERE id=?").run(id); // cured
      log(db, now, id, 'cured', {});
    }
    log(db, now, id, 'payment', { amountCents });
    return getLoan(ctx, id);
  });
}

function daysPastDue(db, loanId, now) {
  const r = db.prepare('SELECT MIN(due_date) AS d FROM installments WHERE loan_id=? AND paid_cents < amount_cents').get(loanId);
  if (!r?.d) return 0;
  return Math.max(0, daysBetween(r.d, dateOnly(now)));
}

// Daily job: expire stale offers, flag defaults.
export function sweep(ctx) {
  const { db, now } = ctx;
  const expired = expireStale(ctx);
  let defaulted = 0;
  for (const l of db.prepare("SELECT id FROM loans WHERE status='funded'").all()) {
    if (daysPastDue(db, l.id, now) > CONFIG.defaultAfterDaysPastDue) {
      db.prepare("UPDATE loans SET status='defaulted' WHERE id=?").run(l.id);
      log(db, now, l.id, 'defaulted', {});
      defaulted++;
    }
  }
  return { expired, defaulted };
}

// ---------- reads ----------
export function getLoan(ctx, id, admin = false) {
  const { db, now, partner } = ctx;
  const l = loanRow(db, id, admin ? null : partner);
  const b = db.prepare('SELECT * FROM borrowers WHERE id=?').get(l.borrower_id);
  const leg = db.prepare('SELECT * FROM legs WHERE id=?').get(l.leg_id);
  const inst = db.prepare('SELECT * FROM installments WHERE loan_id=? ORDER BY seq').all(id);
  const paid = inst.reduce((s, i) => s + i.paid_cents, 0);
  const reasons = JSON.parse(l.decision_reasons);
  return {
    id: l.id, status: l.status, decision: l.decision, riskTier: l.risk_tier,
    // Adverse-action style reasons are returned only when credit was not granted outright.
    decisionReasons: l.decision === 'approved' ? [] : reasons, reviewNote: l.review_note,
    borrower: { id: b.id, legalName: b.legal_name, email: b.email, entityType: b.entity_type },
    trip: { legId: leg.id, route: `${leg.origin_code} → ${leg.dest_code}`, departsAt: leg.departs_at, aircraft: leg.aircraft },
    terms: {
      charterPriceCents: l.charter_price_cents, downPaymentCents: l.down_payment_cents, principalCents: l.principal_cents,
      feeBps: l.fee_bps, feeCents: l.fee_cents, totalRepaymentCents: l.total_cents, apr: l.apr,
      installments: l.installments, intervalDays: l.interval_days
    },
    disclosure: DISCLOSURE,
    schedule: inst.length
      ? inst.map((i) => ({ seq: i.seq, dueDate: i.due_date, amountCents: i.amount_cents, paidCents: i.paid_cents, paidAt: i.paid_at }))
      : scheduleFor({ principalCents: l.principal_cents, feeCents: l.fee_cents, installments: l.installments, intervalDays: l.interval_days, startDate: dateOnly(now) })
          .map((s) => ({ seq: s.seq, dueDate: s.dueDate, amountCents: s.amountCents, paidCents: 0, paidAt: null, preview: true })),
    balanceCents: inst.length ? l.total_cents - paid : null,
    daysPastDue: ['funded', 'defaulted'].includes(l.status) ? daysPastDue(db, id, now) : 0,
    createdAt: l.created_at, expiresAt: l.expires_at, fundedAt: l.funded_at
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
  const funded = "('funded','defaulted','paid')";
  const originated = sum(`SELECT COALESCE(SUM(principal_cents),0) v FROM loans WHERE status IN ${funded}`);
  const collected = sum('SELECT COALESCE(SUM(paid_cents),0) v FROM installments');
  const feesCollected = sum('SELECT COALESCE(SUM(MIN(paid_cents, amount_cents) * fee_cents / amount_cents),0) v FROM installments');
  const outstanding = sum(`SELECT COALESCE(SUM(i.amount_cents - i.paid_cents),0) v FROM installments i JOIN loans l ON l.id=i.loan_id WHERE l.status IN ('funded','defaulted')`);
  const defaultedBal = sum(`SELECT COALESCE(SUM(i.amount_cents - i.paid_cents),0) v FROM installments i JOIN loans l ON l.id=i.loan_id WHERE l.status='defaulted'`);
  const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM loans GROUP BY status').all().map((r) => [r.status, r.n]));
  const today = dateOnly(now);
  const buckets = { current: 0, d1_30: 0, d31_plus: 0 };
  for (const l of db.prepare("SELECT id FROM loans WHERE status IN ('funded','defaulted')").all()) {
    const d = daysPastDue(db, l.id, now);
    buckets[d === 0 ? 'current' : d <= 30 ? 'd1_30' : 'd31_plus']++;
  }
  const committed = committedCapital(db);
  return {
    asOf: today, capitalPoolCents: CONFIG.capitalPoolCents, committedPrincipalCents: committed,
    availableCapitalCents: CONFIG.capitalPoolCents - committed, utilization: committed / CONFIG.capitalPoolCents,
    originatedCents: originated, collectedCents: collected, feeRevenueCollectedCents: feesCollected,
    outstandingReceivableCents: outstanding, defaultedBalanceCents: defaultedBal, loansByStatus: byStatus, delinquency: buckets
  };
}
