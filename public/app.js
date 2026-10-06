// Demo marketplace UI. In production the licensed charter site calls the SkyFinance API from its
// backend; the partner key below is a public demo key and must never ship in a real browser bundle.
const PARTNER_KEY = 'demo_partner_key';
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0 = (c) => '$' + Math.round(c / 100).toLocaleString('en-US');
const pct = (x) => (x * 100).toFixed(1) + '%';
const dur = (m) => (m >= 60 ? Math.floor(m / 60) + 'h ' : '') + (m % 60 ? (m % 60) + 'm' : '').trim();
const when = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const REASON = { per_seat_or_member_flight: 'Per-seat / members-only', leg_held: 'Offer pending', leg_booked: 'Booked', departure_too_soon: 'Departs too soon', operator_not_verified: 'Operator not verified' };

async function api(path, { method = 'GET', body, admin } = {}) {
  const r = await fetch('/api/v1' + path, {
    method, headers: { 'content-type': 'application/json', ...(admin ? { 'x-admin-key': admin } : { 'x-api-key': PARTNER_KEY }) },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error?.message || 'Request failed'), { code: j.error?.code });
  return j;
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3500); }
const modal = (html) => { $('#modalBody').innerHTML = html; $('#modal').hidden = false; };
const closeModal = () => ($('#modal').hidden = true);
$('#closeModal').onclick = closeModal;
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };

// ---- tabs
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('main > section').forEach((s) => (s.hidden = s.id !== b.dataset.tab));
  if (b.dataset.tab === 'market') loadLegs();
}));

// ---- marketplace
let LEGS = [];
async function loadLegs() {
  try { LEGS = (await api('/legs')).legs; renderLegs(); } catch (e) { $('#legs').innerHTML = `<p class="callout bad">${esc(e.message)}</p>`; }
}
function renderLegs() {
  const q = $('#routeFilter').value.trim().toLowerCase(), fin = $('#finOnly').checked;
  const list = LEGS.filter((l) => (!fin || l.financing.financeable) &&
    (!q || [l.origin.code, l.origin.city, l.destination.code, l.destination.city].some((x) => x.toLowerCase().includes(q))));
  $('#legs').innerHTML = list.map((l) => {
    const f = l.financing;
    const aircraft = l.pricedPerSeat ? 'MEMBERS ONLY · Priced per seat' : `${esc(l.aircraft)}<br>${l.seats} seats · ${esc(l.category)}${l.altAircraft ? ` · +${l.altAircraft}` : ''}`;
    return `<div class="card">
      <div class="route"><span>${esc(l.origin.code)}<br><span class="city">${esc(l.origin.city)}</span></span><span class="arrow">→</span><span>${esc(l.destination.code)}<br><span class="city">${esc(l.destination.city)}</span></span></div>
      <div class="sub">${dur(l.durationMin)} flight · ${esc(l.window)}</div><div class="sub">${aircraft}</div>
      <div class="price">${usd0(l.priceCents)} <span class="sub">${l.pricedPerSeat ? 'per seat' : 'USD'}</span></div>
      <div class="sub">Available ${when(l.departsAt)}</div>
      ${f.financeable ? `<div><span class="badge ok">Pay over 3 months · ${usd0(f.preview.monthlyPaymentCents)}/mo</span></div>
        <button class="primary" data-leg="${esc(l.id)}">Finance this trip</button>`
        : `<div><span class="badge">${esc(REASON[f.reason] || 'Not financeable')}</span></div><button class="ghost" disabled>Financing unavailable</button>`}
    </div>`;
  }).join('') || '<p class="muted">No flights match.</p>';
  document.querySelectorAll('[data-leg]').forEach((b) => (b.onclick = () => openCheckout(LEGS.find((l) => l.id === b.dataset.leg))));
}
$('#routeFilter').oninput = renderLegs; $('#finOnly').onchange = renderLegs;

