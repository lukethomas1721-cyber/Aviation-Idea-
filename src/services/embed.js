import { createHash, randomBytes } from 'node:crypto';
import { CONFIG } from '../config.js';
import { ApiError, bad } from '../errors.js';
import { loadLeg, loanRow } from './shared.js';
import { joinGroup } from './group.js';

// Embedded checkout (the "plug-in"). The partner's BACKEND creates a session with its secret API key and hands the
// customer's browser only the short-lived session token. A token can touch exactly one flight and the one loan created
// through it; it cannot list other loans, read other customers, or (outside demo mode) record payments.
const MAX_SESSION_HOURS = 4;
const hash = (t) => createHash('sha256').update(t).digest('hex');

export function createSession(ctx, { legId, email }) {
  const { db, now, partner } = ctx;
  if (typeof legId !== 'string') throw bad('invalid_leg', 'legId is required');
  loadLeg(db, legId); // 404s if unknown
  if (email !== undefined && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('invalid_email', 'email must be a valid address');
  const token = `jrs_${randomBytes(24).toString('hex')}`;
  const expiresAt = new Date(now.getTime() + CONFIG.sessionMinutes * 60000).toISOString();
  db.prepare('INSERT INTO checkout_sessions (token_hash,partner_id,leg_id,email,expires_at,created_at) VALUES (?,?,?,?,?,?)')
    .run(hash(token), partner.id, legId, email?.toLowerCase() ?? null, expiresAt, now.toISOString());
  return { token, expiresAt, embedUrl: `${ctx.origin}/embed.html?token=${token}` };
}

// Resolves and slides the session (capped), or returns null.
export function resolveSession(db, now, token) {
  if (typeof token !== 'string' || !token.startsWith('jrs_')) return null;
  const s = db.prepare('SELECT * FROM checkout_sessions WHERE token_hash=?').get(hash(token));
  if (!s || s.expires_at <= now.toISOString()) return null;
  const cap = Date.parse(s.created_at) + MAX_SESSION_HOURS * 3600000;
  const next = new Date(Math.min(cap, now.getTime() + CONFIG.sessionMinutes * 60000)).toISOString();
  db.prepare('UPDATE checkout_sessions SET expires_at=? WHERE token_hash=?').run(next, s.token_hash);
  return { ...s, expires_at: next };
}

export const setSessionLoan = (db, session, loanId) =>
  db.prepare('UPDATE checkout_sessions SET loan_id=? WHERE token_hash=?').run(loanId, session.token_hash);

export function sessionLoanId(session) {
  if (!session.loan_id) throw new ApiError(404, 'no_loan', 'No application has been started in this session');
  return session.loan_id;
}

export function frameAncestors(db, token, now) {
  const s = token ? resolveSession(db, now, token) : null;
  if (!s) return "'none'";
  const p = db.prepare('SELECT allowed_origins FROM partners WHERE id=?').get(s.partner_id);
  return ["'self'", ...String(p?.allowed_origins ?? '').split(',').map((o) => o.trim()).filter((o) => /^https?:\/\/[^\s;,'"]+$/.test(o))].join(' ');
}

// ---- friend invite pages (public; the unguessable invite token is the credential) ----
export function inviteInfo(db, token) {
  const m = db.prepare('SELECT * FROM loan_members WHERE invite_token=?').get(String(token));
  if (!m) throw new ApiError(404, 'invite_not_found', 'Invite not found');
  const loan = db.prepare('SELECT * FROM loans WHERE id=?').get(m.loan_id);
  const leg = db.prepare('SELECT * FROM legs WHERE id=?').get(loan.leg_id);
  const main = db.prepare("SELECT name FROM loan_members WHERE loan_id=? AND role='main'").get(loan.id);
  return {
    invitee: m.name, status: m.status, from: main?.name, route: `${leg.origin_city} (${leg.origin_code}) → ${leg.dest_city} (${leg.dest_code})`,
    departsAt: leg.departs_at, aircraft: leg.aircraft, open: loan.status === 'approved' && !loan.group_finalized && m.status === 'invited'
  };
}

export function joinByInvite(ctx, token, body) {
  const m = ctx.db.prepare('SELECT loan_id FROM loan_members WHERE invite_token=?').get(String(token));
  if (!m) throw new ApiError(404, 'invite_not_found', 'Invite not found');
  const loan = loanRow(ctx.db, m.loan_id);
  joinGroup({ ...ctx, partner: { id: loan.partner_id } }, token, body); // scope to the loan's own partner
  return inviteInfo(ctx.db, token);
}
