import { timingSafeEqual, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { ApiError } from './errors.js';
import { hashKey } from './seed.js';
import { mockRails } from './rails.js';
import { mockNotifier } from './notify.js';
import { mockPartnerLender } from './lenders.js';
import * as svc from './services/loans.js';
import * as servicing from './services/servicing.js';
import * as members from './services/members.js';
import * as group from './services/group.js';
import * as embed from './services/embed.js';
import { CONFIG } from './config.js';
import { PLANS } from './plans.js';
import { unitEconomics, marketModel } from './economics.js';
import { ApiError as AE } from './errors.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const PUBLIC_DIR = resolve(new URL('../public', import.meta.url).pathname);

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Public origin used to build embed URLs. Set PUBLIC_URL in production; otherwise derive it from the request.
const originOf = (req) => process.env.PUBLIC_URL?.replace(/\/$/, '') ?? `${req.headers['x-forwarded-proto'] ?? 'http'}://${req.headers.host}`;

// Small in-memory fixed-window limiter (per client IP) for the token-authenticated and public endpoints.
const hits = new Map();
const LIMIT = Number(process.env.RATE_LIMIT_PER_MIN ?? 240);
function limit(req) {
  // Behind one trusted proxy (Render) the LAST x-forwarded-for entry is the one the proxy appended; earlier ones are client-supplied.
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',').pop().trim();
  const minute = Math.floor(Date.now() / 60000);
  const h = hits.get(ip);
  if (!h || h.minute !== minute) { if (hits.size > 10_000) hits.clear(); hits.set(ip, { minute, n: 1 }); return; }
  if (++h.n > LIMIT) throw new ApiError(429, 'rate_limited', 'Too many requests');
}

