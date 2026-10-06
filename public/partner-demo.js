// A stand-in for a charter company's website. In reality the listing data and the session endpoint live on the
// charter company's own backend; here the JetReserve demo server provides both (demo mode only).
import { esc, usd0, dur, when } from './lib.js';

const log = (line) => { const el = document.getElementById('log'); el.textContent = (el.textContent === '(none yet)' ? '' : el.textContent + '\n') + `${new Date().toLocaleTimeString()}  ${line}`; };

async function load() {
  const r = await fetch('/api/v1/demo/legs');
  if (!r.ok) { document.getElementById('legs').innerHTML = '<p class="callout bad">The demo partner backend is disabled on this server (demo mode off).</p>'; return; }
  const { legs } = await r.json();
  document.getElementById('legs').innerHTML = legs.filter((l) => !l.pricedPerSeat).map((l) => `
    <div class="card"><div class="route">${esc(l.origin.code)} → ${esc(l.destination.code)}</div>
      <div class="sub">${esc(l.origin.city)} to ${esc(l.destination.city)} · ${dur(l.durationMin)} · ${esc(l.window)} · ${when(l.departsAt)}</div>
      <div class="sub">${esc(l.aircraft)} · ${l.seats} seats</div>
      <div class="price">${usd0(l.priceCents)}</div>
      ${l.financing.financeable
        ? `<div data-jetreserve-leg="${esc(l.id)}" data-session-url="/api/v1/demo/session" data-weekly="${l.financing.preview.weeklyPaymentCents}"></div>`
        : `<div class="badge">${l.financing.reason?.startsWith('leg_') ? 'Sold' : 'Financing not available'}</div>`}
    </div>`).join('');
  window.JetReserve?.scan();
}
for (const t of ['jetreserve:ready', 'jetreserve:status', 'jetreserve:funded', 'jetreserve:close']) {
  window.addEventListener(t, (e) => log(`${t} ${JSON.stringify(e.detail)}`));
}
window.addEventListener('jetreserve:funded', (e) => log(`✅ Booking confirmed for loan ${e.detail.loanId}: mark the flight as sold on this site.`));
load();
