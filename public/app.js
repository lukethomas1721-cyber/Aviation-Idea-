// Demo UI. In production the licensed charter site calls the JetReserve API from its backend (or uses the embedded
// plug-in, see widget.js); the partner key below is a public demo key and must never ship in a real browser bundle.
import { esc, usd, usd0, pct, dur, when, uid, scheduleTable } from './lib.js';
import { createCheckout } from './checkout.js';

const PARTNER_KEY = 'demo_partner_key';
const $ = (s, r = document) => r.querySelector(s);
const REASON = { per_seat_or_member_flight: 'Per-seat / members-only', leg_held: 'Offer pending', leg_locked: 'Booking in progress', leg_booked: 'Booked', departure_too_soon: 'Departs too soon', operator_not_verified: 'Operator not verified', leg_type_not_financeable: 'Not yet financeable' };

async function api(path, { method = 'GET', body, admin } = {}) {
  const r = await fetch('/api/v1' + path, {
    method, headers: { 'content-type': 'application/json', ...(admin ? { 'x-admin-key': admin } : { 'x-api-key': PARTNER_KEY }) },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error?.message || 'Request failed'), { code: j.error?.code, details: j.error?.details });
  return j;
}
const post = (path, body, admin) => api(path, { method: 'POST', body: body ?? {}, admin });
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3500); }
const modal = (html) => { $('#modalBody').innerHTML = html; $('#modal').hidden = false; };
const closeModal = () => ($('#modal').hidden = true);
$('#closeModal').onclick = closeModal;
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };

document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('main > section').forEach((s) => (s.hidden = s.id !== b.dataset.tab));
  if (b.dataset.tab === 'market') loadLegs();
  if (b.dataset.tab === 'member') loadPlans();
}));

// ---- marketplace
let LEGS = [], ME = '';
const checkout = createCheckout({
  email: () => ME,
  ui: { modal, close: closeModal, toast, changed: () => loadLegs() },
  client: {
    quote: ({ legId, termMonths, entityType }) => post('/quotes', { legId, email: ME || undefined, termMonths, entityType }),
    apply: ({ legId, termMonths, borrower }) => post('/applications', { legId, termMonths, borrower, consents: { creditCheck: true } }),
    getLoan: (id) => api('/loans/' + id),
    accept: (id, body) => post(`/loans/${id}/accept`, body),
    cancel: (id) => post(`/loans/${id}/cancel`),
    createGroup: (id, friends) => post(`/loans/${id}/group`, { friends }),
    finalize: (id, mode) => post(`/loans/${id}/group/finalize`, { mode }),
    simulateJoin: (token) => post(`/group/join/${token}`, { idVerified: true, autopay: { method: 'card', last4: '5555' } }),
    pay: (id, body) => post(`/loans/${id}/payments`, { ...body, idempotencyKey: uid() })
  }
});
$('#meBtn').onclick = () => { ME = $('#meEmail').value.trim().toLowerCase(); loadLegs(); };
async function loadLegs() {
  try { LEGS = (await api('/legs' + (ME ? '?email=' + encodeURIComponent(ME) : ''))).legs; renderLegs(); }
  catch (e) { $('#legs').innerHTML = `<p class="callout bad">${esc(e.message)}</p>`; }
}
function renderLegs() {
  const q = $('#routeFilter').value.trim().toLowerCase(), fin = $('#finOnly').checked;
  const list = LEGS.filter((l) => (!fin || l.financing.financeable) &&
    (!q || [l.origin.code, l.origin.city, l.destination.code, l.destination.city].some((x) => x.toLowerCase().includes(q))));
  $('#legs').innerHTML = list.map((l) => {
    const f = l.financing, p = f.preview;
    const aircraft = l.pricedPerSeat ? 'MEMBERS ONLY · Priced per seat' : `${esc(l.aircraft)}<br>${l.seats} seats · ${esc(l.category)}${l.altAircraft ? ` · +${l.altAircraft}` : ''}`;
    return `<div class="card">
      <div class="route"><span>${esc(l.origin.code)}<br><span class="city">${esc(l.origin.city)}</span></span><span class="arrow">→</span><span>${esc(l.destination.code)}<br><span class="city">${esc(l.destination.city)}</span></span></div>
      <div class="sub">${dur(l.durationMin)} flight · ${esc(l.window)}</div><div class="sub">${aircraft}</div>
      <div class="price">${usd0(l.priceCents)} <span class="sub">${l.pricedPerSeat ? 'per seat' : 'USD'}</span></div>
      <div class="sub">Available ${when(l.departsAt)}</div>
      ${f.financeable ? `<div><span class="badge ok">${usd0(p.weeklyPaymentCents)}/week · ${p.installments} wks · ${esc(p.plan.name)}</span></div>
        <button class="primary" data-leg="${esc(l.id)}">Fly now, pay weekly</button>`
        : `<div><span class="badge">${esc(REASON[f.reason] || 'Not financeable')}</span></div><button class="ghost" disabled>Financing unavailable</button>`}
    </div>`;
  }).join('') || '<p class="muted">No flights match.</p>';
  document.querySelectorAll('[data-leg]').forEach((b) => (b.onclick = () => checkout.open(LEGS.find((l) => l.id === b.dataset.leg))));
}
$('#routeFilter').oninput = renderLegs; $('#finOnly').onchange = renderLegs;

