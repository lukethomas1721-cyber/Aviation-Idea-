import { randomBytes } from 'node:crypto';
import { CONFIG } from '../config.js';
import { tx, newId } from '../db.js';
import { ApiError, bad } from '../errors.js';
import { dateOnly, daysBetween, shareFor } from '../money.js';
import { applyToInstallment, closeIfPaid, loanRow, log } from './shared.js';

// Group pay: one main customer signs the loan and is responsible for the whole balance; up to 8 friends each
// pay an equal share of the down payment and every weekly payment. Friends are payers, not borrowers.

export const isGroup = (db, loanId) => db.prepare('SELECT COUNT(*) n FROM loan_members WHERE loan_id=?').get(loanId).n > 0;
export const shareOf = (loan, member, total) => shareFor(total, loan.group_n, member.role === 'main', loan.group_covered);

export function autopayFrom(a) {
  if (!a || !['ach', 'card'].includes(a.method) || !/^\d{4}$/.test(String(a.last4 ?? ''))) {
    throw bad('autopay_required', "autopay must be {method: 'ach'|'card', last4: '1234'}");
  }
  return { method: a.method, last4: String(a.last4) };
}

export function createGroup(ctx, loanId, { friends }) {
  const { db, now, partner } = ctx;
  if (!Array.isArray(friends) || friends.length < 1 || friends.length > CONFIG.maxGroupFriends) {
    throw bad('invalid_group', `Invite between 1 and ${CONFIG.maxGroupFriends} friends`);
  }
  for (const f of friends) {
    if (typeof f?.name !== 'string' || f.name.trim().length < 2 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email ?? '')) throw bad('invalid_group', 'Each friend needs a name and email');
  }
  return tx(db, () => {
    const loan = loanRow(db, loanId, partner);
    if (loan.status !== 'approved') throw new ApiError(409, 'invalid_state', 'Groups can only be created on an approved offer');
    if (isGroup(db, loanId)) throw new ApiError(409, 'group_exists', 'This loan already has a group');
    const b = db.prepare('SELECT * FROM borrowers WHERE id=?').get(loan.borrower_id);
    const ins = db.prepare('INSERT INTO loan_members (id,loan_id,role,name,email,invite_token,status,created_at,joined_at) VALUES (?,?,?,?,?,?,?,?,?)');
    ins.run(newId('mem'), loanId, 'main', b.legal_name, b.email, null, 'joined', now.toISOString(), now.toISOString());
    for (const f of friends) ins.run(newId('mem'), loanId, 'friend', f.name.trim(), f.email.toLowerCase(), randomBytes(12).toString('hex'), 'invited', now.toISOString(), null);
    const exp = new Date(now.getTime() + CONFIG.groupInviteMinutes * 60000).toISOString(); // keep the flight held while friends join
    db.prepare('UPDATE loans SET expires_at=? WHERE id=?').run(exp, loanId);
    log(db, now, loanId, 'group_created', { friends: friends.length });
    return groupView(db, loanRow(db, loanId));
  });
}

export function joinGroup(ctx, token, { name, idVerified, autopay }) {
  const { db, now, partner } = ctx;
  const ap = autopayFrom(autopay);
  if (idVerified !== true) throw bad('id_verification_required', 'Each friend must verify their ID (idVerified: true from your ID provider)');
  return tx(db, () => {
    const m = db.prepare('SELECT * FROM loan_members WHERE invite_token=?').get(String(token));
    if (!m) throw new ApiError(404, 'invite_not_found', 'Invite not found');
    const loan = loanRow(db, m.loan_id, partner);
    if (loan.status !== 'approved' || loan.group_finalized) throw new ApiError(409, 'group_closed', 'This group is no longer accepting members');
    if (m.status !== 'invited') throw new ApiError(409, 'already_joined', `Invite is ${m.status}`);
    db.prepare("UPDATE loan_members SET status='joined', name=COALESCE(?,name), autopay_method=?, autopay_last4=?, joined_at=? WHERE id=?")
      .run(name?.trim() || null, ap.method, ap.last4, now.toISOString(), m.id);
    log(db, now, loan.id, 'group_joined', { member: m.id });
    return groupView(db, loanRow(db, loan.id));
  });
}

// Lock the group. Friends who have not joined are dropped (shares recalculated) or covered by the main customer.
export function finalizeGroup(ctx, loanId, { mode = 'shrink' } = {}) {
  const { db, now, partner } = ctx;
  if (!['shrink', 'main_covers'].includes(mode)) throw bad('invalid_mode', "mode must be 'shrink' or 'main_covers'");
  return tx(db, () => {
    const loan = loanRow(db, loanId, partner);
    if (loan.status !== 'approved') throw new ApiError(409, 'invalid_state', `Loan is ${loan.status}`);
    if (!isGroup(db, loanId)) throw new ApiError(404, 'no_group', 'No group on this loan');
    if (loan.group_finalized) throw new ApiError(409, 'group_finalized', 'Group already finalized');
    const pending = db.prepare("UPDATE loan_members SET status=? WHERE loan_id=? AND role='friend' AND status='invited'").run(mode === 'shrink' ? 'removed' : 'covered', loanId);
    const counts = db.prepare("SELECT SUM(role='main' OR status='joined') AS active, SUM(status='covered') AS covered FROM loan_members WHERE loan_id=?").get(loanId);
    const covered = counts.covered ?? 0;
    db.prepare('UPDATE loans SET group_finalized=1, group_n=?, group_covered=? WHERE id=?').run(counts.active + covered, covered, loanId);
    log(db, now, loanId, 'group_finalized', { mode, dropped: Number(pending.changes) });
    return groupView(db, loanRow(db, loanId));
  });
}

