import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../src/db.js';
import { seed, DEMO_PARTNER_KEY, demoOperatorKey } from '../src/seed.js';
import { createApp } from '../src/app.js';
import { CONFIG } from '../src/config.js';
import { goodBorrower } from './helpers.js';

let server, base, db, clockMs;
before(async () => {
  db = openDb(':memory:');
  seed(db, new Date());
  clockMs = Date.now();
  server = createServer(createApp({ db, adminKey: 'test-admin', now: () => new Date(clockMs) }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const j = (path, { method = 'GET', body, headers = {} } = {}) =>
  fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
const partner = (path, o = {}) => j(path, { ...o, headers: { 'x-api-key': DEMO_PARTNER_KEY, ...o.headers } });
const embed = (token, path, o = {}) => j('/api/v1/embed' + path, { ...o, headers: { 'x-session-token': token, ...o.headers } });
const legs = async () => (await (await partner('/api/v1/legs?financeable=1')).json()).legs;
const session = async (legId, email) => (await (await partner('/api/v1/checkout-sessions', { method: 'POST', body: { legId, email } })).json());
const sign = { acceptedTerms: true, signatureName: 'Jane Flyer', autopay: { method: 'ach', last4: '4242' }, backupCardLast4: '1111' };

test('partner backend mints a session; the browser only ever uses the token', async () => {
  const [leg] = await legs();
  const r = await partner('/api/v1/checkout-sessions', { method: 'POST', body: { legId: leg.id } });
  assert.equal(r.status, 201);
  const s = await r.json();
  assert.match(s.token, /^jrs_[0-9a-f]{48}$/);
  assert.equal(s.embedUrl, `${base}/embed.html?token=${s.token}`);
  const meta = await (await embed(s.token, '/session')).json();
  assert.equal(meta.leg.id, leg.id);
  assert.equal(meta.demoPay, true);
  assert.equal((await partner('/api/v1/checkout-sessions', { method: 'POST', body: { legId: 'nope' } })).status, 404);
  assert.equal((await j('/api/v1/checkout-sessions', { method: 'POST', body: { legId: leg.id } })).status, 401); // needs the secret key
});

test('credentials are not interchangeable: partner key is not a session token and vice versa', async () => {
  const [leg] = await legs();
  const { token } = await session(leg.id);
  assert.equal((await embed(DEMO_PARTNER_KEY, '/session')).status, 401);
  assert.equal((await embed('jrs_' + '0'.repeat(48), '/session')).status, 401);
  assert.equal((await j('/api/v1/legs', { headers: { 'x-api-key': token } })).status, 401);
  assert.equal((await j('/api/v1/loans', { headers: { 'x-session-token': token } })).status, 401);
  assert.equal((await j('/api/v1/admin/portfolio', { headers: { 'x-session-token': token } })).status, 401);
});

test('full embedded checkout: quote -> apply -> sign -> simulated processor -> funded', async () => {
  const [, leg] = await legs();
  const { token } = await session(leg.id);
  const quote = await (await embed(token, '/quote', { method: 'POST', body: { entityType: 'llc' } })).json();
  assert.equal(quote.terms.installments, 13);
  const loan = await (await embed(token, '/applications', { method: 'POST', body: { borrower: goodBorrower({ email: 'embed1@x.test' }), consents: { creditCheck: true } } })).json();
  assert.equal(loan.status, 'approved');
  assert.equal((await embed(token, '/applications', { method: 'POST', body: { borrower: goodBorrower({ email: 'embed1@x.test' }), consents: { creditCheck: true } } })).status, 409);
  assert.equal((await (await embed(token, '/loan/accept', { method: 'POST', body: sign })).json()).status, 'signed');
  await embed(token, '/demo/pay', { method: 'POST', body: { kind: 'down_payment' } });
  const funded = await (await embed(token, '/demo/pay', { method: 'POST', body: { kind: 'installment' } })).json();
  assert.equal(funded.status, 'funded');
  assert.equal((await (await embed(token, '/loan')).json()).id, loan.id);
});

test('a session can only reach its own flight and loan', async () => {
  const [a, b] = await legs();
  const s1 = await session(a.id), s2 = await session(b.id);
  await embed(s1.token, '/applications', { method: 'POST', body: { borrower: goodBorrower({ email: 'own1@x.test' }), consents: { creditCheck: true } } });
  assert.equal((await embed(s2.token, '/loan')).status, 404);                          // s2 has no loan, and cannot name s1's
  const l2 = await (await embed(s2.token, '/applications', { method: 'POST', body: { borrower: goodBorrower({ email: 'own2@x.test' }), consents: { creditCheck: true } } })).json();
  assert.equal(l2.trip.legId, b.id);                                                   // flight comes from the session, not the request
  const sneaky = await embed(s2.token, '/applications', { method: 'POST', body: { legId: a.id, borrower: goodBorrower({ email: 'own3@x.test' }), consents: { creditCheck: true } } });
  assert.equal(sneaky.status, 409);
});

test('in production (demo mode off) the browser cannot confirm payments', async () => {
  const [leg] = (await legs()).slice(-1);
  const { token } = await session(leg.id);
  await embed(token, '/applications', { method: 'POST', body: { borrower: goodBorrower({ email: 'prod@x.test' }), consents: { creditCheck: true } } });
  await embed(token, '/loan/accept', { method: 'POST', body: sign });
  CONFIG.demoMode = false;
  try {
    assert.equal((await embed(token, '/demo/pay', { method: 'POST', body: { kind: 'down_payment' } })).status, 404);
    assert.equal((await embed(token, '/demo/join', { method: 'POST', body: { token: 'x' } })).status, 404);
    assert.equal((await j('/api/v1/demo/legs')).status, 404);
    assert.equal((await j('/api/v1/demo/session', { method: 'POST', body: { legId: leg.id } })).status, 404);
    assert.equal((await (await embed(token, '/session')).json()).demoPay, false);
  } finally { CONFIG.demoMode = true; }
});

test('sessions expire (sliding window, capped)', async () => {
  const [leg] = await legs();
  const { token } = await session(leg.id);
  clockMs += 20 * 60000;                                                               // activity inside the window slides it forward
  assert.equal((await embed(token, '/session')).status, 200);
  clockMs += 20 * 60000;
  assert.equal((await embed(token, '/session')).status, 200);
  clockMs += 31 * 60000;                                                               // idle past the window
  const r = await embed(token, '/session');
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.code, 'session_expired');
  clockMs += 0;
});

test('embed.html may only be framed by the partner\'s registered origins', async () => {
  db.prepare("UPDATE partners SET allowed_origins='https://charter.example, https://evil.example;script'").run();
  const [leg] = await legs();
  const { token } = await session(leg.id);
  const withToken = await fetch(`${base}/embed.html?token=${token}`);
  assert.equal(withToken.status, 200);
  const csp = withToken.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'self' https:\/\/charter\.example(;|$)/);
  assert.ok(!csp.includes('evil.example'), 'malformed origins are dropped');
  assert.match((await fetch(`${base}/embed.html`)).headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match((await fetch(`${base}/`)).headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match((await fetch(`${base}/`)).headers.get('content-security-policy'), /default-src 'self'/);
});

test('friend invite links: public info + join, scoped to the loan\'s own partner', async () => {
  const [, , leg] = await legs();
  const { token } = await session(leg.id);
  const loan = await (await embed(token, '/applications', { method: 'POST', body: { borrower: goodBorrower({ email: 'grp@x.test', legalName: 'Pat Organizer' }), consents: { creditCheck: true } } })).json();
  const g = await (await embed(token, '/loan/group', { method: 'POST', body: { friends: [{ name: 'Ann Lee', email: 'ann@x.test' }] } })).json();
  const invite = g.members.find((m) => m.role === 'friend').inviteToken;
  const info = await (await j(`/api/v1/join/${invite}`)).json();
  assert.equal(info.from, 'Pat Organizer');
  assert.equal(info.open, true);
  assert.equal(JSON.stringify(info).includes('x.test'), false, 'no one\'s email address leaks through the public invite page');
  assert.equal((await j(`/api/v1/join/${invite}`, { method: 'POST', body: { idVerified: true } })).status, 422);       // autopay required
  const joined = await j(`/api/v1/join/${invite}`, { method: 'POST', body: { idVerified: true, autopay: { method: 'card', last4: '1234' } } });
  assert.equal(joined.status, 200);
  assert.equal((await joined.json()).status, 'joined');
  assert.equal((await j('/api/v1/join/doesnotexist')).status, 404);
  const fin = await (await embed(token, '/loan/group/finalize', { method: 'POST', body: {} })).json();
  assert.equal(fin.finalized, true);
  assert.equal(fin.payers, 2);
  assert.equal(loan.status, 'approved');
});

test('operator upload over HTTP returns the flight-specific offers; bad keys are rejected', async () => {
  const body = { originCode: 'DAL', originCity: 'Dallas', destCode: 'HOU', destCity: 'Houston', aircraft: 'CJ3', window: 'Afternoon', priceCents: 900000, durationMin: 50, departsAt: new Date(Date.now() + 2 * 86400000).toISOString() };
  const ok = await j('/api/v1/operator/legs', { method: 'POST', body, headers: { 'x-operator-key': demoOperatorKey(1) } });
  assert.equal(ok.status, 201);
  const out = await ok.json();
  assert.equal(out.financingOffers[0].plan, 'non_member');
  assert.equal((await j('/api/v1/operator/legs', { method: 'POST', body, headers: { 'x-operator-key': 'nope' } })).status, 401);
  assert.equal((await j('/api/v1/operator/legs', { method: 'POST', body, headers: { 'x-api-key': DEMO_PARTNER_KEY } })).status, 401);
});

test('admin servicing endpoints are admin-only', async () => {
  for (const p of ['/api/v1/admin/credit-reporting', '/api/v1/admin/economics', '/api/v1/admin/market']) {
    assert.equal((await j(p)).status, 401);
    assert.equal((await j(p, { headers: { 'x-admin-key': 'test-admin' } })).status, 200);
  }
  const e = await (await j('/api/v1/admin/economics?priceCents=4000000&plan=non_member&termMonths=3', { headers: { 'x-admin-key': 'test-admin' } })).json();
  assert.equal(e.jetreserveEarnsCents, 1_300_000);
});
