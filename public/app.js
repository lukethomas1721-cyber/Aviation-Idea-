// Demo UI. In production the licensed charter site calls the JetReserve API from its backend; the partner key below
// is a public demo key and must never ship in a real browser bundle. Payment buttons simulate the processor webhooks.
const PARTNER_KEY = 'demo_partner_key';
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0 = (c) => '$' + Math.round(c / 100).toLocaleString('en-US');
const pct = (x) => (x * 100).toFixed(0) + '%';
const dur = (m) => (m >= 60 ? Math.floor(m / 60) + 'h ' : '') + (m % 60 ? (m % 60) + 'm' : '').trim();
const when = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const REASON = { per_seat_or_member_flight: 'Per-seat / members-only', leg_held: 'Offer pending', leg_locked: 'Booking in progress', leg_booked: 'Booked', departure_too_soon: 'Departs too soon', operator_not_verified: 'Operator not verified' };
const uid = () => crypto.randomUUID();

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
  document.querySelectorAll('[data-leg]').forEach((b) => (b.onclick = () => openCheckout(LEGS.find((l) => l.id === b.dataset.leg))));
}
$('#routeFilter').oninput = renderLegs; $('#finOnly').onchange = renderLegs;

const PROFILES = {
  strong: { label: 'Strong (approve)', income: 300000, years: 0, score: 750, type: 'individual' },
  business: { label: 'Established LLC (approve)', income: 5000000, years: 8, score: 740, type: 'llc' },
  borderline: { label: 'Borderline credit (manual review)', income: 300000, years: 0, score: 640, type: 'individual' },
  weak: { label: 'Weak credit (decline)', income: 300000, years: 0, score: 540, type: 'individual' }
};

function scheduleTable(s) {
  const show = s.length > 6 ? [...s.slice(0, 3), null, ...s.slice(-1)] : s;
  return `<table><thead><tr><th>#</th><th>Due</th><th class="n">Amount</th></tr></thead><tbody>${
    show.map((x) => x ? `<tr><td>${x.seq}</td><td>${esc(x.dueDate)}${x.paidCents >= x.amountCents ? ' ✓' : ''}</td><td class="n">${usd(x.amountCents)}</td></tr>` : `<tr><td colspan="3" class="muted">… ${s.length - 4} more weekly payments …</td></tr>`).join('')}</tbody></table>`;
}
const termsBlock = (t, c) => `
  <table><tbody>
    <tr><td>Trip price</td><td class="n">${usd(t.charterPriceCents)}</td></tr>
    ${t.downPaymentCents ? `<tr><td>Down payment (${t.cashDownCents !== t.downPaymentCents ? 'before credit' : 'due at signing'})</td><td class="n">${usd(t.downPaymentCents)}</td></tr>` : ''}
    ${t.creditAppliedCents ? `<tr><td>Member trip credit applied</td><td class="n">−${usd(t.creditAppliedCents)}</td></tr>` : ''}
    <tr><td>Amount financed</td><td class="n">${usd(t.principalCents)}</td></tr>
    <tr><td>Flat charge (${(t.flatBps / 100).toFixed(0)}%)</td><td class="n">${usd(t.feeCents)}</td></tr>
    <tr><td><b>${t.installments} weekly payments of</b></td><td class="n"><b>${usd(t.weeklyPaymentCents)}</b></td></tr>
    <tr><td>Total repaid after down payment</td><td class="n">${usd(t.totalRepaymentCents)}</td></tr>
    <tr><td>Estimated APR</td><td class="n">${pct(t.apr)}</td></tr>
  </tbody></table>${c?.exceedsReferenceCap ? `<div class="callout warn fine">Pricing review flag: this APR is above the ${pct(c.referenceAprCap)} reference cap for consumer loans. Requires attorney sign-off before launch${c.enforced ? ' (enforced: loan would be refused)' : ''}.</div>` : ''}`;