// createApp returns a plain (req,res) handler; db/clock/rails are injectable for tests.
export function createApp({ db, now = () => new Date(), rails = mockRails, notify = mockNotifier, lenders = mockPartnerLender, adminKey }) {
  const routes = [];
  const route = (method, pattern, auth, fn) =>
    routes.push({ method, auth, fn, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') });

  // public
  route('GET', '/api/v1/health', null, () => ({ ok: true }));
  route('GET', '/api/v1/plans', null, () => ({ plans: Object.values(PLANS) }));
  // partner (the charter site / marketplace, server-to-server)
  route('GET', '/api/v1/legs', 'partner', (c) => ({ legs: svc.listLegs(c.db, c.partner, c.now, { origin: c.query.get('origin'), dest: c.query.get('dest'), financeableOnly: c.query.get('financeable') === '1', email: c.query.get('email') }) }));
  route('POST', '/api/v1/quotes', 'partner', (c) => svc.createQuote(c, c.body));
  route('POST', '/api/v1/applications', 'partner', (c) => ({ status: 201, body: svc.applyForLoan(c, c.body) }));
  route('GET', '/api/v1/loans', 'partner', (c) => ({ loans: svc.listLoans(c, { email: c.query.get('email'), status: c.query.get('status') }) }));
  route('GET', '/api/v1/loans/:id', 'partner', (c) => svc.getLoan(c, c.params.id));
  route('POST', '/api/v1/loans/:id/accept', 'partner', (c) => svc.acceptLoan(c, c.params.id, c.body));
  route('POST', '/api/v1/loans/:id/cancel', 'partner', (c) => svc.cancelLoan(c, c.params.id));
  route('POST', '/api/v1/loans/:id/payments', 'partner', (c) => svc.recordPayment(c, c.params.id, c.body));
  route('GET', '/api/v1/loans/:id/payoff', 'partner', (c) => servicing.payoffQuote(c, c.params.id));
  route('POST', '/api/v1/loans/:id/payoff', 'partner', (c) => { const r = servicing.payoffLoan(c, c.params.id, c.body); return { ...r, loan: svc.getLoan(c, c.params.id) }; });
  // group pay
  route('POST', '/api/v1/loans/:id/group', 'partner', (c) => ({ status: 201, body: group.createGroup(c, c.params.id, c.body) }));
  route('POST', '/api/v1/loans/:id/group/finalize', 'partner', (c) => group.finalizeGroup(c, c.params.id, c.body));
  route('POST', '/api/v1/group/join/:token', 'partner', (c) => group.joinGroup(c, c.params.token, c.body));
  route('POST', '/api/v1/loans/:id/group/members/:mid/payoff', 'partner', (c) => { group.payoffMember(c, c.params.id, c.params.mid, c.body); return svc.getLoan(c, c.params.id); });
  // members (Access / Elite memberships, deposit holders)
  route('POST', '/api/v1/members/join', 'partner', (c) => ({ status: 201, body: members.joinMembership(c, c.body) }));
  route('POST', '/api/v1/members/renew', 'partner', (c) => members.renewMembership(c, c.body));
  route('POST', '/api/v1/members/deposit', 'partner', (c) => ({ status: 201, body: members.depositFunds(c, c.body) }));
  route('GET', '/api/v1/members/:email', 'partner', (c) => members.memberView(c, decodeURIComponent(c.params.email)));
  // embedded checkout (the plug-in): the partner's backend mints a short-lived session token
  route('POST', '/api/v1/checkout-sessions', 'partner', (c) => ({ status: 201, body: embed.createSession(c, c.body) }));
  route('GET', '/api/v1/embed/session', 'session', (c) => {
    const leg = svc.listLegs(c.db, c.partner, c.now, { email: c.session.email }).find((l) => l.id === c.session.leg_id);
    return { leg, partner: { name: c.partner.name }, email: c.session.email, demoPay: CONFIG.demoMode, loanId: c.session.loan_id };
  });
  route('POST', '/api/v1/embed/quote', 'session', (c) => svc.createQuote(c, { legId: c.session.leg_id, email: c.session.email ?? undefined, termMonths: c.body.termMonths, entityType: c.body.entityType }));
  route('POST', '/api/v1/embed/applications', 'session', (c) => {
    if (c.session.loan_id && ['approved', 'pending_review', 'signed', 'funded'].includes(db.prepare('SELECT status FROM loans WHERE id=?').get(c.session.loan_id)?.status)) {
      throw new ApiError(409, 'session_has_loan', 'An application is already in progress in this session');
    }
    const loan = svc.applyForLoan(c, { legId: c.session.leg_id, termMonths: c.body.termMonths, borrower: c.body.borrower, consents: c.body.consents });
    embed.setSessionLoan(db, c.session, loan.id);
    return { status: 201, body: loan };
  });
  route('GET', '/api/v1/embed/loan', 'session', (c) => svc.getLoan(c, embed.sessionLoanId(c.session)));
  route('POST', '/api/v1/embed/loan/accept', 'session', (c) => svc.acceptLoan(c, embed.sessionLoanId(c.session), c.body));
  route('POST', '/api/v1/embed/loan/cancel', 'session', (c) => svc.cancelLoan(c, embed.sessionLoanId(c.session)));
  route('POST', '/api/v1/embed/loan/group', 'session', (c) => ({ status: 201, body: group.createGroup(c, embed.sessionLoanId(c.session), c.body) }));
  route('POST', '/api/v1/embed/loan/group/finalize', 'session', (c) => group.finalizeGroup(c, embed.sessionLoanId(c.session), c.body));
  // Simulated processor confirmations. Only exist in demo mode: in production, payments are confirmed by the processor, never the browser.
  route('POST', '/api/v1/embed/demo/pay', 'session', (c) => {
    if (!CONFIG.demoMode) throw new ApiError(404, 'not_found', 'No such route');
    return svc.recordPayment(c, embed.sessionLoanId(c.session), { kind: c.body.kind, memberId: c.body.memberId, idempotencyKey: `demo-${randomBytes(8).toString('hex')}` });
  });
  route('POST', '/api/v1/embed/demo/join', 'session', (c) => {
    if (!CONFIG.demoMode) throw new ApiError(404, 'not_found', 'No such route');
    embed.joinByInvite(c, c.body.token, { idVerified: true, autopay: { method: 'card', last4: '5555' } });
    return svc.getLoan(c, embed.sessionLoanId(c.session));
  });
  // friend invite pages
  route('GET', '/api/v1/join/:token', null, (c) => embed.inviteInfo(db, c.params.token));
  route('POST', '/api/v1/join/:token', null, (c) => embed.joinByInvite(c, c.params.token, c.body));
  // demo "partner backend" so the sample charter site works without a separate server (demo mode only)
  route('GET', '/api/v1/demo/legs', null, (c) => {
    if (!CONFIG.demoMode) throw new ApiError(404, 'not_found', 'No such route');
    return { legs: svc.listLegs(db, db.prepare("SELECT * FROM partners WHERE id='ptr_demo'").get(), c.now, {}) };
  });
  route('POST', '/api/v1/demo/session', null, (c) => {
    if (!CONFIG.demoMode) throw new ApiError(404, 'not_found', 'No such route');
    return { status: 201, body: embed.createSession({ ...c, partner: db.prepare("SELECT * FROM partners WHERE id='ptr_demo'").get() }, c.body) };
  });
  // operators (Part 135 certificate holders) list legs; each becomes a flight-specific financing offer
  route('POST', '/api/v1/operator/legs', 'operator', (c) => ({ status: 201, body: svc.createOperatorLeg(c, c.operator, c.body) }));
  // lender back office
  route('GET', '/api/v1/admin/portfolio', 'admin', (c) => svc.portfolio(c));
  route('GET', '/api/v1/admin/loans', 'admin', (c) => ({ loans: svc.listLoans(c, { status: c.query.get('status'), email: c.query.get('email'), admin: true }) }));
  route('POST', '/api/v1/admin/loans/:id/review', 'admin', (c) => svc.reviewLoan(c, c.params.id, c.body));
  route('POST', '/api/v1/admin/loans/:id/payments', 'admin', (c) => {
    const loan = db.prepare('SELECT partner_id FROM loans WHERE id=?').get(c.params.id);
    if (!loan) throw new AE(404, 'loan_not_found', 'Loan not found');
    return svc.recordPayment({ ...c, partner: { id: loan.partner_id } }, c.params.id, c.body);
  });
  route('POST', '/api/v1/admin/loans/:id/collections', 'admin', (c) => servicing.collectionsAction(c, c.params.id, c.body));
  route('GET', '/api/v1/admin/credit-reporting', 'admin', (c) => servicing.creditReporting(c));
  route('GET', '/api/v1/admin/economics', 'admin', (c) => {
    const planId = c.query.get('plan') ?? 'non_member';
    if (!PLANS[planId]) throw new ApiError(422, 'unknown_plan', 'Unknown plan');
    const price = Number(c.query.get('priceCents') ?? 4_000_000);
    if (!Number.isInteger(price) || price <= 0) throw new ApiError(422, 'invalid_price', 'priceCents must be a positive integer');
    return unitEconomics({ priceCents: price, planId, termMonths: c.query.get('termMonths') ? Number(c.query.get('termMonths')) : undefined, brokerMarginBps: c.query.get('brokerMarginBps') ? Number(c.query.get('brokerMarginBps')) : undefined, now: c.now });
  });
  route('GET', '/api/v1/admin/market', 'admin', () => marketModel());
  route('POST', '/api/v1/admin/sweep', 'admin', (c) => svc.sweep(c));
  route('POST', '/api/v1/admin/legs', 'admin', (c) => ({ status: 201, body: svc.createMarketplaceLeg(c, c.body) }));
  route('GET', '/api/v1/admin/trust', 'admin', (c) => members.trustReconciliation(c, c.query.get('bankBalanceCents') === null ? undefined : Number(c.query.get('bankBalanceCents'))));

  function authOperator(req) {
    const key = req.headers['x-operator-key'];
    if (!key) throw new ApiError(401, 'unauthorized', 'Missing x-operator-key');
    const o = db.prepare('SELECT * FROM operators WHERE api_key_hash=? AND active=1 AND cert_verified=1').get(hashKey(String(key)));
    if (!o) throw new ApiError(401, 'unauthorized', 'Invalid operator key');
    return o;
  }

  function authSession(req, ctx) {
    const s = embed.resolveSession(db, ctx.now, req.headers['x-session-token']);
    if (!s) throw new ApiError(401, 'session_expired', 'Checkout session is missing or expired');
    ctx.session = s;
    ctx.partner = db.prepare('SELECT * FROM partners WHERE id=? AND active=1').get(s.partner_id);
    if (!ctx.partner) throw new ApiError(401, 'unauthorized', 'Partner is inactive');
  }

  function authPartner(req) {
    const key = req.headers['x-api-key'];
    if (!key) throw new ApiError(401, 'unauthorized', 'Missing x-api-key');
    const p = db.prepare('SELECT * FROM partners WHERE api_key_hash=? AND active=1').get(hashKey(String(key)));
    if (!p) throw new ApiError(401, 'unauthorized', 'Invalid API key');
    return p;
  }

  async function readJson(req) {
    const chunks = []; let size = 0;
    for await (const ch of req) {
      size += ch.length;
      if (size > 100_000) throw new ApiError(413, 'payload_too_large', 'Body too large');
      chunks.push(ch);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError(400, 'invalid_json', 'Body must be valid JSON'); }
  }

  async function serveStatic(pathname, res, url) {
    const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^([/\\])+/, '');
    const file = join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + '/') || !MIME[extname(file)]) return false;
    try {
      const data = await readFile(file);
      // The embedded checkout may be framed only by the origins its partner registered; everything else cannot be framed.
      const ancestors = pathname === '/embed.html' ? embed.frameAncestors(db, url.searchParams.get('token'), now()) : "'none'";
      res.writeHead(200, {
        'content-type': MIME[extname(file)], 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        'content-security-policy': `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors ${ancestors}`
      });
      res.end(data);
      return true;
    } catch { return false; }
  }

  return async function handler(req, res) {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, 'http://x');
      if (!url.pathname.startsWith('/api/')) {
        if (req.method === 'GET' && (await serveStatic(url.pathname, res, url))) return;
        return send(404, { error: { code: 'not_found', message: 'Not found' } });
      }
      const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!match) {
        const pathExists = routes.some((r) => r.re.test(url.pathname));
        return send(pathExists ? 405 : 404, { error: { code: pathExists ? 'method_not_allowed' : 'not_found', message: 'No such route' } });
      }
      const ctx = { db, now: now(), rails, notify, lenders, origin: originOf(req), query: url.searchParams, params: url.pathname.match(match.re).groups ?? {}, partner: null, body: {} };
      limit(req); // before auth, so repeated bad credentials are throttled too
      if (match.auth === 'partner') ctx.partner = authPartner(req);
      if (match.auth === 'operator') ctx.operator = authOperator(req);
      if (match.auth === 'session') authSession(req, ctx);
      if (match.auth === 'admin' && !(adminKey && safeEqual(req.headers['x-admin-key'] ?? '', adminKey))) throw new ApiError(401, 'unauthorized', 'Invalid admin key');
      if (req.method === 'POST') ctx.body = await readJson(req);
      const out = match.fn(ctx);
      if (out && out.status && out.body) return send(out.status, out.body);
      send(200, out);
    } catch (e) {
      if (e instanceof ApiError) return send(e.status, { error: { code: e.code, message: e.message, details: e.details } });
      console.error(e);
      send(500, { error: { code: 'internal_error', message: 'Internal error' } });
    }
  };
}