// Demo borrower profiles so each underwriting outcome can be exercised.
const PROFILES = {
  strong: { label: 'Strong (approve)', revenue: 5000000, years: 8, score: 750 },
  borderline: { label: 'Borderline credit (manual review)', revenue: 5000000, years: 4, score: 640 },
  weak: { label: 'Weak credit (decline)', revenue: 5000000, years: 3, score: 540 }
};

function scheduleTable(s) {
  return `<table><thead><tr><th>#</th><th>Due</th><th class="n">Amount</th></tr></thead><tbody>${
    s.map((x) => `<tr><td>${x.seq}</td><td>${esc(x.dueDate)}</td><td class="n">${usd(x.amountCents)}</td></tr>`).join('')}</tbody></table>`;
}
const termsBlock = (t) => `
  <table><tbody>
    <tr><td>Charter price</td><td class="n">${usd(t.charterPriceCents)}</td></tr>
    ${t.downPaymentCents ? `<tr><td>Down payment (to operator)</td><td class="n">${usd(t.downPaymentCents)}</td></tr>` : ''}
    <tr><td>Amount financed</td><td class="n">${usd(t.principalCents)}</td></tr>
    <tr><td>Financing charge (${t.feeBps / 100}% flat)</td><td class="n">${usd(t.feeCents)}</td></tr>
    <tr><td><b>Total repayment</b></td><td class="n"><b>${usd(t.totalRepaymentCents)}</b></td></tr>
    <tr><td>Estimated APR</td><td class="n">${pct(t.apr)}</td></tr>
  </tbody></table>`;

async function openCheckout(leg) {
  modal('<p class="muted">Loading quote…</p>');
  try {
    const q = await api('/quotes', { method: 'POST', body: { legId: leg.id } });
    const t = q.terms;
    modal(`<h2>Finance ${esc(leg.origin.code)} → ${esc(leg.destination.code)}</h2>
      <p class="muted">${esc(leg.aircraft)} · ${when(leg.departsAt)} · ${esc(leg.window)}</p>
      ${termsBlock(t)}<h3>Payment schedule (if funded today)</h3>${scheduleTable(t.schedule)}
      <p class="fine">${esc(q.disclosure)}</p>
      <h3>Business details</h3>
      <form id="appForm" class="form">
        <label class="full">Demo profile<select id="profile">${Object.entries(PROFILES).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('')}</select></label>
        <label class="full">Legal business name<input name="legalName" required value="Acme Holdings LLC"></label>
        <label>Business email<input name="email" type="email" required value="cfo@acme.example"></label>
        <label>Entity type<select name="entityType"><option value="llc">LLC</option><option value="corporation">Corporation</option><option value="partnership">Partnership</option><option value="sole_proprietor">Sole proprietor</option></select></label>
        <label>Annual revenue (USD)<input name="rev" type="number" min="0" required></label>
        <label>Years in business<input name="years" type="number" min="0" step="0.5" required></label>
        <label>Credit score (demo input)<input name="score" type="number" min="300" max="850" required></label>
        <label class="chk full"><input type="checkbox" name="consent" required> I authorize SkyFinance to obtain business and guarantor credit reports to evaluate this request.</label>
        <div class="full actions"><button class="primary" id="applyBtn">See my decision</button></div>
      </form>`);
    const form = $('#appForm');
    const fill = () => { const p = PROFILES[$('#profile').value]; form.rev.value = p.revenue; form.years.value = p.years; form.score.value = p.score; };
    $('#profile').onchange = fill; fill();
    form.onsubmit = async (e) => {
      e.preventDefault();
      $('#applyBtn').disabled = true;
      try {
        const loan = await api('/applications', { method: 'POST', body: {
          legId: leg.id, consents: { creditCheck: true },
          borrower: { legalName: form.legalName.value, email: form.email.value, entityType: form.entityType.value,
            annualRevenueCents: Math.round(Number(form.rev.value) * 100), yearsInBusiness: Number(form.years.value), creditScore: Number(form.score.value) } } });
        showDecision(loan);
      } catch (err) { toast(err.message); $('#applyBtn').disabled = false; }
    };
  } catch (e) { modal(`<p class="callout bad">${esc(e.message)}</p>`); }
}