// ---- checkout: quote -> apply
async function openCheckout(leg) {
  modal('<p class="muted">Loading quote…</p>');
  let termMonths;
  const form = () => $('#appForm');
  async function renderQuote() {
    const type = form()?.entityType.value ?? 'individual';
    const q = await post('/quotes', { legId: leg.id, email: ME || undefined, termMonths, entityType: type });
    termMonths = q.terms.termMonths;
    $('#termsArea').innerHTML = `
      <div class="opts">${q.options.map((o) => `<label class="opt ${o.termMonths === termMonths ? 'sel' : ''}"><input type="radio" name="term" value="${o.termMonths}" ${o.termMonths === termMonths ? 'checked' : ''}>${o.termMonths} months · ${usd0(o.weeklyPaymentCents)}/wk</label>`).join('')}</div>
      <p class="sub">Plan: <b>${esc(q.terms.plan.name)}</b>${q.member?.member ? ` · trip credit ${usd(q.member.tripCreditCents)}` : ''}</p>
      ${termsBlock(q.terms, q.compliance)}<h3>Payment schedule (first payment charged at signing)</h3>${scheduleTable(q.terms.schedule)}
      <p class="fine">${esc(q.disclosure)}</p>`;
    document.querySelectorAll('[name=term]').forEach((r) => (r.onchange = () => { termMonths = Number(r.value); renderQuote().catch((e) => toast(e.message)); }));
  }
  try {
    modal(`<h2>${esc(leg.origin.code)} → ${esc(leg.destination.code)}</h2>
      <p class="muted">${esc(leg.aircraft)} · ${when(leg.departsAt)} · ${esc(leg.window)}</p>
      <div id="termsArea"><p class="muted">Loading…</p></div>
      <h3>Your details</h3>
      <form id="appForm" class="form">
        <label class="full">Demo profile<select id="profile">${Object.entries(PROFILES).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('')}</select></label>
        <label class="full">Legal name<input name="legalName" required value="Pat Flyer"></label>
        <label>Email<input name="email" type="email" required value="${esc(ME || 'pat@example.com')}"></label>
        <label>Client type<select name="entityType"><option value="individual">Individual</option><option value="llc">LLC</option><option value="corporation">Corporation</option><option value="partnership">Partnership</option><option value="sole_proprietor">Sole proprietor</option></select></label>
        <label>Annual income / revenue (USD)<input name="rev" type="number" min="0" required></label>
        <label>Years in business<input name="years" type="number" min="0" step="0.5" required></label>
        <label>Credit score (demo input)<input name="score" type="number" min="300" max="850" required></label>
        <label class="chk full"><input type="checkbox" name="consent" required> I authorize JetReserve to verify my ID and obtain credit reports to evaluate this request.</label>
        <div class="full actions"><button class="primary" id="applyBtn">See my decision</button></div>
      </form>`);
    const f = form();
    const fill = () => { const p = PROFILES[$('#profile').value]; f.rev.value = p.income; f.years.value = p.years; f.score.value = p.score; f.entityType.value = p.type; renderQuote().catch((e) => toast(e.message)); };
    $('#profile').onchange = fill; f.entityType.onchange = () => renderQuote().catch((e) => toast(e.message));
    await renderQuote(); fill();
    f.onsubmit = async (e) => {
      e.preventDefault(); $('#applyBtn').disabled = true;
      try {
        const loan = await post('/applications', { legId: leg.id, termMonths, consents: { creditCheck: true }, borrower: {
          legalName: f.legalName.value, email: f.email.value, entityType: f.entityType.value,
          annualRevenueCents: Math.round(Number(f.rev.value) * 100), yearsInBusiness: Number(f.years.value), creditScore: Number(f.score.value) } });
        showLoan(loan);
      } catch (err) { toast(err.message); $('#applyBtn').disabled = false; }
    };
  } catch (e) { modal(`<p class="callout bad">${esc(e.message)}</p>`); }
}

// ---- one view per loan status
async function refresh(id) { return api('/loans/' + id); }
const act = (id, fn) => async (e) => { try { showLoan(await fn(e)); } catch (err) { toast(err.message); } finally { loadLegs(); } };

