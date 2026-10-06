// The checkout flow, shared by the JetReserve marketplace and the embeddable plug-in.
// It talks to the backend only through `client`, so the same UI works with a partner API key (marketplace demo)
// or a short-lived checkout-session token (embedded plug-in).
//   client: { quote, apply, getLoan, accept, cancel, createGroup, finalize, simulateJoin, pay }
//   ui:     { modal(html), close(), toast(msg), onLoan?(loan), changed?() }
import { esc, usd, when, scheduleTable, termsBlock } from './lib.js';

const $ = (s, r = document) => r.querySelector(s);
const PROFILES = {
  strong: { label: 'Strong (approve)', income: 300000, years: 0, score: 750, type: 'individual', state: 'TX' },
  business: { label: 'Established LLC (approve)', income: 5000000, years: 8, score: 740, type: 'llc', state: 'TX' },
  borderline: { label: 'Borderline credit (manual review + partner referral)', income: 300000, years: 0, score: 640, type: 'individual', state: 'TX' },
  weak: { label: 'Weak credit (decline)', income: 300000, years: 0, score: 540, type: 'individual', state: 'TX' },
  outofstate: { label: 'Outside launch states (decline)', income: 300000, years: 0, score: 750, type: 'individual', state: 'CA' }
};

export function createCheckout({ client, ui, demoPay = true, email = () => '' }) {
  const act = (fn) => async (e) => { try { show(await fn(e)); } catch (err) { ui.toast(err.message); } finally { ui.changed?.(); } };

  async function open(leg) {
    ui.modal('<p class="muted">Loading quote…</p>');
    let termMonths;
    const form = () => $('#appForm');
    async function renderQuote() {
      const q = await client.quote({ legId: leg.id, termMonths, entityType: form()?.entityType.value ?? 'individual' });
      termMonths = q.terms.termMonths;
      $('#termsArea').innerHTML = `
        <div class="opts">${q.options.map((o) => `<label class="opt ${o.termMonths === termMonths ? 'sel' : ''}"><input type="radio" name="term" value="${o.termMonths}" ${o.termMonths === termMonths ? 'checked' : ''}>${o.termMonths} months · ${usd(o.weeklyPaymentCents).replace('.00', '')}/wk</label>`).join('')}</div>
        <p class="sub">Plan: <b>${esc(q.terms.plan.name)}</b>${q.member?.member ? ` · trip credit ${usd(q.member.tripCreditCents)}` : ''}</p>
        ${termsBlock(q.terms, q.compliance)}<h3>Payment schedule (first payment charged at signing)</h3>${scheduleTable(q.terms.schedule)}
        <p class="fine">${esc(q.disclosure)}</p>`;
      document.querySelectorAll('[name=term]').forEach((r) => (r.onchange = () => { termMonths = Number(r.value); renderQuote().catch((e) => ui.toast(e.message)); }));
    }
    try {
      ui.modal(`<h2>${esc(leg.origin.code)} → ${esc(leg.destination.code)}</h2>
        <p class="muted">${esc(leg.aircraft)} · ${when(leg.departsAt)} · ${esc(leg.window)}</p>
        <div id="termsArea"><p class="muted">Loading…</p></div>
        <h3>Your details</h3>
        <form id="appForm" class="form">
          <label class="full">Demo profile<select id="profile">${Object.entries(PROFILES).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('')}</select></label>
          <label class="full">Legal name<input name="legalName" required value="Pat Flyer"></label>
          <label>Email<input name="email" type="email" required value="${esc(email() || 'pat@example.com')}"></label>
          <label>Client type<select name="entityType"><option value="individual">Individual</option><option value="llc">LLC</option><option value="corporation">Corporation</option><option value="partnership">Partnership</option><option value="sole_proprietor">Sole proprietor</option></select></label>
          <label>State<select name="state"><option>TX</option><option>CA</option><option>NY</option><option>FL</option></select></label>
          <label>Annual income / revenue (USD)<input name="rev" type="number" min="0" required></label>
          <label>Years in business<input name="years" type="number" min="0" step="0.5" required></label>
          <label>Credit score (demo input)<input name="score" type="number" min="300" max="850" required></label>
          <label class="chk full"><input type="checkbox" name="consent" required> I authorize JetReserve to verify my ID and obtain credit reports to evaluate this request.</label>
          <div class="full actions"><button class="primary" id="applyBtn">See my decision</button></div>
        </form>`);
      const f = form();
      const fill = () => { const p = PROFILES[$('#profile').value]; f.rev.value = p.income; f.years.value = p.years; f.score.value = p.score; f.entityType.value = p.type; f.state.value = p.state; renderQuote().catch((e) => ui.toast(e.message)); };
      $('#profile').onchange = fill; f.entityType.onchange = () => renderQuote().catch((e) => ui.toast(e.message));
      await renderQuote(); fill();
      f.onsubmit = async (e) => {
        e.preventDefault(); $('#applyBtn').disabled = true;
        try {
          show(await client.apply({ legId: leg.id, termMonths, borrower: {
            legalName: f.legalName.value, email: f.email.value, entityType: f.entityType.value, state: f.state.value,
            annualRevenueCents: Math.round(Number(f.rev.value) * 100), yearsInBusiness: Number(f.years.value), creditScore: Number(f.score.value) } }));
        } catch (err) { ui.toast(err.message); $('#applyBtn').disabled = false; }
        finally { ui.changed?.(); }
      };
    } catch (e) { ui.modal(`<p class="callout bad">${esc(e.message)}</p>`); }
  }

  function show(loan) {
    ui.onLoan?.(loan);
    const reasons = loan.decisionReasons.map((r) => `<li>${esc(r.message)}</li>`).join('');
    if (loan.status === 'declined') return ui.modal(`<h2>We can't offer financing for this trip</h2><div class="callout bad"><ul>${reasons}</ul></div><p class="fine">You may request the credit report source used. You can still book this trip with another form of payment.</p>`);
    if (loan.status === 'pending_review') return ui.modal(`<h2>Under review</h2><div class="callout warn"><ul>${reasons}</ul></div>
      ${loan.referral && /^https:\/\//.test(loan.referral.offerUrl) ? `<div class="callout ok"><b>Another option:</b> you may qualify with ${esc(loan.referral.partner)}. <a href="${esc(loan.referral.offerUrl)}" target="_blank" rel="noopener noreferrer">See their offer</a>.</div>` : ''}
      <p>The flight is held while an underwriter reviews your request.</p>`);
    if (['expired', 'cancelled'].includes(loan.status)) return ui.modal(`<h2>Offer ${esc(loan.status)}</h2><p class="muted">Any payments collected have been refunded.</p>`);
    if (loan.status === 'approved') return approved(loan);
    if (loan.status === 'signed') return signed(loan);
    ui.modal(`<h2>Flight booked 🎉</h2><div class="callout ok">The operator has been paid ${usd(loan.terms.operatorPayoutCents)} in full. Your trip is locked.</div>
      <p>${loan.terms.installments} weekly payments of ${usd(loan.schedule[0].amountCents)}; next is due ${esc((loan.schedule.find((s) => s.paidCents < s.amountCents) || {}).dueDate || '—')}.</p>
      ${scheduleTable(loan.schedule)}<p class="fine">Reference: ${esc(loan.id)}</p>`);
  }

  function approved(loan) {
    const g = loan.group;
    ui.modal(`<h2>You're approved ✓</h2><div class="callout ok">${esc(loan.plan.name)} plan · risk tier ${esc(loan.riskTier)} · offer held until ${new Date(loan.expiresAt).toLocaleTimeString()}</div>
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
    $('#cancelOffer').onclick = async () => { try { await client.cancel(loan.id); } catch { /* already closed */ } ui.onLoan?.({ status: 'cancelled', id: loan.id }); ui.close(); ui.changed?.(); };
    if (!g) $('#mkGroup').onclick = act(async () => {
      const friends = $('#friends').value.split('\n').map((l) => l.split(',').map((x) => x.trim())).filter((p) => p[0]).map(([name, email]) => ({ name, email }));
      await client.createGroup(loan.id, friends); return client.getLoan(loan.id);
    });
    else wireGroup(loan);
    $('#signForm').onsubmit = act(async (e) => { e.preventDefault(); const f = e.target;
      return client.accept(loan.id, { acceptedTerms: true, signatureName: f.sig.value, autopay: { method: f.method.value, last4: f.last4.value }, backupCardLast4: f.backup.value }); });
  }

  function groupPanel(loan) {
    const g = loan.group;
    return `<table><thead><tr><th>Person</th><th>Status</th><th class="n">Down</th><th class="n">Weekly</th><th></th></tr></thead><tbody>${g.members.map((m) => `<tr>
      <td>${esc(m.name)}${m.role === 'main' ? ' <span class="badge">you</span>' : ''}</td><td>${esc(m.status)}</td>
      <td class="n">${m.downShareCents != null ? usd(m.downShareCents) : '—'}</td><td class="n">${m.weeklyShareCents != null ? usd(m.weeklyShareCents) : '—'}</td>
      <td>${m.inviteToken ? `<a class="mono" href="/join.html?token=${esc(m.inviteToken)}" target="_blank" rel="noopener">invite link</a>${demoPay ? ` <button type="button" class="ghost btn-sm" data-invite="${esc(m.inviteToken)}">Simulate join</button>` : ''}` : ''}</td></tr>`).join('')}</tbody></table>
      ${g.finalized ? `<p class="fine">Group locked: ${g.payers} people pay.</p>` : `<p class="fine">Send each friend their invite link. Friends verify ID and add autopay to join. The flight stays held until the deadline; lock the group when ready.</p>
      <div class="actions"><button type="button" class="ghost" id="finShrink">Lock group (drop anyone not joined)</button><button type="button" class="ghost" id="finCover">Lock group (I cover absent shares)</button></div>`}`;
  }
  function wireGroup(loan) {
    document.querySelectorAll('[data-invite]').forEach((b) => (b.onclick = act(async () => { await client.simulateJoin(b.dataset.invite); return client.getLoan(loan.id); })));
    const fin = (mode) => act(async () => { await client.finalize(loan.id, mode); return client.getLoan(loan.id); });
    if ($('#finShrink')) { $('#finShrink').onclick = fin('shrink'); $('#finCover').onclick = fin('main_covers'); }
  }

  function signed(loan) {
    const g = loan.group, t = loan.terms, first = loan.schedule[0];
    const pay = (body) => act(async () => { await client.pay(loan.id, body); return client.getLoan(loan.id); });
    const downOwed = loan.dueAtSigningCents > first.amountCents - first.paidCents;
    ui.modal(`<h2>Flight locked — complete your payment</h2>
      <div class="callout">The flight is held for you. JetReserve pays the operator once the down payment and first autopay clear.</div>
      <p>Due now: <b>${usd(loan.dueAtSigningCents)}</b> ${t.cashDownCents ? `(down ${usd(t.cashDownCents)} + first weekly ${usd(first.amountCents)})` : `(first weekly payment)`}</p>
      ${demoPay ? (g ? `<table><thead><tr><th>Person</th><th class="n">Down</th><th class="n">First weekly</th><th></th></tr></thead><tbody>${g.members.filter((m) => m.downShareCents != null).map((m) => `<tr><td>${esc(m.name)}</td><td class="n">${usd(m.downShareCents)}</td><td class="n">${usd(m.weeklyShareCents)}</td>
        <td>${m.downPaid ? '✓ down ' : `<button class="ghost btn-sm" data-down="${esc(m.id)}">Pay down</button> `}${m.firstPaid ? '✓ first' : `<button class="ghost btn-sm" data-first="${esc(m.id)}">Pay first</button>`}</td></tr>`).join('')}</tbody></table>`
      : `<div class="actions">${downOwed ? '<button class="primary" id="payDown">Pay down payment (demo)</button>' : ''}<button class="primary" id="payFirst">Pay first autopay (demo)</button></div>`)
        : '<div class="callout">Your payment is collected through the secure payment form. This page updates when it clears.</div>'}
      <p class="fine">${demoPay ? 'Demo only: these buttons simulate the payment processor confirming each charge. ' : ''}Offer expires ${new Date(loan.expiresAt).toLocaleTimeString()}; unpaid bookings are released and refunded.</p>
      <div class="actions"><button class="ghost" id="cancelOffer">Cancel &amp; refund</button></div>`);
    $('#cancelOffer').onclick = act(() => client.cancel(loan.id));
    if (demoPay && g) {
      document.querySelectorAll('[data-down]').forEach((b) => (b.onclick = pay({ kind: 'down_payment', memberId: b.dataset.down })));
      document.querySelectorAll('[data-first]').forEach((b) => (b.onclick = pay({ kind: 'installment', memberId: b.dataset.first })));
    } else if (demoPay) {
      if ($('#payDown')) $('#payDown').onclick = pay({ kind: 'down_payment' });
      $('#payFirst').onclick = pay({ kind: 'installment' });
    }
  }

  return { open, show };
}
