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

test('end to end over HTTP', async () => {
  const { legs } = await (await call('/api/v1/legs?financeable=1')).json();
  assert.ok(legs.length >= 10);
  const leg = legs[0];
  const app = await call('/api/v1/applications', { method: 'POST', body: { legId: leg.id, borrower: goodBorrower(), consents: { creditCheck: true } } });
  assert.equal(app.status, 201);
  const loan = await app.json();
  assert.equal(loan.status, 'approved');
  const acc = await call(`/api/v1/loans/${loan.id}/accept`, { method: 'POST', body: { acceptedTerms: true, signatureName: 'Jane CFO' } });
  assert.equal((await acc.json()).status, 'funded');
  const again = await call(`/api/v1/loans/${loan.id}/accept`, { method: 'POST', body: { acceptedTerms: true, signatureName: 'Jane CFO' } });
  assert.equal(again.status, 409);
  const list = await (await call('/api/v1/loans?email=cfo@acme.test')).json();
  assert.equal(list.loans.length, 1);
});

test('bad JSON and unknown routes', async () => {
  const r = await fetch(base + '/api/v1/quotes', { method: 'POST', headers: { 'x-api-key': DEMO_PARTNER_KEY }, body: '{oops' });
  assert.equal(r.status, 400);
  assert.equal((await call('/api/v1/nothing')).status, 404);
  assert.equal((await fetch(base + '/../package.json')).status, 404);
});