function showDecision(loan) {
  const reasons = loan.decisionReasons.map((r) => `<li>${esc(r.message)}</li>`).join('');
  if (loan.status === 'declined') {
    return modal(`<h2>We can't offer financing for this trip</h2><div class="callout bad"><ul>${reasons}</ul></div>
      <p class="fine">You may request the specific credit report source used. You can still book this trip with another form of payment.</p>`);
  }
  if (loan.status === 'pending_review') {
    return modal(`<h2>Under review</h2><div class="callout warn"><ul>${reasons}</ul></div>
      <p>The flight is held while an underwriter reviews your request. Check <b>My Financing</b> for the outcome.</p>`);
  }
  modal(`<h2>You're approved ✓</h2><div class="callout ok">Risk tier ${esc(loan.riskTier)} · offer held until ${new Date(loan.expiresAt).toLocaleTimeString()}</div>
    ${termsBlock(loan.terms)}<h3>Payment schedule</h3>${scheduleTable(loan.schedule)}
    <p class="fine">${esc(loan.disclosure)}</p>
    <form id="acceptForm" class="form">
      <label class="full">Type your full name to sign<input name="sig" required minlength="2" placeholder="Authorized signer"></label>
      <label class="chk full"><input type="checkbox" name="agree" required> I agree to repay ${usd(loan.terms.totalRepaymentCents)} in ${loan.terms.installments} monthly installments and accept the loan terms.</label>
      <div class="full actions"><button class="primary">Accept &amp; book flight</button><button type="button" class="ghost" id="declineOffer">Cancel</button></div>
    </form>`);
  $('#declineOffer').onclick = async () => { try { await api(`/loans/${loan.id}/cancel`, { method: 'POST' }); } catch {} closeModal(); loadLegs(); };
  $('#acceptForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const f = await api(`/loans/${loan.id}/accept`, { method: 'POST', body: { acceptedTerms: true, signatureName: e.target.sig.value } });
      modal(`<h2>Flight booked 🎉</h2><p>The operator has been paid ${usd(f.terms.principalCents)}. Your first installment of ${usd(f.schedule[0].amountCents)} is due ${esc(f.schedule[0].dueDate)}.</p>
        ${scheduleTable(f.schedule)}<p class="fine">Reference: ${esc(f.id)}</p>`);
      loadLegs();
    } catch (err) { toast(err.message); }
  };
}

// ---- my financing
$('#lookup').onsubmit = async (e) => { e.preventDefault(); loadMyLoans($('#lookupEmail').value); };
async function loadMyLoans(email) {
  try {
    const { loans } = await api('/loans?email=' + encodeURIComponent(email));
    $('#loanList').innerHTML = loans.length ? loans.map((l) => loanCard(l)).join('') : '<p class="muted">No financing found for that email.</p>';
    document.querySelectorAll('[data-pay]').forEach((b) => (b.onclick = async () => {
      try { await api(`/loans/${b.dataset.pay}/payments`, { method: 'POST', body: { amountCents: Number(b.dataset.amt), idempotencyKey: crypto.randomUUID() } }); toast('Payment recorded'); loadMyLoans(email); }
      catch (err) { toast(err.message); }
    }));
  } catch (e) { toast(e.message); }
}
const STATUS_CLASS = { funded: 'ok', paid: 'ok', approved: 'ok', pending_review: 'warn', defaulted: 'bad', declined: 'bad', expired: '', cancelled: '' };
function loanCard(l) {
  const next = l.schedule.find((s) => s.paidCents < s.amountCents && !s.preview);
  return `<div class="card" style="margin-bottom:12px"><div class="route">${esc(l.trip.route)} <span class="badge ${STATUS_CLASS[l.status] || ''}">${esc(l.status.replace('_', ' '))}</span></div>
    <div class="sub">${esc(l.borrower.legalName)} · ${esc(l.trip.aircraft)} · departs ${when(l.trip.departsAt)} · ${esc(l.id)}</div>
    ${l.balanceCents !== null ? `<div class="price">${usd(l.balanceCents)} <span class="sub">remaining of ${usd(l.terms.totalRepaymentCents)}${l.daysPastDue ? ` · <span style="color:var(--bad)">${l.daysPastDue}d past due</span>` : ''}</span></div>` : ''}
    <div class="scroll">${scheduleTable(l.schedule.map((s) => ({ ...s, amountCents: s.amountCents })))}</div>
    ${next ? `<div class="actions"><button class="primary" data-pay="${esc(l.id)}" data-amt="${next.amountCents - next.paidCents}">Pay installment ${next.seq} (${usd(next.amountCents - next.paidCents)})</button></div><p class="fine">Demo only: records a payment without moving money. A real deployment collects via ACH/card.</p>` : ''}</div>`;
}

