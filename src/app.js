import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { ApiError } from './errors.js';
import { hashKey } from './seed.js';
import { mockRails } from './rails.js';
import * as svc from './services/loans.js';
import * as members from './services/members.js';
import * as group from './services/group.js';
import { PLANS } from './plans.js';
import { ApiError as AE } from './errors.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const PUBLIC_DIR = resolve(new URL('../public', import.meta.url).pathname);

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// createApp returns a plain (req,res) handler; db/clock/rails are injectable for tests.
export function createApp({ db, now = () => new Date(), rails = mockRails, adminKey }) {
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
  // lender back office
  route('GET', '/api/v1/admin/portfolio', 'admin', (c) => svc.portfolio(c));
  route('GET', '/api/v1/admin/loans', 'admin', (c) => ({ loans: svc.listLoans(c, { status: c.query.get('status'), email: c.query.get('email'), admin: true }) }));
  route('POST', '/api/v1/admin/loans/:id/review', 'admin', (c) => svc.reviewLoan(c, c.params.id, c.body));
  route('POST', '/api/v1/admin/loans/:id/payments', 'admin', (c) => {
    const loan = db.prepare('SELECT partner_id FROM loans WHERE id=?').get(c.params.id);
    if (!loan) throw new AE(404, 'loan_not_found', 'Loan not found');
    return svc.recordPayment({ ...c, partner: { id: loan.partner_id } }, c.params.id, c.body);
  });
  route('POST', '/api/v1/admin/sweep', 'admin', (c) => svc.sweep(c));
  route('POST', '/api/v1/admin/legs', 'admin', (c) => ({ status: 201, body: svc.createMarketplaceLeg(c, c.body) }));
  route('GET', '/api/v1/admin/trust', 'admin', (c) => members.trustReconciliation(c, c.query.get('bankBalanceCents') === null ? undefined : Number(c.query.get('bankBalanceCents'))));

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

  async function serveStatic(pathname, res) {
    const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^([/\\])+/, '');
    const file = join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + '/') || !MIME[extname(file)]) return false;
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)], 'x-content-type-options': 'nosniff' });
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
        if (req.method === 'GET' && (await serveStatic(url.pathname, res))) return;
        return send(404, { error: { code: 'not_found', message: 'Not found' } });
      }
      const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!match) {
        const pathExists = routes.some((r) => r.re.test(url.pathname));
        return send(pathExists ? 405 : 404, { error: { code: pathExists ? 'method_not_allowed' : 'not_found', message: 'No such route' } });
      }
      const ctx = { db, now: now(), rails, query: url.searchParams, params: url.pathname.match(match.re).groups ?? {}, partner: null, body: {} };
      if (match.auth === 'partner') ctx.partner = authPartner(req);
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
