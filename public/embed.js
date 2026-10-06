// Hosted checkout opened by widget.js in an iframe on a partner's site. It holds only a short-lived session token
// (from the URL) that is scoped to one flight and one loan; it never sees the partner's API key.
import { esc } from './lib.js';
import { createCheckout } from './checkout.js';

const $ = (s) => document.querySelector(s);
const token = new URLSearchParams(location.search).get('token');
// Messages to the host page carry ids and status only, never personal data.
const tell = (msg) => window.parent !== window && window.parent.postMessage({ source: 'jetreserve', ...msg }, '*');

async function call(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api/v1/embed' + path, { method, headers: { 'content-type': 'application/json', 'x-session-token': token ?? '' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error?.message || 'Request failed'), { code: j.error?.code });
  return j;
}
const post = (path, body) => call(path, { method: 'POST', body: body ?? {} });
const toast = (msg) => { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3500); };
const modal = (html) => { $('#modalBody').innerHTML = html; };

const ui = {
  modal, toast, close: () => tell({ type: 'jetreserve:close' }),
  onLoan: (loan) => tell({ type: loan.status === 'funded' ? 'jetreserve:funded' : 'jetreserve:status', status: loan.status, loanId: loan.id })
};
const client = {
  quote: ({ termMonths, entityType }) => post('/quote', { termMonths, entityType }),
  apply: ({ termMonths, borrower }) => post('/applications', { termMonths, borrower, consents: { creditCheck: true } }),
  getLoan: () => call('/loan'),
  accept: (_id, body) => post('/loan/accept', body),
  cancel: () => post('/loan/cancel'),
  createGroup: (_id, friends) => post('/loan/group', { friends }),
  finalize: (_id, mode) => post('/loan/group/finalize', { mode }),
  simulateJoin: (invite) => post('/demo/join', { token: invite }),
  pay: (_id, body) => post('/demo/pay', body)
};

$('#closeModal').onclick = ui.close;
(async () => {
  try {
    const meta = await call('/session');
    // Simulated-payment buttons exist only when the server is in demo mode; in production the processor confirms payments.
    const checkout = createCheckout({ client, ui, demoPay: meta.demoPay, email: () => meta.email ?? '' });
    tell({ type: 'jetreserve:ready' });
    if (meta.loanId) checkout.show(await client.getLoan()); else checkout.open(meta.leg);
  } catch (e) {
    modal(`<h2>Checkout unavailable</h2><p class="callout bad">${esc(e.message)}</p><p class="muted">Close this window and try again from the listing.</p>`);
  }
})();
