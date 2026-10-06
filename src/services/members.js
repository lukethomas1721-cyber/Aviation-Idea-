import { CONFIG } from '../config.js';
import { tx } from '../db.js';
import { ApiError, bad } from '../errors.js';
import { addDays, dateOnly } from '../money.js';
import { PLANS, duesPerPaymentCents } from '../plans.js';
import { exposureFor, OPEN_STATUSES } from './shared.js';

const norm = (e) => String(e ?? '').trim().toLowerCase();
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const getMembership = (db, email) => db.prepare('SELECT * FROM memberships WHERE email=?').get(norm(email)) ?? null;

// Pricing plan applied at quote time: an active, non-frozen membership wins; otherwise non-member / marketplace.
export function pricingPlanFor(db, email, leg) {
  const m = email ? getMembership(db, email) : null;
  if (m && m.status === 'active' && !m.perks_frozen) return { planId: m.plan_id, membership: m };
  return { planId: leg.markup_bps > 0 ? 'marketplace' : 'non_member', membership: m };
}

// ---- trust ledger (client money; never mixed with company cash) ----
const ledger = (db, email, kind, amount, ref, now) =>
  db.prepare('INSERT INTO trust_ledger (email,kind,amount_cents,ref,created_at) VALUES (?,?,?,?,?)').run(norm(email), kind, amount, ref ?? null, now.toISOString());

export const creditBalance = (db, email) =>
  db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS v FROM trust_ledger WHERE email=? AND kind IN ('credit_grant','credit_applied','credit_released')").get(norm(email)).v;

export function reserveCredit(db, email, loanId, cents, now) {
  if (cents > 0) ledger(db, email, 'credit_applied', -cents, loanId, now);
}
export function releaseCredit(db, loanId, now) {
  const row = db.prepare("SELECT email, SUM(amount_cents) AS v FROM trust_ledger WHERE ref=? AND kind IN ('credit_applied','credit_released') GROUP BY email").get(loanId);
  if (row && row.v < 0) ledger(db, row.email, 'credit_released', -row.v, loanId, now);
}

// ---- memberships ----
function chargeDues(db, now, email, plan) {
  const amount = duesPerPaymentCents(plan);
  db.prepare('INSERT INTO membership_payments (email,plan_id,amount_cents,credit_granted_cents,created_at) VALUES (?,?,?,?,?)')
    .run(email, plan.id, amount, plan.creditPerPaymentCents, now.toISOString());
  ledger(db, email, 'credit_grant', plan.creditPerPaymentCents, `dues:${plan.id}`, now);
  return amount;
}

export function joinMembership(ctx, { email, planId }) {
  const { db, now } = ctx;
  const plan = PLANS[planId];
  if (!plan?.dues) throw bad('invalid_plan', "planId must be 'access' or 'elite'");
  if (!EMAIL.test(norm(email))) throw bad('invalid_email', 'A valid email is required');
  email = norm(email);
  return tx(db, () => {
    const existing = getMembership(db, email);
    if (existing && existing.status === 'active') throw new ApiError(409, 'already_member', `Already an active ${existing.plan_id} member`);
    const next = addDays(dateOnly(now), plan.dues.billingMonths * 30);
    if (existing) db.prepare("UPDATE memberships SET plan_id=?, status='active', perks_frozen=0, next_billing_at=? WHERE email=?").run(plan.id, next, email);
    else db.prepare('INSERT INTO memberships (email,plan_id,joined_at,next_billing_at) VALUES (?,?,?,?)').run(email, plan.id, now.toISOString(), next);
    chargeDues(db, now, email, plan); // payment collection is mocked; processor integration goes here
    return memberView(ctx, email);
  });
}

