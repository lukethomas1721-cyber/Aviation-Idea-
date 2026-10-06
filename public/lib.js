// Shared formatting + markup helpers (marketplace, embedded checkout, invite page).
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const usd = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const usd0 = (c) => '$' + Math.round(c / 100).toLocaleString('en-US');
export const pct = (x) => (x * 100).toFixed(0) + '%';
export const dur = (m) => (m >= 60 ? Math.floor(m / 60) + 'h ' : '') + (m % 60 ? (m % 60) + 'm' : '').trim();
export const when = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
export const uid = () => crypto.randomUUID();

export function scheduleTable(s) {
  const show = s.length > 6 ? [...s.slice(0, 3), null, ...s.slice(-1)] : s;
  return `<table><thead><tr><th>#</th><th>Due</th><th class="n">Amount</th></tr></thead><tbody>${
    show.map((x) => x ? `<tr><td>${x.seq}</td><td>${esc(x.dueDate)}${x.paidCents >= x.amountCents ? ' ✓' : ''}</td><td class="n">${usd(x.amountCents)}</td></tr>` : `<tr><td colspan="3" class="muted">… ${s.length - 4} more weekly payments …</td></tr>`).join('')}</tbody></table>`;
}

export const termsBlock = (t, c) => `
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