function showLoan(loan) {
  const reasons = loan.decisionReasons.map((r) => `<li>${esc(r.message)}</li>`).join('');
  const L = loan.id;
  if (loan.status === 'declined') return modal(`<h2>We can't offer financing for this trip</h2><div class="callout bad"><ul>${reasons}</ul></div><p class="fine">You may request the credit report source used. You can still book this trip with another form of payment.</p>`);
  if (loan.status === 'pending_review') return modal(`<h2>Under review</h2><div class="callout warn"><ul>${reasons}</ul></div><p>The flight is held while an underwriter reviews your request. Check <b>My Financing</b> for the outcome.</p>`);
  if (['expired', 'cancelled'].includes(loan.status)) return modal(`<h2>Offer ${esc(loan.status)}</h2><p class="muted">Any payments collected have been refunded.</p>`);
  if (loan.status === 'approved') return approvedView(loan);
  if (loan.status === 'signed') return signedView(loan);
  modal(`<h2>Flight booked 🎉</h2><div class="callout ok">The operator has been paid ${usd(loan.terms.operatorPayoutCents)} in full. Your trip is locked.</div>
    <p>${loan.terms.installments} weekly payments of ${usd(loan.schedule[0].amountCents)}; next is due ${esc((loan.schedule.find((s) => s.paidCents < s.amountCents) || {}).dueDate || '—')}.</p>
    ${scheduleTable(loan.schedule)}<p class="fine">Reference: ${esc(L)}</p>`);
}

function approvedView(loan) {
  const g = loan.group;
  modal(`<h2>You're approved ✓</h2><div class="callout ok">${esc(loan.plan.name)} plan · risk tier ${esc(loan.riskTier)} · offer held until ${new Date(loan.expiresAt).toLocaleTimeString()}</div>
    ${termsBlock(loan.terms)}
    <h3>Group pay <span class="muted">(optional · up to 8 friends)</span></h3>
    ${g ? groupPanel(loan) : `<p class="fine">Split the down payment and every weekly payment equally. You sign the loan and stay responsible for the full balance; if a friend's payment fails after a short grace period it is charged to your card.</p>
      <textarea id="friends" placeholder="One friend per line:  Name, email@example.com"></textarea><div class="actions"><button class="ghost" id="mkGroup">Invite friends</button></div>`}
    <h3>Sign &amp; set up autopay</h3>
    <form id="signForm" class="form">
      <label class="full">Type your full name to sign<input name="sig" required minlength="2"></label>
      <label>Autopay method<select name="method"><option value="ach">Bank account (ACH)</option><option value="card">Card</option></select></label>
      <label>Last 4 digits<input name="last4" required pattern="\\d{4}" maxlength="4" value="4242"></label>
      <label>Backup card, last 4<input name="backup" required pattern="\\d{4}" maxlength="4" value="1111"></label>
      <label class="chk full"><input type="checkbox" name="agree" required> I agree to repay ${usd(loan.terms.totalRepaymentCents)} by weekly autopay${loan.terms.cashDownCents ? ` after a ${usd(loan.terms.cashDownCents)} down payment` : ''} and accept the loan terms.</label>
      <div class="full actions"><button class="primary" ${g && !g.finalized ? 'disabled title="Finalize the group first"' : ''}>Sign &amp; lock this flight</button><button type="button" class="ghost" id="cancelOffer">Cancel</button></div>
    </form>`);
  $('#cancelOffer').onclick = async () => { try { await post(`/loans/${loan.id}/cancel`); } catch {} closeModal(); loadLegs(); };
  if (!g) $('#mkGroup').onclick = act(loan.id, async () => {
    const friends = $('#friends').value.split('\n').map((l) => l.split(',').map((x) => x.trim())).filter((p) => p[0]).map(([name, email]) => ({ name, email }));
    await post(`/loans/${loan.id}/group`, { friends }); return refresh(loan.id);
  });
  else wireGroup(loan);
  $('#signForm').onsubmit = act(loan.id, async (e) => { e.preventDefault(); const f = e.target;
    return post(`/loans/${loan.id}/accept`, { acceptedTerms: true, signatureName: f.sig.value, autopay: { method: f.method.value, last4: f.last4.value }, backupCardLast4: f.backup.value }); });
}