export function groupView(db, loan) {
  if (!isGroup(db, loan.id)) return null;
  const members = db.prepare('SELECT * FROM loan_members WHERE loan_id=? ORDER BY role DESC, created_at, id').all(loan.id);
  const inst1 = db.prepare('SELECT amount_cents FROM installments WHERE loan_id=? AND seq=1').get(loan.id)?.amount_cents
    ?? Math.floor((loan.principal_cents + loan.fee_cents) / loan.installments);
  const paidSet = (sql) => new Set(db.prepare(sql).all(loan.id).map((r) => r.member_id));
  const downPaid = paidSet("SELECT member_id FROM member_payments WHERE loan_id=? AND kind='down'");
  const firstPaid = paidSet("SELECT member_id FROM member_payments WHERE loan_id=? AND kind='installment' AND seq=1");
  return {
    finalized: !!loan.group_finalized, payers: loan.group_finalized ? loan.group_n - loan.group_covered : null,
    members: members.map((m) => {
      const pays = loan.group_finalized && (m.role === 'main' || m.status === 'joined' || m.status === 'paid_off');
      return {
        id: m.id, role: m.role, name: m.name, email: m.email, status: m.status,
        inviteToken: m.status === 'invited' ? m.invite_token : undefined,
        downShareCents: pays ? shareOf(loan, m, loan.cash_down_cents) : null,
        weeklyShareCents: pays ? shareOf(loan, m, inst1) : null,
        downPaid: downPaid.has(m.id),
        firstPaid: firstPaid.has(m.id)
      };
    })
  };
}

// A friend who misses a weekly share past the grace period is charged to the main customer's card,
// so the loan is always paid in full.
export function backstop(ctx) {
  const { db, now, rails } = ctx;
  const today = dateOnly(now);
  let charged = 0;
  const loans = db.prepare("SELECT * FROM loans WHERE status IN ('funded','defaulted') AND group_finalized=1").all();
  for (const loan of loans) {
    const main = db.prepare("SELECT * FROM loan_members WHERE loan_id=? AND role='main'").get(loan.id);
    const friends = db.prepare("SELECT * FROM loan_members WHERE loan_id=? AND role='friend' AND status='joined'").all(loan.id);
    const insts = db.prepare('SELECT * FROM installments WHERE loan_id=? ORDER BY seq').all(loan.id);
    for (const inst of insts) {
      if (daysBetween(inst.due_date, today) <= CONFIG.graceDays) continue;
      for (const f of friends) {
        const share = shareOf(loan, f, inst.amount_cents);
        if (db.prepare("SELECT 1 FROM member_payments WHERE loan_id=? AND member_id=? AND kind='installment' AND seq=?").get(loan.id, f.id, inst.seq)) continue;
        tx(db, () => {
          const r = rails.charge({ loanId: loan.id, memberId: main.id, amountCents: share });
          if (r.status !== 'succeeded') return;
          db.prepare("INSERT INTO member_payments (loan_id,member_id,kind,seq,amount_cents,status,paid_by,created_at) VALUES (?,?,'installment',?,?,'backstopped',?,?)")
            .run(loan.id, f.id, inst.seq, share, main.id, now.toISOString());
          applyToInstallment(db, loan.id, inst.seq, share, now);
          log(db, now, loan.id, 'backstop', { member: f.id, seq: inst.seq, amountCents: share });
          charged++;
        });
      }
    }
    closeIfPaid(db, loan.id, now);
  }
  return charged;
}

// A friend pays off their remaining share early, or the main customer buys out a friend who drops out.
// The flat charge is not reduced.
export function payoffMember(ctx, loanId, memberId, { payerMemberId }) {
  const { db, now, partner } = ctx;
  return tx(db, () => {
    const loan = loanRow(db, loanId, partner);
    if (!['funded', 'defaulted'].includes(loan.status)) throw new ApiError(409, 'invalid_state', `Loan is ${loan.status}`);
    const member = db.prepare('SELECT * FROM loan_members WHERE id=? AND loan_id=?').get(memberId, loanId);
    const payer = db.prepare('SELECT * FROM loan_members WHERE id=? AND loan_id=?').get(payerMemberId, loanId);
    if (!member || member.role !== 'friend' || member.status !== 'joined') throw new ApiError(404, 'member_not_found', 'No active friend with that id');
    if (!payer || (payer.id !== member.id && payer.role !== 'main')) throw bad('invalid_payer', 'Only the friend or the main customer can pay off a share');
    let total = 0;
    for (const inst of db.prepare('SELECT * FROM installments WHERE loan_id=? ORDER BY seq').all(loanId)) {
      if (db.prepare("SELECT 1 FROM member_payments WHERE loan_id=? AND member_id=? AND kind='installment' AND seq=?").get(loanId, memberId, inst.seq)) continue;
      const share = shareOf(loan, member, inst.amount_cents);
      db.prepare("INSERT INTO member_payments (loan_id,member_id,kind,seq,amount_cents,status,paid_by,created_at) VALUES (?,?,'installment',?,?,'paid',?,?)")
        .run(loanId, memberId, inst.seq, share, payerMemberId, now.toISOString());
      applyToInstallment(db, loanId, inst.seq, share, now);
      total += share;
    }
    db.prepare("UPDATE loan_members SET status='paid_off' WHERE id=?").run(memberId);
    log(db, now, loanId, 'share_paid_off', { member: memberId, payer: payerMemberId, amountCents: total });
    closeIfPaid(db, loanId, now);
    return { paidOffCents: total, loan: null };
  });
}