// ---- membership
const PLAN_BLURB = {
  non_member: 'No cost to join · 10% down · 25% flat · 3 months',
  access: '$1,000/mo, billed $6,000 every 6 months · $2,500 trip credit with each payment · 15% flat · 3 or 5 months',
  elite: '$3,000/mo, billed $9,000 every 3 months · $5,000 trip credit with each payment · 10% flat · 3 or 5 months',
  deposit: 'Deposit $50k–$500k held in trust · credit line equal to deposit · no down payment · 5% flat · 12 months'
};
async function loadPlans() {
  const { plans } = await api('/plans');
  $('#plans').innerHTML = plans.filter((p) => PLAN_BLURB[p.id]).map((p) => `<div class="card"><div class="route">${esc(p.name)}</div><div class="sub">${esc(PLAN_BLURB[p.id])}</div>
    ${p.id === 'access' || p.id === 'elite' ? `<button class="primary" data-plan="${p.id}">Join ${esc(p.name)}</button>` : ''}
    ${p.id === 'deposit' ? `<select id="depAmt">${p.depositOptionsCents.map((c) => `<option value="${c}">${usd0(c)}</option>`).join('')}</select><button class="primary" id="depBtn">Make deposit</button>` : ''}</div>`).join('');
  const email = () => $('#memberEmail').value.trim();
  document.querySelectorAll('[data-plan]').forEach((b) => (b.onclick = async () => { try { renderMember(await post('/members/join', { email: email(), planId: b.dataset.plan })); ME = email().toLowerCase(); } catch (e) { toast(e.message); } }));
  if ($('#depBtn')) $('#depBtn').onclick = async () => { try { renderMember(await post('/members/deposit', { email: email(), amountCents: Number($('#depAmt').value) })); ME = email().toLowerCase(); } catch (e) { toast(e.message); } };
}
function renderMember(m) {
  $('#memberBody').innerHTML = !m.member ? '<p class="callout">Not a member yet — pick a plan below.</p>' : `<div class="card" style="margin:12px 0"><div class="route">${esc(m.planName)} <span class="badge ok">${esc(m.status)}</span>${m.perksFrozen ? ' <span class="badge bad">perks frozen</span>' : ''}</div>
    <div class="sub">Trip credit in trust: <b>${usd(m.tripCreditCents)}</b>${m.creditLine ? ` · Credit line: <b>${usd(m.creditLine.availableCents)}</b> available of ${usd(m.creditLine.limitCents)}` : ''}</div>
    ${m.nextBillingAt ? `<div class="sub">Next billing ${esc(m.nextBillingAt)}</div><div class="actions"><button class="ghost" id="renew">Pay next dues (demo)</button></div>` : ''}</div>`;
  if ($('#renew')) $('#renew').onclick = async () => { try { renderMember(await post('/members/renew', { email: m.email })); } catch (e) { toast(e.message); } };
}
$('#memberForm').onsubmit = async (e) => { e.preventDefault(); try { const m = await api('/members/' + encodeURIComponent($('#memberEmail').value.trim())); renderMember(m); if (m.member) ME = m.email; } catch (err) { toast(err.message); } };