function groupPanel(loan) {
  const g = loan.group;
  return `<table><thead><tr><th>Person</th><th>Status</th><th class="n">Down</th><th class="n">Weekly</th><th></th></tr></thead><tbody>${g.members.map((m) => `<tr>
    <td>${esc(m.name)}${m.role === 'main' ? ' <span class="badge">you</span>' : ''}</td><td>${esc(m.status)}</td>
    <td class="n">${m.downShareCents != null ? usd(m.downShareCents) : '—'}</td><td class="n">${m.weeklyShareCents != null ? usd(m.weeklyShareCents) : '—'}</td>
    <td>${m.inviteToken ? `<button type="button" class="ghost btn-sm" data-invite="${esc(m.inviteToken)}">Simulate join</button>` : ''}</td></tr>`).join('')}</tbody></table>
    ${g.finalized ? `<p class="fine">Group locked: ${g.payers} people pay.</p>` : `<p class="fine">Invite links use each friend's token (shown to your site's backend). Friends verify ID and add autopay to join. The flight stays held until the deadline.</p>
    <div class="actions"><button type="button" class="ghost" id="finShrink">Lock group (drop anyone not joined)</button><button type="button" class="ghost" id="finCover">Lock group (I cover absent shares)</button></div>`}`;
}
function wireGroup(loan) {
  document.querySelectorAll('[data-invite]').forEach((b) => (b.onclick = act(loan.id, async () => {
    await post(`/group/join/${b.dataset.invite}`, { idVerified: true, autopay: { method: 'card', last4: '5555' } }); return refresh(loan.id); })));
  const fin = (mode) => act(loan.id, async () => { await post(`/loans/${loan.id}/group/finalize`, { mode }); return refresh(loan.id); });
  if ($('#finShrink')) { $('#finShrink').onclick = fin('shrink'); $('#finCover').onclick = fin('main_covers'); }
}

