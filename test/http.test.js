import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../src/db.js';
import { seed, DEMO_PARTNER_KEY } from '../src/seed.js';
import { createApp } from '../src/app.js';
import { goodBorrower } from './helpers.js';

let server, base;
before(async () => {
  const db = openDb(':memory:');
  seed(db, new Date());
  server = createServer(createApp({ db, adminKey: 'test-admin' }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = (path, { key = DEMO_PARTNER_KEY, admin, method = 'GET', body } = {}) =>
  fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}), ...(admin ? { 'x-admin-key': admin } : {}) }, body: body && JSON.stringify(body) });

test('auth: partner and admin endpoints reject bad keys', async () => {
  assert.equal((await call('/api/v1/legs', { key: null })).status, 401);
  assert.equal((await call('/api/v1/legs', { key: 'nope' })).status, 401);
  assert.equal((await call('/api/v1/admin/portfolio', { admin: 'wrong' })).status, 401);
  assert.equal((await call('/api/v1/admin/portfolio', { admin: 'test-admin' })).status, 200);
});

test('end to end over HTTP: quote -> apply -> sign -> pay down + first autopay -> funded', async () => {
  const { legs } = await (await call('/api/v1/legs?financeable=1')).json();
  assert.ok(legs.length >= 10);
  const leg = legs[0];
  assert.equal(leg.financing.preview.installments, 13);
  const quote = await (await call('/api/v1/quotes', { method: 'POST', body: { legId: leg.id, entityType: 'llc' } })).json();
  assert.equal(quote.terms.plan.id, 'non_member');
  const app = await call('/api/v1/applications', { method: 'POST', body: { legId: leg.id, borrower: goodBorrower(), consents: { creditCheck: true } } });
  assert.equal(app.status, 201);
  const loan = await app.json();
  assert.equal(loan.status, 'approved');
  const sign = { acceptedTerms: true, signatureName: 'Jane CFO', autopay: { method: 'ach', last4: '4242' }, backupCardLast4: '1111' };
  const acc = await (await call(`/api/v1/loans/${loan.id}/accept`, { method: 'POST', body: sign })).json();
  assert.equal(acc.status, 'signed');
  assert.ok(acc.dueAtSigningCents > 0);
  assert.equal((await call(`/api/v1/loans/${loan.id}/accept`, { method: 'POST', body: sign })).status, 409);
  await call(`/api/v1/loans/${loan.id}/payments`, { method: 'POST', body: { kind: 'down_payment', idempotencyKey: 'http-down-1' } });
  const funded = await (await call(`/api/v1/loans/${loan.id}/payments`, { method: 'POST', body: { kind: 'installment', idempotencyKey: 'http-first-1' } })).json();
  assert.equal(funded.status, 'funded');
  const list = await (await call('/api/v1/loans?email=cfo@acme.test')).json();
  assert.equal(list.loans.length, 1);
});

test('members, plans and trust endpoints', async () => {
  assert.equal((await (await call('/api/v1/plans', { key: null })).json()).plans.length, 5);
  const j = await call('/api/v1/members/join', { method: 'POST', body: { email: 'vip@x.test', planId: 'elite' } });
  assert.equal(j.status, 201);
  assert.equal((await j.json()).tripCreditCents, 500_000);
  assert.equal((await (await call('/api/v1/members/vip%40x.test')).json()).plan, 'elite');
  assert.equal((await call('/api/v1/admin/trust?bankBalanceCents=500000', { admin: 'test-admin' })).status, 200);
  assert.equal((await call('/api/v1/admin/trust', { admin: 'nope' })).status, 401);
  const leg = await call('/api/v1/admin/legs', { method: 'POST', admin: 'test-admin', body: { operatorId: 'op_demo1', originCode: 'DAL', originCity: 'Dallas', destCode: 'HOU', destCity: 'Houston', aircraft: 'CJ3', operatorPriceCents: 800000, durationMin: 50, departsAt: new Date(Date.now() + 3 * 86400000).toISOString(), window: 'Afternoon' } });
  assert.equal(leg.status, 201);
  assert.equal((await leg.json()).priceCents, 920000);
});

test('bad JSON and unknown routes', async () => {
  const r = await fetch(base + '/api/v1/quotes', { method: 'POST', headers: { 'x-api-key': DEMO_PARTNER_KEY }, body: '{oops' });
  assert.equal(r.status, 400);
  assert.equal((await call('/api/v1/nothing')).status, 404);
  assert.equal((await fetch(base + '/../package.json')).status, 404);
});