// ---- my financing
$('#lookup').onsubmit = async (e) => { e.preventDefault(); loadMyLoans($('#lookupEmail').value); };
async function loadMyLoans(email) {
  try {
    const { loans } = await api('/loans?email=' + encodeURIComponent(email));
    $('#loanList').innerHTML = loans.length ? loans.map(loanCard).join('') : '<p class="muted">No financing found for that email.</p>';
    const reload = () => loadMyLoans(email);
    document.querySelectorAll('[data-pay]').forEach((b) => (b.onclick = async () => {
      try { await post(`/loans/${b.dataset.pay}/payments`, { idempotencyKey: uid() }); toast('Weekly payment recorded'); reload(); } catch (err) { toast(err.message); }
    }));
    document.querySelectorAll('[data-latefee]').forEach((b) => (b.onclick = async () => {
      try { await post(`/loans/${b.dataset.latefee}/payments`, { kind: 'late_fee', idempotencyKey: uid() }); toast('Late fee paid'); reload(); } catch (err) { toast(err.message); }
    }));
    document.querySelectorAll('[data-open]').forEach((b) => (b.onclick = async () => checkout.show(await api('/loans/' + b.dataset.open))));
    document.querySelectorAll('[data-payoff]').forEach((b) => (b.onclick = () => payoffDialog(b.dataset.payoff, reload)));
  } catch (e) { toast(e.message); }
}
async function payoffDialog(id, reload) {
  try {
    const q = await api(`/loans/${id}/payoff`);
    modal(`<h2>Pay off early</h2>
      <table><tbody>
        <tr><td>Scheduled balance (${q.installmentsRemaining} payments)</td><td class="n">${usd(q.scheduledBalanceCents)}</td></tr>
        ${q.rebateApplies ? `<tr><td>Refund of unearned charge</td><td class="n">−${usd(q.unearnedChargeRefundCents)}</td></tr>` : ''}
        ${q.lateFeesCents ? `<tr><td>Late fees</td><td class="n">${usd(q.lateFeesCents)}</td></tr>` : ''}
        <tr><td><b>Pay off today</b></td><td class="n"><b>${usd(q.payoffCents)}</b></td></tr>
      </tbody></table>
      <p class="fine">${q.rebateApplies ? 'The unearned portion of the flat charge is refunded when you pay off early.' : 'Business-purpose loans keep the full flat charge on early payoff.'} Quote as of ${esc(q.asOf)}.</p>
      <div class="actions"><button class="primary" id="doPayoff">Pay ${usd(q.payoffCents)} (demo)</button><button class="ghost" id="noPayoff">Not now</button></div>`);
    $('#noPayoff').onclick = closeModal;
    $('#doPayoff').onclick = async () => { try { await post(`/loans/${id}/payoff`, { idempotencyKey: uid(), expectedPayoffCents: q.payoffCents }); closeModal(); toast('Paid off'); reload(); } catch (err) { toast(err.message); } };
  } catch (err) { toast(err.message); }
}
const STATUS_CLASS = { funded: 'ok', paid: 'ok', approved: 'ok', signed: 'warn', pending_review: 'warn', defaulted: 'bad', declined: 'bad', charged_off: 'bad', expired: '', cancelled: '' };
function loanCard(l) {
  const open = ['funded', 'defaulted'].includes(l.status);
  const next = open ? l.schedule.find((s) => s.paidCents < s.amountCents) : null;
  return `<div class="card" style="margin-bottom:12px"><div class="route">${esc(l.trip.route)} <span class="badge ${STATUS_CLASS[l.status] || ''}">${esc(l.status.replace('_', ' '))}</span> <span class="badge">${esc(l.plan.name)}</span>${l.collectionsStage ? ` <span class="badge bad">collections: ${esc(l.collectionsStage.replace('_', ' '))}</span>` : ''}</div>
    <div class="sub">${esc(l.borrower.legalName)} · ${esc(l.trip.aircraft)} · departs ${when(l.trip.departsAt)} · ${esc(l.id)}</div>
    ${l.balanceCents !== null ? `<div class="price">${usd(l.balanceCents)} <span class="sub">remaining of ${usd(l.terms.totalRepaymentCents)}${l.daysPastDue ? ` · <span class="bad-text">${l.daysPastDue}d past due</span>` : ''}</span></div>` : ''}
    ${l.lateFeesDueCents ? `<div class="sub bad-text">Late fees due: ${usd(l.lateFeesDueCents)}</div>` : ''}
    <div class="scroll">${scheduleTable(l.schedule)}</div>
    <div class="actions">${next ? `<button class="primary" data-pay="${esc(l.id)}">Pay week ${next.seq} (${usd(next.amountCents - next.paidCents)})</button>` : ''}
    ${open ? `<button class="ghost" data-payoff="${esc(l.id)}">Pay off early</button>` : ''}
    ${l.lateFeesDueCents ? `<button class="ghost" data-latefee="${esc(l.id)}">Pay late fee</button>` : ''}
    ${['approved', 'signed'].includes(l.status) ? `<button class="ghost" data-open="${esc(l.id)}">Continue</button>` : ''}</div>
    ${next ? '<p class="fine">Demo only: records a payment without moving money. A real deployment collects via ACH/card autopay.</p>' : ''}</div>`;
}