// ---- lender portal
let ADMIN = '';
$('#adminForm').onsubmit = async (e) => { e.preventDefault(); ADMIN = $('#adminKey').value; loadAdmin(); };
async function loadAdmin() {
  try {
    const [p, { loans }] = await Promise.all([api('/admin/portfolio', { admin: ADMIN }), api('/admin/loans', { admin: ADMIN })]);
    const stat = (l, v) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`;
    $('#adminBody').innerHTML = `<div class="stats">
      ${stat('Capital pool', usd0(p.capitalPoolCents))}${stat('Committed principal', usd0(p.committedPrincipalCents))}${stat('Utilization', pct(p.utilization))}
      ${stat('Originated', usd0(p.originatedCents))}${stat('Collected', usd0(p.collectedCents))}${stat('Fee revenue (collected)', usd0(p.feeRevenueCollectedCents))}
      ${stat('Receivable outstanding', usd0(p.outstandingReceivableCents))}${stat('Defaulted balance', usd0(p.defaultedBalanceCents))}
      ${stat('Current / 1-30 / 31+ dpd', `${p.delinquency.current} / ${p.delinquency.d1_30} / ${p.delinquency.d31_plus}`)}</div>
      <div class="actions"><button class="ghost" id="sweepBtn">Run daily sweep</button></div>
      <h3>Loans</h3><div class="scroll"><table><thead><tr><th>Loan</th><th>Borrower</th><th>Trip</th><th class="n">Financed</th><th>Tier</th><th>Status</th><th></th></tr></thead><tbody>${
        loans.map((l) => `<tr><td>${esc(l.id.slice(0, 13))}</td><td>${esc(l.borrower.legalName)}</td><td>${esc(l.trip.route)}</td><td class="n">${usd0(l.terms.principalCents)}</td><td>${esc(l.riskTier)}</td>
          <td><span class="badge ${STATUS_CLASS[l.status] || ''}">${esc(l.status.replace('_', ' '))}</span></td>
          <td>${l.status === 'pending_review' ? `<button class="ghost" data-rv="approve" data-id="${esc(l.id)}">Approve</button> <button class="ghost" data-rv="decline" data-id="${esc(l.id)}">Decline</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No loans yet — book a trip on the Empty Legs tab.</td></tr>'}</tbody></table></div>`;
    $('#sweepBtn').onclick = async () => { const r = await api('/admin/sweep', { method: 'POST', admin: ADMIN }); toast(`Expired ${r.expired}, defaulted ${r.defaulted}`); loadAdmin(); };
    document.querySelectorAll('[data-rv]').forEach((b) => (b.onclick = async () => {
      try { await api(`/admin/loans/${b.dataset.id}/review`, { method: 'POST', admin: ADMIN, body: { decision: b.dataset.rv } }); loadAdmin(); } catch (err) { toast(err.message); }
    }));
  } catch (e) { $('#adminBody').innerHTML = `<p class="callout bad">${esc(e.message)}</p>`; }
}

loadLegs();