export function renewMembership(ctx, { email }) {
  const { db, now } = ctx;
  email = norm(email);
  return tx(db, () => {
    const m = getMembership(db, email);
    const plan = m && PLANS[m.plan_id];
    if (!plan?.dues || m.status !== 'active') throw new ApiError(404, 'no_membership', 'No active Access/Elite membership');
    chargeDues(db, now, email, plan);
    db.prepare('UPDATE memberships SET next_billing_at=? WHERE email=?').run(addDays(dateOnly(now), plan.dues.billingMonths * 30), email);
    return memberView(ctx, email);
  });
}

export function depositFunds(ctx, { email, amountCents }) {
  const { db, now } = ctx;
  const plan = PLANS.deposit;
  if (!EMAIL.test(norm(email))) throw bad('invalid_email', 'A valid email is required');
  if (!plan.depositOptionsCents.includes(amountCents)) throw bad('invalid_deposit', 'Deposit must be one of the offered amounts', { allowed: plan.depositOptionsCents });
  email = norm(email);
  return tx(db, () => {
    const m = getMembership(db, email);
    if (m && m.status === 'active' && m.plan_id !== 'deposit') throw new ApiError(409, 'already_member', `Already an active ${m.plan_id} member`);
    if (m) db.prepare("UPDATE memberships SET plan_id='deposit', status='active', deposit_cents=deposit_cents+? WHERE email=?").run(amountCents, email);
    else db.prepare("INSERT INTO memberships (email,plan_id,deposit_cents,joined_at) VALUES (?,'deposit',?,?)").run(email, amountCents, now.toISOString());
    ledger(db, email, 'deposit', amountCents, 'deposit', now); // held in trust as collateral for the credit line
    return memberView(ctx, email);
  });
}

// Credit line = deposit. Open question in the plan: whether it refills as repaid (config.depositRefills).
export function creditLine(db, email) {
  const m = getMembership(db, email);
  if (!m || m.plan_id !== 'deposit' || m.status !== 'active') return null;
  const b = db.prepare('SELECT id FROM borrowers WHERE email=?').get(norm(email));
  let used = 0;
  if (b) {
    used = CONFIG.depositRefills
      ? exposureFor(db, b.id)
      : db.prepare(`SELECT COALESCE(SUM(principal_cents),0) AS v FROM loans WHERE borrower_id=? AND status IN (${OPEN_STATUSES.concat(['paid']).map(() => '?').join(',')})`).get(b.id, ...OPEN_STATUSES, 'paid').v;
  }
  return { limitCents: m.deposit_cents, usedCents: used, availableCents: Math.max(0, m.deposit_cents - used) };
}

export function memberView(ctx, email) {
  const { db } = ctx;
  email = norm(email);
  const m = getMembership(db, email);
  if (!m) return { email, member: false, plan: 'non_member', tripCreditCents: 0 };
  return {
    email, member: true, plan: m.plan_id, planName: PLANS[m.plan_id].name, status: m.status, perksFrozen: !!m.perks_frozen,
    tripCreditCents: creditBalance(db, email), depositCents: m.deposit_cents, creditLine: creditLine(db, email),
    nextBillingAt: m.next_billing_at, joinedAt: m.joined_at
  };
}

// Monthly reconciliation: client balances in the ledger must equal the trust bank account.
export function trustReconciliation(ctx, bankBalanceCents) {
  const rows = ctx.db.prepare('SELECT email, SUM(amount_cents) AS balance FROM trust_ledger GROUP BY email HAVING balance != 0 ORDER BY email').all();
  const total = rows.reduce((s, r) => s + r.balance, 0);
  const negative = rows.filter((r) => r.balance < 0);
  return {
    ledgerTotalCents: total, suretyBondRequiredCents: total, // plan: bond sized to client balances
    clientBalances: rows.map((r) => ({ email: r.email, balanceCents: r.balance })),
    bankBalanceCents: bankBalanceCents ?? null,
    differenceCents: bankBalanceCents == null ? null : bankBalanceCents - total,
    reconciled: bankBalanceCents == null ? null : bankBalanceCents === total && negative.length === 0,
    negativeBalances: negative.length
  };
}