function signedView(loan) {
  const g = loan.group, t = loan.terms, first = loan.schedule[0];
  const pay = (body) => act(loan.id, async () => { await post(`/loans/${loan.id}/payments`, { ...body, idempotencyKey: uid() }); return refresh(loan.id); });
  modal(`<h2>Flight locked — complete your payment</h2>
    <div class="callout">The flight is held for you. JetReserve pays the operator once the down payment and first autopay clear.</div>
    <p>Due now: <b>${usd(loan.dueAtSigningCents)}</b> ${t.cashDownCents ? `(down ${usd(t.cashDownCents)} + first weekly ${usd(first.amountCents)})` : `(first weekly payment)`}</p>
    ${g ? `<table><thead><tr><th>Person</th><th class="n">Down</th><th class="n">First weekly</th><th></th></tr></thead><tbody>${g.members.filter((m) => m.downShareCents != null).map((m) => `<tr><td>${esc(m.name)}</td><td class="n">${usd(m.downShareCents)}</td><td class="n">${usd(m.weeklyShareCents)}</td>
      <td>${m.downPaid ? '✓ down ' : `<button class="ghost btn-sm" data-down="${esc(m.id)}">Pay down</button> `}${m.firstPaid ? '✓ first' : `<button class="ghost btn-sm" data-first="${esc(m.id)}">Pay first</button>`}</td></tr>`).join('')}</tbody></table>`
    : `<div class="actions">${loan.dueAtSigningCents > first.amountCents - first.paidCents ? '<button class="primary" id="payDown">Pay down payment (demo)</button>' : ''}<button class="primary" id="payFirst">Pay first autopay (demo)</button></div>`}
    <p class="fine">Demo only: these buttons simulate the payment processor confirming each charge. Offer expires ${new Date(loan.expiresAt).toLocaleTimeString()}; unpaid bookings are released and refunded.</p>
    <div class="actions"><button class="ghost" id="cancelOffer">Cancel &amp; refund</button></div>`);
  $('#cancelOffer').onclick = act(loan.id, () => post(`/loans/${loan.id}/cancel`));
  if (g) {
    document.querySelectorAll('[data-down]').forEach((b) => (b.onclick = pay({ kind: 'down_payment', memberId: b.dataset.down })));
    document.querySelectorAll('[data-first]').forEach((b) => (b.onclick = pay({ kind: 'installment', memberId: b.dataset.first })));
  } else {
    if ($('#payDown')) $('#payDown').onclick = pay({ kind: 'down_payment' });
    $('#payFirst').onclick = pay({ kind: 'installment' });
  }
}

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
    document.querySelectorAll('[data-pay]').forEach((b) => (b.onclick = async () => {
      try { await post(`/loans/${b.dataset.pay}/payments`, { idempotencyKey: uid() }); toast('Weekly payment recorded'); loadMyLoans(email); } catch (err) { toast(err.message); }
    }));
    document.querySelectorAll('[data-open]').forEach((b) => (b.onclick = async () => showLoan(await refresh(b.dataset.open))));
  } catch (e) { toast(e.message); }
}
const STATUS_CLASS = { funded: 'ok', paid: 'ok', approved: 'ok', signed: 'warn', pending_review: 'warn', defaulted: 'bad', declined: 'bad', expired: '', cancelled: '' };
function loanCard(l) {
  const next = ['funded', 'defaulted'].includes(l.status) ? l.schedule.find((s) => s.paidCents < s.amountCents) : null;
  return `<div class="card" style="margin-bottom:12px"><div class="route">${esc(l.trip.route)} <span class="badge ${STATUS_CLASS[l.status] || ''}">${esc(l.status.replace('_', ' '))}</span> <span class="badge">${esc(l.plan.name)}</span></div>
    <div class="sub">${esc(l.borrower.legalName)} · ${esc(l.trip.aircraft)} · departs ${when(l.trip.departsAt)} · ${esc(l.id)}</div>
    ${l.balanceCents !== null ? `<div class="price">${usd(l.balanceCents)} <span class="sub">remaining of ${usd(l.terms.totalRepaymentCents)}${l.daysPastDue ? ` · <span style="color:var(--bad)">${l.daysPastDue}d past due</span>` : ''}</span></div>` : ''}
    <div class="scroll">${scheduleTable(l.schedule)}</div>
    <div class="actions">${next ? `<button class="primary" data-pay="${esc(l.id)}">Pay week ${next.seq} (${usd(next.amountCents - next.paidCents)})</button>` : ''}
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
      ${stat('Marketplace markup', usd0(p.marketplaceMarkupCents))}${stat('Membership dues', usd0(p.membershipDuesCents))}${stat('Client trust account', usd0(p.trustAccountCents))}
      ${stat('Receivable outstanding', usd0(p.outstandingReceivableCents))}${stat('Defaulted balance', usd0(p.defaultedBalanceCents))}
      ${stat('Current / 1-30 / 31+ dpd', `${p.delinquency.current} / ${p.delinquency.d1_30} / ${p.delinquency.d31_plus}`)}</div>
      <div class="actions"><button class="ghost" id="sweepBtn">Run daily sweep</button></div>
      <h3>Trust account reconciliation</h3>
      <form id="trustForm" class="row"><input id="bankBal" type="number" step="0.01" placeholder="Bank balance (USD) to reconcile against ${usd(trust.ledgerTotalCents)} ledger"><button>Reconcile</button></form><div id="trustOut" class="fine"></div>
      <h3>Loans</h3><div class="scroll"><table><thead><tr><th>Loan</th><th>Client</th><th>Plan</th><th>Trip</th><th class="n">Financed</th><th>Tier</th><th>Status</th><th></th></tr></thead><tbody>${
        loans.map((l) => `<tr><td>${esc(l.id.slice(0, 13))}</td><td>${esc(l.borrower.legalName)}</td><td>${esc(l.plan.name)}</td><td>${esc(l.trip.route)}</td><td class="n">${usd0(l.terms.principalCents)}</td><td>${esc(l.riskTier)}</td>
          <td><span class="badge ${STATUS_CLASS[l.status] || ''}">${esc(l.status.replace('_', ' '))}</span></td>
          <td>${l.status === 'pending_review' ? `<button class="ghost" data-rv="approve" data-id="${esc(l.id)}">Approve</button> <button class="ghost" data-rv="decline" data-id="${esc(l.id)}">Decline</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No loans yet — book a trip on the Empty Legs tab.</td></tr>'}</tbody></table></div>`;
    $('#sweepBtn').onclick = async () => { const r = await post('/admin/sweep', {}, ADMIN); toast(`Expired ${r.expired}, defaulted ${r.defaulted}, backstopped ${r.backstopped}`); loadAdmin(); };
    $('#trustForm').onsubmit = async (e) => { e.preventDefault(); const t = await api('/admin/trust?bankBalanceCents=' + Math.round(Number($('#bankBal').value) * 100), { admin: ADMIN });
      $('#trustOut').textContent = t.reconciled ? `✓ Reconciled. ${t.clientBalances.length} client balance(s) total ${usd(t.ledgerTotalCents)}.` : `✗ Difference ${usd(t.differenceCents)} (bank − ledger).`; };
    document.querySelectorAll('[data-rv]').forEach((b) => (b.onclick = async () => {
      try { await post(`/admin/loans/${b.dataset.id}/review`, { decision: b.dataset.rv }, ADMIN); loadAdmin(); } catch (err) { toast(err.message); }
    }));
  } catch (e) { $('#adminBody').innerHTML = `<p class="callout bad">${esc(e.message)}</p>`; }
}

loadLegs();