// ---- lender portal
let ADMIN = '';
$('#adminForm').onsubmit = async (e) => { e.preventDefault(); ADMIN = $('#adminKey').value; loadAdmin(); };
async function loadAdmin() {
  try {
    const [p, { loans }, trust] = await Promise.all([api('/admin/portfolio', { admin: ADMIN }), api('/admin/loans', { admin: ADMIN }), api('/admin/trust', { admin: ADMIN })]);
    const stat = (l, v) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`;
    $('#adminBody').innerHTML = `<div class="stats">
      ${stat('Capital pool', usd0(p.capitalPoolCents))}${stat('Committed principal', usd0(p.committedPrincipalCents))}${stat('Utilization', (p.utilization * 100).toFixed(1) + '%')}
      ${stat('Originated', usd0(p.originatedCents))}${stat('Collected', usd0(p.collectedCents))}${stat('Flat-charge revenue (collected)', usd0(p.feeRevenueCollectedCents))}
      ${stat('Marketplace / broker margin', usd0(p.marketplaceMarkupCents))}${stat('Membership dues', usd0(p.membershipDuesCents))}${stat('Client trust account', usd0(p.trustAccountCents))}
      ${stat('Receivable outstanding', usd0(p.outstandingReceivableCents))}${stat('Defaulted balance', usd0(p.defaultedBalanceCents))}${stat('Charged off', usd0(p.chargedOffCents))}
      ${stat('Loss reserve (placeholder rate)', usd0(p.lossReserveCents))}${stat('Surety bond required', usd0(trust.suretyBondRequiredCents))}
      ${stat('Current / 1-30 / 31+ dpd', `${p.delinquency.current} / ${p.delinquency.d1_30} / ${p.delinquency.d31_plus}`)}</div>
      <div class="actions"><button class="ghost" id="sweepBtn">Run daily sweep</button><button class="ghost" id="crBtn">Credit-reporting extract (CSV)</button></div>
      <h3>Trust account reconciliation</h3>
      <form id="trustForm" class="row"><input id="bankBal" type="number" step="0.01" placeholder="Bank balance (USD) to reconcile against ${usd(trust.ledgerTotalCents)} ledger"><button>Reconcile</button></form><div id="trustOut" class="fine"></div>
      <h3>Unit economics calculator</h3>
      <form id="econForm" class="row"><input id="ePrice" type="number" value="40000" min="1" aria-label="Trip price USD"><select id="ePlan"><option value="non_member">Non-member</option><option value="access">Access</option><option value="elite">Elite</option><option value="deposit">Deposit</option></select><select id="eTerm"><option value="3">3 mo</option><option value="5">5 mo</option><option value="12">12 mo</option></select><button>Calculate</button></form><div id="econOut" class="fine"></div>
      <h3>Loans</h3><div class="scroll"><table><thead><tr><th>Loan</th><th>Client</th><th>Plan</th><th>Trip</th><th class="n">Financed</th><th>Tier</th><th>Status</th><th></th></tr></thead><tbody>${
        loans.map((l) => `<tr><td>${esc(l.id.slice(0, 13))}</td><td>${esc(l.borrower.legalName)}</td><td>${esc(l.plan.name)}</td><td>${esc(l.trip.route)}</td><td class="n">${usd0(l.terms.principalCents)}</td><td>${esc(l.riskTier)}</td>
          <td><span class="badge ${STATUS_CLASS[l.status] || ''}">${esc(l.status.replace('_', ' '))}</span>${l.collectionsStage ? ` <span class="badge">${esc(l.collectionsStage.replace('_', ' '))}</span>` : ''}</td>
          <td>${l.status === 'pending_review' ? `<button class="ghost" data-rv="approve" data-id="${esc(l.id)}">Approve</button> <button class="ghost" data-rv="decline" data-id="${esc(l.id)}">Decline</button>` : ''}
          ${l.status === 'defaulted' ? `<button class="ghost" data-col="refer_agency" data-id="${esc(l.id)}">Refer to agency</button> <button class="ghost" data-col="write_off" data-id="${esc(l.id)}">Charge off</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No loans yet — book a trip on the Empty Legs tab.</td></tr>'}</tbody></table></div>`;
    $('#sweepBtn').onclick = async () => { const r = await post('/admin/sweep', {}, ADMIN); toast(`Expired ${r.expired}, defaulted ${r.defaulted}, reminders ${r.reminders}, backstopped ${r.backstopped}`); loadAdmin(); };
    $('#crBtn').onclick = async () => { const r = await api('/admin/credit-reporting', { admin: ADMIN }); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' })); a.download = 'credit-reporting.csv'; a.click(); toast(r.disclaimer); };
    $('#trustForm').onsubmit = async (e) => { e.preventDefault(); const t = await api('/admin/trust?bankBalanceCents=' + Math.round(Number($('#bankBal').value) * 100), { admin: ADMIN });
      $('#trustOut').textContent = t.reconciled ? `✓ Reconciled. ${t.clientBalances.length} client balance(s) total ${usd(t.ledgerTotalCents)}.` : `✗ Difference ${usd(t.differenceCents)} (bank − ledger).`; };
    $('#econForm').onsubmit = async (e) => { e.preventDefault();
      try { const x = await api(`/admin/economics?priceCents=${Math.round(Number($('#ePrice').value) * 100)}&plan=${$('#ePlan').value}&termMonths=${$('#eTerm').value}`, { admin: ADMIN });
        $('#econOut').textContent = `Down ${usd(x.downCents)} · financed ${usd(x.financedCents)} · flat charge ${usd(x.flatChargeCents)} · weekly ${usd(x.weeklyPaymentCents)} · client pays ${usd(x.clientPaysCents)} · JetReserve earns ${usd(x.jetreserveEarnsCents)} (incl. ${usd(x.brokerMarginCents)} broker margin)`;
      } catch (err) { $('#econOut').textContent = err.message; } };
    document.querySelectorAll('[data-rv]').forEach((b) => (b.onclick = async () => {
      try { await post(`/admin/loans/${b.dataset.id}/review`, { decision: b.dataset.rv }, ADMIN); loadAdmin(); } catch (err) { toast(err.message); }
    }));
    document.querySelectorAll('[data-col]').forEach((b) => (b.onclick = async () => {
      if (b.dataset.col === 'write_off' && !confirm('Charge off this loan? This frees the capital and records the loss.')) return;
      try { await post(`/admin/loans/${b.dataset.id}/collections`, { action: b.dataset.col }, ADMIN); loadAdmin(); } catch (err) { toast(err.message); }
    }));
  } catch (e) { $('#adminBody').innerHTML = `<p class="callout bad">${esc(e.message)}</p>`; }
}

loadLegs();
